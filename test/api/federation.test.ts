import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { testServer } from "../helpers.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

test("federation is off by default", async () => {
  const t = await testServer();
  try {
    const res = await t.call("GET", "/_matrix/federation/v1/version");
    assert.equal(res.json.errcode, "M_UNRECOGNIZED");
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/matrix-nodejs-homeserver/issues/16
test("the federation version is the package's", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    const res = await t.call("GET", "/_matrix/federation/v1/version");
    assert.deepEqual(res.json, { server: { name: pkg.name, version: pkg.version } });
  } finally {
    await t.close();
  }
});

// https://github.com/k18k/matrix-nodejs-homeserver/issues/22
test("federation requests do not reach private addresses unless allowed", async () => {
  const t = await testServer({ federation: { enabled: true } });
  try {
    await assert.rejects(t.hs.federation.client.requestRaw("127.0.0.1:1", "GET", "/x"), { errcode: "M_FORBIDDEN" });
    await assert.rejects(t.hs.federation.client.requestRaw("localhost:1", "GET", "/x"), /private address/);
  } finally {
    await t.close();
  }
});
