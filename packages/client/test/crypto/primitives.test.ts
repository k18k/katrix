import { test } from "node:test";
import assert from "node:assert/strict";
import * as nodeCrypto from "node:crypto";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { fromHex, toHex } from "../../src/util/bytes.ts";
import { encodeUtf8 } from "../../src/util/utf8.ts";

// Every primitive against its standard's official test vectors, then against Node.js's OpenSSL
// as an independent implementation on random inputs, then on inputs it must refuse.

const p = nobleCryptoPrimitives();
const h = fromHex;
const ascii = (s: string) => encodeUtf8(s);

test("SHA-256: FIPS 180-2 examples", () => {
  assert.equal(toHex(p.sha256(ascii(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(toHex(p.sha256(ascii("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    toHex(p.sha256(ascii("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("HMAC-SHA-256: RFC 4231 test cases 1, 2 and 6", () => {
  assert.equal(
    toHex(p.hmacSha256(new Uint8Array(20).fill(0x0b), ascii("Hi There"))),
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
  assert.equal(
    toHex(p.hmacSha256(ascii("Jefe"), ascii("what do ya want for nothing?"))),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
  assert.equal(
    toHex(p.hmacSha256(new Uint8Array(131).fill(0xaa), ascii("Test Using Larger Than Block-Size Key - Hash Key First"))),
    "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
  );
});

test("HKDF-SHA-256: RFC 5869 test cases 1 and 3", () => {
  const ikm = new Uint8Array(22).fill(0x0b);
  assert.equal(
    toHex(p.hkdfSha256(ikm, h("000102030405060708090a0b0c"), h("f0f1f2f3f4f5f6f7f8f9"), 42)),
    "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
  );
  // No salt and no info: the case Olm ("OLM_ROOT" aside) and Megolm use, salt = HashLen zeros.
  assert.equal(
    toHex(p.hkdfSha256(ikm, undefined, new Uint8Array(0), 42)),
    "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
  );
  assert.equal(
    toHex(p.hkdfSha256(ikm, new Uint8Array(0), new Uint8Array(0), 42)),
    toHex(p.hkdfSha256(ikm, new Uint8Array(32), new Uint8Array(0), 42)),
  );
});

test("X25519: RFC 7748 §5.2 and the §6.1 key exchange", () => {
  assert.equal(
    toHex(
      p.x25519SharedSecret(
        h("a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4"),
        h("e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c"),
      ),
    ),
    "c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552",
  );
  const alice = h("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const bob = h("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
  assert.equal(toHex(p.x25519PublicKey(alice)), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(toHex(p.x25519PublicKey(bob)), "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
  const shared = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
  assert.equal(toHex(p.x25519SharedSecret(alice, p.x25519PublicKey(bob))), shared);
  assert.equal(toHex(p.x25519SharedSecret(bob, p.x25519PublicKey(alice))), shared);
});

test("X25519 refuses low-order public keys and wrong lengths", () => {
  const secret = p.randomBytes(32);
  // The all-zero point and the point of order 8 give an all-zero shared secret.
  for (const bad of [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  ]) {
    assert.throws(() => p.x25519SharedSecret(secret, h(bad)), /Invalid X25519 public key/);
  }
  assert.throws(() => p.x25519SharedSecret(secret, new Uint8Array(31)), /32 bytes/);
});

test("Ed25519: RFC 8032 §7.1 tests 1–3", () => {
  const vectors = [
    [
      "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
      "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
      "",
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    ],
    [
      "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
      "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
      "72",
      "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00",
    ],
    [
      "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
      "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
      "af82",
      "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a",
    ],
  ];
  for (const [seed, pub, msg, sig] of vectors) {
    assert.equal(toHex(p.ed25519PublicKey(h(seed))), pub);
    assert.equal(toHex(p.ed25519Sign(h(seed), h(msg))), sig);
    assert.ok(p.ed25519Verify(h(pub), h(msg), h(sig)));
  }
});

test("Ed25519 rejects forged, altered and non-canonical signatures", () => {
  const seed = h("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
  const pub = p.ed25519PublicKey(seed);
  const msg = ascii("message");
  const sig = p.ed25519Sign(seed, msg);
  assert.ok(p.ed25519Verify(pub, msg, sig));
  assert.ok(!p.ed25519Verify(pub, ascii("messagf"), sig), "other message");
  for (let i = 0; i < 64; i += 7) {
    const bad = sig.slice();
    bad[i] ^= 1;
    assert.ok(!p.ed25519Verify(pub, msg, bad), `bit flip at ${i}`);
  }
  assert.ok(!p.ed25519Verify(p.ed25519PublicKey(p.randomBytes(32)), msg, sig), "other key");
  // S + L: the same signature with a non-reduced scalar. RFC 8032 verification must reject it
  // (otherwise signatures are malleable).
  const L = (1n << 252n) + 27742317777372353535851937790883648493n;
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
  const s2 = s + L;
  const malleated = sig.slice();
  for (let i = 0; i < 32; i++) malleated[32 + i] = Number((s2 >> BigInt(8 * i)) & 0xffn);
  assert.ok(!p.ed25519Verify(pub, msg, malleated), "S >= L");
  assert.ok(!p.ed25519Verify(pub, msg, sig.subarray(0, 63)), "short signature");
  assert.ok(!p.ed25519Verify(new Uint8Array(32), msg, sig), "zero key");
});

const AES_KEY = h("603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4");
const AES_PLAIN = h(
  "6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710",
);

test("AES-256-CBC: NIST SP 800-38A F.2.5 (then the PKCS#7 padding block)", () => {
  const iv = h("000102030405060708090a0b0c0d0e0f");
  const ct = p.aes256CbcEncrypt(AES_KEY, iv, AES_PLAIN);
  assert.equal(ct.length, 80);
  assert.equal(
    toHex(ct.subarray(0, 64)),
    "f58c4c04d6e5f1ba779eabfb5f7bfbd69cfc4e967edb808d679f777bc6702c7d39f23369a9d9bacfa530e26304231461b2eb05e2c39be9fcda6c19078c6a9d1b",
  );
  assert.deepEqual(p.aes256CbcDecrypt(AES_KEY, iv, ct), AES_PLAIN);
});

test("AES-256-CTR: NIST SP 800-38A F.5.5", () => {
  const iv = h("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff");
  const ct = p.aes256Ctr(AES_KEY, iv, AES_PLAIN);
  assert.equal(
    toHex(ct),
    "601ec313775789a5b7a7f504bbf3d228f443e3ca4d62b59aca84e990cacaf5c52b0930daa23de94ce87017ba2d84988ddfc9c58db67aada613c2dd08457941a6",
  );
  assert.deepEqual(p.aes256Ctr(AES_KEY, iv, ct), AES_PLAIN);
});

test("AES-256-CBC refuses bad padding, bad lengths and wrong keys", () => {
  // Fixed inputs: with random ones, a flipped last byte could still form valid padding (1/256).
  const key = AES_KEY;
  const iv = h("000102030405060708090a0b0c0d0e0f");
  const ct = p.aes256CbcEncrypt(key, iv, ascii("sixteen byte msg plus"));
  assert.throws(() => p.aes256CbcDecrypt(key, iv, ct.subarray(0, ct.length - 1)), /length/);
  assert.throws(() => p.aes256CbcDecrypt(key, iv, new Uint8Array(0)), /length/);
  const tampered = ct.slice();
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => p.aes256CbcDecrypt(key, iv, tampered), /padding/);
  assert.throws(() => p.aes256CbcEncrypt(key.subarray(0, 16), iv, ct), /32 bytes/);
  assert.throws(() => p.aes256CbcEncrypt(key, iv.subarray(0, 8), ct), /16 bytes/);
});

test("differential: the primitives agree with OpenSSL (node:crypto) on random inputs", () => {
  for (let n = 0; n < 50; n++) {
    const data = p.randomBytes(n * 13);
    const key = p.randomBytes(32);
    const iv = p.randomBytes(16);
    assert.equal(toHex(p.sha256(data)), nodeCrypto.createHash("sha256").update(data).digest("hex"));
    assert.equal(toHex(p.hmacSha256(key, data)), nodeCrypto.createHmac("sha256", key).update(data).digest("hex"));
    const info = p.randomBytes(n % 20);
    const salt = n % 3 === 0 ? undefined : p.randomBytes(n % 40);
    assert.equal(
      toHex(p.hkdfSha256(data, salt, info, 80)),
      Buffer.from(nodeCrypto.hkdfSync("sha256", data, salt ?? new Uint8Array(0), info, 80)).toString("hex"),
    );
    const cbc = nodeCrypto.createCipheriv("aes-256-cbc", key, iv);
    assert.equal(toHex(p.aes256CbcEncrypt(key, iv, data)), Buffer.concat([cbc.update(data), cbc.final()]).toString("hex"));
    const ctr = nodeCrypto.createCipheriv("aes-256-ctr", key, iv);
    assert.equal(toHex(p.aes256Ctr(key, iv, data)), Buffer.concat([ctr.update(data), ctr.final()]).toString("hex"));
  }
  // X25519 and Ed25519 through node:crypto's KeyObject API.
  for (let n = 0; n < 10; n++) {
    const a = nodeCrypto.generateKeyPairSync("x25519");
    const b = p.x25519GenerateKeyPair();
    const aRaw = a.privateKey.export({ format: "jwk" }).d!;
    const aSecret = Buffer.from(aRaw, "base64url");
    const bPub = nodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: Buffer.from(b.publicKey).toString("base64url") },
      format: "jwk",
    });
    const viaNode = nodeCrypto.diffieHellman({ privateKey: a.privateKey, publicKey: bPub });
    assert.equal(toHex(p.x25519SharedSecret(aSecret, b.publicKey)), viaNode.toString("hex"));

    const e = p.ed25519GenerateKeyPair();
    const msg = p.randomBytes(n * 10);
    const sk = nodeCrypto.createPrivateKey({
      key: {
        kty: "OKP",
        crv: "Ed25519",
        d: Buffer.from(e.secretKey).toString("base64url"),
        x: Buffer.from(e.publicKey).toString("base64url"),
      },
      format: "jwk",
    });
    assert.equal(toHex(p.ed25519Sign(e.secretKey, msg)), nodeCrypto.sign(null, msg, sk).toString("hex"));
  }
});

test("randomness comes from the given source, in getRandomValues-sized chunks", () => {
  const calls: number[] = [];
  const rp = nobleCryptoPrimitives({
    randomValues: (a) => {
      calls.push(a.length);
      nodeCrypto.getRandomValues(a as Uint8Array<ArrayBuffer>);
      return a;
    },
  });
  assert.equal(rp.randomBytes(70000).length, 70000);
  assert.deepEqual(calls, [65536, 4464]);
  // Two draws differ.
  assert.notEqual(toHex(p.randomBytes(32)), toHex(p.randomBytes(32)));
});
