import type { CryptoPrimitives, KeyPair } from "../../crypto/primitives.ts";
import { TypedEmitter } from "../../util/emitter.ts";
import { describeError, type Logger } from "../../util/logger.ts";
import { bytesEqual, constantTimeEqual, decodeBase64, encodeBase64 } from "@katrix/shared";
import type { CrossSigning } from "../cross-signing.ts";
import type { DeviceTracker } from "../devices.ts";
import { decodeQr, encodeQr, QR_SCAN, QR_SHOW, RECIPROCATE, type QrMode } from "./qr.ts";
import {
  HASH,
  KEY_AGREEMENT,
  MAC_METHOD,
  SAS_METHOD,
  SAS_TYPES,
  sasBytes,
  sasCommitment,
  sasDecimals,
  sasEmoji,
  sasInfo,
  sasMac,
} from "./sas.ts";

export type VerificationPhase = "requested" | "ready" | "started" | "done" | "cancelled";

/** How the messages of one verification travel: to-device, or as events in a room. */
export interface VerificationChannel {
  readonly kind: "to-device" | "room";
  /** The transaction ID (to-device), or the request event's ID (in a room). */
  readonly transactionId: string;
  /** Send a message; resolves with the content as sent (the start content goes into the SAS commitment). */
  send(type: string, content: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** After the other side answered from one device: only that device gets the rest. */
  narrowTo?(deviceId: string): void;
}

export interface SasCode {
  emoji: Array<{ emoji: string; description: string }>;
  decimal: [number, number, number];
}

export interface VerificationEvents {
  /** The phase changed, or something the app shows did (an SAS, a scanned code, a cancellation). */
  change: [];
  /** The short authentication string to compare: call confirmSas() or mismatchSas(). */
  sas: [sas: SasCode];
  /** The other device says it scanned our QR code: ask the user whether it did, then confirmQrScanned(). */
  qrScanned: [];
}

/** What a verification needs from the client. */
export interface VerificationContext {
  primitives: CryptoPrimitives;
  crossSigning: CrossSigning;
  devices: DeviceTracker;
  logger: Logger;
  userId: string;
  deviceId: string;
  /** This device's Ed25519 key. */
  deviceEd25519(): string;
  /** After a verification succeeded (to fetch secrets from a newly verified own device). */
  onVerified?: (request: VerificationRequest) => void;
}

/** The methods this SDK supports; showing and scanning QR codes needs the app's camera and screen. */
export const ALL_METHODS = [SAS_METHOD, QR_SHOW, QR_SCAN, RECIPROCATE];

interface SasState {
  /** Whether we sent the start that is in effect. */
  weStarted: boolean;
  startContent: Record<string, unknown>;
  keyPair: KeyPair;
  commitment?: string;
  theirKey?: string;
  shared?: Uint8Array;
  sasTypes: string[];
  code?: SasCode;
  confirmed: boolean;
  theirMac?: { mac: Record<string, string>; keys: string };
}

/**
 * One key verification (https://spec.matrix.org/v1.19/client-server-api/#key-verification-framework):
 * request → ready → start (SAS or QR) → done, or cancelled at any point. The keys verified are
 * fixed when the method starts, as the spec requires, and checked again at the end.
 */
export class VerificationRequest extends TypedEmitter<VerificationEvents> {
  phase: VerificationPhase = "requested";
  readonly initiatedByMe: boolean;
  readonly otherUserId: string;
  /** The other side's device: known once it answered (or for a request it sent). */
  otherDeviceId?: string;
  theirMethods: string[] = [];
  readonly ourMethods: string[];
  /** "m.sas.v1" or "m.reciprocate.v1" once started. */
  method?: string;
  cancelCode?: string;
  cancelReason?: string;
  /** The verification finished on another of our devices, or the other side answered elsewhere. */
  handledElsewhere = false;
  readonly createdAt = Date.now();
  readonly channel: VerificationChannel;
  private readonly ctx: VerificationContext;
  private sas?: SasState;
  /** Keys fixed at the start: the other device's Ed25519 key and the other user's master key. */
  private pinned?: { deviceKey?: string; masterKey?: string };
  private qr?: { mode: QrMode; secret: Uint8Array; code: Uint8Array; secondKey: Uint8Array; firstKey: Uint8Array };
  private scanned?: { mode: QrMode; trust: () => Promise<void> };
  private theirDone = false;
  private ourDone = false;

