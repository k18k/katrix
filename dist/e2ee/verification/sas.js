import { encodeBase64 } from "../../shared/base64.js";
import { canonicalJson } from "../../shared/canonical-json.js";
import { encodeUtf8 } from "../../shared/utf8.js";
// src/e2ee/verification/sas.ts
const SAS_METHOD = "m.sas.v1";
const KEY_AGREEMENT = "curve25519-hkdf-sha256";
const HASH = "sha256";
const MAC_METHOD = "hkdf-hmac-sha256.v2";
const SAS_TYPES = ["decimal", "emoji"];
/** The 64 SAS emoji and their English names, from the spec's data-definitions/sas-emoji.json. */
const SAS_EMOJI = [
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
	["📌", "Pin"]
];
/** The commitment in m.key.verification.accept: the hash of the accepter's public key and the canonical start content. */
function sasCommitment(primitives, publicKey, startContent) {
	return encodeBase64(primitives.sha256(encodeUtf8(publicKey + canonicalJson(startContent))));
}
/** The HKDF info for the SAS bytes: who started and who accepted, with their ephemeral keys, and the transaction. */
function sasInfo(p) {
	return `MATRIX_KEY_VERIFICATION_SAS|${p.startUser}|${p.startDevice}|${p.startKey}|${p.acceptUser}|${p.acceptDevice}|${p.acceptKey}|${p.transactionId}`;
}
function sasBytes(primitives, sharedSecret, info) {
	return primitives.hkdfSha256(sharedSecret, void 0, encodeUtf8(info), 6);
}
/** Three numbers from 1000 to 9191, from the first 5 bytes (the spec's bit operations). */
function sasDecimals(b) {
	return [
		(b[0] << 5 | b[1] >> 3) + 1e3,
		((b[1] & 7) << 10 | b[2] << 2 | b[3] >> 6) + 1e3,
		((b[3] & 63) << 7 | b[4] >> 1) + 1e3
	];
}
/** Seven emoji from the first 42 bits, 6 bits each, most significant first. */
function sasEmoji(b) {
	const out = [];
	for (let i = 0; i < 7; i++) {
		let index = 0;
		for (let bit = i * 6; bit < i * 6 + 6; bit++) index = index << 1 | b[bit >> 3] >> 7 - (bit & 7) & 1;
		out.push({
			emoji: SAS_EMOJI[index][0],
			description: SAS_EMOJI[index][1]
		});
	}
	return out;
}
/**
* A MAC of hkdf-hmac-sha256.v2: HKDF of the shared secret with the info
* "MATRIX_KEY_VERIFICATION_MAC" + sender user + sender device + other user + other device +
* transaction + key ID (or "KEY_IDS"), then HMAC-SHA-256 of the value; standard unpadded base64.
*/
function sasMac(primitives, sharedSecret, p, value) {
	const info = `MATRIX_KEY_VERIFICATION_MAC${p.senderUser}${p.senderDevice}${p.otherUser}${p.otherDevice}${p.transactionId}${p.keyId}`;
	const key = primitives.hkdfSha256(sharedSecret, void 0, encodeUtf8(info), 32);
	return encodeBase64(primitives.hmacSha256(key, encodeUtf8(value)));
}
export { HASH, KEY_AGREEMENT, MAC_METHOD, SAS_EMOJI, SAS_METHOD, SAS_TYPES, sasBytes, sasCommitment, sasDecimals, sasEmoji, sasInfo, sasMac };

//# sourceMappingURL=sas.js.map