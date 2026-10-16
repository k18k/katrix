import type { KeyObject } from "node:crypto";
import { getState } from "./authrules.ts";
import { domainOf } from "../federation/index.ts";
import { MatrixError } from "./errors.ts";
import { publicKeyFromBase64, verifyJsonSignature } from "./crypto.ts";
import { redact, type PDU } from "./events.ts";
import type { Homeserver } from "../homeserver.ts";

// Policy Servers (spec v1.18): a room may name a server (`m.room.policy`) that checks events before
// they are sent. Local events get its signature before they leave this server; remote events
// without a valid one are soft-failed. This server does not act as a policy server itself.

const KEY_ID = "ed25519:policy_server";

interface RoomPolicy {
  via: string;
  key: KeyObject;
}

export class PolicyServers {
  private readonly hs: Homeserver;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  /** The room's policy server, if the room uses one (valid `m.room.policy` and a joined user on `via`). */
  async policyOf(roomId: string): Promise<RoomPolicy | null> {
    const state = await this.hs.rooms.currentState(roomId);
    const content = getState(state, "m.room.policy", "")?.content;
    const via = content?.via;
    const ed25519 = content?.public_keys?.ed25519;
    if (typeof via !== "string" || typeof ed25519 !== "string") return null;
    let key: KeyObject;
    try {
      key = publicKeyFromBase64(ed25519);
    } catch {
      return null;
    }
    for (const ev of state.values()) {
      if (
        ev.type === "m.room.member" &&
        ev.content?.membership === "join" &&
        typeof ev.state_key === "string" &&
        domainOf(ev.state_key) === via
      )
        return { via, key };
    }
    return null;
  }

  /** The policy state event itself is never sent to the policy server. */
  private exempt(pdu: PDU): boolean {
    return pdu.type === "m.room.policy" && pdu.state_key === "";
  }

  private validSignature(pdu: PDU, version: string, policy: RoomPolicy): boolean {
    // Signatures cover the redacted federation form (without our local `event_id`).
    const wire = this.hs.federation.toFederationPdu(pdu, version) as Record<string, any>;
    return verifyJsonSignature(redact(wire, version), policy.via, KEY_ID, policy.key);
  }

  /** Ask the policy server to sign `pdu`; adds the signature to it. Throws the server's error. */
  private async requestSignature(pdu: PDU, version: string, policy: RoomPolicy): Promise<void> {
    const res = await this.hs.federation.client.request(policy.via, "POST", "/_matrix/policy/v1/sign", {
      body: this.hs.federation.toFederationPdu(pdu, version),
      timeoutMs: 10_000,
    });
    const sig = res?.[policy.via]?.[KEY_ID];
    if (typeof sig !== "string") throw new MatrixError(403, "M_FORBIDDEN", "The policy server did not sign the event");
    pdu.signatures = { ...pdu.signatures, [policy.via]: { ...pdu.signatures?.[policy.via], [KEY_ID]: sig } };
  }

  /**
   * Before a local event is sent: get the policy server's signature, or refuse the event with the
   * policy server's error. If the policy server cannot be reached the event is sent unsigned (other
   * servers may then soft-fail it), so an unavailable policy server does not lock up the room.
   */
  async signLocal(roomId: string, version: string, pdu: PDU): Promise<void> {
    if (this.exempt(pdu) || !this.hs.federation.enabled) return;
    const policy = await this.policyOf(roomId);
    if (!policy) return;
    if (policy.via === this.hs.serverName) {
      this.hs.logger.warn("Room", roomId, "names this server as its policy server, which it does not implement");
      return;
    }
    try {
      await this.requestSignature(pdu, version, policy);
    } catch (err) {
      if (err instanceof MatrixError && err.status < 500) throw err;
      this.hs.logger.warn("Policy server", policy.via, "unreachable; sending", pdu.event_id, "without its signature", err);
      return;
    }
    if (!this.validSignature(pdu, version, policy)) throw new MatrixError(403, "M_FORBIDDEN", "The policy server's signature is invalid");
  }

  /** Whether a remote event is recommended for inclusion (otherwise it is soft-failed). */
  async recommended(roomId: string, version: string, pdu: PDU): Promise<boolean> {
    if (this.exempt(pdu)) return true;
    const policy = await this.policyOf(roomId);
    if (!policy) return true;
    if (this.validSignature(pdu, version, policy)) return true;
    // The policy server's key may have rotated: ask for a fresh signature once.
    if (policy.via === this.hs.serverName) return false;
    const copy = structuredClone(pdu);
    try {
      await this.requestSignature(copy, version, policy);
    } catch {
      return false;
    }
    if (!this.validSignature(copy, version, policy)) return false;
    pdu.signatures = copy.signatures;
    return true;
  }
}
