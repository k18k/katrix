import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { deviceKeysObject, oneTimeKeysObject, signObject } from "../../src/e2ee/keys.ts";
import type { MatrixClient } from "../../src/client.ts";
import { nativeE2EEProtocol } from "../../src/protocol/native.ts";
import type { OlmAccount, OlmMessage, OlmSession, OutboundGroupSession } from "../../src/protocol/protocol.ts";
import { encodeUtf8 } from "../../src/util/utf8.ts";

/**
 * A hand-driven device for negative tests: real keys on the server, but every message it sends
 * is built by the test, so it can send what an honest client never would.
 */
export class RawPeer {
  readonly protocol = nativeE2EEProtocol(nobleCryptoPrimitives());
  readonly account: OlmAccount = this.protocol.newAccount();
  readonly client: MatrixClient;
  private sessions = new Map<string, OlmSession>();
  private txn = 0;

  constructor(client: MatrixClient) {
    this.client = client;
  }

  get userId() {
    return this.client.userId;
  }
  get deviceId() {
    return this.client.deviceId;
  }
  get keys() {
    return this.account.identityKeys();
  }

  async uploadKeys(): Promise<void> {
    this.account.generateOneTimeKeys(5);
    const { oneTime } = oneTimeKeysObject(this.account, this.userId, this.deviceId);
    await this.client.api.request("POST", "/v3/keys/upload", {
      body: { device_keys: deviceKeysObject(this.account, this.userId, this.deviceId), one_time_keys: oneTime },
    });
    this.account.markKeysAsPublished();
  }

  /** The target device's keys, and an Olm session to it from one of its one-time keys. */
  async sessionTo(userId: string, deviceId: string): Promise<{ session: OlmSession; curve25519: string; ed25519: string }> {
    const q: any = await this.client.api.request("POST", "/v3/keys/query", { body: { device_keys: { [userId]: [deviceId] } } });
    const keys = q.device_keys[userId][deviceId].keys;
    const curve25519 = keys[`curve25519:${deviceId}`];
    const ed25519 = keys[`ed25519:${deviceId}`];
    let session = this.sessions.get(curve25519);
    if (!session) {
      const c: any = await this.client.api.request("POST", "/v3/keys/claim", {
        body: { one_time_keys: { [userId]: { [deviceId]: "signed_curve25519" } } },
      });
      const otk = Object.values<any>(c.one_time_keys[userId][deviceId])[0];
      session = this.account.createOutboundSession(curve25519, otk.key);
      this.sessions.set(curve25519, session);
    }
    return { session, curve25519, ed25519 };
  }

  /** Olm-encrypt `payload` (whatever it says) for a device; returns the m.room.encrypted content. */
  async olmContent(
    userId: string,
    deviceId: string,
    payload: (target: { ed25519: string }) => Record<string, unknown>,
  ): Promise<{ content: Record<string, unknown>; message: OlmMessage }> {
    const { session, curve25519, ed25519 } = await this.sessionTo(userId, deviceId);
    const message = session.encrypt(encodeUtf8(JSON.stringify(payload({ ed25519 }))));
    return {
      message,
      content: { algorithm: "m.olm.v1.curve25519-aes-sha2", sender_key: this.keys.curve25519, ciphertext: { [curve25519]: message } },
    };
  }

  /** An honest payload, with fields overridden. */
  payload(
    type: string,
    content: Record<string, unknown>,
    to: { userId: string; ed25519: string },
    overrides: Record<string, unknown> = {},
  ) {
    return {
      type,
      content,
      sender: this.userId,
      sender_device: this.deviceId,
      keys: { ed25519: this.keys.ed25519 },
      recipient: to.userId,
      recipient_keys: { ed25519: to.ed25519 },
      ...overrides,
    };
  }

  async sendToDevice(userId: string, deviceId: string, type: string, content: Record<string, unknown>): Promise<void> {
    await this.client.api.request("PUT", `/v3/sendToDevice/${encodeURIComponent(type)}/raw${this.txn++}${Date.now()}`, {
      body: { messages: { [userId]: { [deviceId]: content } } },
    });
  }

  roomKey(roomId: string, session: OutboundGroupSession) {
    return { algorithm: "m.megolm.v1.aes-sha2", room_id: roomId, session_id: session.sessionId(), session_key: session.sessionKey() };
  }

  /** A Megolm event content for the room from `session`, with a plaintext of our choosing. */
  megolmContent(session: OutboundGroupSession, plaintext: Record<string, unknown>) {
    return {
      algorithm: "m.megolm.v1.aes-sha2",
      sender_key: this.keys.curve25519,
      device_id: this.deviceId,
      session_id: session.sessionId(),
      ciphertext: session.encrypt(encodeUtf8(JSON.stringify(plaintext))),
    };
  }

  async sendRoomEvent(roomId: string, content: Record<string, unknown>): Promise<string> {
    const res: any = await this.client.api.request(
      "PUT",
      `/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/raw${this.txn++}${Date.now()}`,
      { body: content },
    );
    return res.event_id;
  }

  signed<T extends Record<string, unknown>>(obj: T) {
    return signObject(this.account, this.userId, this.deviceId, obj);
  }
}
