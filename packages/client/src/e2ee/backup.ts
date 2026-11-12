import type { CryptoPrimitives } from "../crypto/primitives.ts";
import type { MatrixHttpApi } from "../http/api.ts";
import { MatrixError } from "../http/errors.ts";
import type { E2EEProtocol } from "../protocol/protocol.ts";
import type { Store } from "../storage/store.ts";
import { describeError, type Logger } from "../util/logger.ts";
import { Mutex } from "../util/mutex.ts";
import {
  constantTimeEqual,
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  encodeUtf8,
  signingJson,
  type BackupAuthData,
  type BackupVersionResponse,
  type EncryptedSessionData,
  type KeyBackupData,
} from "@katrix/shared";
import { inboundKey, type InboundGroupSessionRecord, type Pickler } from "./crypto-store.ts";
import type { CrossSigning } from "./cross-signing.ts";
import type { DeviceTracker } from "./devices.ts";
import { MEGOLM_ALGORITHM, verifyObject } from "./keys.ts";
import type { SecretBox } from "./secret-box.ts";

export const BACKUP_ALGORITHM = "m.megolm_backup.v1.curve25519-aes-sha2";

/** The plaintext of a backed-up session (BackedUpSessionData). */
export interface BackedUpSession {
  algorithm: string;
  forwarding_curve25519_key_chain: string[];
  sender_key: string;
  sender_claimed_keys: Record<string, string>;
  session_key: string;
  shared_history?: boolean;
}

const ZERO_SALT = new Uint8Array(32);
const EMPTY = new Uint8Array(0);

function backupKeys(primitives: CryptoPrimitives, sharedSecret: Uint8Array) {
  const okm = primitives.hkdfSha256(sharedSecret, ZERO_SALT, EMPTY, 80);
  return { aes: okm.subarray(0, 32), mac: okm.subarray(32, 64), iv: okm.subarray(64, 80) };
}

/**
 * Encrypt a session for m.megolm_backup.v1.curve25519-aes-sha2, by the spec's steps: an ephemeral
 * X25519 key agreement with the backup key, HKDF-SHA-256 into AES-256-CBC key, MAC key and IV.
 * The MAC is of the empty string, not the ciphertext: a bug in libolm every implementation now
 * shares (the spec's warning, MSC4048), so it only shows that the keys were derived right.
 */
export function encryptBackupSession(
  primitives: CryptoPrimitives,
  backupPublicKey: Uint8Array,
  session: BackedUpSession,
): EncryptedSessionData {
  const ephemeral = primitives.x25519GenerateKeyPair();
  const k = backupKeys(primitives, primitives.x25519SharedSecret(ephemeral.secretKey, backupPublicKey));
  const ciphertext = primitives.aes256CbcEncrypt(k.aes, k.iv, encodeUtf8(JSON.stringify(session)));
  return {
    ephemeral: encodeBase64(ephemeral.publicKey),
    ciphertext: encodeBase64(ciphertext),
    mac: encodeBase64(primitives.hmacSha256(k.mac, EMPTY).subarray(0, 8)),
  };
}

export function decryptBackupSession(
  primitives: CryptoPrimitives,
  backupPrivateKey: Uint8Array,
  data: EncryptedSessionData,
): BackedUpSession {
  const k = backupKeys(primitives, primitives.x25519SharedSecret(backupPrivateKey, decodeBase64(data.ephemeral)));
  if (!constantTimeEqual(primitives.hmacSha256(k.mac, EMPTY).subarray(0, 8), decodeBase64(data.mac)))
    throw new Error("The backed-up session does not decrypt with this key");
  const session = JSON.parse(decodeUtf8(primitives.aes256CbcDecrypt(k.aes, k.iv, decodeBase64(data.ciphertext)))) as BackedUpSession;
  if (typeof session?.session_key !== "string" || typeof session.sender_key !== "string")
    throw new Error("The backed-up session is malformed");
  return session;
}

interface StoredBackup {
  version: string;
  publicKey: string;
  /** Sealed (SecretBox) private key, when this device has it. */
  privateKey?: string;
}

const STORE_KEY = "key_backup";

