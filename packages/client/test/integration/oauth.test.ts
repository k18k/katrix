import { test } from "node:test";
import assert from "node:assert/strict";
import { getFetchHandler } from "@katrix/server";
import { CredentialsTokenProvider } from "../../src/auth/login.ts";
import {
  completeAuthorization,
  createAuthorizationRequest,
  getAuthMetadata,
  refreshOAuthToken,
  registerClient,
  type AuthorizationRequest,
} from "../../src/auth/oauth.ts";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import type { HttpAdapter } from "../../src/http/adapter.ts";
import { MatrixHttpApi } from "../../src/http/api.ts";
import { MatrixError } from "../../src/http/errors.ts";
import { homeserver } from "./helpers.ts";

// The OAuth 2.0 login of the client SDK against the homeserver's own OAuth server: discovery,
// client registration, the authorization code flow with PKCE, and refresh.

const ISSUER = "https://hs.example";
const REDIRECT_URI = "https://app.example/callback";
const CLIENT_METADATA = {
  client_name: "Test client",
  client_uri: "https://app.example/",
  redirect_uris: [REDIRECT_URI],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const p = nobleCryptoPrimitives();

type Handler = ReturnType<typeof getFetchHandler>;

/** The app's browser step: one cookie jar, redirects followed by hand. */
function browser(handler: Handler) {
  const jar = new Map<string, string>();
  async function request(opts: { method: string; url: string; form?: Record<string, string> }) {
    const headers = new Headers();
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (opts.form) headers.set("content-type", "application/x-www-form-urlencoded");
    const body = opts.form ? new URLSearchParams(opts.form) : undefined;
    const res = await handler(new Request(new URL(opts.url, ISSUER), { method: opts.method, headers, redirect: "manual", body }));
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const [name, ...value] = pair.split("=");
      jar.set(name, value.join("="));
    }
    return { status: res.status, location: res.headers.get("location") ?? "", text: await res.text() };
  }
  return {
    get: (url: string) => request({ method: "GET", url }),
    post: (opts: { url: string; form: Record<string, string> }) => request({ method: "POST", ...opts }),
  };
}

function csrf(html: string) {
  const match = /name="csrf" value="([^"]+)"/.exec(html);
  assert.ok(match, "the page has a CSRF field");
  return match[1];
}

/** A homeserver with its OAuth server on, the user alice, and this test's client registered. */
async function server() {
  const t = await homeserver({ publicBaseUrl: ISSUER, oauthServer: true });
  await t.hs.admin.createUser("alice", { password: "password" });
  const metadata = await getAuthMetadata(new MatrixHttpApi({ baseUrl: t.baseUrl, http: t.http }));
  const clientId = await registerClient(t.http, metadata, CLIENT_METADATA);
  const handler = getFetchHandler(t.hs);

  /** Open the authorization URL, log in as alice, decide on the consent page; returns the redirect back to the app. */
  async function authorize(opts: { url: string; decision: "allow" | "deny" }) {
    const b = browser(handler);
    const start = await b.get(opts.url);
    assert.equal(start.status, 302, start.text);
    const toLogin = await b.get(start.location);
    assert.equal(toLogin.status, 302, toLogin.text);
    const loginUrl = new URL(toLogin.location);
    const login = await b.get(toLogin.location);
    const loggedIn = await b.post({
      url: loginUrl.pathname,
      form: { csrf: csrf(login.text), next: loginUrl.searchParams.get("next") ?? "", username: "alice", password: "password" },
    });
    assert.equal(loggedIn.status, 303, loggedIn.text);
    const consent = await b.get(loggedIn.location);
    const decided = await b.post({ url: new URL(start.location).pathname, form: { csrf: csrf(consent.text), decision: opts.decision } });
    assert.equal(decided.status, 303, decided.text);
    return decided.location;
  }

  return {
    ...t,
    metadata,
    clientId,
    authorize,
    authorizationRequest: (opts: { deviceId?: string; responseMode?: "query" | "fragment" } = {}) =>
      createAuthorizationRequest(p, { metadata, clientId, redirectUri: REDIRECT_URI, ...opts }),
    complete: (opts: { request: AuthorizationRequest; callbackUrl: string }) =>
      completeAuthorization(t.http, { metadata, clientId, ...opts }),
    whoami: (accessToken: string) =>
      new MatrixHttpApi({ baseUrl: t.baseUrl, http: t.http, tokens: { accessToken: () => accessToken } }).endpoint(
        "GET /v3/account/whoami",
        {},
        {},
      ),
  };
}

