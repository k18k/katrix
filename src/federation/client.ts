import { resolveSrv } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { MatrixError } from "../core/errors.ts";
import { canonicalJson } from "../core/json.ts";
import { unpaddedBase64 } from "../core/crypto.ts";
import { sign } from "node:crypto";
import type { Homeserver } from "../homeserver.ts";

interface Resolved {
  /** Host to connect to (IP or hostname). */
  host: string;
  port: number;
  /** Value for the Host header and TLS SNI/certificate name. */
  hostHeader: string;
  tlsName: string;
  expires: number;
}

export interface FederationRequestOptions {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  /** Sign the request with X-Matrix auth. Default: true. */
  signed?: boolean;
  timeoutMs?: number;
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

function splitHostPort(name: string): { host: string; port: number | null } {
  const ipv6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(name);
  if (ipv6) return { host: ipv6[1], port: ipv6[2] ? Number(ipv6[2]) : null };
  const idx = name.lastIndexOf(":");
  if (idx > 0 && /^\d+$/.test(name.slice(idx + 1))) return { host: name.slice(0, idx), port: Number(name.slice(idx + 1)) };
  return { host: name, port: null };
}

/** Signs and sends server-server requests, implementing Matrix server discovery. */
export class FederationClient {
  private hs: Homeserver;
  private resolved = new Map<string, Resolved>();
  /** One connection pool per destination, so a dead peer's sockets can be dropped without affecting others. */
  private agents = new Map<string, Agent>();
  private rejectUnauthorized: boolean;

  constructor(hs: Homeserver, opts: { rejectUnauthorized?: boolean } = {}) {
    this.hs = hs;
    this.rejectUnauthorized = opts.rejectUnauthorized ?? true;
  }

  private agentFor(key: string): Agent {
    let agent = this.agents.get(key);
    if (!agent) {
      agent = new Agent({ keepAlive: true, maxSockets: 16, rejectUnauthorized: this.rejectUnauthorized });
      this.agents.set(key, agent);
    }
    return agent;
  }

  /** Drop pooled connections to a destination (after errors, the peer may have restarted). */
  resetConnections(destination: string): void {
    const agent = this.agents.get(destination);
    if (agent) { agent.destroy(); this.agents.delete(destination); }
    this.resolved.delete(destination);
  }

  /** Build the X-Matrix Authorization header value for a request. */
  authHeader(destination: string, method: string, uri: string, content?: unknown): string {
    const key = this.hs.signingKey;
    const toSign: Record<string, unknown> = { method, uri, origin: this.hs.serverName, destination };
    if (content !== undefined) toSign.content = content;
    const sig = unpaddedBase64(sign(null, Buffer.from(canonicalJson(toSign)), key.privateKey));
    return `X-Matrix origin="${this.hs.serverName}",destination="${destination}",key="ed25519:${key.keyId}",sig="${sig}"`;
  }

  async resolve(serverName: string): Promise<Resolved> {
    const cached = this.resolved.get(serverName);
    if (cached && cached.expires > Date.now()) return cached;
    const r = await this.discover(serverName);
    this.resolved.set(serverName, r);
    return r;
  }

  private async discover(serverName: string): Promise<Resolved> {
    const day = Date.now() + 24 * 3600_000;
    const { host, port } = splitHostPort(serverName);
    // 1/2. IP literals and explicit ports are used as-is.
    if (isIP(host)) return { host, port: port ?? 8448, hostHeader: serverName, tlsName: host, expires: day };
    if (port !== null) return { host, port, hostHeader: serverName, tlsName: host, expires: day };
    // 3. .well-known delegation.
    const delegated = await this.wellKnown(host);
    if (delegated) {
      const d = splitHostPort(delegated);
      if (isIP(d.host)) return { host: d.host, port: d.port ?? 8448, hostHeader: delegated, tlsName: d.host, expires: day };
      if (d.port !== null) return { host: d.host, port: d.port, hostHeader: delegated, tlsName: d.host, expires: day };
      const srv = await this.srv(d.host);
      if (srv) return { ...srv, hostHeader: d.host, tlsName: d.host, expires: day };
      return { host: d.host, port: 8448, hostHeader: d.host, tlsName: d.host, expires: day };
    }
    // 4. SRV records, 5. default port.
    const srv = await this.srv(host);
    if (srv) return { ...srv, hostHeader: host, tlsName: host, expires: Date.now() + 3600_000 };
    return { host, port: 8448, hostHeader: host, tlsName: host, expires: Date.now() + 3600_000 };
  }

