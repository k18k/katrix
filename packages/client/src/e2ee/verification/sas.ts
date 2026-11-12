import type { CryptoPrimitives } from "../../crypto/primitives.ts";
import { canonicalJson, encodeBase64, encodeUtf8 } from "@katrix/shared";

// SAS verification's derivations (https://spec.matrix.org/v1.19/client-server-api/#short-authentication-string-sas-verification),
// for key_agreement_protocol curve25519-hkdf-sha256, hash sha256 and MAC hkdf-hmac-sha256.v2. The
// deprecated curve25519 and hkdf-hmac-sha256 (wrong base64) are neither offered nor accepted.

export const SAS_METHOD = "m.sas.v1";
export const KEY_AGREEMENT = "curve25519-hkdf-sha256";
export const HASH = "sha256";
export const MAC_METHOD = "hkdf-hmac-sha256.v2";
export const SAS_TYPES = ["decimal", "emoji"] as const;

/** The 64 SAS emoji and their English names, from the spec's data-definitions/sas-emoji.json. */
export const SAS_EMOJI: ReadonlyArray<readonly [emoji: string, description: string]> = [
  ["🐶", "Dog"],
  ["🐱", "Cat"],
  ["🦁", "Lion"],
  ["🐎", "Horse"],
  ["🦄", "Unicorn"],
  ["🐷", "Pig"],
  ["🐘", "Elephant"],
  ["🐰", "Rabbit"],
  ["🐼", "Panda"],
  ["🐓", "Rooster"],
  ["🐧", "Penguin"],
  ["🐢", "Turtle"],
  ["🐟", "Fish"],
  ["🐙", "Octopus"],
  ["🦋", "Butterfly"],
  ["🌷", "Flower"],
  ["🌳", "Tree"],
  ["🌵", "Cactus"],
  ["🍄", "Mushroom"],
  ["🌏", "Globe"],
  ["🌙", "Moon"],
  ["☁️", "Cloud"],
  ["🔥", "Fire"],
  ["🍌", "Banana"],
  ["🍎", "Apple"],
  ["🍓", "Strawberry"],
  ["🌽", "Corn"],
  ["🍕", "Pizza"],
  ["🎂", "Cake"],
  ["❤️", "Heart"],
  ["😀", "Smiley"],
  ["🤖", "Robot"],
  ["🎩", "Hat"],
  ["👓", "Glasses"],
  ["🔧", "Spanner"],
  ["🎅", "Santa"],
  ["👍", "Thumbs Up"],
  ["☂️", "Umbrella"],
  ["⌛", "Hourglass"],
  ["⏰", "Clock"],
  ["🎁", "Gift"],
  ["💡", "Light Bulb"],
  ["📕", "Book"],
  ["✏️", "Pencil"],
  ["📎", "Paperclip"],
  ["✂️", "Scissors"],
  ["🔒", "Lock"],
  ["🔑", "Key"],
  ["🔨", "Hammer"],
  ["☎️", "Telephone"],
  ["🏁", "Flag"],
  ["🚂", "Train"],
  ["🚲", "Bicycle"],
  ["✈️", "Aeroplane"],
  ["🚀", "Rocket"],
  ["🏆", "Trophy"],
  ["⚽", "Ball"],
  ["🎸", "Guitar"],
  ["🎺", "Trumpet"],
  ["🔔", "Bell"],
  ["⚓", "Anchor"],
  ["🎧", "Headphones"],
  ["📁", "Folder"],
  ["📌", "Pin"],
];

/** The commitment in m.key.verification.accept: the hash of the accepter's public key and the canonical start content. */
export function sasCommitment(primitives: CryptoPrimitives, publicKey: string, startContent: Record<string, unknown>): string {
  return encodeBase64(primitives.sha256(encodeUtf8(publicKey + canonicalJson(startContent))));
}

/** The HKDF info for the SAS bytes: who started and who accepted, with their ephemeral keys, and the transaction. */
export function sasInfo(p: {
  startUser: string;
  startDevice: string;
  startKey: string;
  acceptUser: string;
  acceptDevice: string;
  acceptKey: string;
  transactionId: string;
}): string {
  return `MATRIX_KEY_VERIFICATION_SAS|${p.startUser}|${p.startDevice}|${p.startKey}|${p.acceptUser}|${p.acceptDevice}|${p.acceptKey}|${p.transactionId}`;
}

export function sasBytes(primitives: CryptoPrimitives, sharedSecret: Uint8Array, info: string): Uint8Array {
  return primitives.hkdfSha256(sharedSecret, undefined, encodeUtf8(info), 6);
}

/** Three numbers from 1000 to 9191, from the first 5 bytes (the spec's bit operations). */
export function sasDecimals(b: Uint8Array): [number, number, number] {
  return [
    ((b[0] << 5) | (b[1] >> 3)) + 1000,
    (((b[1] & 0x7) << 10) | (b[2] << 2) | (b[3] >> 6)) + 1000,
    (((b[3] & 0x3f) << 7) | (b[4] >> 1)) + 1000,
  ];
}

/** Seven emoji from the first 42 bits, 6 bits each, most significant first. */
export function sasEmoji(b: Uint8Array): Array<{ emoji: string; description: string }> {
  const out: Array<{ emoji: string; description: string }> = [];
  for (let i = 0; i < 7; i++) {
    let index = 0;
    for (let bit = i * 6; bit < i * 6 + 6; bit++) index = (index << 1) | ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
    out.push({ emoji: SAS_EMOJI[index][0], description: SAS_EMOJI[index][1] });
  }
  return out;
}

/**
 * A MAC of hkdf-hmac-sha256.v2: HKDF of the shared secret with the info
 * "MATRIX_KEY_VERIFICATION_MAC" + sender user + sender device + other user + other device +
 * transaction + key ID (or "KEY_IDS"), then HMAC-SHA-256 of the value; standard unpadded base64.
 */
export function sasMac(
  primitives: CryptoPrimitives,
  sharedSecret: Uint8Array,
  p: { senderUser: string; senderDevice: string; otherUser: string; otherDevice: string; transactionId: string; keyId: string },
  value: string,
): string {
  const info = `MATRIX_KEY_VERIFICATION_MAC${p.senderUser}${p.senderDevice}${p.otherUser}${p.otherDevice}${p.transactionId}${p.keyId}`;
  const key = primitives.hkdfSha256(sharedSecret, undefined, encodeUtf8(info), 32);
  return encodeBase64(primitives.hmacSha256(key, encodeUtf8(value)));
}
