import { MatrixError, errors } from "#core/errors.ts";
import { canonicalJson } from "#core/json.ts";
import type { Homeserver } from "#homeserver.ts";
import type { RequestContext } from "#http/router.ts";
import type { Session } from "#core/auth.ts";
import { UNSTABLE } from "#core/m.ts";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  // https://github.com/k18k/katrix/issues/86: the spec (v1.13, MSC4138) lists HEAD too.
  "access-control-allow-methods": "GET, HEAD, POST, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "X-Requested-With, Content-Type, Authorization",
};

/** JSON response with a canonical (sorted, compact) body, needed where clients verify signatures over the raw bytes. */
export function canonicalJsonResponse(body: unknown): Response {
  return new Response(canonicalJson(body), { status: 200, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS, ...headers },
  });
}

function withCors(res: Response): Response {
  // Some responses (e.g. Response.redirect) have immutable headers, so copy before adding CORS.
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers });
  for (const [k, v] of Object.entries(CORS_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

/** Default limit for a request body, and so for an upload, when the media adapter sets no `maxUploadSize`. */
const DEFAULT_MAX_BODY = 50 * 1024 * 1024;

/** The largest request body the server accepts. Uploads are the largest bodies, so it follows the media upload limit, like Synapse's. */
export const maxRequestBody = (hs: Homeserver) => hs.media.maxUploadSize ?? DEFAULT_MAX_BODY;

/**
 * Read a request body, refusing it as soon as it is known to be larger than `limit`.
 *
 * https://github.com/k18k/katrix/issues/77 — uncontrolled resource consumption (CWE-400, CWE-770):
 * bodies used to be read in full before any size check, so one oversized request could exhaust the server's memory.
 * The declared Content-Length is checked first and the bytes are counted as they arrive, so at most `limit` is held.
 * The reader is released rather than cancelled: cancelling a Node request stream destroys the socket, and the
 * client would get a reset instead of the 413.
 */
async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) throw errors.tooLarge("Request body too large");
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw errors.tooLarge("Request body too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export interface HandleOptions {
  ip?: string | null;
}

/** Turn a web-standard Request into a Response. */
export async function handleRequest(hs: Homeserver, request: Request, options: HandleOptions = {}): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(request.url);
  const started = performance.now();
  const response = await dispatch(hs, request, url, options);
  const info: Record<string, unknown> = {
    method: request.method,
    path: url.pathname,
    status: response.status,
    durationMs: performance.now() - started,
  };
  // Error responses carry their Matrix error (errcode and message) for logging.
  if (response.status >= 400 && response.headers.get("content-type") === "application/json" && hs.listenerCount("request") > 0) {
    info.error = await response
      .clone()
      .json()
      .catch(() => undefined);
  }
  hs.emit("request", info);
  return response;
}

async function dispatch(hs: Homeserver, request: Request, url: URL, options: HandleOptions): Promise<Response> {
  try {
    if (hs.isClosed) throw new MatrixError(503, "M_UNKNOWN", "Server is shutting down");
    await hs.ready;
    const matched = hs.router.match(request.method, url.pathname);
    if (matched === "method") throw new MatrixError(405, "M_UNRECOGNIZED", "Method not allowed");
    if (!matched) throw errors.unrecognized();

    let bodyBytes: Promise<Uint8Array> | null = null;
    const readBytes = () => (bodyBytes ??= readBody(request, maxRequestBody(hs)));
    let session: Promise<Session> | null = null;
    const token = () => extractToken(request, url);

    const ctx: RequestContext = {
      hs,
      request,
      url,
      method: request.method,
      params: matched.params,
      query: url.searchParams,
      ip: options.ip ?? null,
      bytes: readBytes,
      async json() {
        const bytes = await readBytes();
        if (bytes.length === 0) return {};
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw errors.notJson();
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw errors.badJson("Body must be a JSON object");
        return parsed as any;
      },
      accessToken: token,
      auth() {
        return (session ??= (async () => {
          const t = token();
          if (!t) throw errors.missingToken();
          // Application services authenticate with their as_token and may act as users in their namespace.
          const reg = hs.appservices.byToken(t);
          if (reg) {
            const userId = await hs.appservices.masquerade(reg, url.searchParams.get("user_id"));
            const deviceId = url.searchParams.get("device_id") ?? url.searchParams.get(UNSTABLE.ORG.MATRIX.MSC3202.DEVICE_ID);
            if (
              deviceId &&
              !(await hs.db.findOne("devices", [
                { field: "user_id", value: userId },
                { field: "device_id", value: deviceId },
              ]))
            ) {
              throw errors.forbidden("Unknown device for this user");
            }
            const user = await hs.db.findOne("users", [{ field: "user_id", value: userId }]);
            return { userId, deviceId: deviceId ?? "", accessToken: t, isGuest: false, isAdmin: !!user?.is_admin, appservice: reg };
          }
          const session = await hs.auth.authenticate(t, ctx.ip);
          if (session.locked && !/^\/_matrix\/client\/(?:r0|v3)\/logout(?:\/all)?$/.test(url.pathname)) throw errors.userLocked();
          return session;
        })());
      },
      async optionalAuth() {
        return token() ? ctx.auth() : null;
      },
      async rateLimit(action) {
        const s = token() ? await ctx.auth().catch(() => null) : null;
        if (s?.isAdmin || (s?.appservice && s.appservice.rate_limited === false)) return;
        await hs.rateLimits.check(action, s?.userId ?? ctx.ip ?? "unknown");
      },
    };

    const result = await matched.handler(ctx);
    if (result instanceof Response) return withCors(result);
    return jsonResponse(result ?? {});
  } catch (err) {
    if (err instanceof MatrixError) return jsonResponse(err.toJSON(), err.status);
    // A remote server we had to ask could not be reached (DNS, connection, TLS or timeout).
    if (isNetworkError(err)) {
      hs.logger.debug("Remote server unreachable", request.method, url.pathname, err);
      return jsonResponse({ errcode: "M_UNKNOWN", error: `Remote server unreachable: ${(err as Error).message}` }, 502);
    }
    hs.logger.error("Unhandled error", request.method, url.pathname, err);
    return jsonResponse({ errcode: "M_UNKNOWN", error: "Internal server error" }, 500);
  }
}

const NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
]);

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (code !== undefined && NETWORK_CODES.has(code)) || /^(Connection timed out|Federation request timed out)$/.test(err.message);
}

function extractToken(request: Request, url: URL): string | null {
  const header = request.headers.get("authorization");
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (m) return m[1].trim();
  }
  return url.searchParams.get("access_token");
}