  constructor(
    ctx: VerificationContext,
    channel: VerificationChannel,
    opts: { initiatedByMe: boolean; otherUserId: string; otherDeviceId?: string; ourMethods?: string[] },
  ) {
    super();
    this.ctx = ctx;
    this.channel = channel;
    this.initiatedByMe = opts.initiatedByMe;
    this.otherUserId = opts.otherUserId;
    this.otherDeviceId = opts.otherDeviceId;
    this.ourMethods = opts.ourMethods ?? ALL_METHODS;
  }

  get transactionId(): string {
    return this.channel.transactionId;
  }

  /** The SAS to compare, once the keys are exchanged. */
  get sasCode(): SasCode | undefined {
    return this.sas?.code;
  }

  private setPhase(phase: VerificationPhase): void {
    this.phase = phase;
    this.emit("change");
  }

  private get common(): string[] {
    return this.ourMethods.filter((m) => this.theirMethods.includes(m));
  }

  // ─── Requesting and accepting ─────────────────────────────────────────────

  /** Accept a request from the other side (m.key.verification.ready). */
  async accept(): Promise<void> {
    if (this.initiatedByMe || this.phase !== "requested") throw new Error("Only a pending incoming request can be accepted");
    const methods = this.ourMethods.filter(
      (m) => this.theirMethods.includes(m) || (m === RECIPROCATE && this.theirMethods.some((t) => t.startsWith("m.qr_code"))),
    );
    if (!methods.some((m) => m === SAS_METHOD || m === QR_SHOW || m === QR_SCAN)) {
      await this.cancel("m.unknown_method", "No verification method in common");
      return;
    }
    await this.channel.send("m.key.verification.ready", { from_device: this.ctx.deviceId, methods });
    this.setPhase("ready");
  }

  /** Decline or abort (m.key.verification.cancel). */
  async cancel(code = "m.user", reason = "The user cancelled the verification"): Promise<void> {
    if (this.phase === "done" || this.phase === "cancelled") return;
    this.cancelCode = code;
    this.cancelReason = reason;
    this.setPhase("cancelled");
    await this.channel
      .send("m.key.verification.cancel", { code, reason })
      .catch((e) => this.ctx.logger.warn("could not send a cancellation", describeError(e)));
  }

  // ─── Incoming messages ────────────────────────────────────────────────────

  /** A message of this verification from the other side (`fromDevice` from its content). */
  async handle(type: string, content: Record<string, any>, sender: string): Promise<void> {
    if (this.phase === "done" || this.phase === "cancelled") return;
    try {
      // A message from another device of ours: it took the request over (in-room requests).
      if (
        sender === this.ctx.userId &&
        content.from_device !== undefined &&
        content.from_device !== this.ctx.deviceId &&
        sender !== this.otherUserId
      ) {
        if (type === "m.key.verification.ready" || type === "m.key.verification.start") {
          this.handledElsewhere = true;
          this.setPhase("cancelled");
        }
        return;
      }
      if (sender !== this.otherUserId) return;
      if (
        this.otherDeviceId &&
        content.from_device !== undefined &&
        content.from_device !== this.otherDeviceId &&
        type !== "m.key.verification.cancel"
      )
        return;
      switch (type) {
        case "m.key.verification.ready":
          return await this.onReady(content);
        case "m.key.verification.start":
          return await this.onStart(content);
        case "m.key.verification.accept":
          return await this.onAccept(content);
        case "m.key.verification.key":
          return await this.onKey(content);
        case "m.key.verification.mac":
          return await this.onMac(content);
        case "m.key.verification.done":
          return await this.onDone();
        case "m.key.verification.cancel":
          this.cancelCode = typeof content.code === "string" ? content.code : "m.user";
          this.cancelReason = typeof content.reason === "string" ? content.reason : undefined;
          this.setPhase("cancelled");
          return;
      }
    } catch (e) {
      this.ctx.logger.warn("verification failed", describeError(e));
      await this.cancel("m.unexpected_message", "The verification failed");
    }
  }

  private async onReady(content: Record<string, any>): Promise<void> {
    if (!this.initiatedByMe || this.phase !== "requested") return this.unexpected();
    if (typeof content.from_device !== "string") return this.unexpected();
    this.otherDeviceId = content.from_device;
    this.theirMethods = Array.isArray(content.methods) ? content.methods.filter((m: unknown): m is string => typeof m === "string") : [];
    this.channel.narrowTo?.(content.from_device);
    this.setPhase("ready");
  }

