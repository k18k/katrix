# matrix-nodejs-homeserver

## 0.3.10

### Patch Changes

- 4024a28: Fix: a delayed event (MSC4140, used by MatrixRTC to end the call membership of a client that went away) was lost when sending it failed once, or when its instance stopped at that moment. It is now kept until it is sent, retried after 10 seconds, and never sent twice; only a send the room refuses drops it. [#100](https://github.com/k18k/matrix-nodejs-homeserver/issues/100)
- 99c3af6: Fix (Node and Express handlers): when a request was answered without reading its whole body (such as a 401 for an upload with an expired token), the response waited until the client had sent the rest, so a client that stopped sending got no answer for minutes. The response now goes out at once; the rest of the body is dropped for up to 5 seconds, then the connection is closed. [#103](https://github.com/k18k/matrix-nodejs-homeserver/issues/103)
- f575572: Security fix: a remote server's verify key that had expired was still accepted for signatures made after its expiry, when no newer key could be fetched. Expired keys now count only for events created while they were valid. [#98](https://github.com/k18k/matrix-nodejs-homeserver/issues/98)
- 859757e: Security fix: over federation, `event_auth` returned the auth chain (power levels, memberships, join rules) of events in other rooms than the one asked about, also rooms whose server ACL denies the asking server. [#97](https://github.com/k18k/matrix-nodejs-homeserver/issues/97)
- d118e39: Security fix: over federation, `get_missing_events` could return events of another room than the one asked about, including message contents a remote server was not allowed to see. [#96](https://github.com/k18k/matrix-nodejs-homeserver/issues/96)
- 2ad4bff: Fix: two concurrent uploads to the same pending media ID (`PUT /_matrix/media/v3/upload/...`) could both succeed and store different content under one ID. The second now gets `409 M_CANNOT_OVERWRITE_MEDIA`. [#102](https://github.com/k18k/matrix-nodejs-homeserver/issues/102)
- 76bc2bc: Fix (`memoryAdapter`): rolling back a transaction could overwrite a write made outside it in the meantime. Operations now wait while a transaction is open, as on SQLite. [#101](https://github.com/k18k/matrix-nodejs-homeserver/issues/101)
- 631f09f: Security fix: every URL preview request fetched the page and its image again and stored a new copy of the image, so one account could make the server download and keep any amount of data. Previews are now reused for an hour, built once for concurrent requests, and rate limited per user (new rate-limit action `preview`, 0.5/s with a burst of 10 by default). [#104](https://github.com/k18k/matrix-nodejs-homeserver/issues/104)
- a87be72: Fix (SQLite): a write that ran at the same moment as another request's transaction could end up inside that transaction, and was lost when it rolled back, although it had reported success. [#95](https://github.com/k18k/matrix-nodejs-homeserver/issues/95)
- f1b555b: Fix: `timestamp_to_event` over federation answered by arrival order instead of timestamp, so other servers could be given a later event than the nearest one. [#105](https://github.com/k18k/matrix-nodejs-homeserver/issues/105)
- fbc238a: Faster writes of large batches (such as push notifications in big rooms) on the SQL adapters: rows were grouped in quadratic time. [#106](https://github.com/k18k/matrix-nodejs-homeserver/issues/106)
- 41a26f7: The user directory search no longer reads every room's state and every remote member one by one for each request: the members of public rooms are reused for up to 30 seconds (changes on the same instance show at once), and remote members are read in a batch. [#107](https://github.com/k18k/matrix-nodejs-homeserver/issues/107)

## 0.3.9

### Patch Changes

- b9c4752: Fix: right after joining a remote room (with a partial-state join), paginating back returned no history before the join, and clients stopped there. Backfill now also asks the servers the join reported. [#94](https://github.com/k18k/matrix-nodejs-homeserver/issues/94)
- 4f6bc6a: Security fix: when `postgresCluster`'s connection for cluster messages dropped (a Postgres restart), it was not opened again, so the instance missed every later logout, token revocation and cache invalidation from the other instances, and kept accepting revoked tokens. It now reconnects, and drops its caches of shared state afterwards, since messages sent meanwhile are lost. [#92](https://github.com/k18k/matrix-nodejs-homeserver/issues/92)
- 2afaab6: Fix: a Postgres restart, or a dropped connection, crashed the process (`pg` emits an `error` event that nothing handled). `postgresAdapter` and `postgresCluster` now handle it; requests fail while the database is away and work again when it is back. [#91](https://github.com/k18k/matrix-nodejs-homeserver/issues/91)
- bf4b36d: The package is built with TypeScript itself instead of tsdown, and declares no dependencies (the audit bot's crypto module stays an optional peer dependency). The published files keep the same layout: one `.js` and one `.d.ts` per module under `dist/`.
- bd27e34: Request bodies are checked by a small built-in validator (vpm) instead of a bundled copy of zod: the published package is smaller and still has no runtime dependencies. Error responses for invalid bodies keep their Matrix error codes; the wording of some generic messages changed.

## 0.3.8

### Patch Changes

- 372092b: New: the guarantees a `DatabaseAdapter` must keep are documented on the interface, and `adapterConformance` (with `CONFORMANCE_SCHEMA`) lets you check a custom adapter against them with any test framework. The server now warns at startup when the adapter has no `transaction()`. [#58](https://github.com/k18k/matrix-nodejs-homeserver/issues/58)
- 096bdae: Application services can create their users' devices with `PUT /devices/{deviceId}` (answered with 201) and delete them without User-Interactive Authentication, as spec v1.17 (MSC4190) allows. Bridges no longer need `/login` to get devices. [#85](https://github.com/k18k/matrix-nodejs-homeserver/issues/85)
- 569a83e: CORS responses now allow `HEAD`, as the spec (v1.13) lists. [#86](https://github.com/k18k/matrix-nodejs-homeserver/issues/86)
- 8b8c801: Security fix: with guest access enabled, guests could join any room, also rooms whose `m.room.guest_access` does not allow them. Guests now join only rooms with `guest_access: can_join`, and leave a room when that setting is turned off, as the spec requires. [#87](https://github.com/k18k/matrix-nodejs-homeserver/issues/87)
- 42a99ac: Invite blocking from spec v1.18: with `m.invite_permission_config` set to `{ "default_action": "block" }` in a user's account data, every invite to them is refused with `403 M_INVITE_BLOCKED` (client invites, member state, federation), `createRoom` leaves them out of its invites, and pending invites are hidden from `/sync`. Blocked invites now use the error code `M_INVITE_BLOCKED` instead of `M_FORBIDDEN`, also for the unstable MSC4155 rules. [#88](https://github.com/k18k/matrix-nodejs-homeserver/issues/88)
- e0be361: `postgresCluster`: an instance that lost a cluster lock's lease (it could not renew it for 30 seconds, for example while the database was unreachable, or another instance took it over) carried on as if it still held the lock. Its database transactions under that lock now fail and roll back instead of committing alongside the new owner's. [#57](https://github.com/k18k/matrix-nodejs-homeserver/issues/57)
- e9b4dab: Security fix: an `m.login.token` sent in several concurrent login requests could log in more than once. Exactly one of them now gets a session. [#56](https://github.com/k18k/matrix-nodejs-homeserver/issues/56)
- a3ae21f: Fix: after a knock was rejected or an invite rescinded in a remote room, the next membership change for that user (a second rejection, an invite) was dropped in rooms of version 3 and later. [#84](https://github.com/k18k/matrix-nodejs-homeserver/issues/84)
- e1f2e55: Security fix: after a token refresh, the old access token was still accepted for the rest of that millisecond, on every node of a cluster. It is now rejected at once. [#55](https://github.com/k18k/matrix-nodejs-homeserver/issues/55)
- f2f2dfb: Security fix: a registration token with `uses_allowed` could register more accounts than allowed, through concurrent registrations, or when the token stage was not the last registration stage (its use was then not counted). Uses are now checked and counted together when the account is created. [#81](https://github.com/k18k/matrix-nodejs-homeserver/issues/81)
- 6dbae7d: `/versions` now lists spec versions v1.12 to v1.19. Clients that enable features by version (such as the OAuth 2.0 API from v1.15 on) now use them. [#89](https://github.com/k18k/matrix-nodejs-homeserver/issues/89)
- 4ffe9ea: Fix: when a user knocked again on a remote room right after their knock was rejected, the rejection could arrive over federation after the new knock and replace it, so the new knock never showed up in `/sync`. Membership events for rooms the server is not in no longer replace newer ones. [#48](https://github.com/k18k/matrix-nodejs-homeserver/issues/48)

## 0.3.7

### Patch Changes

- f6706fd: Security fix: thumbnails were served without the sandboxing `Content-Security-Policy` that downloads carry. With a thumbnailer that passes some formats through (such as SVG), an uploaded script could run on the homeserver's origin. All media responses now carry the sandbox and `X-Content-Type-Options: nosniff`. [#79](https://github.com/k18k/matrix-nodejs-homeserver/issues/79)
- 6e32ebb: Security fix: `GET /rooms/{roomId}/members?at=…` let a user who had left or been banned from a room read its member list at any later point, including the current one. `at` now has to point to a moment the user may see under the room's history visibility; otherwise the answer is `403`. [#78](https://github.com/k18k/matrix-nodejs-homeserver/issues/78)
- f1da38e: Security fix: the OAuth 2.0 token endpoint answered `500` to `Authorization: Basic` credentials with a malformed percent-escape, which any anonymous client could trigger. It now answers `401 invalid_client`. [#76](https://github.com/k18k/matrix-nodejs-homeserver/issues/76)
- a79edfd: Security fix: request bodies were read into memory in full before the upload limit was checked, so one oversized request could exhaust the server's memory; with the Node and Express handlers even without an access token. Bodies are now refused as soon as they pass the limit (`413 M_TOO_LARGE`), and the Node handler no longer reads a body before a handler asks for it. The limit (the media adapter's `maxUploadSize`, 50 MiB by default) now applies to every request body, not only uploads. [#77](https://github.com/k18k/matrix-nodejs-homeserver/issues/77)

## 0.3.6

### Patch Changes

- 80610f6: Admins can make a local user join a room: `hs.admin.joinUser(userId, roomIdOrAlias)` and Synapse's `POST /_synapse/admin/v1/join/{roomIdOrAlias}` with `{ "user_id" }`. Public rooms are joined directly. In other rooms, a local member who may invite invites the user first, so the room's members see who added them.
- 9770c09: New: an audit bot, `matrix-nodejs-homeserver/auditbot` (`startAuditBot(hs, { sink, dataDir, storePassphrase })`). It records every room of the server to an archive, one JSON line per event, like the Auditing of Element Server Suite Pro. End-to-end encrypted rooms are recorded decrypted: the bot is a room member with its own device, visible in member lists as "Audit log (this room is recorded)". `rooms: "groups"` leaves direct messages out. It needs the optional peer dependency `@matrix-org/matrix-sdk-crypto-nodejs`; the main entry point does not load it. See AUDITBOT.md.

## 0.3.5

### Patch Changes

- e82882d: Security: with delegated OAuth, the `m.oauth` step for replacing cross-signing keys passed as soon as the client named it, without the user approving anything. Anyone holding a user's access token could replace their cross-signing identity. The step now passes only within 10 minutes after the user approved the reset. With `oauthServer` the approval comes from the account page. With a delegated provider it comes through `POST /_synapse/admin/v1/users/{userId}/_allow_cross_signing_replacement_without_uia`, which matrix-authentication-service calls. ([#65](https://github.com/k18k/matrix-nodejs-homeserver/issues/65))
- e82882d: The homeserver can serve the spec's OAuth 2.0 API itself (`oauthServer` option). Clients such as Element X register on their own, and users sign in, register, approve clients and manage their account on the server's web pages. Covered: dynamic client registration, the authorization code grant with PKCE, the device authorization grant, refresh tokens, revocation, `prompt=create`, account management actions, and `m.oauth` for cross-signing resets. The legacy login API stays available unless `legacyApi: false`.
  
  Upstream identity providers no longer need OpenID Connect: a provider can give its endpoints directly. `githubProvider({ clientId, clientSecret })` sets up GitHub, so a server can offer GitHub as its only login.
  
  Breaking: tokens from OAuth (this server's or a delegated provider's) can no longer call endpoints that need User-Interactive Authentication (deleting devices, changing the password, deactivating, adding addresses). They get 403 with `account_management_uri` and are sent to account management, as the spec intends. `POST /keys/device_signing/upload` is the exception, through `m.oauth`.
- b2fe231: The OAuth 2.0 API's server metadata and issuer are also served at MSC2965's unstable paths (`/_matrix/client/unstable/org.matrix.msc2965/auth_metadata`, `…/auth_issuer`). Clients that use those before spec v1.15, such as Element X, now find the OAuth login. ([#73](https://github.com/k18k/matrix-nodejs-homeserver/issues/73))
- e82882d: Refreshing tokens no longer logs a client out when the refresh response gets lost: the old refresh token keeps working until the new access token is first used. A refresh token used again after that is treated as leaked and logs the device out. ([#66](https://github.com/k18k/matrix-nodejs-homeserver/issues/66))
  
  Refresh tokens no longer stop working after a week without use. The cleanup deleted them together with expired access tokens. ([#67](https://github.com/k18k/matrix-nodejs-homeserver/issues/67))
- 56f9a51: After a restart on a persistent database without the Postgres cluster adapter, audit log entries, content reports and application service transactions failed with a unique constraint error until their IDs passed the ones already stored. Audit entries were lost in that time. Startup now continues every such sequence after the stored IDs. ([#70](https://github.com/k18k/matrix-nodejs-homeserver/issues/70))

## 0.3.4

### Patch Changes

- 7e7b256: A homeserver running as the only instance on its database (no `cluster` adapter) now keeps track of where each user's, device's and room's data last changed. `/sync` uses it to skip most database reads that would find nothing new, such as to-device messages, account data, presence, receipts, membership changes and key counts. Memory use is bounded. With a cluster adapter, nothing changes ([#51](https://github.com/k18k/matrix-nodejs-homeserver/issues/51)).
- 5b0379f: `device_lists.changed` in `/sync` no longer lists room members whose membership was only rewritten, for example when a partial-state join completes. Only users who actually joined after the sync token are listed, as Synapse does ([#53](https://github.com/k18k/matrix-nodejs-homeserver/issues/53)).
- b1fb8e4: A waiting `/sync` (and sliding sync) no longer rebuilds its response whenever anything changes on the server, only when something changes for its user. Under load, most rebuilds used to find nothing new. Presence changes of local users and room state rebuilt after state resolution now wake the users concerned ([#50](https://github.com/k18k/matrix-nodejs-homeserver/issues/50)).
- 7e7b256: On SQLite, sends stay fast while many `/sync` requests are answered. In the load test, sends took 6 ms at the median instead of 0.1 s, and 19 ms at the 95th percentile instead of 2.5 s. `maxConcurrentSyncs` now defaults to 16 instead of 4, which brings messages to other users sooner on both SQLite and Postgres ([#52](https://github.com/k18k/matrix-nodejs-homeserver/issues/52)).
- 6fa306b: The homeserver logs a warning, with where it was allocated, when a stream position is held for more than 5 seconds: until it is released, no `/sync` gets past it ([#48](https://github.com/k18k/matrix-nodejs-homeserver/issues/48)).

## 0.3.3

### Patch Changes

- 7db0092: Batched reads on Postgres return each read's rows as one JSON array. Such statements take half as long for Postgres to plan and are faster to run ([#45](https://github.com/k18k/matrix-nodejs-homeserver/issues/45)).
- 7d013f6: On Postgres, reads that concurrent requests make at the same moment are sent to the database as one statement, which cuts the per-query overhead under load. In the load test, messages reached other users' `/sync` about 30% sooner. Nothing is cached ([#43](https://github.com/k18k/matrix-nodejs-homeserver/issues/43)).
  
  `DatabaseAdapter.findManyBatch` takes an optional second argument, `{ prepare }`, and `SqlExecutor.query` takes a third. Custom adapters that implement them can ignore these.
- 1b36be8: Push notifications of an event are written with a few multi-row statements instead of one per room member, which takes load off the database when messages are sent in large rooms. Database adapters can provide the new optional `upsertMany(model, rows)`; without it, rows are upserted one by one ([#39](https://github.com/k18k/matrix-nodejs-homeserver/issues/39)).
- a949e9e: The Postgres adapter prepares statements once per connection and reuses them, instead of having Postgres parse and plan every query again. Lists are now sent as one array parameter (`= ANY($1)`) and limits as parameters. If you use a connection pooler that does not support prepared statements, pass `postgresAdapter(pool, { preparedStatements: false })`. The SQLite adapter's statement cache is now bounded to 500 statements ([#40](https://github.com/k18k/matrix-nodejs-homeserver/issues/40)).
  
  Breaking: `PgPoolLike.query` is now called with a config object (`{ text, values, name }`), as `pg.Pool` and `pg.Client` accept. A custom object that only takes `(text, values)` needs updating.
- 79fb3d5: Push evaluation no longer copies every room member's push rules for each message, which cut the homeserver's CPU use when messages are sent in large rooms ([#41](https://github.com/k18k/matrix-nodejs-homeserver/issues/41)).
- 7551de3: The SQLite adapter sets `synchronous = NORMAL`, which SQLite recommends with WAL. Commits no longer wait for an fsync on the main thread, so a commit survives a crash of the process, but a power loss can roll back the last few commits. To wait for the disk on every commit, pass `sqliteAdapter(db, { synchronous: "full" })` ([#46](https://github.com/k18k/matrix-nodejs-homeserver/issues/46)).
- 14b3e10: On SQLite, the homeserver keeps taking new requests while it answers many `/sync` requests at once. Database calls now yield to the event loop every 10 ms, where under load the event loop could be blocked for seconds. In the load test, sends took 0.1 s instead of 0.74 s, and the server kept up with twice as many messages ([#47](https://github.com/k18k/matrix-nodejs-homeserver/issues/47)).
- 58a442d: Incremental `/sync` finds presence and device-list changes through a new index on `presence.stream`, instead of looking up every user who shares a room. This takes load off the database ([#44](https://github.com/k18k/matrix-nodejs-homeserver/issues/44)).
- 3c98489: `/sync` builds the changed rooms concurrently, and reads each room's timeline, state, receipts, account data and unread counts together rather than one after another. Each changed room also needs two fewer queries. Syncs on Postgres finish sooner and new messages arrive faster ([#38](https://github.com/k18k/matrix-nodejs-homeserver/issues/38)).
- 4b3d9e7: `/sync` deletes acknowledged to-device messages only when the previous response delivered some, rather than on every sync. Sync tokens of responses with to-device messages end in `_a` ([#42](https://github.com/k18k/matrix-nodejs-homeserver/issues/42)).
- fd12482: Unread counts in `/sync` read three columns of the unread notifications through an index on (user, room, position), instead of whole rows with their actions ([#36](https://github.com/k18k/matrix-nodejs-homeserver/issues/36)).

## 0.3.2

### Patch Changes

- ec5aa79: The admin API answers 403 to users who are not server admins before it looks at the request body; some endpoints answered with a body error instead ([#24](https://github.com/k18k/matrix-nodejs-homeserver/issues/24)).
- 0769859: Canonical JSON orders keys by Unicode code point, as the spec requires. Keys with characters outside the Basic Multilingual Plane (such as emoji) were ordered differently, so hashes and signatures of such events did not match other servers' ([#25](https://github.com/k18k/matrix-nodejs-homeserver/issues/25)).
- 1ab82d1: With `postgresCluster`, a lock released on one node wakes the nodes waiting for it at once, instead of them noticing on their next retry ([#32](https://github.com/k18k/matrix-nodejs-homeserver/issues/32)).
- fedf18a: Incremental `/sync` no longer scans every membership on the server: the memberships table gets an index on its stream position ([#28](https://github.com/k18k/matrix-nodejs-homeserver/issues/28)).
- fc9e5ba: Runs on Node.js 22 and 24 (LTS) as well as 26: the package now requires Node.js 22 or later instead of 26.
- b78be1a: Faster message sending in busy rooms: the push notifications for a new event are stored together in one transaction instead of one write per member ([#27](https://github.com/k18k/matrix-nodejs-homeserver/issues/27)).
- 8ae8f27: Security ([#22](https://github.com/k18k/matrix-nodejs-homeserver/issues/22)): requests to addresses that users or remote servers choose (federation destinations, push gateways, identity servers, URL previews, remote media) no longer reach private addresses such as localhost, the LAN or cloud metadata. A deployment that federates over a LAN, or runs a push gateway on the same machine, allows them with the new `allowPrivateAddresses` option: `true` for all, or a list of ranges such as `["127.0.0.1/32"]`. URL previews are also protected against DNS rebinding and unchecked redirects of their images.
- 63064b5: Servers using `postgresCluster` no longer hang under load: cluster locks are leases in the database instead of advisory locks that kept a pool connection busy, which could take every connection and stop the server ([#29](https://github.com/k18k/matrix-nodejs-homeserver/issues/29)).
- 1e43821: Much less database load from online users: `/sync` refreshes a user's last-active time at most once a minute instead of on every request, which took about half of the server's time under load ([#26](https://github.com/k18k/matrix-nodejs-homeserver/issues/26)).
- 0382deb: URL previews work for sites with IPv4 addresses again; every IPv4 host was refused as a private address ([#21](https://github.com/k18k/matrix-nodejs-homeserver/issues/21)).
- 0382deb: Security ([#20](https://github.com/k18k/matrix-nodejs-homeserver/issues/20)): when a remote server answers a media download with a link to the file, the server fetches that link only from public addresses, over http(s), with the media size limit. Before, a remote server could make it read internal addresses and pass the responses to a local user.
- f48fb4c: The Redis cluster adapter (`redisCluster`, with the `RedisLike` and `RedisSubscriberLike` types) is removed. Run several instances with `postgresCluster`, which coordinates them through the Postgres database they already share, or implement `ClusterAdapter` for another backend.
- 7f15fe9: Security ([#19](https://github.com/k18k/matrix-nodejs-homeserver/issues/19)): after an SSO login, the server no longer sends the login token straight to the address the login started from, which let a crafted link deliver a user's token to an attacker. Users now confirm the client on a page that names it; clients listed in the new `sso.clientAllowlist` option skip it. `redirectUrl`s with `javascript:`, `data:` and similar schemes are refused. The provider's discovery document must name the configured issuer, and with the `openid` scope the provider must return an ID token.
- 9f0b958: Faster writes with a cluster adapter: concurrent writes share the publish of their stream position instead of waiting for each other one by one ([#30](https://github.com/k18k/matrix-nodejs-homeserver/issues/30)).
- fb043d1: Incremental `/sync` sends its independent database reads together: one round trip per group on Postgres instead of one per read ([#34](https://github.com/k18k/matrix-nodejs-homeserver/issues/34)). Database adapters can implement the new optional `findManyBatch` for this.
- 3093483: Incremental `/sync` finds the rooms that changed with a few queries for all of the user's rooms and builds only those, instead of querying every joined room each time ([#33](https://github.com/k18k/matrix-nodejs-homeserver/issues/33)). Custom database adapters may receive a new `fields` option in `findMany`; returning whole rows remains correct.
- a46f2a5: Under load, sends and joins no longer wait behind the `/sync` requests that a message wakes: a process builds at most `maxConcurrentSyncs` (default 4) sync responses at once ([#35](https://github.com/k18k/matrix-nodejs-homeserver/issues/35)). In the Postgres load test, send p50 went from ~9 s to ~50 ms.
- 3093483: Incremental `/sync` reads only the membership and device-list changes that concern the user, instead of every change on the server since the token, and a new message loads the pushers of all notified members in one query ([#31](https://github.com/k18k/matrix-nodejs-homeserver/issues/31)).

## 0.3.1

### Patch Changes

- 7f9c651: `GET /_matrix/federation/v1/version` reports the installed version of the package instead of a hardcoded `0.1.0` ([#16](https://github.com/k18k/matrix-nodejs-homeserver/issues/16)).

## 0.3.0

### Minor Changes

- 0de468f: Federation is now off by default. A server joins the Matrix network only with `federation: { enabled: true }`; without it, local users can only talk to each other. Servers that federate today must add that option.
- 6107d6f: Export `M`, a readonly object with the Matrix identifiers the server uses (event types, login types, capabilities, push rule IDs, ...), so code can write `M.ROOM.MEMBER` or `M.LOGIN.PASSWORD` instead of the strings `"m.room.member"` and `"m.login.password"`. `UNSTABLE` does the same for identifiers outside the `m.` namespace, such as `UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET` for `"org.matrix.cross_signing_reset"`.

### Patch Changes

- c01ef31: zod is bundled into the package, so installing it no longer pulls in any dependencies.

## 0.2.0

### Minor Changes

- 975859c: License, packaging, request validation and security fixes.
  
  - **npm:** the package is now published on npm as `matrix-nodejs-homeserver` (it was `@k18k/matrix-nodejs-homeserver` on GitHub Packages).
  - **License:** the package is now under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Commercial use needs a separate agreement with the author.
  - **Packaging:** the package ships a built `dist/` (one `.js` and `.d.ts` per module, built with tsdown) instead of TypeScript sources with stripped `.js` files beside them.
  - **Validation:** request bodies of POST endpoints are validated with zod, a new runtime dependency. Unknown keys are still accepted, and the Matrix error codes are unchanged.
  - **Security:** fixed several denial-of-service bugs and weak randomness:
    - glob patterns from server ACLs, push rules, invite rules and filters are matched in linear time ([#2](https://github.com/k18k/matrix-nodejs-homeserver/issues/2));
    - room version strings from other servers are parsed in linear time ([#3](https://github.com/k18k/matrix-nodejs-homeserver/issues/3));
    - application service registration comments are parsed in linear time ([#4](https://github.com/k18k/matrix-nodejs-homeserver/issues/4));
    - random strings are uniform ([#5](https://github.com/k18k/matrix-nodejs-homeserver/issues/5));
    - generated account names use a secure random generator ([#6](https://github.com/k18k/matrix-nodejs-homeserver/issues/6)).
  - **Fix:** MSC4222 sync responses use the key the client asked with.
