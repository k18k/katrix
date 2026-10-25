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

It covers the whole stable Client-Server API (Matrix v1.19, deprecated endpoints aside): a test checks that every endpoint of the shared endpoint map is called.

- **Login and registration**: password, SSO login tokens, application services, refresh tokens. The [OAuth 2.0 API](https://spec.matrix.org/v1.19/client-server-api/#oauth-20-api) has its building blocks (`getAuthMetadata`, `registerClient`, `createAuthorizationRequest` with PKCE, `completeAuthorization`, `refreshOAuthToken`); the browser step is the app's.
  - Registration also covers guests, username and registration-token checks, and email or phone tokens.
  - Discovery: `.well-known`, versions, support contacts. Password reset is there too.
  - User-interactive authentication goes through `withUserInteractiveAuth` with a callback (`passwordAuth`, `dummyAuth`, or your own for CAPTCHA, terms or `m.oauth`).
- **Account** (`client.account`, `client.devices`, `client.profile`, `client.presence`):
  - capabilities, password change, deactivation and third-party IDs;
  - account data, ignored users, filters, OpenID and login tokens, logout of all devices;
  - devices: list, rename, delete;
  - profile fields, including the time zone and custom fields; presence.
- **Sync**: `/sync` v3 with `use_state_after` and lazy-loaded members, behind the `SyncTransport` interface (which Simplified Sliding Sync, MSC4186, can implement without changes to the client). A sync round is one atomic unit of work (see Storage).
- **Rooms**:
  - create, join, knock, invite (also by third-party ID), kick, ban, leave, forget, upgrade (and `followUpgrade`);
  - state helpers: name, topic, avatar, join rules, history visibility, power levels, pinned events, aliases;
  - members with lazy loading, display names as the spec computes them, power levels;
  - timelines with back-pagination and gaps, and local echoes matched by transaction ID;
  - redactions, receipts (also threaded), read markers, typing, tags, reports, peeking.
- **Relations**: edits applied by the spec's validity rules (`event.latestContent`), reactions grouped per key, thread summaries and the main timeline. Sending helpers: `sendEdit`, `sendReply`, `sendThreadMessage`, `removeReaction`.
- **Direct chats** (`createDirectRoom`, `findDirectRoom`, `m.direct`) and **spaces** (`client.spaces`: create, children in the spec's order, parents, hierarchy).
- **Directory and search** (`client.directory`): aliases, the public room directory, room summaries, user search, third-party networks, server-side search, mutual rooms.
- **Media** (`client.media`): uploads (also asynchronous), authenticated downloads and thumbnails, URL previews. `sendFile` encrypts the file in encrypted rooms.
- **Push** (`client.push`): pushers, push rules, the notification list. The rules are also evaluated on the client, on decrypted messages: the `notification` event, and `getUnreadCounts` for encrypted rooms.
- **End-to-end encryption**:
  - Olm and Megolm, with device and one-time keys, rotation, withheld keys, replay detection and unwedging;
  - cross-signing (`client.e2ee.crossSigning`), secret storage, key backup, and recovery with a recovery key or passphrase (`client.e2ee.recovery`);
  - room key and secret sharing between the user's own verified devices;
  - key verification by SAS (emoji, numbers) or QR code, to-device and in rooms (`client.e2ee.verification`).
  - Messages are never sent in the clear into an encrypted room.
- **Calls** (`client.calls`): the VoIP signalling (invites, answers, candidates, renegotiation, glare, hangups) over the app's WebRTC.
- **Administration** (`client.admin`): whois, suspending and locking accounts, appservice ping.

```ts
// A new device: recover identity and history with the recovery key.
await client.e2ee!.recovery.recover(recoveryKeyOrPassphrase);

// Or set recovery up on the first device (the password answers the server's re-authentication).
const { recoveryKey } = await client.e2ee!.recovery.setUp({ passphrase, auth: passwordAuth(client.userId, password) });

// Verify another user in your direct chat with them.
const request = await client.e2ee!.verification.requestUserVerification(roomId, "@bob:example.org");
request.on("sas", ({ emoji }) => show(emoji)); // then request.confirmSas() or request.mismatchSas()

// Answer a call with the browser's WebRTC, given
// new MatrixClient({ ...opts, calls: { peerConnectionFactory: (config) => new RTCPeerConnection(config) } }):
client.calls.on("incoming", (call) => call.answer((pc) => stream.getTracks().forEach((t) => pc.addTrack(t, stream))));
```

## Architecture

Four layers, each behind an interface:

| Layer | Interface | Built in |
|---|---|---|
| Crypto primitives: X25519, Ed25519, AES-256-CBC and -CTR, HMAC-SHA-256, HKDF, SHA-256, randomness | `CryptoPrimitives` | `nobleCryptoPrimitives()` |
| The Olm and Megolm protocols, on the primitives only | `E2EEProtocol` | `nativeE2EEProtocol(primitives)` |
| Durable state | `StorageAdapter` | `MemoryStorage`; `sqliteStorage` (`@katrix/client/sqlite`), `indexedDbStorage` (`@katrix/client/indexeddb`) |
| HTTP | `HttpAdapter` | `fetchHttpAdapter(fetch?)` |

`E2EEProtocol` follows vodozemac's API (Account, Session, GroupSession, InboundGroupSession; bytes in, Base64 wire strings out, state as opaque pickles), so vodozemac or another implementation can replace the built-in one through `new MatrixClient({ e2ee: { protocol } })`. Both interfaces are synchronous, as vodozemac and libolm are: Hermes has no WebCrypto, and a ratchet must not advance across an `await`.

SAS, cross-signing, secret storage and key backup are built on `CryptoPrimitives` too (X25519, HKDF, HMAC, Ed25519, AES-CTR and -CBC, PBKDF2-SHA-512).

### Storage

The default `MemoryStorage` forgets everything when the app stops. For a real app use a durable one:

```ts
import { sqliteStorage } from "@katrix/client/sqlite"; // node:sqlite, better-sqlite3, op-sqlite, expo-sqlite
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("katrix.db");
const storage = sqliteStorage({ run: (sql, p) => void db.prepare(sql).run(...p), all: (sql, p) => db.prepare(sql).all(...p) });

// In browsers:
// import { indexedDbStorage } from "@katrix/client/indexeddb";
// const storage = indexedDbStorage({ name: `katrix-${userId}` });
```

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

A device's keys must be signed by the device itself and name the right user and device, and a known device whose keys change is not updated. On top of that, cross-signing:
- a user is verified when our user-signing key signed their master key, after an SAS or QR verification;
- a device is verified when it is directly verified, or when its owner is verified and their self-signing key signed it;
- a user whose master key changes from the one first seen is flagged (`identityChanged`) until the change is accepted;
- the master key's private half is never kept on the device: the spec forbids that without a secure store, and the SDK cannot know whether the app's storage is one.

A decrypted event's `decryptionInfo.authenticity` says whether its room key came from a known device of the sender ("authenticated"), from a device not known yet ("unknown_device"), or without proof of origin ("unauthenticated": also every key from the backup or from another of our devices). Room keys only count when they arrive Olm-encrypted, and a room key passed on by another user does not make its messages look like that user's (they fail with `SENDER_MISMATCH`). Keys and secrets are given only to, and taken only from, the user's own verified devices.

## Tests

```sh
npm test -w @katrix/client           # unit, crypto, integration with packages/server, then the Hermes run
npm run test:hermes -w @katrix/client
```

- Primitives against their standards' test vectors (FIPS 180-2, RFC 4231, RFC 5869, RFC 7748, RFC 8032, NIST SP 800-38A) and against OpenSSL on random inputs.
- The spec's own vectors for canonical JSON, JSON signing and unpadded Base64.
- Olm and Megolm: conversations, out-of-order and skipped messages, replays, tampered and truncated messages, forged signatures, a validly signed message with a wrong MAC, low-order keys, one-time and fallback key use, corrupted and wrongly keyed pickles, the Megolm ratchet across every part boundary.
- Interop with vodozemac (matrix-sdk-crypto) in both directions, including a Megolm message past index 2^16; and with matrix-sdk-crypto's secret storage, passphrase keys, recovery keys and key backup encryption. SAS and QR verification are tested between two Katrix clients only: the matrix-sdk-crypto Node.js bindings have no verification API.
- Storage adapters against each other: memory, SQLite (node:sqlite) and IndexedDB (fake-indexeddb, which is checked against the W3C's IndexedDB tests).
- Integration with `packages/server`: every area above (account, directory, media, push, relations, spaces, cross-signing, recovery, key sharing, verification, calls with a stand-in RTCPeerConnection), login, sync, rooms, pagination, restarts from storage (also on SQLite with encryption), encrypted rooms with rotation and new devices, a Rust client in the same room, and attacks by a room member and by the server (redirected to-device payloads, plaintext room keys, plaintexts for another room, replays, relayed room keys, replayed pre-key messages, corrupted stored sessions), and a check that no secret reaches logs or errors.

[PolyForm Noncommercial 1.0.0](LICENSE).
