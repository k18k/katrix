import { test } from "node:test";
import assert from "node:assert/strict";
import { isCrossSigningKey, isDeviceKeys, isOneTimeKey, isSignatures } from "../src/index.ts";

const signatures = { "@alice:example.org": { "ed25519:DEV": "sig" } };

test("signatures are user → key ID → signature", () => {
  assert.equal(isSignatures(signatures), true);
  assert.equal(isSignatures({}), true);
  for (const value of [null, [], "sig", { "@alice:example.org": "sig" }, { "@alice:example.org": { "ed25519:DEV": 1 } }])
    assert.equal(isSignatures(value), false, JSON.stringify(value));
});

test("a one-time key is a string or a signed key object", () => {
  assert.equal(isOneTimeKey("key"), true);
  assert.equal(isOneTimeKey({ key: "key", signatures }), true);
  for (const value of [1, null, {}, { key: 1, signatures }, { key: "key" }, { key: "key", signatures: "sig" }])
    assert.equal(isOneTimeKey(value), false, JSON.stringify(value));
});

test("device keys need their IDs, algorithms, keys and signatures", () => {
  const keys = {
    user_id: "@alice:example.org",
    device_id: "DEV",
    algorithms: ["m.olm.v1.curve25519-aes-sha2"],
    keys: { "curve25519:DEV": "c", "ed25519:DEV": "e" },
    signatures,
  };
  assert.equal(isDeviceKeys(keys), true);
  assert.equal(isDeviceKeys({ ...keys, unsigned: { device_display_name: "Phone" } }), true);
  for (const broken of [
    { ...keys, user_id: 1 },
    { ...keys, device_id: undefined },
    { ...keys, algorithms: "m.olm.v1.curve25519-aes-sha2" },
    { ...keys, keys: { "ed25519:DEV": 1 } },
    { ...keys, signatures: undefined },
    { ...keys, unsigned: "Phone" },
  ])
    assert.equal(isDeviceKeys(broken), false, JSON.stringify(broken));
});

test("a cross-signing key needs its user, usage and keys; signatures are optional", () => {
  const key = { user_id: "@alice:example.org", usage: ["master"], keys: { "ed25519:abc": "abc" } };
  assert.equal(isCrossSigningKey(key), true);
  assert.equal(isCrossSigningKey({ ...key, signatures }), true);
  for (const broken of [
    { ...key, usage: "master" },
    { ...key, keys: [] },
    { ...key, signatures: [] },
    { ...key, user_id: null },
  ])
    assert.equal(isCrossSigningKey(broken), false, JSON.stringify(broken));
});