/** An HTTP adapter that answers every request with the same response. */
function fixedHttp(response: { status: number; text: string }) {
  return {
    request: async () => ({
      status: response.status,
      header: () => undefined,
      text: async () => response.text,
      bytes: async () => new TextEncoder().encode(response.text),
    }),
  } satisfies HttpAdapter;
}

test("the authorization request carries PKCE, a fresh state and a device ID", async () => {
  const t = await server();
  try {
    const request = t.authorizationRequest();
    const other = t.authorizationRequest();
    assert.match(request.deviceId, /^[A-Z]{10}$/);
    assert.notEqual(request.state, other.state);
    assert.notEqual(request.codeVerifier, other.codeVerifier);
    assert.ok(request.url.startsWith(`${t.metadata.authorization_endpoint}?`));
    const query = new URL(request.url).searchParams;
    assert.equal(query.get("response_type"), "code");
    assert.equal(query.get("client_id"), t.clientId);
    assert.equal(query.get("redirect_uri"), REDIRECT_URI);
    assert.equal(query.get("scope"), `urn:matrix:client:api:* urn:matrix:client:device:${request.deviceId}`);
    assert.equal(query.get("state"), request.state);
    assert.equal(query.get("response_mode"), "fragment");
    assert.equal(query.get("code_challenge_method"), "S256");
    assert.equal(query.get("code_challenge"), Buffer.from(p.sha256(Buffer.from(request.codeVerifier))).toString("base64url"));
    assert.ok(!request.url.includes(request.codeVerifier), "the verifier stays with the client");

    const appended = createAuthorizationRequest(p, {
      metadata: { ...t.metadata, authorization_endpoint: `${ISSUER}/authorize?tenant=a` },
      clientId: t.clientId,
      redirectUri: REDIRECT_URI,
      deviceId: "DEVICEABCD",
    });
    assert.ok(appended.url.startsWith(`${ISSUER}/authorize?tenant=a&response_type=code&`));
    assert.equal(appended.deviceId, "DEVICEABCD");
  } finally {
    await t.close();
  }
});

test("the code flow logs in, and the refresh token gives a new access token", async () => {
  const t = await server();
  try {
    const request = t.authorizationRequest();
    const callbackUrl = await t.authorize({ url: request.url, decision: "allow" });
    assert.ok(callbackUrl.startsWith(`${REDIRECT_URI}#`), "the code comes back in the fragment");
    const before = Date.now();
    const tokens = await t.complete({ request, callbackUrl });
    assert.ok(tokens.refreshToken);
    assert.ok(tokens.expiresAt !== undefined && tokens.expiresAt > before);
    assert.deepEqual(await t.whoami(tokens.accessToken), { user_id: "@alice:localhost", device_id: request.deviceId, is_guest: false });

    // The same redirect a second time: the code is spent.
    const again = await t.complete({ request, callbackUrl }).catch((e: unknown) => e);
    assert.ok(again instanceof MatrixError);
    assert.equal(again.errcode, "invalid_grant");
    assert.ok(!again.message.includes(request.codeVerifier), "the error does not echo the request");
  } finally {
    await t.close();
  }
});