  private async unexpected(): Promise<void> {
    await this.cancel("m.unexpected_message", "Unexpected verification message");
  }

  // ─── SAS ──────────────────────────────────────────────────────────────────

  /** Start SAS verification (after ready). */
  async startSas(): Promise<void> {
    if (this.phase !== "ready" || !this.common.includes(SAS_METHOD)) throw new Error("SAS cannot be started now");
    await this.pinKeys();
    const startContent = await this.channel.send("m.key.verification.start", {
      from_device: this.ctx.deviceId,
      method: SAS_METHOD,
      key_agreement_protocols: [KEY_AGREEMENT],
      hashes: [HASH],
      message_authentication_codes: [MAC_METHOD],
      short_authentication_string: [...SAS_TYPES],
    });
    this.method = SAS_METHOD;
    this.sas = {
      weStarted: true,
      startContent,
      keyPair: this.ctx.primitives.x25519GenerateKeyPair(),
      sasTypes: [...SAS_TYPES],
      confirmed: false,
    };
    this.setPhase("started");
  }

  /** Whether our start wins over theirs when both sent one: the lexicographically smaller user (then device) wins. */
  private weWinStartRace(): boolean {
    if (this.ctx.userId !== this.otherUserId) return this.ctx.userId < this.otherUserId;
    return this.ctx.deviceId < (this.otherDeviceId ?? "");
  }

  private async onStart(content: Record<string, any>): Promise<void> {
    if (typeof content.from_device === "string") this.otherDeviceId ??= content.from_device;
    if (content.method === RECIPROCATE) return this.onReciprocate(content);
    if (content.method !== SAS_METHOD) return void (await this.cancel("m.unknown_method", "Unsupported verification method"));
    if (this.phase === "started") {
      if (this.sas?.weStarted && this.method === SAS_METHOD && this.weWinStartRace()) return;
      if (!this.sas?.weStarted || this.method !== SAS_METHOD) return this.unexpected();
    } else if (this.phase !== "ready" && !(this.phase === "requested" && !this.initiatedByMe)) return this.unexpected();
    const has = (field: string, value: string) => Array.isArray(content[field]) && content[field].includes(value);
    if (!has("key_agreement_protocols", KEY_AGREEMENT) || !has("hashes", HASH) || !has("message_authentication_codes", MAC_METHOD))
      return void (await this.cancel("m.unknown_method", "No key agreement, hash or MAC in common"));
    const sasTypes = SAS_TYPES.filter((t) => has("short_authentication_string", t));
    if (sasTypes.length === 0) return void (await this.cancel("m.unknown_method", "No SAS method in common"));
    await this.pinKeys();
    const keyPair = this.ctx.primitives.x25519GenerateKeyPair();
    // The commitment covers the start content exactly as received (transaction ID or relation included).
    const commitment = sasCommitment(this.ctx.primitives, encodeBase64(keyPair.publicKey), content);
    this.sas = { weStarted: false, startContent: content, keyPair, sasTypes, confirmed: false };
    this.method = SAS_METHOD;
    this.setPhase("started");
    await this.channel.send("m.key.verification.accept", {
      method: SAS_METHOD,
      key_agreement_protocol: KEY_AGREEMENT,
      hash: HASH,
      message_authentication_code: MAC_METHOD,
      short_authentication_string: sasTypes,
      commitment,
    });
  }

  private async onAccept(content: Record<string, any>): Promise<void> {
    const sas = this.sas;
    if (!sas?.weStarted || sas.commitment !== undefined) return this.unexpected();
    if (content.key_agreement_protocol !== KEY_AGREEMENT || content.hash !== HASH || content.message_authentication_code !== MAC_METHOD)
      return void (await this.cancel("m.unknown_method", "Unsupported key agreement, hash or MAC"));
    if (typeof content.commitment !== "string") return this.unexpected();
    sas.commitment = content.commitment;
    sas.sasTypes = SAS_TYPES.filter(
      (t) => Array.isArray(content.short_authentication_string) && content.short_authentication_string.includes(t),
    );
    await this.channel.send("m.key.verification.key", { key: encodeBase64(sas.keyPair.publicKey) });
  }

