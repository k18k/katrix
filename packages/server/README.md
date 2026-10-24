# @katrix/server

[![Complement](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fk18k%2Fkatrix%2Fcomplement-results%2Fbadges%2Fcomplement.json)](https://github.com/k18k/katrix/actions/workflows/ci.yml)
[![Load test: SQLite](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fk18k%2Fkatrix%2Floadtest-results%2Fbadges%2Fsqlite.json)](https://github.com/k18k/katrix/actions/workflows/loadtest.yml)
[![Load test: Postgres](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fk18k%2Fkatrix%2Floadtest-results%2Fbadges%2Fpg-nocluster.json)](https://github.com/k18k/katrix/actions/workflows/loadtest.yml)
[![Load test: Postgres cluster, 1 node](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fk18k%2Fkatrix%2Floadtest-results%2Fbadges%2Fpg-cluster-1.json)](https://github.com/k18k/katrix/actions/workflows/loadtest.yml)
[![Load test: Postgres cluster, 2 nodes](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fk18k%2Fkatrix%2Floadtest-results%2Fbadges%2Fpg-cluster-2.json)](https://github.com/k18k/katrix/actions/workflows/loadtest.yml)

The homeserver of [Katrix](https://github.com/k18k/katrix) (formerly `matrix-nodejs-homeserver`, renamed in 0.4.0): a
[Matrix](https://matrix.org) homeserver as an importable Node.js library. It isn't
tied to any HTTP framework, database, auth system or deployment shape. You can use
it for a demo on SQLite, embed it in a monolith next to your existing users, or run
it as a horizontally scaled chat backend that replaces Slack or Teams.

- Node.js **22+** (tested on 22, 24 and 26; development uses 26). TypeScript with only erasable syntax (`erasableSyntaxOnly`), and no runtime dependencies (request bodies are checked by a small built-in validator, `src/core/vpm.ts`).
- Client-Server API, Server-Server API (federation), end-to-end encryption, sliding sync, VoIP/MatrixRTC and push
- Runs on `node:http`, Express, Fastify, Hono or any fetch runtime
- Stores data in SQLite, PostgreSQL, MySQL, memory or your own adapter
- Can run as several instances behind a load balancer
- Tested against [Complement](https://github.com/matrix-org/complement) in CI

## Installation

```sh
npm install @katrix/server
```

```ts
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHomeserver, getNodeHandler, sqliteAdapter, filesystemMedia } from "@katrix/server";

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

SQLite runs in WAL mode with `synchronous = NORMAL`: a commit survives a crash of the process,
but a power loss can roll back the last few. Pass `sqliteAdapter(db, { synchronous: "full" })`
to wait for the disk on every commit, at the cost of blocking the event loop each time.

Tables are created on startup. Writes for each event are atomic: SQLite uses
`BEGIN IMMEDIATE`, Postgres and MySQL use a dedicated pooled connection, and the
memory adapter keeps an undo log.

The Postgres adapter prepares its statements on each connection and reuses them. Behind a
pooler that does not support prepared statements (PgBouncer before 1.21, or in transaction
mode without `max_prepared_statements`), pass `postgresAdapter(pool, { preparedStatements: false })`.

To use another store, implement `DatabaseAdapter` (`create`, `upsert`, `findOne`,
`findMany`, `update`, `delete`, `max`, and optionally `migrate`, `transaction`,
`findManyBatch` and `upsertMany`).
The exported `schema` describes every model. If your driver can run parameterised
SQL, `sqlAdapter({ dialect, executor, transaction })` handles the SQL generation for you.

The guarantees an adapter must keep (atomic single writes with row counts, rollback, unique
primary keys under concurrency, idempotent migrations, value round-trips) are documented on
`DatabaseAdapter`, and the exported `adapterConformance` checks them, independent of a test framework:

```ts
import { adapterConformance, CONFORMANCE_SCHEMA } from "@katrix/server";

for (const check of adapterConformance)
  test(check.name, async () => {
    const db = myAdapter(); // a fresh, empty store for each check
    await db.migrate?.(CONFORMANCE_SCHEMA);
    await check.run(db);
  });
```

The bundled adapters pass it in CI (memory, SQLite, Postgres). `memoryAdapter` keeps nothing across
restarts, and `sqliteAdapter` serves one process; several instances need Postgres (or MySQL) with
`postgresCluster`. An adapter without `transaction()` works, but a crash during a write can leave
a room event half stored; the server warns about it at startup.

## Scaling horizontally

By default a homeserver assumes it is the only process using its database. To run
several instances behind a load balancer, give them a shared **cluster adapter**:

```ts
import { postgresCluster } from "@katrix/server";

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
- **SSO with upstream providers:** OpenID Connect (Google, Keycloak,
  Authentik, Better Auth, …) or plain OAuth 2.0 such as GitHub
  (`githubProvider({ clientId, clientSecret })`). Users can sign in with `m.login.sso`:
  ```ts
  sso: { providers: [{ id: "google", name: "Google", issuer: "https://accounts.google.com",
    clientId, clientSecret, mapUser: (claims) => ({ localpart: claims.email.split("@")[0] }) }] },
  publicBaseUrl: "https://matrix.example.com",
  ```
  After signing in, users confirm the client the login token goes to, on a page
  that names it. Clients you trust skip that page:
  `sso: { providers, clientAllowlist: ["https://app.element.io/"] }`.
- **The OAuth 2.0 API, served by the homeserver** (spec v1.15–v1.18). Clients
  such as Element X register themselves, and users sign in, register, approve
  the client and manage their account on the server's own web pages. Those pages
  offer the password and the providers of `sso`. Login only with GitHub:
  ```ts
  import { createHomeserver, githubProvider } from "@katrix/server";

  createHomeserver({
    homeserver: "example.com",
    publicBaseUrl: "https://matrix.example.com",
    oauthServer: { termsUrl: "https://example.com/terms", policyUrl: "https://example.com/privacy" },
    userAuthAdapter: { passwordLoginEnabled: false },
    sso: { providers: [githubProvider({ clientId, clientSecret })] },
  });
  ```
  The GitHub OAuth app's callback URL is
  `https://matrix.example.com/_matrix/client/v3/login/sso/callback/github`. The first
  login creates the account. Users are matched by their GitHub ID, so a renamed
  GitHub account keeps its Matrix account.

  What is served: dynamic client registration with the spec's redirect URI
  rules, the authorization code grant with PKCE (S256), the device authorization
  grant (for CLIs and TVs), refresh tokens and revocation. It also covers
  `prompt=create`, the account management page with every action the spec
  lists, `m.oauth` for cross-signing resets, and ID tokens for clients that ask
  for `openid`. Access tokens live 5 minutes (`accessTokenLifetimeMs`). Refresh
  tokens rotate: a client whose response got lost can retry, and a refresh
  token used again after it was replaced logs the device out. The pages are
  under `/_synapse/client/oauth2/`. The legacy API stays available
  (`legacyApi: false` turns it off), and its `m.login.sso` goes through the same
  pages.
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
import { s3Media } from "@katrix/server";
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

## Audit bot

`@katrix/server/auditbot` records every room of the server to an archive, end-to-end
encrypted ones decrypted, like the Auditing of Element Server Suite Pro. The bot is a room
member with its own device, visible in member lists. See [AUDITBOT.md](https://github.com/k18k/katrix/blob/main/packages/server/AUDITBOT.md).

```ts
import { fileSink, startAuditBot } from "@katrix/server/auditbot";

await startAuditBot(hs, { sink: fileSink("/data/audit"), dataDir: "/data/auditbot", storePassphrase, rooms: "groups" });
```

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
| `publicBaseUrl` | Advertised via `/.well-known/matrix/client`. Required for SSO and `oauthServer`. |
| `oauthServer` | `true` or `{ legacyApi, accessTokenLifetimeMs, termsUrl, policyUrl, webSessionLifetimeMs }`: the OAuth 2.0 API, served by the homeserver. |
| `oauth`, `sso` | Delegated OAuth, and upstream identity providers (OIDC or OAuth 2.0, e.g. `githubProvider`). |
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

## Security

Before running a server in production, go through [PRODUCTION.md](PRODUCTION.md): the threat model,
what the library guarantees (with the tests that show it) and the operator's checklist. Report
vulnerabilities privately as described in [SECURITY.md](https://github.com/k18k/katrix/blob/main/SECURITY.md).

## Spec coverage

- **Accounts:** registration (open, closed or token-gated), password, SSO, OAuth, login tokens, refresh tokens, devices, deactivation
- **Rooms:** versions 1–12, presets, aliases, the directory, spaces (`/hierarchy`, `/room_summary`), upgrades, restricted and knock rooms
- **Events:** `/sync` (with filters, lazy loading and `state_after`), simplified sliding sync, `/messages` with backfill, `/context`, relations, threads, search, redactions, receipts, typing, presence, account data, tags
- **E2EE:** device keys, one-time and fallback keys, cross-signing, signatures, key backup, to-device (also over federation)
- **Push:** rule evaluation, notification counts, pushers, `/notifications`
- **Media:** legacy and authenticated endpoints, async uploads, thumbnails, the remote media proxy, URL previews
- **Federation, VoIP/MatrixRTC, admin, server notices**

[SPEC-COVERAGE.md](SPEC-COVERAGE.md) lists every endpoint of the latest stable spec (v1.19), whether
the server implements it, and whether Complement or a test here exercises it; all 156 client-server
and 35 server-server endpoints are implemented. Regenerate it with `scripts/spec-coverage.ts` after
a full Complement run.

Behaviour that changed between v1.12 and v1.19 was audited against the spec's changelogs. The gaps
found are tracked as issues ([#85](https://github.com/k18k/katrix/issues/85),
[#86](https://github.com/k18k/katrix/issues/86),
[#87](https://github.com/k18k/katrix/issues/87),
[#88](https://github.com/k18k/katrix/issues/88)); `/versions` will list v1.12 and
later once they are closed ([#89](https://github.com/k18k/katrix/issues/89)).
Unstable features (MSCs) are advertised in `/versions` under `unstable_features`: simplified sliding
sync (MSC4186), MatrixRTC (MSC4143), thread subscriptions (MSC4306) and others.

## Development

The repository is an npm workspace: this package is `packages/server`, and `apps/` holds the
public server built on it (see the repository's README). Install from the repository root;
the commands below run in `packages/server`.

```sh
npm install                      # at the repository root
npm run typecheck                # tsc only type-checks (noEmit)
npm run build                    # tsc → dist/ (what the published package contains)
node --conditions=matrix-src examples/node-http.ts      # development runs the TypeScript sources directly (type stripping)
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
built by TypeScript (`tsconfig.build.json`): one `.js` and one `.d.ts` per source module.
Sources import each other as `#core/x.ts`; `package.json` maps those imports to `dist/*.js` by
default, and to `src/*.ts` under the `matrix-src` condition. Anything that runs the sources
directly (tests, examples, Complement and load-test images) passes `--conditions=matrix-src`; the
TypeScript config sets it as a custom condition. `npm pack`, `npm publish` and
installs from GitHub build it through the `prepare` script. Recent npm versions ask you to
approve install scripts of git dependencies (`npm install-scripts approve`).

### Releasing

Changes that users of the package should know about come with a changeset:

```sh
npx changeset        # pick the bump (patch, minor, major) and describe the change
```

Commit the generated file in `.changeset/` with the change. On `main`, the Release workflow
keeps a "Release" pull request open that bumps the version and writes `CHANGELOG.md`.
`@katrix/server` and `@katrix/client` share one version (a `fixed` group in
`.changeset/config.json`). Merging the pull request publishes both to npm (trusted publishing,
with provenance), tags the releases and creates the GitHub releases.

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
| 10 | 214 / 214 | 851 / 851 | load-test fixes #25–#35: batched /sync reads, sync concurrency limit, Postgres lock leases, group commit (248ac8d) |
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

Tuning and investigation runs are local; a [workflow](https://github.com/k18k/katrix/blob/main/.github/workflows/loadtest.yml) runs the same scenarios on main for the badges. [loadtest/](loadtest/) holds a k6 scenario and a
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
DATA_DIR=/tmp/lt node --conditions=matrix-src loadtest/server.ts &
BASE_URL=http://localhost:8008 ONLINE_USERS=1000 MESSAGES_PER_SECOND=50 ROOMS=25 k6 run loadtest/k6/matrix.js
```

How many users does this machine support? `loadtest/capacity.sh` doubles the load until k6's
thresholds fail, narrows it down, and ends with a line such as "This machine safely supports
~N users online with 5 instances on one Postgres database" (one message per second per 10
users, 40 users per room; `NODES`, `START`, `RAMP` and `DURATION` change the setup).

```sh
packages/server/loadtest/capacity.sh
```

<!-- loadtest-results:start -->
The badges at the top come from the [Load test workflow](https://github.com/k18k/katrix/actions/workflows/loadtest.yml) on main: the same
scenario on one GitHub runner (4 CPUs), with k6 on the same machine, and clusters of two nodes
(five nodes would compete with Postgres and k6 for four CPUs). Each run's job summary has
the full table.

Latest results, on one developer machine (WSL2, Docker Desktop): 1000 users online in 25 rooms
(40 per room), 30 s ramp-up, then 30 s of messages. Times are p50 / p95; "sent" is the share of
the messages the scenario asks for that the server accepted (a server that falls behind takes
fewer, and then looks faster than it is).

At 10 messages/s (every user receiving one message every 2.5 s):

| Setup | send | delivery | sent | failed |
|---|---|---|---|---|
| SQLite, 1 process | 5 ms / 15 ms | 14 ms / 0.18 s | 100% | 0% |
| Postgres, no cluster | 9 ms / 30 ms | 29 ms / 0.60 s | 100% | 0% |

At 50 messages/s (every user receiving two messages a second, 59,000 deliveries in 30 s):

| Setup | req/s | send | /sync | delivery | sent | failed |
|---|---|---|---|---|---|---|
| SQLite, 1 process | 722 | 11 ms / 25 ms | 0.77 s / 1.3 s | 1.2 s / 1.6 s | 100% | 0% |
| Postgres, no cluster | 687 | 35 ms / 49 ms | 0.79 s / 1.2 s | 1.2 s / 1.6 s | 100% | 0% |
| Postgres, cluster, 1 node | 766 | 72 ms / 98 ms | 1.1 s / 1.5 s | 1.7 s / 2.2 s | 100% | 0% |
| Postgres, cluster, 5 nodes | 910 | 146 ms / 233 ms | 0.42 s / 1.6 s | 0.37 s / 1.5 s | 100% | 0% |

At 50 messages/s, delivery time is how long a process takes to rebuild the `/sync` of every
user in turn, since every user has something new in nearly every rebuild.

What the load tests found and fixed:
- presence written on every `/sync` (#26), one commit per push notification (#27), a missing
  index (#28), Postgres cluster locks that could deadlock the pool (#29), stream writes
  serialized per instance (#30), `/sync` reading every change on the server (#31) and every
  joined room (#33), lock handover by polling (#32), unbatched `/sync` reads (#34), syncs
  crowding out sends (#35);
- in 0.3.3 (#38–#47): rooms built one after another (#38), a statement per push notification
  (#39), Postgres re-planning every statement (#40), push rules copied per member (#41),
  needless to-device deletes (#42), concurrent reads as separate statements (#43), presence and
  device lists looked up per user (#44), costly batched reads (#45), an fsync per SQLite commit
  (#46), a blocked event loop (#47);
- since 0.3.3: waiting `/sync` requests rebuilt whenever anything on the server changed, and
  about two thirds of all rebuilds found nothing new (#50); a single instance now keeps track of
  where data last changed, so `/sync` skips reads that would find nothing, like Synapse's stream
  change caches (#51); queued syncs held the event loop, and yielding per statement made sends
  slow (#52).

The load test itself was fixed too: its senders registered during the measurement, so a slow
server was sent fewer messages, and nginx could start after k6 (a red badge with "100% failed").
<!-- loadtest-results:end -->

### Soak and failure injection

`test/core/reliability.test.ts` checks in every CI run what has to hold under concurrency,
restarts and failing writes: two nodes sending at once deliver every message to `/sync` exactly
once and in order, a sync token survives a restart, and a write that fails halfway leaves no trace
and does not stall `/sync`. Lost cluster leases (#57), concurrent token redemption (#56),
cross-node revocation (#55) and dropped Postgres connections (#91, #92) have tests of their own.

Longer runs are local. `loadtest/chaos.sh` runs the load scenario on Postgres with several nodes
and meanwhile restarts Postgres, kills one node (SIGKILL) and starts it again; `FAULTS=0` makes it
a plain soak run (`DURATION=1h`, `6h`, …). It prints each node's first and last 10-second report
(memory, event-loop delay, 5xx) and k6's summary.

```sh
ONLINE_USERS=1000 MESSAGES_PER_SECOND=20 ROOMS=25 RAMP=30s DURATION=5m NODES=3 packages/server/loadtest/chaos.sh
```

What has to hold: requests fail only while a fault lasts, every node serves again within seconds
after it ends, and no node exits. The first run found that a Postgres restart crashed every node
(#91) and cut them off from each other's messages for good (#92). Since then, on one developer
machine (3 nodes, 1000 users in 25 rooms, 20 messages/s for 5 minutes, Postgres restarted at
1:30 and a node killed from 2:30 to 3:30): k6's thresholds passed, 10 of 264,732 requests failed
(all during the faults), 99.99% of checks passed, message delivery p50 45 ms / p95 323 ms (the
slowest, 28 s, during the node kill), and memory stayed between 250 and 350 MB per node.

### Interoperability

[interop/](interop/) runs this server next to Synapse, federating both ways with certificates from
a throwaway CA, and `interop/run.ts` drives scenarios through both servers' client APIs: joins and
invites in both directions, messages, edits, reactions, redactions, state, typing and receipts,
backfill of history after a remote join, media over federation, profiles, leave and rejoin, and
end-to-end encryption in both directions with matrix-rust-sdk's crypto (the audit bot's client).
CI runs it on every change.

```sh
docker compose -p matrix-interop -f packages/server/interop/docker-compose.yml up -d --build --wait
node --conditions=matrix-src packages/server/interop/run.ts
docker compose -p matrix-interop -f packages/server/interop/docker-compose.yml down -v
```

With Synapse 1.163.1 all 11 scenarios pass. They found one bug: history right after a
partial-state join was out of reach (#94). Element and other UI clients are not automated.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free to use, modify and share for any noncommercial
purpose: personal use, study, hobby projects, and use by charities, schools, research,
public-safety and government organisations. Commercial use needs a separate agreement with
the author (contact via [github.com/k18k](https://github.com/k18k)). This is a
source-available license, not an OSI open-source one.
