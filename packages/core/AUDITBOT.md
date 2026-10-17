# Audit bot

`matrix-nodejs-homeserver/auditbot` records the rooms of the server, end-to-end encrypted ones
included, to an archive: an account of the server that is a member of every room (or every room
but direct messages) and writes each event as one JSON line.

It needs the crypto library, an optional peer dependency:

```sh
npm install matrix-nodejs-homeserver @matrix-org/matrix-sdk-crypto-nodejs
```

```ts
import { createHomeserver } from "matrix-nodejs-homeserver";
import { fileSink, startAuditBot } from "matrix-nodejs-homeserver/auditbot";

const hs = createHomeserver({ /* … */ });
const bot = await startAuditBot(hs, {
  sink: fileSink("/data/audit"),          // {room ID}/{YYYY-MM-DD}.jsonl
  dataDir: "/data/auditbot",              // crypto store and sync position: keep and back up
  storePassphrase: process.env.AUDIT_STORE_PASSPHRASE!,
  rooms: "groups",                        // or "all" (default): with direct messages
});
// await bot.stop() on shutdown, before hs.close()
```

## How it works

- **It is a room member.** It joins new rooms on its own, and existing ones at start and every
  10 minutes. Public rooms are joined directly. In other rooms, a local member who may invite
  invites it (`hs.admin.joinUser`, Synapse's `POST /_synapse/admin/v1/join`). The invite shows in
  the room, and the bot is in the member list as "Audit log (this room is recorded)", so everyone
  can see that a room is recorded.
- **End-to-end encryption.** It is a device like any other, with matrix-sdk-crypto (the Rust
  crypto of the Element apps). Clients send it the room keys as they do to every member's device,
  and it decrypts the events. Its device is signed by its own cross-signing identity. Keys live in
  an encrypted SQLite store in `dataDir`, so it reads messages again after a restart.
- **Direct messages** are left out with `rooms: "groups"`. It does not join rooms created with
  `is_direct`, and it leaves a room that turns out to be one.
- **In-process.** It runs in the homeserver's process and calls its API through the request
  handler, with no network and no port.

What it cannot read: anything sent before it joined a room. It also misses messages from
clients set to share keys only with verified devices. A message whose key never arrives is
recorded after an hour with `decryption_error` and its ciphertext.

## Records

```json
{"recorded_at":1792270000000,"room_id":"!abc:example.com","event_id":"$…","type":"m.room.message",
 "sender":"@alice:example.com","origin_server_ts":1792269999000,
 "content":{"msgtype":"m.text","body":"hello"},"encrypted":true,"sender_device":"ABCDEFGHIJ"}
```

`state_key` and `redacts` appear when the event has them. `initial_state: true` marks state the
room had when the bot joined. A sink is anything with `write(records)`: `fileSink(dir)`,
`memorySink()`, or your own (S3, a SIEM, a database).

## Before you turn it on

Recording people's conversations, encrypted ones included, needs a legal basis and telling them:
terms of use, a privacy policy, and in the EU the GDPR. The bot's name says it in every room, but
it does not replace those.

The crypto library is a native module (Linux, macOS, Windows; x64 and arm64). Its install script
downloads it from the project's GitHub releases. With `--ignore-scripts`, run
`node node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js`.