  private async onKey(content: Record<string, any>): Promise<void> {
    const sas = this.sas;
    if (!sas || sas.theirKey !== undefined || typeof content.key !== "string") return this.unexpected();
    if (sas.weStarted) {
      if (sas.commitment === undefined) return this.unexpected();
      const expected = sasCommitment(this.ctx.primitives, content.key, sas.startContent);
      if (!constantTimeEqual(decodeBase64(expected), decodeBase64(sas.commitment)))
        return void (await this.cancel("m.mismatched_commitment", "The key does not match the commitment"));
    }
    sas.theirKey = content.key;
    sas.shared = this.ctx.primitives.x25519SharedSecret(sas.keyPair.secretKey, decodeBase64(content.key));
    const ourKey = encodeBase64(sas.keyPair.publicKey);
    if (!sas.weStarted) await this.channel.send("m.key.verification.key", { key: ourKey });
    const us = { user: this.ctx.userId, device: this.ctx.deviceId, key: ourKey };
    const them = { user: this.otherUserId, device: this.otherDeviceId ?? "", key: content.key };
    const [start, acc] = sas.weStarted ? [us, them] : [them, us];
    const bytes = sasBytes(
      this.ctx.primitives,
      sas.shared,
      sasInfo({
        startUser: start.user,
        startDevice: start.device,
        startKey: start.key,
        acceptUser: acc.user,
        acceptDevice: acc.device,
        acceptKey: acc.key,
        transactionId: this.transactionId,
      }),
    );
    sas.code = { emoji: sasEmoji(bytes), decimal: sasDecimals(bytes) };
    this.emit("sas", sas.code);
    this.emit("change");
  }

  /** The user says the SAS matches: send our MACs (and finish, if theirs are here and check out). */
  async confirmSas(): Promise<void> {
    const sas = this.sas;
    if (!sas?.shared || sas.confirmed) throw new Error("There is no SAS to confirm");
    sas.confirmed = true;
    const keys: Record<string, string> = { [`ed25519:${this.ctx.deviceId}`]: this.ctx.deviceEd25519() };
    const master = await this.ctx.crossSigning.masterKey(this.ctx.userId);
    // Our master key too, when we trust it: the other side can then trust our whole identity.
    if (master && (await this.ctx.crossSigning.userTrust(this.ctx.userId)).verified) keys[`ed25519:${master}`] = master;
    const params = (keyId: string) => ({
      senderUser: this.ctx.userId,
      senderDevice: this.ctx.deviceId,
      otherUser: this.otherUserId,
      otherDevice: this.otherDeviceId ?? "",
      transactionId: this.transactionId,
      keyId,
    });
    const mac: Record<string, string> = {};
    for (const [keyId, key] of Object.entries(keys)) mac[keyId] = sasMac(this.ctx.primitives, sas.shared, params(keyId), key);
    const keyIds = Object.keys(keys).sort().join(",");
    await this.channel.send("m.key.verification.mac", { mac, keys: sasMac(this.ctx.primitives, sas.shared, params("KEY_IDS"), keyIds) });
    if (sas.theirMac) await this.checkTheirMac();
  }

  /** The user says the SAS does not match. */
  mismatchSas(): Promise<void> {
    return this.cancel("m.mismatched_sas", "The short authentication strings did not match");
  }

  private async onMac(content: Record<string, any>): Promise<void> {
    const sas = this.sas;
    if (!sas?.shared || sas.theirMac || typeof content.mac !== "object" || content.mac === null || typeof content.keys !== "string")
      return this.unexpected();
    sas.theirMac = { mac: content.mac, keys: content.keys };
    if (sas.confirmed) await this.checkTheirMac();
  }

