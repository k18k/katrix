# matrix-nodejs-homeserver

A [Matrix](https://matrix.org) homeserver as an importable Node.js library. It isn't
tied to any HTTP framework, database, auth system or deployment shape. You can use
it for a demo on SQLite, embed it in a monolith next to your existing users, or run
it as a horizontally scaled chat backend that replaces Slack or Teams.

- Node.js **22+** (tested on 22, 24 and 26; development uses 26). TypeScript with only erasable syntax (`erasableSyntaxOnly`), and no runtime dependencies ([zod](https://zod.dev), used for request validation, is bundled).
- Client-Server API, Server-Server API (federation), end-to-end encryption, sliding sync, VoIP/MatrixRTC and push
- Runs on `node:http`, Express, Fastify, Hono or any fetch runtime
- Stores data in SQLite, PostgreSQL, MySQL, memory or your own adapter
- Can run as several instances behind a load balancer
- Tested against [Complement](https://github.com/matrix-org/complement) in CI

## Installation

```sh
npm install matrix-nodejs-homeserver
```

```ts
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHomeserver, getNodeHandler, sqliteAdapter, filesystemMedia } from "matrix-nodejs-homeserver";

const homeserver = createHomeserver({
  homeserver: "k18k.app",
  databaseAdapter: sqliteAdapter(new DatabaseSync("homeserver.db")),
  userAuthAdapter: { registrationEnabled: true },
  mediaAdapter: filesystemMedia("./media"),
});

createServer(getNodeHandler(homeserver)).listen(8008);
```

The adapters are optional. If you leave one out, or pass `{}`, the server uses
in-memory storage, built-in password auth (with registration **closed**) and
in-memory media.

## Frameworks

| Framework | Usage |
|---|---|
| `node:http` / `node:https` | `createServer(getNodeHandler(hs))` |
| Express / Connect | `app.use(getExpressHandler(hs))` (works with or without `express.json()`) |
| Fastify | `fastify.register(getFastifyPlugin(hs))` |
| Hono | `app.use("*", getHonoHandler(hs))` |
| Any fetch runtime | `getFetchHandler(hs)` → `(Request) => Promise<Response>` |

The handler serves `/_matrix/*`, `/.well-known/matrix/*` and `/_synapse/*`. Every
other path goes to `next()`. Federation also needs port 8448 (HTTPS), or `.well-known`
delegation to the port you serve on.

## Databases

```ts
sqliteAdapter(new DatabaseSync("hs.db"));           // node:sqlite or better-sqlite3
postgresAdapter(new pg.Pool({ connectionString }));  // node-postgres (pass a Pool to get transactions)
mysqlAdapter(mysql.createPool(uri));                 // mysql2/promise
memoryAdapter();                                     // tests / demos
```

Tables are created on startup. Writes for each event are atomic: SQLite uses
`BEGIN IMMEDIATE`, Postgres and MySQL use a dedicated pooled connection, and the
memory adapter keeps an undo log.

To use another store, implement `DatabaseAdapter` (`create`, `upsert`, `findOne`,
`findMany`, `update`, `delete`, `max`, and optionally `migrate` and `transaction`).
The exported `schema` describes every model. If your driver can run parameterised
SQL, `sqlAdapter({ dialect, executor, transaction })` handles the SQL generation for you.

## Scaling horizontally

By default a homeserver assumes it is the only process using its database. To run
several instances behind a load balancer, give them a shared **cluster adapter**:

```ts
import { postgresCluster } from "matrix-nodejs-homeserver";

createHomeserver({
  homeserver: "example.com",
  databaseAdapter: postgresAdapter(pool),
  cluster: postgresCluster(pool),
});
```

The cluster adapter provides:

- **Stream positions:** the global sequence is shared. Each instance tracks its
  in-flight writes, so `/sync` never skips an event that committed late.
- **Locks:** per-room write locks (keeping the room DAG linear), push-rule
  updates, per-destination federation sending, and startup migrations.
- **Pub/sub:** `/sync` long-poll wakeups, cache invalidation, typing notifications
  and token revocation.
- **Shared ephemeral state:** UIA sessions, SSO logins and transaction deduplication.

[examples/multi-node.ts](examples/multi-node.ts) is meant to run unchanged on several
machines behind a load balancer, all sharing one Postgres database, which also coordinates them. It also shows a media adapter backed by that database, since local
disks differ between machines.

The database adapter has to support concurrent access from several processes, so
use Postgres or MySQL. The SQLite and memory adapters are single-process. You can
implement `ClusterAdapter` yourself to use another backend (etcd, NATS, …).

## Authentication

```ts
createHomeserver({
  homeserver: "example.com",
  userAuthAdapter: {
    registrationEnabled: true,
    registrationRequiresToken: true,   // m.login.registration_token
    passwordLoginEnabled: true,
    async checkPassword({ userId, password, storedHash }) { /* LDAP, your user table… */ return true; },
    async autoProvision(userId) { return true; },   // create unknown users on login
    async validatePassword(pw) { return pw.length < 8 ? "Too short" : null; },
  },
});
```

- **Your app's own sign-in:** after authenticating a user your own way, call
  `await hs.auth.createLoginToken(userId)` and let the client exchange the token via
  `m.login.token`. You can also call `hs.auth.createSession(userId)` to issue an
  access token directly.
- **SSO with upstream OpenID Connect providers** (Google, GitHub via an OIDC
  bridge, Keycloak, Authentik, …). Users can sign in with `m.login.sso`:
  ```ts
  sso: { providers: [{ id: "google", name: "Google", issuer: "https://accounts.google.com",
    clientId, clientSecret, mapUser: (claims) => ({ localpart: claims.email.split("@")[0] }) }] },
  publicBaseUrl: "https://matrix.example.com",
  ```
  After signing in, users confirm the client the login token goes to, on a page
  that names it. Clients you trust skip that page:
  `sso: { providers, clientAllowlist: ["https://app.element.io/"] }`.
- **Delegated OAuth 2.0** (the Matrix OAuth API, e.g. with
  matrix-authentication-service, Keycloak or Authentik). The provider owns the
  accounts, and the homeserver validates its access tokens by introspection:
  ```ts
  oauth: { issuer: "https://auth.example.com/", clientId, clientSecret, accountManagementUrl },
  ```

## Federation

Federation is **off by default**, so a server only joins the Matrix network on purpose.
Turn it on with `federation: { enabled: true }`. It then needs no configuration beyond a
reachable port 8448, or `.well-known/matrix/server` delegation (`federationAddress`). The
implementation includes:

- Server discovery (`.well-known` and SRV) and signed requests
- A persistent outbound queue with retries
- Room versions 1–12 with full authorization rules and state resolution v2/v2.1
- Joins, invites, leaves and knocks over federation
- Backfill and missing-event recovery
- Remote media, profiles, directories, key queries and claims
- EDUs (typing, receipts, presence, device lists, to-device, signing keys)
- Server ACLs

```ts
federation: { enabled: true, allowedServers: ["partner.org"], blockedServers: ["spam.example"] },
```

Without federation, local users can only talk to each other: federation endpoints answer
`M_UNRECOGNIZED`, and remote users, rooms and media cannot be reached.

## VoIP and MatrixRTC

```ts
rtc: {
  turn: { uris: ["turn:turn.example.com:3478?transport=udp"], sharedSecret: process.env.TURN_SECRET },
  transports: [{ type: "livekit", livekit_service_url: "https://livekit-jwt.example.com" }],
},
```

TURN credentials are time-limited (coturn `static-auth-secret`). MatrixRTC
transports are advertised for Element Call. Delayed events (MSC4140) remove a
call membership when a client disappears.

## Push notifications

Push rules are evaluated for every event (all spec condition kinds). The results
drive unread and highlight counts (including per-thread counts) and
`/notifications`, and are delivered to HTTP pushers (Sygnal or any push gateway).

## Media

`memoryMedia()`, `filesystemMedia(dir)`, `s3Media({...})`, or your own
`{ put, get, delete?, maxUploadSize? }`.

`s3Media` works with AWS S3 and S3-compatible stores (MinIO, Cloudflare R2, Garage, Ceph). It signs
requests itself (AWS Signature Version 4), so no AWS SDK is needed:

```ts
import { s3Media } from "matrix-nodejs-homeserver";
createHomeserver({
  ...,
  mediaAdapter: s3Media({
    bucket: "matrix-media",
    region: "eu-central-1",            // "auto" for R2
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    // endpoint: "https://<account>.r2.cloudflarestorage.com",  // for non-AWS stores (path-style by default)
    // prefix: "media/",
  }),
});
```

Thumbnails come from a pluggable thumbnailer:

```ts
import sharp from "sharp";
createHomeserver({ ..., thumbnailer: sharpThumbnailer(sharp) });
```

URL previews are opt-in (`urlPreviews: true`), and private network addresses are
blocked by default.

## Email addresses and phone numbers

Accounts can have validated email addresses and phone numbers (3PIDs): for registration,
password reset, signing in, and for being found by invites. The server only needs a way to
deliver messages:

```ts
createHomeserver({
  ...,
  publicBaseUrl: "https://matrix.example.com",   // validation links point here
  threepid: {
    sendEmail: async ({ to, subject, text, html }) => { await mailer.send({ to, subject, text, html }); },
    sendSms: async ({ to, text }) => { await sms.send(`+${to}`, text); },   // optional
    requireEmailForRegistration: false,
  },
});
```

Invites by email address go through the identity server the client names (`id_server`), and
work without `threepid`.

## Account moderation

Admins can lock an account (it cannot be used until unlocked, but its sessions survive) or
suspend it (read-only: the user can still read, leave rooms, redact their own messages and
log out). Use the admin room (`users lock alice`), `PUT /_matrix/client/v1/admin/lock/{userId}`
and `.../admin/suspend/{userId}`, or `hs.admin.setLocked()` / `hs.admin.setSuspended()`.

## Admin room and first-user bootstrap

```ts
createHomeserver({
  ...,
  userAuthAdapter: { registrationEnabled: false },
  adminRoom: { firstUserIsAdmin: true },   // or simply `adminRoom: true`
});
```

This works like tuwunel or conduwuit. The **first account** registered on the server
becomes a server admin, even while registration is closed. It is placed in the admin
room (`#admins:<server>`) with an admin bot. From then on, admins manage the server
by chatting with the bot:

```
users list                      users create alice [password] [--admin]
users reset-password alice      users deactivate alice      users make-admin alice
users lock alice | unlock       users suspend alice | unsuspend   (reversible moderation)
tokens create 5 7               (5 uses, valid for 7 days)
registration open|close|token   (runtime setting; overrides the configuration)
rooms list | rooms info <room> | rooms delete <room> --purge
media purge 90                  notice alice "Maintenance tonight"
audit [user]                    reports list
server stats                    help
```

Making someone an admin (through the bot, `hs.admin.setAdmin()` or the admin API)
invites them to the admin room, and revoking admin removes them. Options:
`firstUserIsAdmin`, `firstUserCanRegister`, `botLocalpart`, `botDisplayName`,
`roomName` and `aliasLocalpart`.

## Audit log

```ts
audit: {
  enabled: true,
  database: true,                       // queryable via the admin API / `audit` command
  sink: (entry) => siem.send(entry),    // optional extra sink
  actions: ["login", "login_failed", "admin_action"],   // optional filter
  retentionDays: 365,
},
```

The audit log records successful and failed logins, logouts, registrations,
password changes, deactivations, devices, room creation and deletion,
kicks/bans/unbans, every state-changing admin API call and admin-room command,
registration tokens and settings, SSO logins, and content reports. Each entry has
the actor, target, IP, user agent and outcome. You can read it with
`GET /_synapse/admin/v1/audit_log?actor=&action=&since=` or the `audit` command.

Users can report content (`POST /rooms/{roomId}/report[/{eventId}]`). Reports show
up for admins (`/_synapse/admin/v1/event_reports`, `reports list`), and the admin
room is notified. `GET /_matrix/client/v3/admin/whois/{userId}` shows a user's
devices and IP addresses.

## Administration

You can use `hs.admin` from your own code:

```ts
await hs.admin.createUser("alice", { password: "…", admin: true });
await hs.admin.createRegistrationToken({ usesAllowed: 10 });
await hs.admin.deactivateUser("@spammer:example.com");
await hs.admin.deleteRoom(roomId, { purge: true });
await hs.admin.sendServerNotice("@alice:example.com", { msgtype: M.TEXT, body: "Maintenance tonight" });
```

`M` (exported from the package) holds the Matrix identifiers as one readonly object:
`M.ROOM.MEMBER` is `"m.room.member"`, `M.LOGIN.PASSWORD` is `"m.login.password"`.
`UNSTABLE` does the same for unstable and vendor identifiers:
`UNSTABLE.ORG.MATRIX.CROSS_SIGNING_RESET` is `"org.matrix.cross_signing_reset"`.

The same operations are available over HTTP at Synapse-compatible `/_synapse/admin/…`
paths (server admins only), so existing tools keep working.

## Options

| Option | Description |
|---|---|
| `homeserver` | Server name. Required. |
| `databaseAdapter`, `mediaAdapter`, `userAuthAdapter` | See above. |
| `cluster` | Cluster adapter for running several instances. |
| `adminRoom` | `true` or `{ firstUserIsAdmin, firstUserCanRegister, botLocalpart, … }`. Disabled by default. |
| `audit` | `{ enabled, database, sink, actions, retentionDays }`. Disabled by default. |
| `publicBaseUrl` | Advertised via `/.well-known/matrix/client`. Required for SSO. |
| `oauth`, `sso` | Delegated OAuth or upstream OIDC SSO. |
| `federation` | `{ enabled, verifyTls, allowedServers, blockedServers, fasterJoins }`. Off unless `enabled: true`. |
| `allowPrivateAddresses` | Lets requests to addresses that users or remote servers choose (federation, push gateways, identity servers, URL previews, remote media) reach private addresses: `true`, or ranges such as `["127.0.0.1/32"]`. Blocked by default. |
| `rtc` | `{ turn, transports }` |
| `delayedEvents` | `{ maxDelayMs, maxPerUser }` |
| `rateLimits` | `false`, or `{ limiter, rules }`. In-memory token buckets by default. Plug in a shared limiter when running a cluster. |
| `thumbnailer` | For example `sharpThumbnailer(sharp)`. |
| `urlPreviews` | `true` or `{ allowPrivateAddresses }`. |
| `registrationSharedSecret` | Turns on Synapse-compatible shared-secret registration. |
| `serverNotices` | `{ localpart, displayName, roomName }` |
| `signingKey` | `{ keyId, seed }`. By default a key is generated and stored in the database. |
| `defaultRoomVersion` | Defaults to `"10"`. Versions 1–12 are supported. |
| `accessTokenLifetimeMs` | Lifetime of access tokens issued together with refresh tokens. |
| `maxSyncTimeoutMs`, `cleanupIntervalMs` | Long-poll cap and the background cleanup interval. |
| `threepid` | Email/phone support: `{ sendEmail, sendSms, requireEmailForRegistration, sessionLifetimeMs }`. See below. |
| `support` | `{ contacts, supportPage }` served at `/.well-known/matrix/support`. |
| `federationAddress` | `"host:port"` served at `/.well-known/matrix/server` (delegation). |
| `loginViaExistingSession` | `POST /login/get_token` for signing in new devices. On by default (needs re-authentication). |
| `fetch`, `logger` | Outgoing HTTP client and logger. |

Call `await hs.close()` on shutdown. It ends long-polls, stops background jobs and
leaves the cluster cleanly. `hs.on("event", …)` and `hs.on("request", …)` are
available for integration and metrics.

## Spec coverage

- **Accounts:** registration (open, closed or token-gated), password, SSO, OAuth, login tokens, refresh tokens, devices, deactivation
- **Rooms:** versions 1–12, presets, aliases, the directory, spaces (`/hierarchy`, `/room_summary`), upgrades, restricted and knock rooms
- **Events:** `/sync` (with filters, lazy loading and `state_after`), simplified sliding sync, `/messages` with backfill, `/context`, relations, threads, search, redactions, receipts, typing, presence, account data, tags
- **E2EE:** device keys, one-time and fallback keys, cross-signing, signatures, key backup, to-device (also over federation)
- **Push:** rule evaluation, notification counts, pushers, `/notifications`
- **Media:** legacy and authenticated endpoints, async uploads, thumbnails, the remote media proxy, URL previews
- **Federation, VoIP/MatrixRTC, admin, server notices**

Not implemented: third-party identifiers (email/phone), application services,
and a built-in OAuth authorization server. For OAuth, delegate to an existing provider.

## Development

```sh
npm install
npm run typecheck                # tsc only type-checks (noEmit)
npm run build                    # tsdown → dist/ (what the published package contains)
node examples/node-http.ts       # development runs the TypeScript sources directly (type stripping)
```

Endpoints are procedures (`src/http/procedure.ts`): a route declares what it needs and a
handler, and the procedure checks the request in a fixed order (authentication, rate limit,
body, then the response) before and after the handler runs:

```ts
r.client("POST", "/rooms/:roomId/invite", procedure({
  auth: "user",                 // ctx.session (or "optional", "none")
  rateLimit: "invite",
  input: body({ user_id: lenient(z.string()), reason: lenient(z.string()) }), // ctx.input
  handler: async (ctx) => { /* ctx.hs, ctx.session, ctx.input, ctx.params */ },
}));
```

Inside `src`, modules import each other through the package's
[subpath imports](https://nodejs.org/api/packages.html#subpath-imports): `#core/errors.ts` is
`src/core/errors.ts`. The build turns them back into relative imports.

Node does not strip types from files inside `node_modules`, so the package ships `dist/`,
built by tsdown: one `.js` and one `.d.ts` per source module, with zod bundled under
`dist/vendor/`. `npm pack`, `npm publish` and
installs from GitHub build it through the `prepare` script. Recent npm versions ask you to
approve install scripts of git dependencies (`npm install-scripts approve`).

### Releasing

Changes that users of the package should know about come with a changeset:

```sh
npx changeset        # pick the bump (patch, minor, major) and describe the change
```

Commit the generated file in `.changeset/` with the change. On `main`, the Release workflow
keeps a "Release" pull request open that bumps the version and writes `CHANGELOG.md`.
Merging it publishes the package to npm (trusted publishing, with provenance), tags the
release and creates the GitHub release.

### Complement

```sh
scripts/complement.sh                                   # whole suite (only Docker is needed)
scripts/complement.sh ./tests/ -run 'TestLogin|TestSync' # selected tests
```

Complement runs in a Go container at the commit pinned in the script, and starts this
homeserver's image (rebuilt from the checkout on each run) through the Docker socket.

Live status, updated after every Complement run (full or targeted) with
`node complement/status.ts [--reset] --note "what changed" results.json…`
(`go test -json` output; the ledger lives in `complement/results.json`):

<!-- complement-status:start -->
<!-- Generated by complement/status.ts; do not edit by hand. -->

**214 / 214** top-level tests passing (100.0%) · **851 / 851** including subtests (100.0%)

`████████████████████`

| Area | Passing | |
|---|---|---|
| csapi | 105 / 105 | `██████████` |
| federation | 90 / 90 | `██████████` |
| msc2836 | 2 / 2 | `██████████` |
| msc3389 | 3 / 3 | `██████████` |
| msc3391 | 1 / 1 | `██████████` |
| msc3757 | 2 / 2 | `██████████` |
| msc3874 | 1 / 1 | `██████████` |
| msc3890 | 1 / 1 | `██████████` |
| msc3902 | 1 / 1 | `██████████` |
| msc3930 | 1 / 1 | `██████████` |
| msc3967 | 1 / 1 | `██████████` |
| msc4140 | 1 / 1 | `██████████` |
| msc4155 | 1 / 1 | `██████████` |
| msc4222 | 1 / 1 | `██████████` |
| msc4306 | 2 / 2 | `██████████` |
| msc4429 | 1 / 1 | `██████████` |

<details><summary>Progress history</summary>

| Run | Top-level | Subtests | Note |
|---|---|---|---|
| 9 | 214 / 214 | 851 / 851 | zod, procedures, M/UNSTABLE, SSO confirmation, outbound address policy, admin guard (ec5aa79) |
| 8 | 214 / 214 | 851 / 851 | Complement runs in a Go container (no submodule, no local Go); account locking/suspension, policy servers, 3PIDs, legacy sync endpoints |
| 7 | 214 / 214 | 851 / 851 | All Complement tests pass (previous full run: 211/214). Fallback keys stored apart from one-time keys; user directory public-room rules; MSC4311 create event required from v12 |
| 6 | 189 / 214 | 803 / 851 | Partial-state joins (MSC3902): all subtests pass |
| 5 | 188 / 214 | 785 / 851 | Full run #8 + partial-state joins (MSC3902) first pass |
| 4 | 207 / 214 | 785 / 851 | Extended profiles + MSC4429, MSC3967, MSC2836, MSC3389 recheck |
| 3 | 202 / 214 | 774 / 851 | MSC4306 thread subscriptions, MSC4102 receipts |
| 2 | 198 / 214 | 761 / 851 | Restricted rooms, knocking, spaces, MSC batch |
| 1 | 180 / 214 | 692 / 834 | Full run #7 |

</details>

<details><summary>Still failing (0)</summary>


</details>
<!-- complement-status:end -->

CI runs the whole suite with the same script. `complement/passing.txt` lists the tests
(and subtests) that are known to pass, and CI fails if any of them regress.

### Load testing

Load tests run locally, never in CI. [loadtest/](loadtest/) holds a k6 scenario and a
homeserver that reports, every 10 s, requests per second, memory, event-loop delay and
(with Postgres) how many queries wait for a pool connection and how long locks are held.

The scenario: `ONLINE_USERS` each hold a long-polling `/sync` open in one of `ROOMS` rooms,
while `MESSAGES_PER_SECOND` messages are sent in total. Every user registers and joins
through the client API. It measures each request type and the time from sending a message to
its arrival in other users' `/sync` (`message_delivery`).

```sh
# Postgres with N homeserver nodes behind nginx (round-robin, no sticky sessions)
ONLINE_USERS=1000 MESSAGES_PER_SECOND=50 ROOMS=25 RAMP=30s DURATION=30s \
  docker compose -p matrix-loadtest -f loadtest/docker-compose.yml up --build \
  --scale homeserver=5 --abort-on-container-exit --exit-code-from k6 k6
# CLUSTER=0: one process on Postgres without a cluster adapter

# SQLite, one process, no Docker (needs k6 installed)
DATA_DIR=/tmp/lt node loadtest/server.ts &
BASE_URL=http://localhost:8008 ONLINE_USERS=1000 MESSAGES_PER_SECOND=50 ROOMS=25 k6 run loadtest/k6/matrix.js
```

<!-- loadtest-results:start -->
Latest results: 1000 users online in 25 rooms (40 per room), 50 messages/s, 30 s ramp-up then
30 s at full load, on one developer machine (WSL2, Docker Desktop). Times are p50 / p95.

| Setup | req/s | send | /sync | join | delivery | messages delivered | failed |
|---|---|---|---|---|---|---|---|
| SQLite, 1 process (before #28–#33) | ~800 | 46 ms / 0.69 s | 0.50 s / 2.4 s | 61 ms / 0.15 s | 0.58 s / 0.78 s | 5,816 | 0% |
| Postgres, no cluster | 313 | 7.9 s / 10.6 s | 3.0 s / 4.8 s | 0.89 s / 8.4 s | 13.2 s / 15.6 s | 12,463 | 0% |
| Postgres, cluster, 1 node | 298 | 9.8 s / 12.1 s | 3.4 s / 4.4 s | 1.4 s / 10.4 s | 15.2 s / 17.0 s | 4,628 | 0% |
| Postgres, cluster, 5 nodes | 725 | 3.7 s / 12.5 s | 0.85 s / 2.9 s | 0.49 s / 5.2 s | 5.6 s / 13.0 s | 29,482 | 0% |

What the load tests found and fixed so far: presence written on every `/sync` (#26), one commit
per push notification (#27), a missing index (#28), Postgres cluster locks that could deadlock
the pool (#29), stream writes serialized per instance (#30), `/sync` reading every change on the
server (#31) and every joined room (#33), lock handover by polling (#32). On Postgres each node's
pool is still saturated by the queries `/sync` makes when a message wakes every member of a room;
that is the next thing being reduced.
<!-- loadtest-results:end -->

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free to use, modify and share for any noncommercial
purpose: personal use, study, hobby projects, and use by charities, schools, research,
public-safety and government organisations. Commercial use needs a separate agreement with
the author (contact via [github.com/k18k](https://github.com/k18k)). This is a
source-available license, not an OSI open-source one.