test("credentials with refresh.kind oauth refresh through the token endpoint", async () => {
  const t = await server();
  try {
    const request = t.authorizationRequest({ deviceId: "DEVICEABCD", responseMode: "query" });
    const callbackUrl = await t.authorize({ url: request.url, decision: "allow" });
    assert.ok(callbackUrl.startsWith(`${REDIRECT_URI}?`), "the code comes back in the query");
    const tokens = await t.complete({ request, callbackUrl });
    const saved: string[] = [];
    const provider = new CredentialsTokenProvider({
      credentials: {
        userId: "@alice:localhost",
        deviceId: request.deviceId,
        ...tokens,
        refresh: { kind: "oauth", tokenEndpoint: t.metadata.token_endpoint, clientId: t.clientId },
      },
      baseUrl: t.baseUrl,
      http: t.http,
      store: { onTokensRefreshed: (c) => void saved.push(c.accessToken) },
    });
    assert.equal(await provider.refresh(), true);
    const refreshed = provider.current();
    assert.notEqual(refreshed.accessToken, tokens.accessToken);
    assert.notEqual(refreshed.refreshToken, tokens.refreshToken);
    assert.deepEqual(saved, [refreshed.accessToken]);
    assert.equal((await t.whoami(refreshed.accessToken)).device_id, "DEVICEABCD");

    // A refresh token that is not valid is an OAuth error, and ends the provider's session.
    const invalid = await refreshOAuthToken(t.http, t.metadata.token_endpoint, t.clientId, "not-a-token").catch((e: unknown) => e);
    assert.ok(invalid instanceof MatrixError);
    assert.equal(invalid.errcode, "invalid_grant");
    const stale = new CredentialsTokenProvider({
      credentials: { ...refreshed, refreshToken: "not-a-token" },
      baseUrl: t.baseUrl,
      http: t.http,
    });
    assert.equal(await stale.refresh(), false);
  } finally {
    await t.close();
  }
});

test("a redirect that is not the answer to this login attempt is rejected before any request", async () => {
  const t = await server();
  try {
    const request = t.authorizationRequest();
    const http = fixedHttp({ status: 500, text: "" });
    const fail = (callbackUrl: string) =>
      completeAuthorization(http, { metadata: t.metadata, clientId: t.clientId, request, callbackUrl }).catch((e: unknown) => e);

    const forged = await fail(`${REDIRECT_URI}#state=someone-elses&code=abc`);
    assert.ok(forged instanceof Error && !(forged instanceof MatrixError));
    assert.match(forged.message, /state does not match/);

    const noCode = await fail(`${REDIRECT_URI}#state=${request.state}`);
    assert.ok(noCode instanceof Error && !(noCode instanceof MatrixError));
    assert.match(noCode.message, /no code/);

    const denied = await t
      .complete({ request, callbackUrl: await t.authorize({ url: request.url, decision: "deny" }) })
      .catch((e: unknown) => e);
    assert.ok(denied instanceof MatrixError);
    assert.equal(denied.errcode, "access_denied");
  } finally {
    await t.close();
  }
});

test("client registration reports the server's refusal as a MatrixError", async () => {
  const t = await server();
  try {
    assert.equal(await registerClient(t.http, t.metadata, CLIENT_METADATA), t.clientId, "identical metadata, one client ID");

    const refused = await registerClient(t.http, t.metadata, { ...CLIENT_METADATA, redirect_uris: ["https://evil.example/cb"] }).catch(
      (e: unknown) => e,
    );
    assert.ok(refused instanceof MatrixError);
    assert.equal(refused.errcode, "invalid_redirect_uri");

    await assert.rejects(
      registerClient(t.http, { ...t.metadata, registration_endpoint: undefined }, CLIENT_METADATA),
      /does not support dynamic client registration/,
    );
  } finally {
    await t.close();
  }
});

test("a response that is not a JSON object is an error with the status, for both endpoints (#127)", async () => {
  const t = await server();
  try {
    for (const response of [
      { status: 502, text: "<html>Bad gateway</html>" },
      { status: 200, text: "[]" },
      { status: 200, text: "{}" },
    ]) {
      const http = fixedHttp(response);
      const registered = await registerClient(http, t.metadata, CLIENT_METADATA).catch((e: unknown) => e);
      assert.ok(registered instanceof MatrixError, response.text);
      assert.equal(registered.status, response.status);
      assert.equal(registered.errcode, "M_UNKNOWN");
      const refreshed = await refreshOAuthToken(http, t.metadata.token_endpoint, t.clientId, "token").catch((e: unknown) => e);
      assert.ok(refreshed instanceof MatrixError, response.text);
      assert.equal(refreshed.status, response.status);
      assert.equal(refreshed.errcode, "M_UNKNOWN");
    }

    // The optional fields of a token response are only taken when they have the right type.
    const minimal = fixedHttp({ status: 200, text: JSON.stringify({ access_token: "a", refresh_token: 1, expires_in: "soon" }) });
    assert.deepEqual(await refreshOAuthToken(minimal, t.metadata.token_endpoint, t.clientId, "token"), {
      accessToken: "a",
      refreshToken: undefined,
      expiresAt: undefined,
    });
  } finally {
    await t.close();
  }
});
