import { MatrixError } from "./errors.js";
import { createHash } from "node:crypto";
// src/core/identity.ts
const urlSafe = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
var IdentityServers = class {
	hs;
	constructor(hs) {
		this.hs = hs;
	}
	base(idServer) {
		if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(idServer)) throw new MatrixError(400, "M_INVALID_PARAM", "Invalid id_server");
		return `${this.hs.config.threepid.identityServerProtocol}://${idServer}`;
	}
	async call(idServer, method, path, opts = {}) {
		const headers = { accept: "application/json" };
		if (opts.body !== void 0) headers["content-type"] = "application/json";
		if (opts.token) headers.authorization = `Bearer ${opts.token}`;
		if (opts.signed) headers.authorization = this.hs.federation.client.authHeader(idServer, method, path, opts.body);
		let res;
		try {
			res = await this.hs.publicFetch(`${this.base(idServer)}${path}`, {
				method,
				headers,
				body: opts.body === void 0 ? void 0 : JSON.stringify(opts.body),
				signal: AbortSignal.timeout(15e3)
			});
		} catch (err) {
			throw new MatrixError(502, "M_UNKNOWN", `Identity server ${idServer} unreachable: ${err.message}`);
		}
		const json = await res.json().catch(() => ({}));
		if (!res.ok) throw new MatrixError(res.status >= 500 ? 502 : res.status, typeof json.errcode === "string" ? json.errcode : "M_UNKNOWN", typeof json.error === "string" ? json.error : `Identity server returned ${res.status}`);
		return json;
	}
	/** The Matrix user ID bound to a 3PID, if any. */
	async lookup(idServer, token, medium, address) {
		const details = await this.call(idServer, "GET", "/_matrix/identity/v2/hash_details", { token });
		const algorithms = Array.isArray(details.algorithms) ? details.algorithms : [];
		let query, algorithm;
		if (algorithms.includes("sha256") && typeof details.lookup_pepper === "string") {
			algorithm = "sha256";
			query = urlSafe(createHash("sha256").update(`${address} ${medium} ${details.lookup_pepper}`).digest());
		} else if (algorithms.includes("none")) {
			algorithm = "none";
			query = `${address} ${medium}`;
		} else throw new MatrixError(400, "M_UNKNOWN", "The identity server supports no known lookup algorithm");
		const mxid = (await this.call(idServer, "POST", "/_matrix/identity/v2/lookup", {
			token,
			body: {
				addresses: [query],
				algorithm,
				pepper: details.lookup_pepper ?? ""
			}
		})).mappings?.[query];
		return typeof mxid === "string" ? mxid : null;
	}
	async storeInvite(idServer, token, invite) {
		const res = await this.call(idServer, "POST", "/_matrix/identity/v2/store-invite", {
			token,
			body: invite
		});
		if (typeof res.token !== "string" || !Array.isArray(res.public_keys)) throw new MatrixError(502, "M_UNKNOWN", "Invalid store-invite response");
		return res;
	}
	/** Returns the identity server's record of the binding (medium, address, mxid...). */
	async bind(idServer, token, sid, clientSecret, mxid) {
		return this.call(idServer, "POST", "/_matrix/identity/v2/3pid/bind", {
			token,
			body: {
				sid,
				client_secret: clientSecret,
				mxid
			}
		});
	}
	/** Remove a binding; resolves false when the identity server does not support unbinding. */
	async unbind(idServer, mxid, medium, address) {
		try {
			await this.call(idServer, "POST", "/_matrix/identity/v2/3pid/unbind", {
				signed: true,
				body: {
					mxid,
					threepid: {
						medium,
						address
					}
				}
			});
			return true;
		} catch (err) {
			if (err instanceof MatrixError && (err.status === 404 || err.status === 501 || err.errcode === "M_UNRECOGNIZED")) return false;
			throw err;
		}
	}
};
export { IdentityServers };

//# sourceMappingURL=identity.js.map