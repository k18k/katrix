import type { CrossSigningKey } from "@katrix/shared";
import type { Transaction } from "../storage/store.ts";
import type { E2EEProtocol, InboundGroupSession, OlmAccount, OlmSession, OutboundGroupSession, PickleKey } from "../protocol/protocol.ts";

/** Records of the crypto stores. Pickles are opaque strings of the E2EEProtocol named in `protocol`. */

export interface AccountRecord {
  protocol: string;
  pickle: string;
  /** Whether the server has our device keys. */
  deviceKeysUploaded: boolean;
}

export interface OlmSessionRecord {
  pickle: string;
  sessionId: string;
  senderKey: string;
  createdAt: number;
  /** When a message from the other side last decrypted in this session. */
  lastReceivedAt?: number;
}

export interface InboundGroupSessionRecord {
  pickle: string;
  roomId: string;
  sessionId: string;
  /** Curve25519 key of the device that sent us the session (over Olm). */
  senderKey: string;
  /**
   * The user whose device sent it, from the authenticated Olm payload; "" when the session came
   * from somewhere that does not say (a key backup).
   */
  senderUserId: string;
  /** The Ed25519 key the sending device claimed in that payload. */
  claimedEd25519Key?: string;
  firstKnownIndex: number;
  /**
   * Where we got it: from the sending device (m.room_key), our own, forwarded by another device
   * (m.forwarded_room_key), or from the key backup. Only the first two prove who sent it.
   */
  source: "m.room_key" | "own" | "forwarded" | "backup";
  /** Curve25519 keys of the devices that forwarded it to us, in order. */
  forwardingChain?: string[];
  /** The key backup version it was uploaded to. */
  backedUpTo?: string;
}

export interface SharedWith {
  curve25519: string;
  /** The message index the key was shared at; undefined if the key was withheld. */
  index?: number;
  withheld?: string;
}

export interface OutboundGroupSessionRecord {
  pickle: string;
  sessionId: string;
  roomId: string;
  createdAt: number;
  messageCount: number;
  /** By `${userId}|${deviceId}`. */
  sharedWith: Record<string, SharedWith>;
  /** The settings the session was made for; a change rotates it. */
  settings: { algorithm: string; rotationPeriodMs: number; rotationPeriodMsgs: number; historyVisibility: string };
}

export interface DeviceInfo {
  userId: string;
  deviceId: string;
  curve25519: string;
  ed25519: string;
  algorithms: string[];
  displayName?: string;
  /** The signed device keys as the server sent them (without `unsigned`), to check cross-signing signatures. */
  signed?: Record<string, unknown>;
}

/** A user's cross-signing public keys (https://spec.matrix.org/v1.19/client-server-api/#cross-signing), as the server sent them. */
export interface CrossSigningKeys {
  master?: CrossSigningKey;
  selfSigning?: CrossSigningKey;
  /** Only ever known for our own user. */
  userSigning?: CrossSigningKey;
}

/** What this device decided to trust about a user, kept across key queries. */
export interface UserTrustRecord {
  /** The master key first seen for the user (trust on first use); a different one later is an identity change. */
  pinnedMaster?: string;
  /** A master key verified directly here (by SAS, or for our own user, by holding or restoring it). */
  verifiedMaster?: string;
  /** Ed25519 keys of devices verified directly here. */
  verifiedDevices?: string[];
}

export interface UserDevicesRecord {
  devices: Record<string, DeviceInfo>;
  tracked: boolean;
  /** Bumped by every "changed" notice; a query clears it only if it did not change meanwhile. */
  outdated: number;
  crossSigning?: CrossSigningKeys;
  trust?: UserTrustRecord;
}

export const olmSessionKey = (senderKey: string, sessionId: string) => `${senderKey}|${sessionId}`;
export const inboundKey = (roomId: string, sessionId: string) => `${roomId}|${sessionId}`;
export const deviceKey = (userId: string) => `user:${userId}`;

/** Pickling and unpickling with the protocol and pickle key, checking the protocol matches. */
export class Pickler {
  readonly protocol: E2EEProtocol;
  private readonly key?: PickleKey;

  constructor(protocol: E2EEProtocol, key?: PickleKey) {
    this.protocol = protocol;
    this.key = key;
  }

  account(record: AccountRecord): OlmAccount {
    if (record.protocol !== this.protocol.id)
      throw new Error(`The stored account belongs to E2EE protocol ${record.protocol}, not ${this.protocol.id}`);
    return this.protocol.accountFromPickle(record.pickle, this.key);
  }

  session(record: OlmSessionRecord): OlmSession {
    return this.protocol.sessionFromPickle(record.pickle, this.key);
  }

  inbound(record: InboundGroupSessionRecord): InboundGroupSession {
    return this.protocol.inboundGroupSessionFromPickle(record.pickle, this.key);
  }

  outbound(record: OutboundGroupSessionRecord): OutboundGroupSession {
    return this.protocol.outboundGroupSessionFromPickle(record.pickle, this.key);
  }

  pickle(obj: { pickle(key?: PickleKey): string }): string {
    return obj.pickle(this.key);
  }
}

export async function loadAccount(tx: Transaction, pickler: Pickler): Promise<{ record: AccountRecord; account: OlmAccount }> {
  const record = await tx.get<AccountRecord>("account", "account");
  if (!record) throw new Error("No Olm account: the crypto engine is not initialised");
  return { record, account: pickler.account(record) };
}

export function saveAccount(tx: Transaction, pickler: Pickler, record: AccountRecord, account: OlmAccount): void {
  tx.put("account", "account", { ...record, pickle: pickler.pickle(account) });
}
