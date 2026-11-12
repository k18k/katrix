# @katrix/client

## 0.4.1

### Patch Changes

- c48b9a6: The client covers much more of the Client-Server API (#117):
  
  - account management on `client.account`: password, deactivation, 3PIDs, account data, ignored users, filters, OpenID and login tokens;
  - devices on `client.devices`, profiles (any field) on `client.profile`, presence on `client.presence`;
  - aliases, the public room directory, room summaries, user search and third-party networks on `client.directory`;
  - admin endpoints on `client.admin`;
  - on `MatrixClient`, knocking, room upgrades, state helpers, fetching events, context, relations and threads, timestamp lookups, read markers, threaded receipts, search, peeking, tags and reports.
  
  `Auth` now also registers guests, checks usernames and registration tokens, requests email and phone tokens, resets passwords, and lists support contacts. User-interactive authentication goes through `withUserInteractiveAuth` with a callback such as `passwordAuth`.
  
  Breaking: `whoami()` moved to `client.account`, `getProfile()` and `setDisplayName()` to `client.profile`, and `setAccountData()` to `client.account`.
- 1a2ab7e: Voice and video calls on `client.calls` (#117). The SDK handles the Matrix signalling: invites, answers, ICE candidates (batched as the spec suggests), select_answer, renegotiation, rejecting, hanging up, glare, and invite lifetimes. Media goes through the app's WebRTC: pass `calls: { peerConnectionFactory }` (the browser's `RTCPeerConnection`, or react-native-webrtc's), and add your tracks in the setup callback of `place()` and `answer()`. Incoming calls arrive as the `incoming` event; calls in public rooms do not ring. `turnServers()` fetches the homeserver's TURN servers.
- a43d0e2: End-to-end encryption key management (#117):
  
  - **Cross-signing** (`client.e2ee.crossSigning`): create the user's keys, sign their own devices, verify other users, and ask whether a user or device is verified. A user whose identity changed is flagged with `identityChanged` until the change is accepted. The master key's private half is never stored on the device.
  - **Secret storage** (`client.e2ee.secretStorage`): secrets kept in account data, encrypted with a recovery key or passphrase. Recovery keys are compatible with Element.
  - **Key backup** (`client.e2ee.backup`): room keys are uploaded to a trusted backup automatically. A missing key is looked up there first.
  - **Recovery** (`client.e2ee.recovery`): `setUp({ passphrase })` returns a recovery key. `recover(recoveryKeyOrPassphrase)` gives a new device the user's identity and message history.
  - **Sharing between the user's own verified devices** (`client.e2ee.sharing`): room key requests and forwarded keys, secret requests, and withheld notices (`event.withheld`). Keys and secrets are only given to, and only taken from, the user's own verified devices.
- f458968: The client now calls every endpoint of the Client-Server API (Matrix v1.19, except the deprecated ones), and a test keeps it that way (#117). New in this release:
  
  - Key backup management: `backup.versionInfo()`, `backup.signWithMasterKey()` and `backup.deleteKeys()`. Uploads of a single session or room use their own endpoints.
  - Device list changes between two sync tokens: `e2ee.devices.changesBetween()`.
  - `push.rules({ scope: "global" })`.
  - Joining by room ID without servers uses `/rooms/{roomId}/join`.
- 9e6ba9c: Media on `client.media` (#117): uploads (including asynchronous uploads to a reserved mxc:// URI), authenticated downloads and thumbnails, URL previews, and the server's upload limit. `client.sendFile` uploads and sends a file; in an encrypted room it encrypts the file first (AES-256-CTR, with its SHA-256 checked on download), so the server never sees it. `encryptAttachment` and `decryptAttachment` are exported for apps that handle files themselves.
- 9a2ae8c: The client can share room keys only with verified devices (#117), like Element's "never send encrypted messages to unverified sessions". Set it everywhere with `e2ee: { onlyVerifiedDevices: true }`, or per room with `client.e2ee.setOnlyVerifiedDevices(true, roomId)`. Refused devices are told why (`m.room_key.withheld` with `m.unverified`, which the recipient sees as `event.withheld`), and they get the key from the next message on once they are verified.
- 6eed381: Push notifications on `client.push` (#117): pushers, push rules (add, remove, enable, change actions, mute and unmute rooms), and the server's notification list. The client also evaluates the push rules itself, on the plaintext of encrypted messages, which the server cannot read: the new `notification` event fires for messages that should notify (with `highlight` and `sound`), and `client.getUnreadCounts(roomId)` counts unread messages in encrypted rooms from the decrypted timeline.
- a3887c2: The room model understands relations (#117). Edits are applied: `event.latestContent` is the newest valid edit, checked against the spec's rules, so only the sender can edit their message, and the server's bundled edit is used too. Reactions are grouped per key with `room.reactions(eventId)`, and threads are summarised with `room.threadSummary(rootId)` and `room.mainTimeline()`. A `room.relation` event fires when any of these change. To send them there are `sendEdit`, `sendReply` (it mentions the person replied to and stays in their thread), `sendThreadMessage` and `removeReaction`.
  
  Direct chats: `createDirectRoom`, `findDirectRoom` and `markDirect`. Accepting a direct invite records it in `m.direct`. Spaces on `client.spaces`: create a space, add and remove children and parents (in the spec's order), and read the hierarchy. Upgraded rooms: `room.successor()`, `room.predecessor()` and `client.followUpgrade()`.
- 6a3292a: Durable storage for the client (#117), so sessions, encryption keys and rooms survive restarts:
  
  - `@katrix/client/sqlite` (`sqliteStorage`): SQLite through any library with `run` and `all`. That covers node:sqlite and better-sqlite3, and op-sqlite and expo-sqlite in React Native with a few lines of glue.
  - `@katrix/client/indexeddb` (`indexedDbStorage`): browsers.
  
  Both apply each batch atomically.
- 18fd9fd: Sync improvements (#117):
  
  - The client asks for the room state at the end of the timeline (`use_state_after`, Matrix 1.16), which avoids wrong room state after gaps. Servers that do not support it answer as before. It can be turned off with `sync.useStateAfter: false`.
  - Unread counts per thread are in `room.threadNotifications`.
  - Users' presence is in `client.getPresence(userId)`, and `client.presence.set()` now sticks: sync no longer resets it to online.
  - `room.isDirect()` and `room.lastActivity()` help build room lists.
  
  **Breaking:** `logout()` now deletes the device's stored state (rooms, sync token, keys), because they are useless once the device is logged out. Pass `{ clearStorage: false }` to keep it.
- 01d7f60: Key verification on `client.e2ee.verification` (#117). To verify another user, `requestUserVerification(roomId, userId)` sends the request in a room. To verify one of your own devices, `requestOwnDeviceVerification()` sends it to-device. Incoming requests arrive as the `request` event, and you accept or cancel them.
  
  Two methods are supported:
  
  - **SAS**, where both users compare emoji or numbers (`confirmSas` or `mismatchSas`).
  - **QR codes**: `qrCode()` returns the bytes to draw, and `scanQrCode(bytes)` reads the other side's code.
  
  Verifying another user signs their master key, so all their devices are trusted. Verifying your own new device makes it trust your identity and fetch the cross-signing and backup keys from the device that verified it.
- ba395e2: Both packages now export the spec's types for the Client-Server API endpoints they use: request and response types (`LoginRequest`, `LoginResponse`, `SyncResponse`, `KeysQueryResponse`, …) and the map of endpoints, `ClientEndpoints`. `@katrix/client` builds its requests from that map (`MatrixHttpApi.endpoint()`), and `@katrix/server` checks its responses against it. The client's `RawEvent` type is now `ClientEvent`, and `UserIdentifier` and `AuthMetadata` come from the shared types; **code that imports `RawEvent` must use `ClientEvent`.**
  
  `@katrix/server`'s canonical JSON now refuses integers outside the spec's range (±(2^53 − 1)), as the client's did: such numbers do not survive a JSON round trip in JavaScript, and from 1e21 on they were written in exponent notation, which is not canonical JSON.
- e62fde5: The packages are built with tsdown again (unbundled: one module per source file, as before). They now ship source maps and declaration maps, so stack traces and "go to definition" lead to the TypeScript sources, and `@katrix/server`'s declarations no longer contain `#` imports, which some TypeScript setups could not resolve. No API changes.

## 0.4.0

### Minor Changes

- edb1286: The project is now Katrix (https://github.com/k18k/katrix). **This breaks existing code:** the homeserver library moved from `matrix-nodejs-homeserver` to `@katrix/server` (the audit bot from `matrix-nodejs-homeserver/auditbot` to `@katrix/server/auditbot`); install the new package and change your imports. The API itself is unchanged. The server now calls itself `@katrix/server` in `/_matrix/federation/v1/version` and sends `katrix` as its User-Agent for URL previews and SSO.
  
  New: `@katrix/client`, a Matrix client SDK for Node.js, browsers and React Native (Hermes) with end-to-end encryption (Olm and Megolm on `@noble/*`). Its crypto has not had an outside security review yet.
  
  From now on both packages are released together, with one version.

### Patch Changes

- 7c34131: Katrix is released on GitHub instead of the npm registry. Install the latest release with `npm install --allow-git=root github:k18k/katrix#server` (or `#client`), or a given one with `#server-X.Y.Z`; npm 12 needs `--allow-git=root` (or `allow-git=root` in `.npmrc`) to fetch git dependencies, and no token is needed. The package names and imports stay `@katrix/server` and `@katrix/client`. The old `matrix-nodejs-homeserver` package on npm gets no further releases.
