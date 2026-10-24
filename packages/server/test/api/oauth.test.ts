import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { localServer, testServer } from "../helpers.ts";
import { checkRedirectUri, OAuthError } from "#core/oauthserver.ts";
import type { HomeserverOptions } from "#index.ts";

// The OAuth 2.0 API served by the homeserver: a client registers, a browser logs in on the
// server's pages and consents, and the client exchanges the code.

const BASE = "https://hs.example";
const P = "/_synapse/client/oauth2";

async function server(options: Partial<HomeserverOptions> = {}) {
  return testServer({ publicBaseUrl: BASE, oauthServer: true, ...options });
}

type Server = Awaited<ReturnType<typeof server>>;

/** A browser with one cookie jar that does not follow redirects. */
function browser(t: Server) {
  const jar = new Map<string, string>();
  async function request(method: string, url: string, form?: Record<string, string>) {
    const headers = new Headers();
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    if (form) headers.set("content-type", "application/x-www-form-urlencoded");
    const res = await t.handler(
      new Request(new URL(url, BASE), { method, headers, redirect: "manual", body: form ? new URLSearchParams(form) : undefined }),
    );
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, ...v] = pair.split("=");
      jar.set(k, v.join("="));
    }
    const text = await res.text();
    return { status: res.status, location: res.headers.get("location"), text, headers: res.headers };
  }
  return {
    get: (url: string) => request("GET", url),
    post: (url: string, form: Record<string, string>) => request("POST", url, form),
    csrf: (html: string) => /name="csrf" value="([^"]+)"/.exec(html)![1],
  };
}

async function form(t: Server, path: string, body: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await t.handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body),
    }),
  );
  return { status: res.status, json: (await res.json()) as any, headers: res.headers };
}

async function registerClient(t: Server, metadata: Record<string, unknown> = {}) {
  const res = await t.call("POST", `${P}/register`, {
    body: {
      client_name: "Test client",
      client_uri: "https://app.example/",
      redirect_uris: ["https://app.example/callback"],
      grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...metadata,
    },
  });
  assert.equal(res.status, 201, res.text);
  return res.json.client_id as string;
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

/** Log in with a password and consent; returns the token response. */
async function codeFlow(t: Server, b: ReturnType<typeof browser>, clientId: string, opts: { deviceId?: string; scope?: string } = {}) {
  const { verifier, challenge } = pkce();
  const deviceId = opts.deviceId ?? "DEVICEABCD";
  const authorize = new URL(`${BASE}${P}/authorize`);
  for (const [k, v] of Object.entries({
    client_id: clientId,
    response_type: "code",
    response_mode: "fragment",
    redirect_uri: "https://app.example/callback",
    scope: opts.scope ?? `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`,
    state: "st4te",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }))
    authorize.searchParams.set(k, v);
  const start = await b.get(authorize.toString());
  assert.equal(start.status, 302, start.text);
  const consentUrl = start.location!;
  let consent = await b.get(consentUrl);
  if (consent.status === 302) {
    // Not logged in yet: the login page, then back to the consent page.
    const login = await b.get(consent.location!);
    assert.equal(login.status, 200);
    const next = new URL(consent.location!).searchParams.get("next")!;
    const done = await b.post(`${P}/login`, { csrf: b.csrf(login.text), next, username: "alice", password: "password" });
    assert.equal(done.status, 303, done.text);
    consent = await b.get(done.location!);
  }
  assert.equal(consent.status, 200);
  assert.match(consent.text, /Allow access\?/);
  assert.match(consent.text, /Test client/);
  const approved = await b.post(new URL(consentUrl).pathname, { csrf: b.csrf(consent.text), decision: "allow" });
  assert.equal(approved.status, 303);
  const callback = new URL(approved.location!);
  assert.equal(callback.origin + callback.pathname, "https://app.example/callback");
  const params = new URLSearchParams(callback.hash.slice(1));
  assert.equal(params.get("state"), "st4te");
  assert.equal(params.get("iss"), `${BASE}/`);
  const token = await form(t, `${P}/token`, {
    grant_type: "authorization_code",
    code: params.get("code")!,
    redirect_uri: "https://app.example/callback",
    client_id: clientId,
    code_verifier: verifier,
  });
  return { token, code: params.get("code")!, verifier };
}

test("server metadata advertises the spec's endpoints and values", async () => {
  const t = await server();
  try {
    const m = (await t.call("GET", "/_matrix/client/v1/auth_metadata")).json;
    assert.equal(m.issuer, `${BASE}/`);
    for (const k of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
      "device_authorization_endpoint",
    ])
      assert.ok(m[k].startsWith(`${BASE}${P}/`), k);
    assert.ok(m.grant_types_supported.includes("authorization_code") && m.grant_types_supported.includes("refresh_token"));
    assert.deepEqual(m.response_modes_supported, ["query", "fragment"]);
    assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(m.prompt_values_supported, ["create"]);
    assert.ok(m.account_management_actions_supported.includes("org.matrix.cross_signing_reset"));
    // #73: also at MSC2965's unstable paths, which clients use before spec v1.15 (Element X).
    assert.deepEqual((await t.call("GET", "/_matrix/client/unstable/org.matrix.msc2965/auth_metadata")).json, m);
    assert.equal((await t.call("GET", "/_matrix/client/unstable/org.matrix.msc2965/auth_issuer")).json.issuer, `${BASE}/`);
    // The legacy API stays, with SSO through the same pages.
    const flows = (await t.call("GET", "/_matrix/client/v3/login")).json.flows;
    assert.equal(flows.find((f: any) => f.type === "m.login.sso").oauth_aware_preferred, true);
  } finally {
    await t.close();
  }
});

