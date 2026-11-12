import type { CryptoPrimitives, KeyPair } from "../../crypto/primitives.ts";
import { bytesEqual, constantTimeEqual, encodeUtf8 } from "@katrix/shared";
import { b64, field, type Pickled } from "../pickle.ts";
import { ProtocolError } from "../protocol.ts";
import { decodeNormal, encodeNormalBody, MAC_LENGTH, withMac } from "./message.ts";

/**
 * The Olm Double Ratchet (olm.md, "The Olm Algorithm"):
 *
 *   R_0 ‖ C_0,0 = HKDF(0, S, "OLM_ROOT", 64)                    (initial, from the triple DH)
 *   R_i ‖ C_i,0 = HKDF(R_i-1, ECDH(T_i-1, T_i), "OLM_RATCHET", 64)
 *   C_i,j = HMAC(C_i,j-1, "\x02")        M_i,j = HMAC(C_i,j, "\x01")
 *   AES_KEY ‖ HMAC_KEY ‖ AES_IV = HKDF(0, M_i,j, "OLM_KEYS", 80)
 *
 * The limits follow libolm and vodozemac, which every Matrix client interoperates with: five
 * receiver chains, 40 skipped message keys, and a chain may jump at most 2000 messages ahead (a
 * larger gap is refused instead of computing that many keys for an attacker).
 */

const ROOT_INFO = encodeUtf8("OLM_ROOT");
const RATCHET_INFO = encodeUtf8("OLM_RATCHET");
const KEYS_INFO = encodeUtf8("OLM_KEYS");
const MESSAGE_KEY_SEED = Uint8Array.of(0x01);
const CHAIN_KEY_SEED = Uint8Array.of(0x02);

export const MAX_RECEIVER_CHAINS = 5;
export const MAX_SKIPPED_MESSAGE_KEYS = 40;
export const MAX_MESSAGE_GAP = 2000;

interface ChainKey {
  key: Uint8Array;
  index: number;
}

interface SenderChain {
  ratchet: KeyPair;
  chainKey: ChainKey;
}

interface ReceiverChain {
  ratchetKey: Uint8Array;
  chainKey: ChainKey;
}

interface SkippedKey {
  ratchetKey: Uint8Array;
  index: number;
  messageKey: Uint8Array;
}

export interface RatchetState {
  rootKey: Uint8Array;
  senderChain?: SenderChain;
  /** Newest first. */
  receiverChains: ReceiverChain[];
  /** Oldest first. */
  skipped: SkippedKey[];
}

function advanceChainKey(p: CryptoPrimitives, ck: ChainKey): ChainKey {
  return { key: p.hmacSha256(ck.key, CHAIN_KEY_SEED), index: ck.index + 1 };
}

function messageKey(p: CryptoPrimitives, ck: ChainKey): Uint8Array {
  return p.hmacSha256(ck.key, MESSAGE_KEY_SEED);
}

function messageCipherKeys(p: CryptoPrimitives, mk: Uint8Array) {
  const okm = p.hkdfSha256(mk, undefined, KEYS_INFO, 80);
  return { aes: okm.slice(0, 32), mac: okm.slice(32, 64), iv: okm.slice(64, 80) };
}

/**
 * ECDH with a key from the wire. A low-order key (which X25519 refuses) is the sender's fault:
 * a ProtocolError like any other bad message, so callers treat it as one undecryptable message
 * and not as an internal failure.
 */
export function ecdh(p: CryptoPrimitives, secretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  try {
    return p.x25519SharedSecret(secretKey, theirPublicKey);
  } catch {
    throw new ProtocolError("BAD_PUBLIC_KEY", "Invalid Curve25519 key in the message");
  }
}

/** R ‖ C from the root KDF. */
function kdfRoot(p: CryptoPrimitives, salt: Uint8Array | undefined, ikm: Uint8Array, info: Uint8Array) {
  const okm = p.hkdfSha256(ikm, salt, info, 64);
  return { rootKey: okm.slice(0, 32), chainKey: { key: okm.slice(32, 64), index: 0 } };
}

