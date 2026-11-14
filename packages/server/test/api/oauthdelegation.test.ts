import { test } from "node:test";
import assert from "node:assert/strict";
import { localServer, testServer } from "../helpers.ts";

// Delegated authentication (the `oauth` option): access tokens of an external authorization
// server, checked by introspection.

const SCOPE = "urn:matrix:client:api:* urn:matrix:client:device:DEVICE1";

test("introspected tokens log users in only when the server says they are active", async () => {
  const answers = new Map<string, unknown>([
    ["good", { active: true, scope: SCOPE, username: "Carol", name: "Carol C" }],
    ["inactive", { active: false, scope: SCOPE, username: "carol" }],
    ["string-active", { active: "true", scope: SCOPE, username: "carol" }],
    ["no-scope", { active: true, scope: "openid", username: "carol" }],
    ["bad-name", { active: true, scope: SCOPE, username: 7, sub: "dave" }],
    ["array", [{ active: true }]],
  ]);
  const idp = await localServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/.well-known/openid-configuration") {
        res.end(JSON.stringify({ issuer: idp.url, introspection_endpoint: `${idp.url}/introspect` }));
        return;
      }
      res.end(JSON.stringify(answers.get(new URLSearchParams(body).get("token") ?? "") ?? { active: false }));
    });
  });
  const t = await testServer({
    oauth: { issuer: idp.url, clientId: "hs", clientSecret: "secret", accountManagementUrl: "https://account.example/" },
  });
  try {
    const whoami = (token: string) => t.call("GET", "/_matrix/client/v3/account/whoami", { token });
    const ok = await whoami("good");
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.user_id, ok.json.device_id], ["@carol:localhost", "DEVICE1"]);
    const profile = await t.call("GET", "/_matrix/client/v3/profile/@carol:localhost/displayname");
    assert.equal(profile.json.displayname, "Carol C");
    for (const token of ["inactive", "string-active", "no-scope", "array"]) {
      const res = await whoami(token);
      assert.equal(res.status, 401, token);
      assert.equal(res.json.errcode, "M_UNKNOWN_TOKEN", token);
    }
    const fallback = await whoami("bad-name");
    assert.equal(fallback.json.user_id, "@dave:localhost", "a username that is not a string falls back to sub");

    const metadata = await t.call("GET", "/_matrix/client/v1/auth_metadata");
    assert.equal(metadata.json.issuer, idp.url);
    assert.equal(metadata.json.account_management_uri, "https://account.example/");
  } finally {
    await t.close();
    await idp.close();
  }
});