  private async wellKnown(host: string): Promise<string | null> {
    try {
      const res = await this.raw({ host, port: 443, hostHeader: host, tlsName: host, expires: 0 }, "GET", "/.well-known/matrix/server", undefined, {}, 5000);
      if (res.status !== 200) return null;
      const body = JSON.parse(res.body.toString("utf8"));
      return typeof body["m.server"] === "string" && body["m.server"] ? body["m.server"] : null;
    } catch {
      return null;
    }
  }

  private async srv(host: string): Promise<{ host: string; port: number } | null> {
    for (const name of [`_matrix-fed._tcp.${host}`, `_matrix._tcp.${host}`]) {
      try {
        const records = await resolveSrv(name);
        if (records.length) {
          records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
          return { host: records[0].name, port: records[0].port };
        }
      } catch { /* no record */ }
    }
    return null;
  }

  private raw(
    target: Resolved, method: string, pathWithQuery: string, body: Buffer | undefined,
    headers: Record<string, string>, timeoutMs: number, poolKey = target.hostHeader,
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      const req = httpsRequest({
        host: target.host,
        port: target.port,
        method,
        path: pathWithQuery,
        servername: isIP(target.tlsName) ? undefined : target.tlsName,
        agent: this.agentFor(poolKey),
        headers: { host: target.hostHeader, ...headers, ...(body ? { "content-length": String(body.length) } : {}) },
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 100 * 1024 * 1024) { req.destroy(new Error("Response too large")); return; }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      });
      req.on("socket", (socket) => {
        // Fail fast when the peer is unreachable, independently of the response timeout.
        if ((socket as any).connecting) {
          connectTimer = setTimeout(() => req.destroy(new Error("Connection timed out")), Math.min(5_000, timeoutMs));
          socket.once("connect", () => { if (connectTimer) clearTimeout(connectTimer); });
          socket.once("secureConnect", () => { if (connectTimer) clearTimeout(connectTimer); });
        }
      });
      req.on("timeout", () => req.destroy(new Error("Federation request timed out")));
      req.on("error", (err) => { if (connectTimer) clearTimeout(connectTimer); reject(err); });
      req.on("close", () => { if (connectTimer) clearTimeout(connectTimer); });
      if (body) req.write(body);
      req.end();
    });
  }

  private pathWithQuery(path: string, query?: FederationRequestOptions["query"]): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      for (const item of Array.isArray(v) ? v : [v]) params.append(k, item);
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  }

  /** Send a request and return the raw response (used for media). */
  async requestRaw(destination: string, method: string, path: string, opts: FederationRequestOptions = {}): Promise<RawResponse> {
    if (destination === this.hs.serverName) throw new Error("Refusing to send a federation request to ourselves");
    const uri = this.pathWithQuery(path, opts.query);
    const body = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body));
    const headers: Record<string, string> = { accept: "application/json" };
    if (body) headers["content-type"] = "application/json";
    if (opts.signed !== false) headers.authorization = this.authHeader(destination, method, uri, opts.body);
    const target = await this.resolve(destination);
    try {
      return await this.raw(target, method, uri, body, headers, opts.timeoutMs ?? 30_000, destination);
    } catch (err) {
      this.resetConnections(destination);
      throw err;
    }
  }

  /** Send a request and parse the JSON response; non-2xx responses throw a MatrixError. */
  async request(destination: string, method: string, path: string, opts: FederationRequestOptions = {}): Promise<any> {
    const res = await this.requestRaw(destination, method, path, opts);
    let json: any = {};
    try { json = res.body.length ? JSON.parse(res.body.toString("utf8")) : {}; } catch { /* non-JSON */ }
    if (res.status < 200 || res.status >= 300) {
      throw new MatrixError(res.status === 404 ? 404 : res.status >= 500 ? 502 : res.status,
        typeof json.errcode === "string" ? json.errcode : "M_UNKNOWN",
        typeof json.error === "string" ? json.error : `Remote server returned ${res.status}`);
    }
    return json;
  }
}

/** Parse an `Authorization: X-Matrix ...` header. */
export function parseXMatrix(header: string): { origin: string; destination?: string; key: string; sig: string } | null {
  const m = /^X-Matrix\s+(.*)$/i.exec(header.trim());
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const part of m[1].matchAll(/([A-Za-z]+)=(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) {
    params[part[1].toLowerCase()] = (part[2] ?? part[3] ?? "").replace(/\\(.)/g, "$1");
  }
  if (!params.origin || !params.key || !params.sig) return null;
  return { origin: params.origin, destination: params.destination, key: params.key, sig: params.sig };
}
