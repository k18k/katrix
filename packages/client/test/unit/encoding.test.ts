import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { canonicalJson, decodeBase64, decodeUtf8, encodeBase64, encodeUtf8, signingJson } from "@katrix/shared";

const ascii = (s: string) => encodeUtf8(s);

test("unpadded Base64: the spec's test vectors (appendices, Unpadded Base64)", () => {
  const vectors: Array<[string, string]> = [
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ];
  for (const [plain, encoded] of vectors) {
    assert.equal(encodeBase64(ascii(plain)), encoded);
    assert.equal(decodeUtf8(decodeBase64(encoded)), plain);
  }
});

test("Base64 decoding accepts padding and the URL-safe alphabet, refuses anything else", () => {
  assert.deepEqual(decodeBase64("Zm8="), ascii("fo"));
  assert.deepEqual(decodeBase64("Zg=="), ascii("f"));
  assert.deepEqual(decodeBase64("-_8"), decodeBase64("+/8"));
  assert.equal(encodeBase64(Uint8Array.of(0xfb, 0xff), { urlSafe: true }), "-_8");
  assert.equal(encodeBase64(Uint8Array.of(0xfb), { pad: true }), "+w==");
  for (const bad of ["Z", "Zm9v!", "Zm 9v", "Zm9v\n", "Zé", "Zg="]) assert.throws(() => decodeBase64(bad), /Invalid Base64/, bad);
  const random = nobleCryptoPrimitives().randomBytes(1000);
  assert.deepEqual(decodeBase64(encodeBase64(random)), random);
});

test("UTF-8: round trips, and strict decoding of invalid sequences", () => {
  for (const s of ["", "ascii", "zażółć gęślą jaźń", "日本語", "🦀 emoji 👩‍👩‍👧", "\u0000\u007f\u0080߿ࠀ￿"]) {
    assert.equal(decodeUtf8(encodeUtf8(s)), s);
    assert.deepEqual(encodeUtf8(s), new Uint8Array(Buffer.from(s, "utf8")));
  }
  assert.deepEqual(encodeUtf8("\ud800"), Uint8Array.of(0xef, 0xbf, 0xbd), "a lone surrogate becomes U+FFFD");
  for (const bad of [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe2, 0x82], [0x80], [0xff]]) {
    assert.throws(() => decodeUtf8(Uint8Array.from(bad)), /Invalid UTF-8/, JSON.stringify(bad));
  }
  const long = "ą".repeat(10_000);
  assert.equal(decodeUtf8(encodeUtf8(long)), long);
});

test("canonical JSON: the spec's examples (appendices, Canonical JSON)", () => {
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson({ one: 1, two: "Two" }), '{"one":1,"two":"Two"}');
  assert.equal(canonicalJson({ b: "2", a: "1" }), '{"a":"1","b":"2"}');
  assert.equal(
    canonicalJson({
      auth: {
        success: true,
        mxid: "@john.doe:example.com",
        profile: {
          display_name: "John Doe",
          three_pids: [
            { medium: "email", address: "john.doe@example.org" },
            { medium: "msisdn", address: "123456789" },
          ],
        },
      },
    }),
    '{"auth":{"mxid":"@john.doe:example.com","profile":{"display_name":"John Doe","three_pids":[{"address":"john.doe@example.org","medium":"email"},{"address":"123456789","medium":"msisdn"}]},"success":true}}',
  );
  assert.equal(canonicalJson({ a: "日本語" }), '{"a":"日本語"}');
  assert.equal(canonicalJson({ 本: 2, 日: 1 }), '{"日":1,"本":2}');
  assert.equal(canonicalJson({ a: "日" }), '{"a":"日"}');
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
  assert.equal(canonicalJson({ a: -0, b: 1e10 }), '{"a":0,"b":10000000000}');
});

test("canonical JSON sorts by code point, refuses non-integers and big numbers", () => {
  // U+1F600 (surrogates D83D…) sorts after U+FF5E by code point, before it by UTF-16 unit.
  assert.equal(canonicalJson({ "\u{1F600}": 1, "～": 2 }), '{"～":2,"😀":1}');
  assert.equal(canonicalJson({ a: '\u0001\n"\\' }), '{"a":"\\u0001\\n\\"\\\\"}');
  assert.throws(() => canonicalJson({ a: 1.5 }), /safe integers/);
  assert.throws(() => canonicalJson({ a: 2 ** 53 }), /safe integers/);
  assert.throws(() => canonicalJson({ a: NaN }), /safe integers/);
  assert.throws(() => canonicalJson({ a: () => 1 }), /cannot encode/);
  assert.equal(signingJson({ b: 1, signatures: { x: {} }, unsigned: { y: 1 }, a: [1, { d: 1, c: 2 }] }), '{"a":[1,{"c":2,"d":1}],"b":1}');
});

test("JSON signing: the spec's test vectors (appendices, Cryptographic test vectors)", () => {
  const p = nobleCryptoPrimitives();
  const seed = decodeBase64("YJDBA9Xnr2sVqXD9Vj7XVUnmFZcZrlw8Md7kMW+3XA1");
  const sign = (obj: Record<string, unknown>) => encodeBase64(p.ed25519Sign(seed, ascii(signingJson(obj))));
  assert.equal(sign({}), "K8280/U9SSy9IVtjBuVeLr+HpOB4BQFWbg+UZaADMtTdGYI7Geitb76LTrr5QV/7Xg4ahLwYGYZzuHGZKM5ZAQ");
  assert.equal(sign({ one: 1, two: "Two" }), "KqmLSbO39/Bzb0QIYE82zqLwsA+PDzYIpIRA2sRQ4sL53+sN6/fpNSoqE7BP7vBZhG6kYdD13EIMJpvhJI+6Bw");
  // Existing signatures and unsigned data are not covered.
  assert.equal(
    sign({ one: 1, two: "Two", signatures: { other: { "ed25519:x": "y" } }, unsigned: { age: 5 } }),
    sign({ one: 1, two: "Two" }),
  );
});
