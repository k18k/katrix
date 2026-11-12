import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeQr, encodeQr } from "../../src/e2ee/verification/qr.ts";
import { SAS_EMOJI, sasDecimals, sasEmoji } from "../../src/e2ee/verification/sas.ts";
import { fromHex } from "@katrix/shared";

// SAS and QR code formats (https://spec.matrix.org/v1.19/client-server-api/#sas-method-decimal,
// #sas-method-emoji, #qr-code-format), checked against an independent reading of the bits.

function bitsOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(2).padStart(8, "0")).join("");
}

test("SAS decimals: three 13-bit numbers plus 1000", () => {
  assert.deepEqual(sasDecimals(new Uint8Array(5)), [1000, 1000, 1000]);
  assert.deepEqual(sasDecimals(new Uint8Array(5).fill(0xff)), [9191, 9191, 9191]);
  for (let i = 0; i < 50; i++) {
    const b = Uint8Array.from({ length: 5 }, () => (Math.random() * 256) | 0);
    const bits = bitsOf(b);
    const expected = [0, 13, 26].map((o) => parseInt(bits.slice(o, o + 13), 2) + 1000);
    assert.deepEqual(sasDecimals(b), expected);
  }
});

test("SAS emoji: seven 6-bit indices into the spec's table", () => {
  assert.equal(SAS_EMOJI.length, 64);
  assert.deepEqual(SAS_EMOJI[0], ["🐶", "Dog"]);
  assert.deepEqual(SAS_EMOJI[63], ["📌", "Pin"]);
  for (let i = 0; i < 50; i++) {
    const b = Uint8Array.from({ length: 6 }, () => (Math.random() * 256) | 0);
    const bits = bitsOf(b);
    const expected = Array.from({ length: 7 }, (_, k) => SAS_EMOJI[parseInt(bits.slice(k * 6, k * 6 + 6), 2)][0]);
    assert.deepEqual(
      sasEmoji(b).map((e) => e.emoji),
      expected,
    );
  }
});

test("QR codes: the spec's example layout, round trip, and refusals", () => {
  const firstKey = Uint8Array.from({ length: 32 }, (_, i) => i);
  const secondKey = Uint8Array.from({ length: 32 }, (_, i) => 0x10 + i);
  const secret = fromHex("2021222324252627");
  const code = encodeQr({ mode: 0, transactionId: "$ABCD", firstKey, secondKey, secret });
  assert.deepEqual([...code.subarray(0, 10)], [0x4d, 0x41, 0x54, 0x52, 0x49, 0x58, 0x02, 0x00, 0x00, 0x05]);
  const back = decodeQr(code);
  assert.equal(back.transactionId, "$ABCD");
  assert.deepEqual(back.firstKey, firstKey);
  assert.deepEqual(back.secondKey, secondKey);
  assert.deepEqual(back.secret, secret);
  assert.throws(() => decodeQr(code.subarray(0, code.length - 2)), /too short/);
  const v1 = code.slice();
  v1[6] = 0x01;
  assert.throws(() => decodeQr(v1), /version/);
  assert.throws(() => decodeQr(new Uint8Array(80)), /Not a Matrix/);
});
