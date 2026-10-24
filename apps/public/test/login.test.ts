import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { startDevIdp } from "@katrix/dev-idp";
import { loadConfig } from "../src/config.ts";
import { pgConnectionString, startPublicServer } from "../src/server.ts";

// The public app end to end, as it runs locally: the development identity provider (Better Auth)
// is the only login, and a Matrix client goes through the OAuth 2.0 API to a working token.

const PUBLIC = "https://matrix.test";
const P = "/_synapse/client/oauth2";

test("config: one login provider is required, GitHub or the dev provider", () => {
  assert.throws(() => loadConfig({ SERVER_NAME: "matrix.test" }), /GITHUB_CLIENT_ID/);
  const github = loadConfig({ SERVER_NAME: "matrix.test", GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
  assert.equal(github.provider.id, "github");
  assert.equal(github.publicBaseUrl, "https://matrix.test");
  assert.throws(() => loadConfig({ SERVER_NAME: "matrix.test", GITHUB_CLIENT_ID: "id" }), /GITHUB_CLIENT_SECRET/);
});

test("Postgres URLs: libpq's sslrootcert=system is dropped, the rest kept", () => {
  assert.equal(
    pgConnectionString("postgresql://u:p%40ss@host.psdb.cloud:5432/db?sslmode=verify-full&sslrootcert=system"),
    "postgresql://u:p%40ss@host.psdb.cloud:5432/db?sslmode=verify-full",
  );
  assert.equal(pgConnectionString("postgres://u@h/db?sslrootcert=/etc/ca.pem"), "postgres://u@h/db?sslrootcert=/etc/ca.pem");
});

test("e2e: sign in through the dev provider by picking a user", async () => {
  const dataDir = mkdtempSync(`${tmpdir()}/public-app-`);
  const idp = await startDevIdp({ redirectUris: [`${PUBLIC}/_matrix/client/v3/login/sso/callback/dev`] });
  const app = await startPublicServer(
    loadConfig({
      SERVER_NAME: "matrix.test",
      PUBLIC_BASE_URL: PUBLIC,
      PORT: "0",
      DATA_DIR: dataDir,
      DEV_IDP_ISSUER: idp.issuer,
      DEV_IDP_CLIENT_ID: idp.clientId,
      DEV_IDP_CLIENT_SECRET: idp.clientSecret,
      ADMINS: "@alice:matrix.test",
    }),
  );
  // The dev provider is on a loopback address.
  const local = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    // A browser: requests to the public URL go to the local port; one cookie jar per host.
    const jars = new Map<string, Map<string, string>>();
    const browse = async (url: string, init: { method?: string; form?: Record<string, string> } = {}) => {
      const target = new URL(url.startsWith(PUBLIC) ? local + url.slice(PUBLIC.length) : url, local);
      const jar = jars.get(target.host) ?? new Map<string, string>();
      jars.set(target.host, jar);
      const headers: Record<string, string> = { accept: "text/html" };
      if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
      const body = init.form ? new URLSearchParams(init.form).toString() : undefined;
      if (body) headers["content-type"] = "application/x-www-form-urlencoded";
      // node:http rather than fetch: fetch sends `sec-fetch-mode: cors`, and Better Auth then answers
      // with JSON instead of the redirect that a browser's navigation gets.
      const res = await new Promise<IncomingMessage & { text: string }>((resolve, reject) => {
        const req = request(target, { method: init.method ?? (body ? "POST" : "GET"), headers }, (r) => {
          let text = "";
          r.setEncoding("utf8");
          r.on("data", (c) => (text += c));
          r.on("end", () => resolve(Object.assign(r, { text })));
        });
        req.on("error", reject);
        req.end(body);
      });
      for (const c of res.headers["set-cookie"] ?? []) {
        const [k, ...v] = c.split(";")[0].split("=");
        jar.set(k, v.join("="));
      }
      // Relative redirects (Better Auth sends them) are resolved against the page that sent them.
      const location = res.headers.location ? new URL(res.headers.location, target).toString() : null;
      return { status: res.statusCode!, location, text: res.text };
    };

    assert.match((await browse(`${PUBLIC}/`)).text, /v0 · test server/);
    // No passwords: the legacy API offers only SSO.
    const flows = JSON.parse((await browse(`${PUBLIC}/_matrix/client/v3/login`)).text).flows.map((f: { type: string }) => f.type);
    assert.deepEqual(flows, ["m.login.sso", "m.login.token"]);

    const reg = await fetch(`${local}${P}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_uri: "https://app.example/",
        redirect_uris: ["https://app.example/cb"],
        grant_types: ["authorization_code", "refresh_token"],
      }),
    });
    const clientId = ((await reg.json()) as { client_id: string }).client_id;
    const verifier = randomBytes(32).toString("base64url");
    const authorize = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: "https://app.example/cb",
      scope: "urn:matrix:client:api:* urn:matrix:client:device:PUBLICAPP1",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const consentUrl = (await browse(`${PUBLIC}${P}/authorize?${authorize}`)).location!;
    const login = await browse((await browse(consentUrl)).location!);
    assert.doesNotMatch(login.text, /type="password"/);
    const upstream = /href="([^"]*\/upstream\/dev[^"]*)"/.exec(login.text)![1].replaceAll("&amp;", "&");

    // At the dev provider: its picker, then Alice.
    const toIdp = await browse(upstream);
    const picker = await browse((await browse(toIdp.location!)).location!);
    assert.match(picker.text, /Pick who you are/);
    const oauthQuery = /name="oauth_query" value="([^"]*)"/
      .exec(picker.text)![1]
      .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)));
    const picked = await browse(`${idp.baseUrl}/pick`, { form: { email: "alice@dev.localhost", oauth_query: oauthQuery } });
    assert.ok(picked.location!.startsWith(`${PUBLIC}/_matrix/client/v3/login/sso/callback/dev?`), picked.location!);

    // Back at the homeserver: consent, code, token.
    const back = await browse(picked.location!);
    const consent = await browse(back.location!);
    assert.match(consent.text, /@alice:matrix\.test/);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.text)![1];
    const approved = await browse(consentUrl, { form: { csrf, decision: "allow" } });
    const code = new URL(approved.location!).searchParams.get("code")!;
    const token = await fetch(`${local}${P}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://app.example/cb",
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const { access_token } = (await token.json()) as { access_token: string };
    const whoami = (await (
      await fetch(`${local}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${access_token}` } })
    ).json()) as {
      user_id: string;
    };
    assert.equal(whoami.user_id, "@alice:matrix.test");
    assert.ok((await app.hs.admin.getUser("@alice:matrix.test"))?.is_admin);
  } finally {
    await app.close();
    await idp.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
