import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "#core/json.ts";
import { loadSigningKey, signJson, verifyJsonSignature, publicKeyFromBase64 } from "#core/crypto.ts";

// Test vectors from the Matrix specification, appendix "Signing JSON".
const key = loadSigningKey("1", "YJDBA9Xnr2sVqXD9Vj7XVUnmFZcZrlw8Md7kMW+3XA1");

test("canonical JSON sorts keys and drops whitespace", () => {
  assert.equal(canonicalJson({ b: "2", a: "1" }), '{"a":"1","b":"2"}');
  assert.equal(canonicalJson({ one: 1, two: "Two" }), '{"one":1,"two":"Two"}');
  assert.equal(
    canonicalJson({
      auth: {
        success: true,
        mxid: "@john.doe:example.com",
        profile: { display_name: "John Doe", three_pids: [{ medium: "email", address: "john.doe@example.org" }] },
      },
    }),
    '{"auth":{"mxid":"@john.doe:example.com","profile":{"display_name":"John Doe","three_pids":[{"address":"john.doe@example.org","medium":"email"}]},"success":true}}',
  );
  assert.equal(canonicalJson({ a: "日本語" }), '{"a":"日本語"}');
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
  assert.throws(() => canonicalJson({ a: 1.5 }));
});

test("canonical JSON orders keys by Unicode code point", () => {
  // U+FF01 sorts before U+1F600 by code point, but after it by UTF-16 code unit.
  assert.equal(canonicalJson({ "\u{1F600}": 1, "！": 2 }), '{"！":2,"\u{1F600}":1}');
});

test("signatures match the specification's examples", () => {
  assert.deepEqual(signJson<Record<string, any>>({}, "domain", key).signatures, {
    domain: { "ed25519:1": "K8280/U9SSy9IVtjBuVeLr+HpOB4BQFWbg+UZaADMtTdGYI7Geitb76LTrr5QV/7Xg4ahLwYGYZzuHGZKM5ZAQ" },
  });
  assert.deepEqual(signJson<Record<string, any>>({ one: 1, two: "Two" }, "domain", key).signatures, {
    domain: { "ed25519:1": "KqmLSbO39/Bzb0QIYE82zqLwsA+PDzYIpIRA2sRQ4sL53+sN6/fpNSoqE7BP7vBZhG6kYdD13EIMJpvhJI+6Bw" },
  });
});

test("signatures verify, and fail once the object changes", () => {
  const signed = signJson({ hello: "world", unsigned: { age: 1 } }, "domain", key);
  const pub = publicKeyFromBase64(key.publicKeyBase64);
  assert.equal(verifyJsonSignature(signed, "domain", "ed25519:1", pub), true);
  assert.equal(verifyJsonSignature({ ...signed, hello: "there" }, "domain", "ed25519:1", pub), false);
});