export function initialiseAsAlice(p: CryptoPrimitives, sharedSecret: Uint8Array, ratchet: KeyPair): RatchetState {
  const { rootKey, chainKey } = kdfRoot(p, undefined, sharedSecret, ROOT_INFO);
  return { rootKey, senderChain: { ratchet, chainKey }, receiverChains: [], skipped: [] };
}

export function initialiseAsBob(p: CryptoPrimitives, sharedSecret: Uint8Array, theirRatchetKey: Uint8Array): RatchetState {
  const { rootKey, chainKey } = kdfRoot(p, undefined, sharedSecret, ROOT_INFO);
  return { rootKey, receiverChains: [{ ratchetKey: theirRatchetKey, chainKey }], skipped: [] };
}

/** Encrypts and returns the encoded normal message (with MAC). Mutates `state`. */
export function ratchetEncrypt(p: CryptoPrimitives, state: RatchetState, plaintext: Uint8Array): Uint8Array {
  if (!state.senderChain) {
    // First message since we last received: ratchet forward with a new key pair.
    const theirs = state.receiverChains[0];
    if (!theirs) throw new ProtocolError("BAD_MESSAGE_FORMAT", "Ratchet has no chain to encrypt with");
    const ratchet = p.x25519GenerateKeyPair();
    const next = kdfRoot(p, state.rootKey, ecdh(p, ratchet.secretKey, theirs.ratchetKey), RATCHET_INFO);
    state.rootKey = next.rootKey;
    state.senderChain = { ratchet, chainKey: next.chainKey };
  }
  const chain = state.senderChain;
  const mk = messageKey(p, chain.chainKey);
  const index = chain.chainKey.index;
  chain.chainKey = advanceChainKey(p, chain.chainKey);
  const keys = messageCipherKeys(p, mk);
  const ciphertext = p.aes256CbcEncrypt(keys.aes, keys.iv, plaintext);
  const body = encodeNormalBody(chain.ratchet.publicKey, index, ciphertext);
  return withMac(body, p.hmacSha256(keys.mac, body));
}

function decryptWithMessageKey(p: CryptoPrimitives, mk: Uint8Array, message: ReturnType<typeof decodeNormal>): Uint8Array {
  const keys = messageCipherKeys(p, mk);
  const mac = p.hmacSha256(keys.mac, message.authenticated).subarray(0, MAC_LENGTH);
  if (!constantTimeEqual(mac, message.mac)) throw new ProtocolError("BAD_MESSAGE_MAC", "Olm message MAC does not match");
  try {
    return p.aes256CbcDecrypt(keys.aes, keys.iv, message.ciphertext);
  } catch {
    throw new ProtocolError("BAD_DECRYPTION", "Olm message does not decrypt");
  }
}

/**
 * Decrypts an encoded normal message. Works on a copy of the state and returns the new state
 * with the plaintext: a message that fails (wrong MAC, replayed, too far ahead) changes nothing.
 */
