import { M } from "../shared/m.js";
import { publicKeyFromBase64, verifyJsonSignature } from "./crypto.js";
import { redact } from "./events.js";
import { MatrixError } from "./errors.js";
import { getState } from "./authrules.js";
import { domainOf } from "../federation/index.js";
// src/core/policy.ts
const KEY_ID = "ed25519:policy_server";
var PolicyServers = class {
	hs;
	constructor(hs) {
		this.hs = hs;
	}
	/** The room's policy server, if the room uses one (valid `m.room.policy` and a joined user on `via`). */
	async policyOf(roomId) {
		const state = await this.hs.rooms.currentState(roomId);
		const content = getState(state, M.ROOM.POLICY, "")?.content;
		const via = content?.via;
		const ed25519 = content?.public_keys?.ed25519;
		if (typeof via !== "string" || typeof ed25519 !== "string") return null;
		let key;
		try {
			key = publicKeyFromBase64(ed25519);
		} catch {
			return null;
		}
		for (const ev of state.values()) if (ev.type === M.ROOM.MEMBER && ev.content?.membership === "join" && typeof ev.state_key === "string" && domainOf(ev.state_key) === via) return {
			via,
			key
		};
		return null;
	}
	/** The policy state event itself is never sent to the policy server. */
	exempt(pdu) {
		return pdu.type === M.ROOM.POLICY && pdu.state_key === "";
	}
	validSignature(pdu, version, policy) {
		const wire = this.hs.federation.toFederationPdu(pdu, version);
		return verifyJsonSignature(redact(wire, version), policy.via, KEY_ID, policy.key);
	}
	/** Ask the policy server to sign `pdu`; adds the signature to it. Throws the server's error. */
	async requestSignature(pdu, version, policy) {
		const sig = (await this.hs.federation.client.request(policy.via, "POST", "/_matrix/policy/v1/sign", {
			body: this.hs.federation.toFederationPdu(pdu, version),
			timeoutMs: 1e4
		}))?.[policy.via]?.[KEY_ID];
		if (typeof sig !== "string") throw new MatrixError(403, "M_FORBIDDEN", "The policy server did not sign the event");
		pdu.signatures = {
			...pdu.signatures,
			[policy.via]: {
				...pdu.signatures?.[policy.via],
				[KEY_ID]: sig
			}
		};
	}
	/**
	* Before a local event is sent: get the policy server's signature, or refuse the event with the
	* policy server's error. If the policy server cannot be reached the event is sent unsigned (other
	* servers may then soft-fail it), so an unavailable policy server does not lock up the room.
	*/
	async signLocal(roomId, version, pdu) {
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
	async recommended(roomId, version, pdu) {
		if (this.exempt(pdu)) return true;
		const policy = await this.policyOf(roomId);
		if (!policy) return true;
		if (this.validSignature(pdu, version, policy)) return true;
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
};
export { PolicyServers };

//# sourceMappingURL=policy.js.map