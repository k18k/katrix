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
  /** The user whose device sent it, from the authenticated Olm payload. */
  senderUserId: string;
  /** The Ed25519 key the sending device claimed in that payload. */
  claimedEd25519Key?: string;
  firstKnownIndex: number;
  source: "m.room_key" | "own";
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
}

export interface UserDevicesRecord {
  devices: Record<string, DeviceInfo>;
  tracked: boolean;
  /** Bumped by every "changed" notice; a query clears it only if it did not change meanwhile. */
  outdated: number;
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
