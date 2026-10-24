# @katrix/client

The client of [Katrix](https://github.com/k18k/katrix): a [Matrix](https://matrix.org) client SDK in TypeScript, with end-to-end encryption (Olm and Megolm). The same code runs in Node.js, in browsers and in React Native (Hermes): no WebAssembly, no WebCrypto, no Node.js APIs. Its only runtime dependencies are [`@noble/curves`](https://github.com/paulmillr/noble-curves), [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) and [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers).

It speaks the Client-Server API as the spec defines it, so it is meant for any homeserver; the tests run it against [`@katrix/server`](../server) (not yet against Synapse). Its Olm and Megolm interoperate with vodozemac, the crypto of the Element apps: the tests exchange messages with matrix-sdk-crypto in both directions.

> The Olm and Megolm implementation is new and has not had an outside security review yet.

```ts
import { Auth, MatrixClient, fetchHttpAdapter } from "@katrix/client";

const http = fetchHttpAdapter(); // the platform's fetch
const baseUrl = await Auth.discover("example.org", http); // or the URL itself
const credentials = await new Auth({ baseUrl, http }).loginWithPassword("alice", "secret");

const client = new MatrixClient({ baseUrl, http, credentials, storage }); // storage: see below
client.on("room.timeline", (event, room) => console.log(room.name(), event.type, event.content));
client.on("event.decrypted", (event) => console.log("decrypted", event.content));
await client.start();
await client.waitForPrepared();

const roomId = await client.createRoom({ name: "Team", encrypted: true, invite: ["@bob:example.org"] });
await client.sendText(roomId, "hello"); // encrypted, because the room is
```

## What it does

- **Login**: password (`m.login.password`), login token (SSO, `m.login.token`), registration with `m.login.dummy`, refresh tokens. The [OAuth 2.0 API](https://spec.matrix.org/v1.16/client-server-api/#oauth-20-api) has its building blocks (`getAuthMetadata`, `registerClient`, `createAuthorizationRequest` with PKCE, `completeAuthorization`, `refreshOAuthToken`); the browser step is the app's. Everything the client needs from a login is a `TokenProvider`.
- **Sync**: `/sync` v3 behind the `SyncTransport` interface, which Simplified Sliding Sync (MSC4186) can implement without changes to the client. A sync round is one atomic unit of work (see Storage).
- **Rooms**: state, members (with lazy loading and `loadMembers`), display names as the spec computes them, power levels, timelines with back-pagination and gaps, local echoes matched by transaction ID, redactions, receipts, typing, account data, invites.
- **Events**: typed by event type (`EventContentMap`, extendable by declaration merging); `event.is("m.room.member")` narrows the content.
- **End-to-end encryption**: device keys, one-time and fallback keys kept topped up, device list tracking, Olm sessions over claimed one-time keys, `m.room_key` sharing, Megolm encryption and decryption, session rotation (by message count, by age, when a member or device goes, when the settings change), `m.room_key.withheld` for devices without keys, replay detection, unwedging of broken Olm sessions with `m.dummy`. Messages are never sent in the clear into an encrypted room.

Not yet: device verification (SAS), cross-signing, key backup and secret storage, forwarded keys and key requests, media, VoIP. The interfaces leave room for them (below).

## Architecture

Four layers, each behind an interface:

| Layer | Interface | Built in |
|---|---|---|
| Crypto primitives: X25519, Ed25519, AES-256-CBC and -CTR, HMAC-SHA-256, HKDF, SHA-256, randomness | `CryptoPrimitives` | `nobleCryptoPrimitives()` |
| The Olm and Megolm protocols, on the primitives only | `E2EEProtocol` | `nativeE2EEProtocol(primitives)` |
| Durable state | `StorageAdapter` | `MemoryStorage` |
| HTTP | `HttpAdapter` | `fetchHttpAdapter(fetch?)` |

`E2EEProtocol` follows vodozemac's API (Account, Session, GroupSession, InboundGroupSession; bytes in, Base64 wire strings out, state as opaque pickles), so vodozemac or another implementation can replace the built-in one through `new MatrixClient({ e2ee: { protocol } })`. Both interfaces are synchronous, as vodozemac and libolm are: Hermes has no WebCrypto, and a ratchet must not advance across an `await`.

SAS, cross-signing and key backup need nothing beyond `CryptoPrimitives` (X25519, HKDF, HMAC, Ed25519, AES-CTR); `E2EEEngine.sendEncryptedToDevice` is the channel verification will use.

### Storage

A `StorageAdapter` is a key-value store with named stores (`STORES`) and one write method: `write(batch)`, which must apply a batch atomically. The client never keeps a transaction open across its own awaits: it reads, computes, and hands over a finished batch. That fits IndexedDB (whose transactions end by themselves at the first foreign await), SQLite (BEGIN … COMMIT) and MMKV (write the batch as a journal entry, apply it, delete it; replay a leftover journal on open). See `src/storage/adapter.ts`.

What goes into one batch matters: a sync's new token is stored together with what its to-device messages did (new Olm sessions, used one-time keys, received room keys), so a crash repeats the round instead of losing keys. New one-time keys are stored before they are uploaded. Olm sessions are stored before the messages they encrypted are sent.

Pickles can be encrypted at rest with a 32-byte `pickleKey` (AES-256-CTR and HMAC-SHA-256). The stored timeline keeps encrypted events encrypted; plaintext is never written.

One client instance must be the only writer of its storage (two tabs need a lock across them, such as Web Locks).

## Platforms

- **Node.js** 22 or newer.
- **Browsers**: anything with `fetch`, `crypto.getRandomValues` and BigInt.
- **React Native** 0.74 or newer with Hermes: import `react-native-get-random-values` before the SDK. (`@noble/curves` needs `TextEncoder` when it loads, which Hermes has since 0.74; for older versions, polyfill it.)

The sources compile without DOM or Node.js typings, and a test checks they use no platform-specific globals. A second test run (`npm run test:hermes`) removes from Node.js what Hermes lacks (`TextDecoder`, `WebAssembly`, `crypto.subtle`, `Buffer`, `URL`, `atob`, …) and runs a whole encrypted conversation over HTTP in it.

## Trust

Until verification lands, devices are trusted on first use: a device's keys must be signed by the device itself and name the right user and device, and a known device whose keys change is not updated. A decrypted event's `decryptionInfo.authenticity` says whether its room key came from a known device of the sender ("authenticated"), from a device not known yet ("unknown_device"), or without proof of origin ("unauthenticated"). Room keys only count when they arrive Olm-encrypted, and a room key passed on by another user does not make its messages look like that user's (they fail with `SENDER_MISMATCH`).

## Tests

```sh
npm test -w @katrix/client           # unit, crypto, integration with packages/server, then the Hermes run
npm run test:hermes -w @katrix/client
```

- Primitives against their standards' test vectors (FIPS 180-2, RFC 4231, RFC 5869, RFC 7748, RFC 8032, NIST SP 800-38A) and against OpenSSL on random inputs.
- The spec's own vectors for canonical JSON, JSON signing and unpadded Base64.
- Olm and Megolm: conversations, out-of-order and skipped messages, replays, tampered and truncated messages, forged signatures, a validly signed message with a wrong MAC, low-order keys, one-time and fallback key use, corrupted and wrongly keyed pickles, the Megolm ratchet across every part boundary.
- Interop with vodozemac (matrix-sdk-crypto) in both directions, including a Megolm message past index 2^16.
- Integration with `packages/server`: login, sync, rooms, pagination, restarts from storage, encrypted rooms with rotation and new devices, a Rust client in the same room, and attacks by a room member and by the server (redirected to-device payloads, plaintext room keys, plaintexts for another room, replays, relayed room keys, replayed pre-key messages, corrupted stored sessions), and a check that no secret reaches logs or errors.

[PolyForm Noncommercial 1.0.0](LICENSE).