export function ratchetDecrypt(
  p: CryptoPrimitives,
  current: RatchetState,
  bytes: Uint8Array,
): { state: RatchetState; plaintext: Uint8Array } {
  const message = decodeNormal(bytes);
  const state = cloneRatchet(current);
  let chain = state.receiverChains.find((c) => bytesEqual(c.ratchetKey, message.ratchetKey));

  if (chain && message.chainIndex < chain.chainKey.index) {
    // Already past this index: only a skipped key can decrypt it. A replayed message finds none.
    const at = state.skipped.findIndex((s) => s.index === message.chainIndex && bytesEqual(s.ratchetKey, message.ratchetKey));
    if (at < 0) throw new ProtocolError("BAD_MESSAGE_KEY_ID", "Message key already used or unknown");
    const plaintext = decryptWithMessageKey(p, state.skipped[at].messageKey, message);
    state.skipped.splice(at, 1);
    return { state, plaintext };
  }

  if (!chain) {
    // The other side ratcheted. libolm/vodozemac refuse a new chain before we have sent on ours:
    // the sender only ratchets after receiving from us.
    if (!state.senderChain) throw new ProtocolError("BAD_MESSAGE_KEY_ID", "Unexpected ratchet key");
    if (message.chainIndex > MAX_MESSAGE_GAP) throw new ProtocolError("MESSAGE_GAP_TOO_LARGE", "Message index too far ahead");
    const next = kdfRoot(p, state.rootKey, ecdh(p, state.senderChain.ratchet.secretKey, message.ratchetKey), RATCHET_INFO);
    chain = { ratchetKey: message.ratchetKey, chainKey: next.chainKey };
    state.rootKey = next.rootKey;
    state.receiverChains.unshift(chain);
    if (state.receiverChains.length > MAX_RECEIVER_CHAINS) state.receiverChains.length = MAX_RECEIVER_CHAINS;
    // Our next message starts a new sender chain against their new key.
    state.senderChain = undefined;
  }

  if (message.chainIndex - chain.chainKey.index > MAX_MESSAGE_GAP) {
    throw new ProtocolError("MESSAGE_GAP_TOO_LARGE", "Message index too far ahead");
  }
  let ck = chain.chainKey;
  while (ck.index < message.chainIndex) {
    state.skipped.push({ ratchetKey: chain.ratchetKey, index: ck.index, messageKey: messageKey(p, ck) });
    ck = advanceChainKey(p, ck);
  }
  if (state.skipped.length > MAX_SKIPPED_MESSAGE_KEYS) state.skipped.splice(0, state.skipped.length - MAX_SKIPPED_MESSAGE_KEYS);
  const plaintext = decryptWithMessageKey(p, messageKey(p, ck), message);
  chain.chainKey = advanceChainKey(p, ck);
  return { state, plaintext };
}

export function cloneRatchet(s: RatchetState): RatchetState {
  return {
    rootKey: s.rootKey,
    senderChain: s.senderChain && { ratchet: s.senderChain.ratchet, chainKey: { ...s.senderChain.chainKey } },
    receiverChains: s.receiverChains.map((c) => ({ ratchetKey: c.ratchetKey, chainKey: { ...c.chainKey } })),
    skipped: s.skipped.map((k) => ({ ...k })),
  };
}

const chainKeyToJson = (ck: ChainKey) => ({ key: b64(ck.key), index: ck.index });
const chainKeyFromJson = (j: Pickled): ChainKey => ({ key: field.bytes(j, "key", 32), index: field.uint(j, "index") });

export function ratchetToJson(s: RatchetState): Pickled {
  return {
    root_key: b64(s.rootKey),
    sender_chain: s.senderChain
      ? {
          secret_key: b64(s.senderChain.ratchet.secretKey),
          public_key: b64(s.senderChain.ratchet.publicKey),
          chain_key: chainKeyToJson(s.senderChain.chainKey),
        }
      : null,
    receiver_chains: s.receiverChains.map((c) => ({ ratchet_key: b64(c.ratchetKey), chain_key: chainKeyToJson(c.chainKey) })),
    skipped: s.skipped.map((k) => ({ ratchet_key: b64(k.ratchetKey), index: k.index, message_key: b64(k.messageKey) })),
  };
}

export function ratchetFromJson(j: Pickled): RatchetState {
  const sender = field.optional(j, "sender_chain");
  return {
    rootKey: field.bytes(j, "root_key", 32),
    senderChain: sender
      ? {
          ratchet: { secretKey: field.bytes(sender, "secret_key", 32), publicKey: field.bytes(sender, "public_key", 32) },
          chainKey: chainKeyFromJson(field.optional(sender, "chain_key") ?? {}),
        }
      : undefined,
    receiverChains: field
      .array(j, "receiver_chains")
      .map((c) => ({ ratchetKey: field.bytes(c, "ratchet_key", 32), chainKey: chainKeyFromJson(field.optional(c, "chain_key") ?? {}) })),
    skipped: field.array(j, "skipped").map((k) => ({
      ratchetKey: field.bytes(k, "ratchet_key", 32),
      index: field.uint(k, "index"),
      messageKey: field.bytes(k, "message_key", 32),
    })),
  };
}