  private async checkTheirMac(): Promise<void> {
    const sas = this.sas!;
    const theirs = sas.theirMac!;
    const params = (keyId: string) => ({
      senderUser: this.otherUserId,
      senderDevice: this.otherDeviceId ?? "",
      otherUser: this.ctx.userId,
      otherDevice: this.ctx.deviceId,
      transactionId: this.transactionId,
      keyId,
    });
    const keyIds = Object.keys(theirs.mac).sort().join(",");
    if (!macEqual(sasMac(this.ctx.primitives, sas.shared!, params("KEY_IDS"), keyIds), theirs.keys))
      return void (await this.cancel("m.key_mismatch", "The list of keys does not match"));
    let deviceVerified = false;
    let masterVerified = false;
    for (const [keyId, mac] of Object.entries(theirs.mac)) {
      const id = keyId.startsWith("ed25519:") ? keyId.slice(8) : undefined;
      if (id === undefined) continue;
      let key: string | undefined;
      if (id === this.otherDeviceId) key = this.pinned?.deviceKey;
      else if (id === this.pinned?.masterKey) key = this.pinned.masterKey;
      if (key === undefined) continue;
      if (!macEqual(sasMac(this.ctx.primitives, sas.shared!, params(keyId), key), mac))
        return void (await this.cancel("m.key_mismatch", "A key does not match"));
      if (key === this.pinned?.deviceKey && id === this.otherDeviceId) deviceVerified = true;
      else masterVerified = true;
    }
    if (!deviceVerified && !masterVerified) return void (await this.cancel("m.key_mismatch", "No known key was verified"));
    await this.trust({ device: deviceVerified, master: masterVerified });
    await this.sendDone();
  }

  // ─── QR codes ─────────────────────────────────────────────────────────────

  /**
   * The QR code to show the other side (its bytes, to draw as a byte-mode QR code), when it can
   * scan and we can show one; undefined otherwise.
   */
  async qrCode(): Promise<Uint8Array | undefined> {
    if (this.phase !== "ready" || !this.ourMethods.includes(QR_SHOW) || !this.theirMethods.includes(QR_SCAN)) return undefined;
    if (this.qr) return this.qr.code;
    await this.pinKeys();
    const ownMaster = await this.ctx.crossSigning.masterKey(this.ctx.userId);
    const ownTrusted = (await this.ctx.crossSigning.userTrust(this.ctx.userId)).verified;
    let mode: QrMode;
    let firstKey: string | undefined;
    let secondKey: string | undefined;
    if (this.otherUserId !== this.ctx.userId) {
      [mode, firstKey, secondKey] = [0, ownTrusted ? ownMaster : undefined, this.pinned?.masterKey];
    } else if (ownTrusted) {
      [mode, firstKey, secondKey] = [1, ownMaster, this.pinned?.deviceKey];
    } else {
      [mode, firstKey, secondKey] = [2, this.ctx.deviceEd25519(), ownMaster];
    }
    if (!firstKey || !secondKey) return undefined;
    const secret = this.ctx.primitives.randomBytes(16);
    const data = { mode, transactionId: this.transactionId, firstKey: decodeBase64(firstKey), secondKey: decodeBase64(secondKey), secret };
    this.qr = { ...data, code: encodeQr(data) };
    return this.qr.code;
  }

  /**
   * We scanned the other side's QR code: check its keys against what we know, verify the other
   * side, and tell it (m.reciprocate.v1). Throws (and cancels) if the code does not match.
   */
  async scanQrCode(bytes: Uint8Array): Promise<void> {
    if (this.phase !== "ready" || !this.ourMethods.includes(QR_SCAN)) throw new Error("A QR code cannot be scanned now");
    await this.pinKeys();
    const fail = async (why: string): Promise<never> => {
      await this.cancel("m.key_mismatch", why);
      throw new Error(why);
    };
    let qr;
    try {
      qr = decodeQr(bytes);
    } catch (e) {
      return fail(e instanceof Error ? e.message : "Not a verification QR code");
    }
    if (qr.transactionId !== this.transactionId) return fail("The QR code is for another verification");
    const b64 = encodeBase64;
    const ownMaster = await this.ctx.crossSigning.masterKey(this.ctx.userId);
    const ownTrusted = (await this.ctx.crossSigning.userTrust(this.ctx.userId)).verified;
    let trust: () => Promise<void>;
    if (qr.mode === 0) {
      // They verify us (another user): their master key, and ours as they see it.
      if (this.otherUserId === this.ctx.userId || b64(qr.firstKey) !== this.pinned?.masterKey || b64(qr.secondKey) !== ownMaster)
        return fail("The QR code's keys do not match");
      trust = () => this.trust({ device: false, master: true });
    } else if (qr.mode === 1) {
      // Our other device trusts the master key: the master key, and our device key as it sees it.
      if (this.otherUserId !== this.ctx.userId || b64(qr.firstKey) !== ownMaster || b64(qr.secondKey) !== this.ctx.deviceEd25519())
        return fail("The QR code's keys do not match");
      trust = () => this.trust({ device: true, master: true });
    } else {
      // Our other device does not trust the master key yet: its device key, and the master key as it sees it.
      if (
        this.otherUserId !== this.ctx.userId ||
        !ownTrusted ||
        b64(qr.firstKey) !== this.pinned?.deviceKey ||
        b64(qr.secondKey) !== ownMaster
      )
        return fail("The QR code's keys do not match");
      trust = () => this.trust({ device: true, master: false });
    }
    this.method = RECIPROCATE;
    this.scanned = { mode: qr.mode, trust };
    await this.channel.send("m.key.verification.start", { from_device: this.ctx.deviceId, method: RECIPROCATE, secret: b64(qr.secret) });
    this.setPhase("started");
    await trust();
    if (this.theirDone) await this.sendDone();
  }

