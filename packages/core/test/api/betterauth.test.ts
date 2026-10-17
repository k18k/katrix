import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { toNodeHandler } from "better-auth/node";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { testServer } from "../helpers.ts";

// End to end: Better Auth runs as a separate OpenID Connect provider on a local port, and the
// homeserver's OAuth 2.0 API uses it as the upstream identity provider. A Matrix client registers,
// the user signs in at Better Auth, comes back, consents, and the client gets working tokens.

const BASE = "https://hs.example";
const P = "/_synapse/client/oauth2";

const TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "jwks",
  "oauthClient",
  "oauthClientAssertion",
  "oauthClientResource",
  "oauthResource",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
];

/** Better Auth on a random port, with one user and the homeserver registered as a client. */
async function betterAuthServer() {
  let handler: ReturnType<typeof toNodeHandler> = async () => {};
  const http = createServer((req, res) => handler(req, res)).listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const auth = betterAuth({
    baseURL: url,
    secret: randomBytes(32).toString("hex"),
    // The memory adapter needs every table up front.
    database: memoryAdapter(Object.fromEntries(TABLES.map((m) => [m, []]))),
    emailAndPassword: { enabled: true },
    disabledPaths: ["/token"],
    telemetry: { enabled: false },
    logger: { disabled: true },
    plugins: [
      jwt(),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/consent",
        silenceWarnings: { oauthAuthServerConfig: true, openidConfig: true },
      }),
    ],
  });
  handler = toNodeHandler(auth);
  const signUp = await auth.api.signUpEmail({
    body: { email: "alice@example.org", password: "correct horse battery", name: "Alice Example" },
    returnHeaders: true,
  });
  // Creating a client needs a signed-in user.
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const client = await auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie }),
    body: {
      redirect_uris: [`${BASE}/_matrix/client/v3/login/sso/callback/ba`],
      skip_consent: true,
      client_name: "Homeserver",
    },
  });
  return {
    url,
    issuer: `${url}/api/auth`,
    client,
    close: () => {
      http.closeAllConnections();
      return new Promise((resolve) => http.close(resolve));
    },
  };
}

/** A browser for the identity provider: real HTTP, its own cookies, no redirects followed. */
function idpBrowser() {
  const jar = new Map<string, string>();
  return async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const c of res.headers.getSetCookie()) {
      const [k, ...v] = c.split(";")[0].split("=");
      jar.set(k, v.join("="));
    }
    return res;
  };
}

test("e2e: OAuth 2.0 login through Better Auth as the upstream OpenID Connect provider", async () => {
  const idp = await betterAuthServer();
  const t = await testServer({
    publicBaseUrl: BASE,
    oauthServer: true,
    allowPrivateAddresses: true,
    userAuthAdapter: { passwordLoginEnabled: false },
    sso: {
      providers: [
        {
          id: "ba",
          name: "Better Auth",
          issuer: idp.issuer,
          clientId: idp.client.client_id,
          clientSecret: idp.client.client_secret,
          mapUser: (claims) => ({ localpart: String(claims.email).split("@")[0], displayname: claims.name }),
        },
      ],
    },
  });
  try {
    // The homeserver's browser session (cookies for hs.example).
    const jar = new Map<string, string>();
    const hs = async (method: string, url: string, form?: Record<string, string>) => {
      const headers = new Headers();
      if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
      if (form) headers.set("content-type", "application/x-www-form-urlencoded");
      const res = await t.handler(
        new Request(new URL(url, BASE), { method, headers, redirect: "manual", body: form && new URLSearchParams(form) }),
      );
      for (const c of res.headers.getSetCookie()) {
        const [k, ...v] = c.split(";")[0].split("=");
        jar.set(k, v.join("="));
      }
      return { status: res.status, location: res.headers.get("location"), text: await res.text() };
    };

    // 1. A Matrix client registers and starts the authorization code flow.
    const reg = await t.call("POST", `${P}/register`, {
      body: {
        client_uri: "https://app.example/",
        redirect_uris: ["https://app.example/cb"],
        grant_types: ["authorization_code", "refresh_token"],
      },
    });
    assert.equal(reg.status, 201, reg.text);
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URL(`${BASE}${P}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: reg.json.client_id,
      response_type: "code",
      redirect_uri: "https://app.example/cb",
      scope: "urn:matrix:client:api:* urn:matrix:client:device:BETTERAUTH1",
      state: "s",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const consentUrl = (await hs("GET", authorize.toString())).location!;
    const toLogin = await hs("GET", consentUrl);
    const login = await hs("GET", toLogin.location!);
    assert.match(login.text, /Continue with Better Auth/);
    const upstream = /href="([^"]*\/upstream\/ba[^"]*)"/.exec(login.text)![1].replaceAll("&amp;", "&");

    // 2. The login page sends the browser to Better Auth.
    const toIdp = await hs("GET", upstream);
    assert.equal(toIdp.status, 302);
    assert.ok(toIdp.location!.startsWith(`${idp.issuer}/oauth2/authorize`), toIdp.location!);

    // 3. The user signs in at Better Auth, which then redirects back with a code.
    const idpFetch = idpBrowser();
    const signIn = await idpFetch(`${idp.issuer}/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: idp.url },
      body: JSON.stringify({ email: "alice@example.org", password: "correct horse battery" }),
    });
    assert.equal(signIn.status, 200, await signIn.clone().text());
    const authorized = await idpFetch(toIdp.location!);
    // Better Auth answers a signed-in authorization with a redirect, or with its URL as JSON.
    const callback = authorized.headers.get("location") ?? ((await authorized.json()) as { url: string }).url;
    assert.ok(callback.startsWith(`${BASE}/_matrix/client/v3/login/sso/callback/ba?`), callback);

    // 4. Back at the homeserver: the browser is logged in and consents.
    const back = await hs("GET", callback);
    assert.equal(back.status, 302, back.text);
    const consent = await hs("GET", back.location!);
    assert.match(consent.text, /@alice:localhost/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)![1];
    const approved = await hs("POST", new URL(consentUrl).pathname, { csrf, decision: "allow" });
    const code = new URL(approved.location!).searchParams.get("code")!;

    // 5. The client exchanges the code and uses the API.
    const res = await t.handler(
      new Request(`${BASE}${P}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: "https://app.example/cb",
          client_id: reg.json.client_id,
          code_verifier: verifier,
        }),
      }),
    );
    const token = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(token));
    const whoami = await t.call("GET", "/_matrix/client/v3/account/whoami", { token: token.access_token });
    assert.equal(whoami.json.user_id, "@alice:localhost");
    assert.equal(whoami.json.device_id, "BETTERAUTH1");
    const profile = await t.call("GET", "/_matrix/client/v3/profile/@alice:localhost/displayname", { token: token.access_token });
    assert.equal(profile.json.displayname, "Alice Example");
  } finally {
    await t.close();
    await idp.close();
  }
});
