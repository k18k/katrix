import { createHash } from "node:crypto";
import { MatrixError } from "#core/errors.ts";
import type { Homeserver } from "#homeserver.ts";

// Client for the Identity Service API (v2), used for 3PID invites and bindings. Identity servers
// are named by host (and optional port), as clients pass them in `id_server`.

const urlSafe = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export interface StoredInvite {
  token: string;
  public_keys: { public_key: string; key_validity_url: string }[];
  display_name: string;
}

export class IdentityServers {
  private readonly hs: Homeserver;

  constructor(hs: Homeserver) {
    this.hs = hs;
  }

  private base(idServer: string): string {
    if (!/^[A-Za-z0-9.-]+(:\d+)?$/.test(idServer)) throw new MatrixError(400, "M_INVALID_PARAM", "Invalid id_server");
    return `${this.hs.config.threepid.identityServerProtocol}://${idServer}`;
  }

  private async call(
    idServer: string,
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; signed?: boolean } = {},
  ): Promise<any> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    // Some endpoints (unbind) authenticate the homeserver like a federation request.
    if (opts.signed) headers.authorization = this.hs.federation.client.authHeader(idServer, method, path, opts.body);
    let res: Response;
    try {
      res = await this.hs.fetch(`${this.base(idServer)}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new MatrixError(502, "M_UNKNOWN", `Identity server ${idServer} unreachable: ${(err as Error).message}`);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new MatrixError(
        res.status >= 500 ? 502 : res.status,
        typeof json.errcode === "string" ? json.errcode : "M_UNKNOWN",
        typeof json.error === "string" ? json.error : `Identity server returned ${res.status}`,
      );
    }
    return json;
  }

  /** The Matrix user ID bound to a 3PID, if any. */
  async lookup(idServer: string, token: string, medium: string, address: string): Promise<string | null> {
    const details = await this.call(idServer, "GET", "/_matrix/identity/v2/hash_details", { token });
    const algorithms: string[] = Array.isArray(details.algorithms) ? details.algorithms : [];
    let query: string, algorithm: string;
    if (algorithms.includes("sha256") && typeof details.lookup_pepper === "string") {
      algorithm = "sha256";
      query = urlSafe(createHash("sha256").update(`${address} ${medium} ${details.lookup_pepper}`).digest());
    } else if (algorithms.includes("none")) {
      algorithm = "none";
      query = `${address} ${medium}`;
    } else {
      throw new MatrixError(400, "M_UNKNOWN", "The identity server supports no known lookup algorithm");
    }
    const res = await this.call(idServer, "POST", "/_matrix/identity/v2/lookup", {
      token,
      body: { addresses: [query], algorithm, pepper: details.lookup_pepper ?? "" },
    });
    const mxid = res.mappings?.[query];
    return typeof mxid === "string" ? mxid : null;
  }

  async storeInvite(idServer: string, token: string, invite: Record<string, unknown>): Promise<StoredInvite> {
    const res = await this.call(idServer, "POST", "/_matrix/identity/v2/store-invite", { token, body: invite });
    if (typeof res.token !== "string" || !Array.isArray(res.public_keys))
      throw new MatrixError(502, "M_UNKNOWN", "Invalid store-invite response");
    return res;
  }

  /** Returns the identity server's record of the binding (medium, address, mxid...). */
  async bind(idServer: string, token: string, sid: string, clientSecret: string, mxid: string): Promise<Record<string, any>> {
    return this.call(idServer, "POST", "/_matrix/identity/v2/3pid/bind", { token, body: { sid, client_secret: clientSecret, mxid } });
  }

  /** Remove a binding; resolves false when the identity server does not support unbinding. */
  async unbind(idServer: string, mxid: string, medium: string, address: string): Promise<boolean> {
    try {
      await this.call(idServer, "POST", "/_matrix/identity/v2/3pid/unbind", {
        signed: true,
        body: { mxid, threepid: { medium, address } },
      });
      return true;
    } catch (err) {
      if (err instanceof MatrixError && (err.status === 404 || err.status === 501 || err.errcode === "M_UNRECOGNIZED")) return false;
      throw err;
    }
  }
}