test("redirect URIs are validated as the spec describes", () => {
  const ok = (uri: string, type: "web" | "native") => assert.doesNotThrow(() => checkRedirectUri(uri, type, "example.com"), uri);
  const bad = (uri: string, type: "web" | "native") => assert.throws(() => checkRedirectUri(uri, type, "example.com"), OAuthError, uri);
  ok("https://example.com/callback", "web");
  ok("https://app.example.com/callback", "web");
  ok("https://example.com:5173/?query=value", "web");
  bad("https://example.com/callback#fragment", "web");
  bad("http://example.com/callback", "web");
  bad("http://localhost/", "web");
  bad("https://app.com/callback", "web");
  for (const uri of [
    "com.example.app:/callback",
    "com.example:/",
    "com.example:callback",
    "http://localhost/callback",
    "http://127.0.0.1/callback",
    "http://[::1]/callback",
  ])
    ok(uri, "native");
  for (const uri of ["example:/callback", "com.example.app://callback", "https://localhost/callback", "http://localhost:1234/callback"])
    bad(uri, "native");
});

test("client registration requires an https client_uri and gives identical metadata one ID", async () => {
  const t = await server();
  try {
    const missing = await t.call("POST", `${P}/register`, { body: { redirect_uris: ["https://app.example/cb"] } });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error, "invalid_client_metadata");
    const badRedirect = await t.call("POST", `${P}/register`, {
      body: { client_uri: "https://app.example/", redirect_uris: ["https://evil.example/cb"] },
    });
    assert.equal(badRedirect.json.error, "invalid_redirect_uri");
    const a = await registerClient(t);
    const b = await registerClient(t);
    assert.equal(a, b);
    assert.notEqual(a, await registerClient(t, { client_name: "Other" }));
  } finally {
    await t.close();
  }
});

