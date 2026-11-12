import { canonicalJson } from "../shared/canonical-json.js";
import { M } from "../shared/m.js";
import { unpaddedBase64 } from "../core/crypto.js";
import { MatrixError } from "../core/errors.js";
import { checkLiteral } from "../core/outbound.js";
import { sign } from "node:crypto";
import { resolveSrv } from "node:dns/promises";
import { Agent, request } from "node:https";
import { isIP } from "node:net";
// src/federation/client.ts
function splitHostPort(name) {
	const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(name);
	if (ipv6) return {
		host: ipv6[1],
		port: ipv6[2] ? Number(ipv6[2]) : null
	};
	const idx = name.lastIndexOf(":");
	if (idx > 0 && /^\d+$/.test(name.slice(idx + 1))) return {
		host: name.slice(0, idx),
		port: Number(name.slice(idx + 1))
	};
	return {
		host: name,
		port: null
	};
}
/** Signs and sends server-server requests, implementing Matrix server discovery. */
var FederationClient = class {
	hs;
	resolved = /* @__PURE__ */ new Map();
	/** One connection pool per destination, so a dead peer's sockets can be dropped without affecting others. */
	agents = /* @__PURE__ */ new Map();
	rejectUnauthorized;
	constructor(hs, opts = {}) {
		this.hs = hs;
		this.rejectUnauthorized = opts.rejectUnauthorized ?? true;
	}
	agentFor(key) {
		let agent = this.agents.get(key);
		if (!agent) {
			agent = new Agent({
				keepAlive: true,
				maxSockets: 16,
				rejectUnauthorized: this.rejectUnauthorized
			});
			this.agents.set(key, agent);
		}
		return agent;
	}
	/** Drop pooled connections to a destination (after errors, the peer may have restarted). */
	resetConnections(destination) {
		const agent = this.agents.get(destination);
		if (agent) {
			agent.destroy();
			this.agents.delete(destination);
		}
		this.resolved.delete(destination);
	}
	/** Build the X-Matrix Authorization header value for a request. */
	authHeader(destination, method, uri, content) {
		const key = this.hs.signingKey;
		const toSign = {
			method,
			uri,
			origin: this.hs.serverName,
			destination
		};
		if (content !== void 0) toSign.content = content;
		const sig = unpaddedBase64(sign(null, Buffer.from(canonicalJson(toSign)), key.privateKey));
		return `X-Matrix origin="${this.hs.serverName}",destination="${destination}",key="ed25519:${key.keyId}",sig="${sig}"`;
	}
	async resolve(serverName) {
		const cached = this.resolved.get(serverName);
		if (cached && cached.expires > Date.now()) return cached;
		const r = await this.discover(serverName);
		this.resolved.set(serverName, r);
		return r;
	}
	async discover(serverName) {
		const day = Date.now() + 864e5;
		const { host, port } = splitHostPort(serverName);
		if (isIP(host)) return {
			host,
			port: port ?? 8448,
			hostHeader: serverName,
			tlsName: host,
			expires: day
		};
		if (port !== null) return {
			host,
			port,
			hostHeader: serverName,
			tlsName: host,
			expires: day
		};
		const delegated = await this.wellKnown(host);
		if (delegated) {
			const d = splitHostPort(delegated);
			if (isIP(d.host)) return {
				host: d.host,
				port: d.port ?? 8448,
				hostHeader: delegated,
				tlsName: d.host,
				expires: day
			};
			if (d.port !== null) return {
				host: d.host,
				port: d.port,
				hostHeader: delegated,
				tlsName: d.host,
				expires: day
			};
			const srv = await this.srv(d.host);
			if (srv) return {
				...srv,
				hostHeader: d.host,
				tlsName: d.host,
				expires: day
			};
			return {
				host: d.host,
				port: 8448,
				hostHeader: d.host,
				tlsName: d.host,
				expires: day
			};
		}
		const srv = await this.srv(host);
		if (srv) return {
			...srv,
			hostHeader: host,
			tlsName: host,
			expires: Date.now() + 36e5
		};
		return {
			host,
			port: 8448,
			hostHeader: host,
			tlsName: host,
			expires: Date.now() + 36e5
		};
	}
	async wellKnown(host) {
		try {
			const res = await this.raw({
				host,
				port: 443,
				hostHeader: host,
				tlsName: host,
				expires: 0
			}, "GET", "/.well-known/matrix/server", void 0, {}, 5e3);
			if (res.status !== 200) return null;
			const body = JSON.parse(res.body.toString("utf8"));
			return typeof body[M.SERVER] === "string" && body[M.SERVER] ? body[M.SERVER] : null;
		} catch {
			return null;
		}
	}
	async srv(host) {
		for (const name of [`_matrix-fed._tcp.${host}`, `_matrix._tcp.${host}`]) try {
			const records = await resolveSrv(name);
			if (records.length) {
				records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
				return {
					host: records[0].name,
					port: records[0].port
				};
			}
		} catch {}
		return null;
	}
	raw(target, method, pathWithQuery, body, headers, timeoutMs, poolKey = target.hostHeader) {
		try {
			checkLiteral(this.hs.addressPolicy, target.host);
		} catch (err) {
			return Promise.reject(err);
		}
		return new Promise((resolve, reject) => {
			let connectTimer = null;
			const req = request({
				host: target.host,
				port: target.port,
				method,
				path: pathWithQuery,
				servername: isIP(target.tlsName) ? void 0 : target.tlsName,
				agent: this.agentFor(poolKey),
				lookup: this.hs.addressPolicy.lookup,
				headers: {
					host: target.hostHeader,
					...headers,
					...body ? { "content-length": String(body.length) } : {}
				},
				timeout: timeoutMs
			}, (res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (c) => {
					size += c.length;
					if (size > 104857600) {
						req.destroy(/* @__PURE__ */ new Error("Response too large"));
						return;
					}
					chunks.push(c);
				});
				res.on("end", () => resolve({
					status: res.statusCode ?? 0,
					headers: res.headers,
					body: Buffer.concat(chunks)
				}));
				res.on("error", reject);
			});
			req.on("socket", (socket) => {
				if (socket.connecting) {
					connectTimer = setTimeout(() => req.destroy(/* @__PURE__ */ new Error("Connection timed out")), Math.min(5e3, timeoutMs));
					socket.once("connect", () => {
						if (connectTimer) clearTimeout(connectTimer);
					});
					socket.once("secureConnect", () => {
						if (connectTimer) clearTimeout(connectTimer);
					});
				}
			});
			req.on("timeout", () => req.destroy(/* @__PURE__ */ new Error("Federation request timed out")));
			req.on("error", (err) => {
				if (connectTimer) clearTimeout(connectTimer);
				reject(err);
			});
			req.on("close", () => {
				if (connectTimer) clearTimeout(connectTimer);
			});
			if (body) req.write(body);
			req.end();
		});
	}
	pathWithQuery(path, query) {
		const params = new URLSearchParams();
		for (const [k, v] of Object.entries(query ?? {})) {
			if (v === void 0) continue;
			for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
		}
		const qs = params.toString();
		return qs ? `${path}?${qs}` : path;
	}
	/** Send a request and return the raw response (used for media). */
	async requestRaw(destination, method, path, opts = {}) {
		if (destination === this.hs.serverName) throw new Error("Refusing to send a federation request to ourselves");
		const uri = this.pathWithQuery(path, opts.query);
		const body = opts.body === void 0 ? void 0 : Buffer.from(JSON.stringify(opts.body));
		const headers = { accept: "application/json" };
		if (body) headers["content-type"] = "application/json";
		if (opts.signed !== false) headers.authorization = this.authHeader(destination, method, uri, opts.body);
		const target = await this.resolve(destination);
		try {
			return await this.raw(target, method, uri, body, headers, opts.timeoutMs ?? 3e4, destination);
		} catch (err) {
			this.resetConnections(destination);
			throw err;
		}
	}
	/** Send a request and parse the JSON response; non-2xx responses throw a MatrixError. */
	async request(destination, method, path, opts = {}) {
		const res = await this.requestRaw(destination, method, path, opts);
		let json = {};
		try {
			json = res.body.length ? JSON.parse(res.body.toString("utf8")) : {};
		} catch {}
		if (res.status < 200 || res.status >= 300) throw new MatrixError(res.status === 404 ? 404 : res.status >= 500 ? 502 : res.status, typeof json.errcode === "string" ? json.errcode : "M_UNKNOWN", typeof json.error === "string" ? json.error : `Remote server returned ${res.status}`);
		return json;
	}
};
/** Parse an `Authorization: X-Matrix ...` header. */
function parseXMatrix(header) {
	const m = /^X-Matrix\s+(.*)$/i.exec(header.trim());
	if (!m) return null;
	const params = {};
	for (const part of m[1].matchAll(/([A-Za-z]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) params[part[1].toLowerCase()] = (part[2] ?? part[3] ?? "").replace(/\\(.)/g, "$1");
	if (!params.origin || !params.key || !params.sig) return null;
	return {
		origin: params.origin,
		destination: params.destination,
		key: params.key,
		sig: params.sig
	};
}
export { FederationClient, parseXMatrix };

//# sourceMappingURL=client.js.map