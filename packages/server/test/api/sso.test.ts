import { test } from "node:test";
import assert from "node:assert/strict";
import { localServer, testServer } from "../helpers.ts";

// https://github.com/k18k/katrix/issues/19: an SSO login against a local OpenID
// Connect provider that issues unsigned ID tokens straight from its token endpoint.
async function provider(opts: { idToken?: boolean; issuer?: string } = {}) {
  let nonce = "";
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const srv = await localServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/.well-known/openid-configuration")
      return res.end(
        JSON.stringify({
          issuer: opts.issuer ?? srv.url,
          authorization_endpoint: `${srv.url}/authorize`,
          token_endpoint: `${srv.url}/token`,
        }),
      );
    if (req.url === "/token") {
      const claims = { iss: srv.url, aud: "client", sub: "subject-1", nonce, exp: Date.now() / 1000 + 60, preferred_username: "alice" };
      return res.end(
        JSON.stringify(
          opts.idToken === false ? { access_token: "at" } : { access_token: "at", id_token: `${enc({ alg: "none" })}.${enc(claims)}.` },
        ),
      );
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { srv, setNonce: (n: string) => (nonce = n) };
}

async function login(clientAllowlist: string[] | undefined, redirectUrl: string, opts: { idToken?: boolean; issuer?: string } = {}) {
  const idp = await provider(opts);
  const t = await testServer({
    publicBaseUrl: "https://hs.example",
    sso: { providers: [{ id: "idp", name: "IdP", issuer: idp.srv.url, clientId: "client" }], clientAllowlist },
  });
  try {
    const start = await t.call("GET", `/_matrix/client/v3/login/sso/redirect?redirectUrl=${encodeURIComponent(redirectUrl)}`);
    if (start.status !== 302) return start;
    const auth = new URL(start.headers.get("location")!);
    idp.setNonce(auth.searchParams.get("nonce")!);
    return await t.call("GET", `/_matrix/client/v3/login/sso/callback/idp?state=${auth.searchParams.get("state")}&code=c`);
  } finally {
    await t.close();
    await idp.srv.close();
  }
}

test("an unknown client gets a confirmation page that cannot be framed", async () => {
  const res = await login(undefined, "https://client.example/app");
  assert.equal(res.status, 200);
  assert.match(res.text, /Continue to client\.example\?/);
  assert.match(res.text, /href="https:\/\/client\.example\/app\?loginToken=/);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.match(res.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
});

test("an allowlisted client is redirected with the token; a lookalike host is not", async () => {
  const ok = await login(["https://app.element.io/"], "https://app.element.io/#/login");
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("location")!, /^https:\/\/app\.element\.io\/\?loginToken=/);
  const lookalike = await login(["https://app.element.io"], "https://app.element.io.evil.example/");
  assert.equal(lookalike.status, 200);
  const app = await login(["im.vector.app:"], "im.vector.app://login");
  assert.equal(app.status, 302);
});

test("script and data URLs are refused as redirect targets", async () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x"])
    assert.equal((await login(undefined, url)).json.errcode, "M_MISSING_PARAM");
});

test("an ID token is required with the openid scope, and the issuer must match", async () => {
  const missing = await login(undefined, "https://client.example/", { idToken: false });
  assert.equal(missing.status, 403);
  const other = await login(undefined, "https://client.example/", { issuer: "https://other.example" });
  assert.equal(other.status, 500);
});