test("the authorization code flow logs in with a password and issues working tokens", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t);
    const b = browser(t);
    const { token, code, verifier } = await codeFlow(t, b, clientId);
    assert.equal(token.status, 200, JSON.stringify(token.json));
    assert.equal(token.headers.get("cache-control"), "no-store");
    assert.equal(token.json.token_type, "Bearer");
    assert.equal(token.json.expires_in, 300);
    assert.match(token.json.scope, /urn:matrix:client:device:DEVICEABCD/);
    const whoami = await t.call("GET", "/_matrix/client/v3/account/whoami", { token: token.json.access_token });
    assert.equal(whoami.json.user_id, "@alice:localhost");
    assert.equal(whoami.json.device_id, "DEVICEABCD");

    // A code works once; a second use revokes what it gave.
    const again = await form(t, `${P}/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      client_id: clientId,
      code_verifier: verifier,
    });
    assert.equal(again.json.error, "invalid_grant");
    assert.equal((await t.call("GET", "/_matrix/client/v3/account/whoami", { token: token.json.access_token })).status, 401);

    // Logged in already: the second login only asks for consent.
    const second = await codeFlow(t, b, clientId, { deviceId: "DEVICE2XYZ" });
    assert.equal(second.token.status, 200);
  } finally {
    await t.close();
  }
});

test("a wrong PKCE verifier or redirect URI gets no tokens", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t);
    const b = browser(t);
    // codeFlow exchanges the code itself, so start one by hand and break the verifier.
    const { challenge } = pkce();
    const start = await b.get(
      `${P}/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent("https://app.example/callback")}&scope=${encodeURIComponent(
        "urn:matrix:client:api:* urn:matrix:client:device:D1234567890",
      )}&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    const toLogin = await b.get(start.location!);
    const login = await b.get(toLogin.location!);
    const done = await b.post(`${P}/login`, {
      csrf: b.csrf(login.text),
      next: new URL(toLogin.location!).searchParams.get("next")!,
      username: "alice",
      password: "password",
    });
    const consent = await b.get(done.location!);
    const approved = await b.post(new URL(start.location!).pathname, { csrf: b.csrf(consent.text), decision: "allow" });
    const code = new URL(approved.location!).searchParams.get("code")!;
    const res = await form(t, `${P}/token`, {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://app.example/callback",
      client_id: clientId,
      code_verifier: pkce().verifier,
    });
    assert.equal(res.json.error, "invalid_grant");

    // An unregistered redirect URI is shown to the user, not redirected to.
    const evil = await b.get(
      `${P}/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent("https://evil.example/")}&scope=x&code_challenge=${challenge}&code_challenge_method=S256`,
    );
    assert.equal(evil.status, 400);
    assert.equal(evil.location, null);
    // Without PKCE, the error goes back to the client.
    const noPkce = await b.get(
      `${P}/authorize?client_id=${clientId}&response_type=code&state=s&redirect_uri=${encodeURIComponent("https://app.example/callback")}&scope=x`,
    );
    assert.equal(noPkce.status, 302);
    assert.equal(new URL(noPkce.location!).searchParams.get("error"), "invalid_request");
  } finally {
    await t.close();
  }
});

test("refresh tokens rotate, survive a lost response, and a reused one logs the device out", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t);
    const { token } = await codeFlow(t, browser(t), clientId);
    const refresh = (refresh_token: string) => form(t, `${P}/token`, { grant_type: "refresh_token", refresh_token, client_id: clientId });
    const lost = await refresh(token.json.refresh_token);
    assert.equal(lost.status, 200);
    // The response never arrived: the client retries with the same refresh token.
    const retry = await refresh(token.json.refresh_token);
    assert.equal(retry.status, 200);
    assert.equal((await t.call("GET", "/_matrix/client/v3/account/whoami", { token: lost.json.access_token })).status, 401);
    assert.equal((await t.call("GET", "/_matrix/client/v3/account/whoami", { token: retry.json.access_token })).status, 200);
    // The new token was used, so the first refresh token is spent; using it again means it leaked.
    const reused = await refresh(token.json.refresh_token);
    assert.equal(reused.json.error, "invalid_grant");
    assert.equal((await t.call("GET", "/_matrix/client/v3/account/whoami", { token: retry.json.access_token })).status, 401);
  } finally {
    await t.close();
  }
});