/**
 * Server-side key backup (https://spec.matrix.org/v1.19/client-server-api/#server-side-key-backups):
 * room keys are uploaded encrypted to a public key whose private half only the user has (in
 * secret storage, or shared from another device), so a new device can read old messages.
 *
 * Keys are only uploaded to a backup whose auth_data is trusted: signed by the user's master key
 * or one of their verified devices, or whose private key this device holds.
 */
export class KeyBackup {
  private readonly api: MatrixHttpApi;
  private readonly store: Store;
  private readonly primitives: CryptoPrimitives;
  private readonly protocol: E2EEProtocol;
  private readonly pickler: Pickler;
  private readonly devices: DeviceTracker;
  private readonly crossSigning: CrossSigning;
  private readonly box: SecretBox;
  private readonly logger: Logger;
  private readonly userId: string;
  private readonly signWithDevice: <T extends object>(obj: T) => Promise<T>;
  private readonly uploadMutex = new Mutex();

  constructor(opts: {
    api: MatrixHttpApi;
    store: Store;
    primitives: CryptoPrimitives;
    protocol: E2EEProtocol;
    pickler: Pickler;
    devices: DeviceTracker;
    crossSigning: CrossSigning;
    box: SecretBox;
    logger: Logger;
    userId: string;
    signWithDevice: <T extends object>(obj: T) => Promise<T>;
  }) {
    this.api = opts.api;
    this.store = opts.store;
    this.primitives = opts.primitives;
    this.protocol = opts.protocol;
    this.pickler = opts.pickler;
    this.devices = opts.devices;
    this.crossSigning = opts.crossSigning;
    this.box = opts.box;
    this.logger = opts.logger;
    this.userId = opts.userId;
    this.signWithDevice = opts.signWithDevice;
  }

