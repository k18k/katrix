import { test } from "node:test";
import assert from "node:assert/strict";
import { nobleCryptoPrimitives } from "../../src/crypto/noble.ts";
import { nativeE2EEProtocol } from "../../src/protocol/native.ts";
import { decodeUtf8, encodeUtf8 } from "@katrix/shared";

// Runs only under test/env/hermes.ts (npm run test:hermes).

test("the simulated Hermes environment is active", () => {
  const g = globalThis as Record<string, unknown>;
  assert.equal(g.__HERMES_SIMULATION__, true, "run with --import ./test/env/hermes.ts");
  for (const name of ["TextDecoder", "WebAssembly", "Buffer", "structuredClone", "atob", "btoa", "URL", "URLSearchParams"])
    assert.equal(g[name], undefined, name);
  assert.equal((globalThis.crypto as { subtle?: unknown }).subtle, undefined);
  assert.equal(typeof globalThis.crypto.getRandomValues, "function");
});

test("Olm and Megolm work without TextDecoder, WebAssembly, WebCrypto and Buffer", () => {
  const protocol = nativeE2EEProtocol(nobleCryptoPrimitives());
  const alice = protocol.newAccount();
  const bob = protocol.newAccount();
  bob.generateOneTimeKeys(1);
  const a = alice.createOutboundSession(bob.identityKeys().curve25519, Object.values(bob.oneTimeKeys())[0]);
  const { session: b, plaintext } = bob.createInboundSession(alice.identityKeys().curve25519, a.encrypt(encodeUtf8("cześć 👋")));
  assert.equal(decodeUtf8(plaintext), "cześć 👋");
  assert.equal(decodeUtf8(a.decrypt(b.encrypt(encodeUtf8("hej")))), "hej");
  const out = protocol.newOutboundGroupSession();
  const inbound = protocol.inboundGroupSessionFromSessionKey(out.sessionKey());
  assert.equal(decodeUtf8(inbound.decrypt(out.encrypt(encodeUtf8("grupa"))).plaintext), "grupa");
});

test("without a random source, the primitives refuse to start", () => {
  const saved = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    assert.throws(() => nobleCryptoPrimitives(), /react-native-get-random-values/);
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: saved, configurable: true, writable: true });
  }
});