test("revoking a token logs the device out", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t);
    const { token } = await codeFlow(t, browser(t), clientId);
    assert.equal((await form(t, `${P}/revoke`, { token: token.json.refresh_token, client_id: clientId })).status, 200);
    assert.equal((await t.call("GET", "/_matrix/client/v3/account/whoami", { token: token.json.access_token })).status, 401);
    assert.equal((await form(t, `${P}/revoke`, { token: "unknown" })).status, 200);
  } finally {
    await t.close();
  }
});

test("the device authorization grant", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t, {
      grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
      redirect_uris: [],
    });
    const start = await form(t, `${P}/device`, {
      client_id: clientId,
      scope: "urn:matrix:client:api:* urn:matrix:client:device:CLIDEVICE1",
    });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    assert.match(start.json.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
    const poll = () =>
      form(t, `${P}/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: start.json.device_code,
        client_id: clientId,
      });
    assert.equal((await poll()).json.error, "authorization_pending");
    assert.equal((await poll()).json.error, "slow_down");

    const b = browser(t);
    const link = await b.get(start.json.verification_uri_complete);
    const login = await b.get(link.location!);
    const done = await b.post(`${P}/login`, {
      csrf: b.csrf(login.text),
      next: new URL(link.location!).searchParams.get("next")!,
      username: "alice",
      password: "password",
    });
    const consent = await b.get(done.location!);
    assert.match(consent.text, /CLIDEVICE1/);
    const code = /name="code" value="([^"]+)"/.exec(consent.text)![1];
    assert.equal((await b.post(`${P}/link`, { csrf: b.csrf(consent.text), code, decision: "allow" })).status, 200);
    const token = await poll();
    assert.equal(token.status, 200);
    const whoami = await t.call("GET", "/_matrix/client/v3/account/whoami", { token: token.json.access_token });
    assert.equal(whoami.json.device_id, "CLIDEVICE1");
  } finally {
    await t.close();
  }
});

test("pages refuse forms without the session's CSRF token, and cannot be framed", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const b = browser(t);
    const login = await b.get(`${P}/login`);
    assert.equal(login.headers.get("x-frame-options"), "DENY");
    assert.match(login.headers.get("set-cookie")!, /^__Host-oauth_session=.*HttpOnly; SameSite=Lax.*Secure/);
    const forged = await b.post(`${P}/login`, { csrf: "x".repeat(32), username: "alice", password: "password" });
    assert.equal(forged.status, 403);
    // #71: browsers send the page's own origin on its forms (Referrer-Policy same-origin; with
    // no-referrer Chrome sent "null"), and that origin is accepted.
    assert.equal(login.headers.get("referrer-policy"), "same-origin");
    const sameOrigin = await t.handler(
      new Request(`${BASE}${P}/login`, {
        method: "POST",
        headers: {
          origin: BASE,
          cookie: login.headers.getSetCookie()[0].split(";")[0],
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: b.csrf(login.text), username: "alice", password: "wrong" }),
      }),
    );
    assert.equal(sameOrigin.status, 401);
    const crossSite = await t.handler(
      new Request(`${BASE}${P}/login`, {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          cookie: login.headers.getSetCookie()[0].split(";")[0],
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ csrf: b.csrf(login.text), username: "alice", password: "password" }),
      }),
    );
    assert.equal(crossSite.status, 403);
    // `next` cannot leave the server's pages.
    const ok = await b.post(`${P}/login`, {
      csrf: b.csrf(login.text),
      next: "https://evil.example/",
      username: "alice",
      password: "password",
    });
    assert.equal(ok.location, `${BASE}${P}/account`);
  } finally {
    await t.close();
  }
});

test("m.oauth: a cross-signing reset needs the user's approval on the account page", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t);
    const b = browser(t);
    const { token } = await codeFlow(t, b, clientId);
    const at = token.json.access_token;
    const key = (k: string) => ({ user_id: "@alice:localhost", usage: ["master"], keys: { [`ed25519:${k}`]: k } });
    assert.equal(
      (await t.call("POST", "/_matrix/client/v3/keys/device_signing/upload", { token: at, body: { master_key: key("one") } })).status,
      200,
    );
    const replace = (session?: string) =>
      t.call("POST", "/_matrix/client/v3/keys/device_signing/upload", {
        token: at,
        body: { master_key: key("two"), ...(session ? { auth: { session } } : {}) },
      });
    const challenge = await replace();
    assert.equal(challenge.status, 401);
    assert.deepEqual(challenge.json.flows, [{ stages: ["m.oauth"] }, { stages: ["org.matrix.cross_signing_reset"] }]);
    assert.match(challenge.json.params["m.oauth"].url, /\/account\?action=org\.matrix\.cross_signing_reset$/);
    // Naming the stage is not enough (#65).
    const named = await t.call("POST", "/_matrix/client/v3/keys/device_signing/upload", {
      token: at,
      body: { master_key: key("two"), auth: { type: "m.oauth", session: challenge.json.session } },
    });
    assert.equal(named.status, 401);
    const account = await b.get(new URL(challenge.json.params["m.oauth"].url).pathname + "?action=org.matrix.cross_signing_reset");
    assert.match(account.text, /Reset your identity/);
    assert.equal((await b.post(`${P}/account`, { csrf: b.csrf(account.text), op: "cross_signing_reset" })).status, 303);
    assert.equal((await replace(challenge.json.session)).status, 200);
    // Other UIA endpoints send OAuth users to account management.
    const del = await t.call("POST", "/_matrix/client/v3/delete_devices", { token: at, body: { devices: ["DEVICEABCD"] } });
    assert.equal(del.status, 403);
    assert.match(del.json.account_management_uri, /\/account$/);
  } finally {
    await t.close();
  }
});

test("the account page signs out devices", async () => {
  const t = await server();
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const clientId = await registerClient(t);
    const b = browser(t);
    const { token } = await codeFlow(t, b, clientId);
    const account = await b.get(`${P}/account?action=org.matrix.device_delete&device_id=DEVICEABCD`);
    assert.match(account.text, /class="focus"/);
    await b.post(`${P}/account`, { csrf: b.csrf(account.text), op: "delete_device", device_id: "DEVICEABCD" });
    assert.equal((await t.call("GET", "/_matrix/client/v3/account/whoami", { token: token.json.access_token })).status, 401);
  } finally {
    await t.close();
  }
});

test("an upstream OAuth 2.0 provider without OIDC (like GitHub) logs users in on the pages", async () => {
  let issuedCode = "";
  const idp = await localServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      // Like GitHub: a bad code is a 200 with an error.
      return res.end(
        JSON.stringify(
          new URLSearchParams(body).get("code") === issuedCode
            ? { access_token: "gho_x", token_type: "bearer" }
            : { error: "bad_verification_code" },
        ),
      );
    }
    if (req.url === "/user") {
      assert.equal(req.headers["user-agent"], "katrix");
      return res.end(JSON.stringify({ id: 4242, login: "Octo-Cat", name: "The Octocat" }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  const t = await server({
    allowPrivateAddresses: true,
    sso: {
      providers: [
        {
          id: "gh",
          name: "GitHub",
          clientId: "client",
          clientSecret: "secret",
          endpoints: { authorization: `${idp.url}/authorize`, token: `${idp.url}/token`, userinfo: `${idp.url}/user` },
          subjectClaim: "id",
          mapUser: (c) => ({ localpart: String(c.login).toLowerCase(), displayname: c.name }),
        },
      ],
    },
    userAuthAdapter: { passwordLoginEnabled: false },
  });
  try {
    const b = browser(t);
    const login = await b.get(`${P}/login`);
    assert.doesNotMatch(login.text, /type="password"/);
    assert.match(login.text, /Continue with GitHub/);
    const up = await b.get(`${P}/upstream/gh?next=${encodeURIComponent(`${P}/account`)}`);
    const auth = new URL(up.location!);
    assert.equal(auth.origin, idp.url);
    assert.equal(auth.searchParams.get("scope"), null);
    issuedCode = "c0de";
    // Another browser cannot finish this login.
    const other = browser(t);
    await other.get(`${P}/login`);
    const stolen = await other.get(`/_matrix/client/v3/login/sso/callback/gh?state=${auth.searchParams.get("state")}&code=c0de`);
    assert.equal(stolen.status, 403);

    const up2 = await b.get(`${P}/upstream/gh?next=${encodeURIComponent(`${P}/account`)}`);
    const back = await b.get(
      `/_matrix/client/v3/login/sso/callback/gh?state=${new URL(up2.location!).searchParams.get("state")}&code=c0de`,
    );
    assert.equal(back.status, 302, back.text);
    const account = await b.get(back.location!);
    assert.match(account.text, /@octo-cat:localhost/);
    const row = await t.hs.db.findOne("sso_identities", [{ field: "user_id", value: "@octo-cat:localhost" }]);
    assert.equal(row!.subject, "4242");
  } finally {
    await t.close();
    await idp.close();
  }
});

test("legacy m.login.sso goes through the pages and hands the client a login token", async () => {
  const t = await server({ sso: { providers: [], clientAllowlist: ["https://app.example/"] } });
  try {
    await t.hs.admin.createUser("alice", { password: "password" });
    const b = browser(t);
    const start = await b.get(`/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent("https://app.example/#/login")}`);
    assert.equal(start.status, 302);
    const login = await b.get(start.location!);
    const done = await b.post(`${P}/login`, {
      csrf: b.csrf(login.text),
      next: new URL(start.location!).searchParams.get("next")!,
      username: "alice",
      password: "password",
    });
    const handoff = await b.get(done.location!);
    assert.equal(handoff.status, 302);
    const loginToken = new URL(handoff.location!).searchParams.get("loginToken")!;
    const res = await t.call("POST", "/_matrix/client/v3/login", { body: { type: "m.login.token", token: loginToken } });
    assert.equal(res.json.user_id, "@alice:localhost");
  } finally {
    await t.close();
  }
});

test("without the legacy API, /login answers M_UNRECOGNIZED", async () => {
  const t = await server({ oauthServer: { legacyApi: false } });
  try {
    const res = await t.call("GET", "/_matrix/client/v3/login");
    assert.equal(res.status, 404);
    assert.equal(res.json.errcode, "M_UNRECOGNIZED");
  } finally {
    await t.close();
  }
});

test("cleanup keeps refresh tokens whose access token expired long ago (#67)", async () => {
  const t = await testServer();
  try {
    await t.hs.admin.createUser("bob", { password: "password" });
    const login = await t.call("POST", "/_matrix/client/v3/login", {
      body: { type: "m.login.password", identifier: { type: "m.id.user", user: "bob" }, password: "password", refresh_token: true },
    });
    await t.hs.db.update("access_tokens", [{ field: "token", value: login.json.access_token }], {
      expires_ts: Date.now() - 30 * 24 * 3600_000,
    });
    await t.hs.cleanup();
    const refreshed = await t.call("POST", "/_matrix/client/v3/refresh", { body: { refresh_token: login.json.refresh_token } });
    assert.equal(refreshed.status, 200, refreshed.text);
  } finally {
    await t.close();
  }
});

test("undecodable Basic credentials at the token endpoint are an unknown client, not a server error (#76)", async () => {
  const t = await server();
  try {
    // "JQ==" is base64 for a lone "%", which is not a valid percent-escape.
    const res = await form(t, `${P}/token`, { grant_type: "authorization_code", code: "x" }, { authorization: "Basic JQ==" });
    assert.equal(res.status, 401);
    assert.equal(res.json.error, "invalid_client");
  } finally {
    await t.close();
  }
});