  /** The server's current backup, if there is one. */
  async serverInfo(): Promise<BackupVersionResponse | undefined> {
    try {
      return await this.api.endpoint("GET /v3/room_keys/version", {}, {});
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  /** The backup this device uploads to, if any. */
  async active(): Promise<{ version: string; publicKey: string; hasPrivateKey: boolean } | undefined> {
    const s = await this.store.get<StoredBackup>("account", STORE_KEY);
    return s ? { version: s.version, publicKey: s.publicKey, hasPrivateKey: s.privateKey !== undefined } : undefined;
  }

  /** The backup's private key, if this device has it (to put it in secret storage). */
  async privateKey(): Promise<Uint8Array | undefined> {
    const s = await this.store.get<StoredBackup>("account", STORE_KEY);
    return s?.privateKey ? this.box.open("m.megolm_backup.v1", s.privateKey) : undefined;
  }

  /**
   * Create a new backup (the server's current one is replaced as the place keys go) and start
   * uploading every room key to it. Its auth_data is signed by this device, and by the master
   * key when given. Records the user's choice in m.key_backup (v1.19). Resolves with the
   * private key, for the app to put in secret storage.
   */
  async create(opts: { masterKey?: Uint8Array } = {}): Promise<{ version: string; privateKey: Uint8Array }> {
    const pair = this.primitives.x25519GenerateKeyPair();
    let authData: BackupAuthData = { public_key: encodeBase64(pair.publicKey) };
    authData = await this.signWithDevice(authData);
    if (opts.masterKey) {
      const mpk = encodeBase64(this.primitives.ed25519PublicKey(opts.masterKey));
      const sig = encodeBase64(this.primitives.ed25519Sign(opts.masterKey, encodeUtf8(signingJson(authData as Record<string, unknown>))));
      authData = {
        ...authData,
        signatures: { ...authData.signatures, [this.userId]: { ...authData.signatures?.[this.userId], [`ed25519:${mpk}`]: sig } },
      };
    }
    const { version } = await this.api.endpoint(
      "POST /v3/room_keys/version",
      {},
      { body: { algorithm: BACKUP_ALGORITHM, auth_data: authData } },
    );
    await this.activate(version, pair.publicKey, pair.secretKey);
    await this.api
      .endpoint("PUT /v3/user/:userId/account_data/:type", { userId: this.userId, type: "m.key_backup" }, { body: { enabled: true } })
      .catch((e) => this.logger.warn("could not record m.key_backup", describeError(e)));
    return { version, privateKey: pair.secretKey };
  }

  /**
   * Use the server's current backup with its private key (from secret storage, secret sharing,
   * or typed in by the user). The key must match the backup's public key.
   */
  async enableWithPrivateKey(privateKey: Uint8Array): Promise<string> {
    const info = await this.serverInfo();
    if (!info || info.algorithm !== BACKUP_ALGORITHM) throw new Error("There is no supported key backup on the server");
    const publicKey = this.primitives.x25519PublicKey(privateKey);
    if (encodeBase64(publicKey) !== info.auth_data.public_key?.replace(/=+$/, ""))
      throw new Error("The key does not belong to the current backup");
    await this.activate(info.version, publicKey, privateKey);
    return info.version;
  }

  /** Upload to the server's current backup without its private key, if its auth_data is trusted. Resolves whether it is. */
  async enableIfTrusted(): Promise<boolean> {
    const info = await this.serverInfo();
    if (!info || info.algorithm !== BACKUP_ALGORITHM || !(await this.isTrusted(info))) return false;
    await this.activate(info.version, decodeBase64(info.auth_data.public_key), undefined);
    return true;
  }

  private async activate(version: string, publicKey: Uint8Array, privateKey: Uint8Array | undefined): Promise<void> {
    await this.store.transaction(async (tx) => {
      const previous = await tx.get<StoredBackup>("account", STORE_KEY);
      tx.put("account", STORE_KEY, {
        version,
        publicKey: encodeBase64(publicKey),
        privateKey: privateKey
          ? this.box.seal("m.megolm_backup.v1", privateKey)
          : previous?.version === version
            ? previous.privateKey
            : undefined,
      } satisfies StoredBackup);
    });
  }

  /** Stop uploading (the backup stays on the server). */
  async disable(): Promise<void> {
    await this.store.transaction(async (tx) => tx.delete("account", STORE_KEY));
  }

  /** Delete a backup version on the server (and stop using it here, if it was the active one). */
  async deleteVersion(version: string): Promise<void> {
    await this.api.endpoint("DELETE /v3/room_keys/version/:version", { version }, {});
    if ((await this.active())?.version === version) await this.disable();
  }

  /**
   * Whether a backup's auth_data is trusted: signed by our trusted master key or by one of our
   * verified devices (spec: "Clients must only store keys in backups after they have ensured
   * that the auth_data is trusted").
   */
  async isTrusted(info: BackupVersionResponse): Promise<boolean> {
    const authData = info.auth_data as unknown as Record<string, unknown>;
    const sigs = (info.auth_data.signatures?.[this.userId] ?? {}) as Record<string, string>;
    const own = await this.devices.getUser(this.userId);
    const masterKey = await this.crossSigning.masterKey(this.userId);
    if (
      masterKey &&
      (await this.crossSigning.userTrust(this.userId)).verified &&
      verifyObject(this.protocol, authData, this.userId, masterKey, masterKey)
    )
      return true;
    for (const keyId of Object.keys(sigs)) {
      const deviceId = keyId.slice("ed25519:".length);
      const device = own?.devices[deviceId];
      if (!device || !(await this.crossSigning.deviceTrust(this.userId, deviceId)).verified) continue;
      if (verifyObject(this.protocol, authData, this.userId, deviceId, device.ed25519)) return true;
    }
    const active = await this.active();
    return active?.hasPrivateKey === true && active.publicKey === info.auth_data.public_key?.replace(/=+$/, "");
  }

  /**
   * Upload the room keys not yet in the active backup, in batches. A backup replaced on the
   * server (M_WRONG_ROOM_KEYS_VERSION) stops the uploads until the app enables the new one.
   */
  backupPending(): Promise<number> {
    return this.uploadMutex.run(async () => {
      const active = await this.store.get<StoredBackup>("account", STORE_KEY);
      if (!active) return 0;
      const publicKey = decodeBase64(active.publicKey);
      let uploaded = 0;
      for (;;) {
        const pending = (await this.store.list<InboundGroupSessionRecord>("inbound_group_sessions"))
          .filter(([, r]) => r.backedUpTo !== active.version)
          .slice(0, 200);
        if (pending.length === 0) return uploaded;
        const rooms: Record<string, { sessions: Record<string, KeyBackupData> }> = {};
        for (const [, record] of pending) {
          const data = await this.sessionData(record, publicKey);
          if (!data) continue;
          (rooms[record.roomId] ??= { sessions: {} }).sessions[record.sessionId] = data;
        }
        try {
          await this.upload(active.version, rooms);
        } catch (e) {
          if (e instanceof MatrixError && e.errcode === "M_WRONG_ROOM_KEYS_VERSION") {
            this.logger.warn("the key backup was replaced on the server; stopping uploads", { version: active.version });
            await this.disable();
            return uploaded;
          }
          throw e;
        }
        await this.store.transaction(async (tx) => {
          for (const [key] of pending) {
            const current = await tx.get<InboundGroupSessionRecord>("inbound_group_sessions", key);
            if (current) tx.put("inbound_group_sessions", key, { ...current, backedUpTo: active.version });
          }
        });
        uploaded += pending.length;
      }
    });
  }

  /** One session or one room goes to its own endpoint (a smaller request); more go to PUT /room_keys/keys. */
  private async upload(version: string, rooms: Record<string, { sessions: Record<string, KeyBackupData> }>): Promise<void> {
    const query = { version };
    const roomIds = Object.keys(rooms);
    if (roomIds.length === 1) {
      const [roomId] = roomIds;
      const sessions = rooms[roomId].sessions;
      const ids = Object.keys(sessions);
      if (ids.length === 1) {
        await this.api.endpoint(
          "PUT /v3/room_keys/keys/:roomId/:sessionId",
          { roomId, sessionId: ids[0] },
          { query, body: sessions[ids[0]] },
        );
        return;
      }
      await this.api.endpoint("PUT /v3/room_keys/keys/:roomId", { roomId }, { query, body: { sessions } });
      return;
    }
    if (roomIds.length > 0) await this.api.endpoint("PUT /v3/room_keys/keys", {}, { query, body: { rooms } });
  }

  /** One backup version's information. */
  async versionInfo(version: string): Promise<BackupVersionResponse | undefined> {
    try {
      return await this.api.endpoint("GET /v3/room_keys/version/:version", { version }, {});
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
      throw e;
    }
  }

  /**
   * Add the master key's signature to the current backup's auth_data (after cross-signing was
   * set up or reset, so other devices trust the backup through the identity).
   */
  async signWithMasterKey(masterKey: Uint8Array): Promise<void> {
    const active = await this.active();
    const info = active ? await this.versionInfo(active.version) : undefined;
    if (!info) throw new Error("No active key backup");
    const mpk = encodeBase64(this.primitives.ed25519PublicKey(masterKey));
    const { signatures, ...unsigned } = info.auth_data;
    const sig = encodeBase64(this.primitives.ed25519Sign(masterKey, encodeUtf8(signingJson(unsigned as Record<string, unknown>))));
    const authData = {
      ...info.auth_data,
      signatures: { ...signatures, [this.userId]: { ...signatures?.[this.userId], [`ed25519:${mpk}`]: sig } },
    };
    await this.api.endpoint(
      "PUT /v3/room_keys/version/:version",
      { version: info.version },
      { body: { algorithm: info.algorithm, auth_data: authData, version: info.version } },
    );
  }

  /** Delete backed-up keys on the server: all of them, one room's, or one session. */
  async deleteKeys(opts: { roomId?: string; sessionId?: string } = {}): Promise<void> {
    const active = await this.active();
    const version = active?.version ?? (await this.serverInfo())?.version;
    if (!version) return;
    const query = { version };
    if (opts.roomId && opts.sessionId)
      await this.api.endpoint(
        "DELETE /v3/room_keys/keys/:roomId/:sessionId",
        { roomId: opts.roomId, sessionId: opts.sessionId },
        { query },
      );
    else if (opts.roomId) await this.api.endpoint("DELETE /v3/room_keys/keys/:roomId", { roomId: opts.roomId }, { query });
    else await this.api.endpoint("DELETE /v3/room_keys/keys", {}, { query });
  }

  private async sessionData(record: InboundGroupSessionRecord, publicKey: Uint8Array): Promise<KeyBackupData | undefined> {
    const session = this.pickler.inbound(record);
    const exported = session.exportAt(session.firstKnownIndex());
    if (!exported) return undefined;
    const chain = record.forwardingChain ?? [];
    const sender = await this.devices.deviceByCurveKey(record.senderUserId, record.senderKey);
    const verified =
      record.source === "own" ||
      (record.source === "m.room_key" &&
        sender !== undefined &&
        (await this.crossSigning.deviceTrust(record.senderUserId, sender.deviceId)).verified);
    return {
      first_message_index: session.firstKnownIndex(),
      forwarded_count: chain.length,
      is_verified: verified,
      session_data: encryptBackupSession(this.primitives, publicKey, {
        algorithm: MEGOLM_ALGORITHM,
        forwarding_curve25519_key_chain: chain,
        sender_key: record.senderKey,
        sender_claimed_keys: record.claimedEd25519Key ? { ed25519: record.claimedEd25519Key } : {},
        session_key: exported,
      }),
    };
  }

  /**
   * Download and import keys from the server's backup (all, one room's, or one session), with
   * the private key given or the one this device has. Keys already known from an earlier index
   * are kept. Resolves with the sessions imported, for the client to retry decryption.
   */
  async restore(
    opts: { privateKey?: Uint8Array; roomId?: string; sessionId?: string } = {},
  ): Promise<Array<{ roomId: string; sessionId: string }>> {
    const info = await this.serverInfo();
    if (!info || info.algorithm !== BACKUP_ALGORITHM) return [];
    const privateKey = opts.privateKey ?? (await this.privateKey());
    if (!privateKey) throw new Error("No key backup private key: restore it from secret storage first");
    if (encodeBase64(this.primitives.x25519PublicKey(privateKey)) !== info.auth_data.public_key?.replace(/=+$/, ""))
      throw new Error("The key does not belong to the current backup");
    const query = { version: info.version };
    let rooms: Record<string, Record<string, KeyBackupData>>;
    if (opts.roomId && opts.sessionId) {
      const one = await this.api
        .endpoint("GET /v3/room_keys/keys/:roomId/:sessionId", { roomId: opts.roomId, sessionId: opts.sessionId }, { query })
        .catch((e) => {
          if (e instanceof MatrixError && e.errcode === "M_NOT_FOUND") return undefined;
          throw e;
        });
      rooms = one ? { [opts.roomId]: { [opts.sessionId]: one } } : {};
    } else if (opts.roomId) {
      rooms = {
        [opts.roomId]: (await this.api.endpoint("GET /v3/room_keys/keys/:roomId", { roomId: opts.roomId }, { query })).sessions ?? {},
      };
    } else {
      const all = await this.api.endpoint("GET /v3/room_keys/keys", {}, { query });
      rooms = Object.fromEntries(Object.entries(all.rooms ?? {}).map(([r, v]) => [r, v.sessions ?? {}]));
    }
    const imported: Array<{ roomId: string; sessionId: string }> = [];
    await this.store.transaction(async (tx) => {
      for (const [roomId, sessions] of Object.entries(rooms)) {
        for (const [sessionId, data] of Object.entries(sessions)) {
          let plain: BackedUpSession;
          let session;
          try {
            plain = decryptBackupSession(this.primitives, privateKey, data.session_data);
            if (plain.algorithm !== MEGOLM_ALGORITHM) continue;
            session = this.protocol.inboundGroupSessionFromExport(plain.session_key);
          } catch (e) {
            this.logger.warn("skipping a backed-up key that does not decrypt", { roomId, sessionId, ...describeError(e) });
            continue;
          }
          if (session.sessionId() !== sessionId) continue;
          const key = inboundKey(roomId, sessionId);
          const existing = await tx.get<InboundGroupSessionRecord>("inbound_group_sessions", key);
          if (existing && session.compare(this.pickler.inbound(existing)) !== "better") continue;
          tx.put("inbound_group_sessions", key, {
            pickle: this.pickler.pickle(session),
            roomId,
            sessionId,
            senderKey: plain.sender_key,
            // The backup does not say who sent the session; the event's sender is checked against
            // the device of sender_key when it decrypts, and such keys are never "authenticated".
            senderUserId: existing?.senderUserId ?? "",
            claimedEd25519Key: plain.sender_claimed_keys?.ed25519,
            firstKnownIndex: session.firstKnownIndex(),
            source: "backup",
            forwardingChain: Array.isArray(plain.forwarding_curve25519_key_chain) ? plain.forwarding_curve25519_key_chain : [],
            backedUpTo: info.version,
          } satisfies InboundGroupSessionRecord);
          imported.push({ roomId, sessionId });
        }
      }
    });
    return imported;
  }
}