  private async onReciprocate(content: Record<string, any>): Promise<void> {
    if (!this.qr || this.phase !== "ready" || typeof content.secret !== "string") return this.unexpected();
    if (!bytesEqual(decodeBase64(content.secret), this.qr.secret))
      return void (await this.cancel("m.key_mismatch", "The QR code secret does not match"));
    this.method = RECIPROCATE;
    this.setPhase("started");
    this.emit("qrScanned");
  }

  /** The user confirms the other device scanned our QR code (it showed success): verify it, finish. */
  async confirmQrScanned(): Promise<void> {
    const qr = this.qr;
    if (!qr || this.method !== RECIPROCATE || this.phase !== "started") throw new Error("No QR code was scanned");
    // What the code we showed vouched for: mode 0, their master key; mode 1, their device; mode 2,
    // the master key it confirmed (and the device that scanned it).
    if (qr.mode === 0) await this.trust({ device: false, master: true });
    else if (qr.mode === 1) await this.trust({ device: true, master: false });
    else await this.trust({ device: true, master: true });
    await this.sendDone();
  }

  // ─── Finishing ────────────────────────────────────────────────────────────

  private async onDone(): Promise<void> {
    this.theirDone = true;
    if (this.scanned && !this.ourDone) await this.sendDone();
    else if (this.ourDone) this.setPhase("done");
  }

  private async sendDone(): Promise<void> {
    if (this.ourDone) return;
    this.ourDone = true;
    await this.channel.send("m.key.verification.done", {});
    this.setPhase("done");
    this.ctx.onVerified?.(this);
  }

  /** Fix the keys being verified (spec: they must not change during the verification). */
  private async pinKeys(): Promise<void> {
    if (this.pinned) return;
    await this.ctx.devices.refresh([this.otherUserId]);
    const rec = await this.ctx.devices.getUser(this.otherUserId);
    const masterKey = await this.ctx.crossSigning.masterKey(this.otherUserId);
    // Spec: refuse to verify a user who has a device with the same ID as a cross-signing key.
    if (masterKey && rec?.devices[masterKey]) {
      await this.cancel("m.key_mismatch", "A device ID collides with a cross-signing key");
      throw new Error("A device ID collides with a cross-signing key");
    }
    this.pinned = { deviceKey: this.otherDeviceId ? rec?.devices[this.otherDeviceId]?.ed25519 : undefined, masterKey };
  }

  /** Record what was verified: the other device, the other user's (or our own) master key. */
  private async trust(what: { device: boolean; master: boolean }): Promise<void> {
    const cs = this.ctx.crossSigning;
    const ownUser = this.otherUserId === this.ctx.userId;
    if (what.device && this.otherDeviceId) {
      await cs.setDeviceVerified(this.otherUserId, this.otherDeviceId);
      if (ownUser && (await cs.privateKeys()).selfSigning)
        await cs.signOwnDevice(this.otherDeviceId).catch((e) => this.ctx.logger.warn("could not sign the device", describeError(e)));
    }
    if (what.master && this.pinned?.masterKey) {
      if (ownUser) await cs.markOwnIdentityVerified();
      else if ((await cs.privateKeys()).userSigning && (await cs.userTrust(this.ctx.userId)).verified)
        await cs.verifyUser(this.otherUserId, this.pinned.masterKey);
      else if (this.otherDeviceId) await cs.setDeviceVerified(this.otherUserId, this.otherDeviceId);
    }
  }
}

function macEqual(a: string, b: string): boolean {
  try {
    return constantTimeEqual(decodeBase64(a), decodeBase64(b));
  } catch {
    return false;
  }
}
