import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth, CredentialsTokenProvider } from "../../src/auth/login.ts";
import type { HttpAdapter, HttpRequest } from "../../src/http/adapter.ts";
import { MatrixHttpApi } from "../../src/http/api.ts";
import { ConnectionError, MatrixError } from "../../src/http/errors.ts";
import { newAbortController } from "../../src/platform.ts";

type Handler = (req: HttpRequest) => { status: number; body?: unknown; headers?: Record<string, string> } | Promise<never>;

function mockHttp(handler: Handler): HttpAdapter & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    async request(req) {
      requests.push(req);
      const res = await handler(req);
      const text = res.body === undefined ? "" : JSON.stringify(res.body);
      return {
        status: res.status,
        header: (n) => res.headers?.[n.toLowerCase()],
        text: async () => text,
        bytes: async () => new TextEncoder().encode(text),
      };
    },
  };
}

test("errors carry errcode and the server's message, not the request's secrets", async () => {
  const http = mockHttp(() => ({ status: 403, body: { errcode: "M_FORBIDDEN", error: "Invalid password" } }));
  const auth = new Auth({ baseUrl: "https://hs.example", http });
  const err = await auth.loginWithPassword("alice", "hunter2-secret").catch((e) => e);
  assert.ok(err instanceof MatrixError);
  assert.equal(err.errcode, "M_FORBIDDEN");
  assert.equal(err.status, 403);
  assert.equal(err.message, "POST /_matrix/client/v3/login: 403 M_FORBIDDEN: Invalid password");
  assert.ok(!JSON.stringify(err).includes("hunter2"), "the password is not in the error");
  assert.ok(!String(err.stack).includes("hunter2"));
  assert.equal(http.requests[0].url, "https://hs.example/_matrix/client/v3/login");
  assert.equal(JSON.parse(http.requests[0].body as string).identifier.user, "alice");
});

test("rate limits are waited out (retry_after_ms or Retry-After), then the request succeeds", async () => {
  let n = 0;
  const http = mockHttp(() =>
    ++n < 3
      ? {
          status: 429,
          body: n === 1 ? { errcode: "M_LIMIT_EXCEEDED", retry_after_ms: 20 } : {},
          headers: (n === 2 ? { "retry-after": "0" } : {}) as Record<string, string>,
        }
      : { status: 200, body: { ok: true } },
  );
  const api = new MatrixHttpApi({ baseUrl: "https://hs.example/", http, tokens: { accessToken: () => "tok" } });
  const t0 = Date.now();
  assert.deepEqual(await api.request("GET", "/v3/x"), { ok: true });
  assert.ok(Date.now() - t0 >= 15);
  assert.equal(n, 3);
  assert.equal(http.requests[0].headers.authorization, "Bearer tok");
  assert.equal(http.requests[0].url, "https://hs.example/_matrix/client/v3/x", "trailing slash of the base URL is dropped");
});

test("an expired token is refreshed once, concurrent requests share the refresh", async () => {
  let access = "old";
  let refreshes = 0;
  const http = mockHttp((req) => {
    if (req.url.endsWith("/v3/refresh")) {
      refreshes++;
      assert.equal(JSON.parse(req.body as string).refresh_token, "r1");
      access = "new";
      return { status: 200, body: { access_token: "new", refresh_token: "r2", expires_in_ms: 60000 } };
    }
    return req.headers.authorization === `Bearer ${access}` && access === "new"
      ? { status: 200, body: { ok: 1 } }
      : { status: 401, body: { errcode: "M_UNKNOWN_TOKEN", soft_logout: true } };
  });
  const refreshed: string[] = [];
  const tokens = new CredentialsTokenProvider({
    baseUrl: "https://hs.example",
    http,
    credentials: { userId: "@a:x", deviceId: "D", accessToken: "old", refreshToken: "r1", refresh: { kind: "matrix" } },
    store: { onTokensRefreshed: (c) => void refreshed.push(c.refreshToken!) },
  });
  const api = new MatrixHttpApi({ baseUrl: "https://hs.example", http, tokens });
  const results = await Promise.all([api.request("GET", "/v3/a"), api.request("GET", "/v3/b"), api.request("GET", "/v3/c")]);
  assert.deepEqual(results, [{ ok: 1 }, { ok: 1 }, { ok: 1 }]);
  assert.equal(refreshes, 1);
  assert.deepEqual(refreshed, ["r2"]);
  assert.equal(tokens.current().refreshToken, "r2");
});

test("without a refresh token, a 401 is the caller's", async () => {
  const http = mockHttp(() => ({ status: 401, body: { errcode: "M_UNKNOWN_TOKEN" } }));
  const tokens = new CredentialsTokenProvider({
    baseUrl: "https://hs.example",
    http,
    credentials: { userId: "@a:x", deviceId: "D", accessToken: "t" },
  });
  const err = await new MatrixHttpApi({ baseUrl: "https://hs.example", http, tokens }).request("GET", "/v3/a").catch((e) => e);
  assert.ok(err instanceof MatrixError && err.errcode === "M_UNKNOWN_TOKEN");
  assert.equal(http.requests.length, 1);
});

test("network failures and timeouts are ConnectionErrors; aborts are AbortErrors", async () => {
  const failing = mockHttp(() => Promise.reject(new TypeError("fetch failed: ECONNREFUSED secret-token")));
  const api = new MatrixHttpApi({ baseUrl: "https://hs.example", http: failing });
  const err = await api.request("GET", "/v3/a").catch((e) => e);
  assert.ok(err instanceof ConnectionError);
  assert.ok(!err.message.includes("secret-token"), "the underlying message is not copied");

  const hanging: HttpAdapter = {
    request: (req) =>
      new Promise((_, reject) =>
        req.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }),
      ),
  };
  const slow = new MatrixHttpApi({ baseUrl: "https://hs.example", http: hanging });
  assert.ok((await slow.request("GET", "/v3/a", { timeoutMs: 20 }).catch((e) => e)) instanceof ConnectionError);
  const c = newAbortController();
  const pending = slow.request("GET", "/v3/a", { signal: c.signal }).catch((e) => e);
  c.abort();
  assert.equal((await pending).name, "AbortError");
});

test("query parameters are encoded without URLSearchParams; path segments with path``", async () => {
  const http = mockHttp(() => ({ status: 200, body: {} }));
  const api = new MatrixHttpApi({ baseUrl: "https://hs.example", http });
  const { path } = await import("../../src/util/query.ts");
  await api.request("GET", path`/v3/rooms/${"!a b/c:x"}/messages`, {
    query: { dir: "b", from: "t&1", limit: 5, skip: undefined, via: ["a.org", "b.org"] },
  });
  assert.equal(
    http.requests[0].url,
    "https://hs.example/_matrix/client/v3/rooms/!a%20b%2Fc%3Ax/messages?dir=b&from=t%261&limit=5&via=a.org&via=b.org",
  );
});
