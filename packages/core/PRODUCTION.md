# Running in production: threat model and checklist

A homeserver holds private messages, identities and credentials. This page lists what an attacker
can reach, what the library does about it, and what you, the operator, have to do. Each item says
where the evidence is: a test, an issue with its fix, or the code. Findings are reported as
described in [SECURITY.md](https://github.com/k18k/matrix-nodejs-homeserver/blob/main/SECURITY.md).

## Threat model

| Surface | Who can reach it | Main risks | Controls in the library |
|---|---|---|---|
| Client API without a token (`/login`, `/register`, discovery, OAuth endpoints) | anyone | credential stuffing, account enumeration, resource exhaustion | rate limits on login, registration and OAuth client registration; registration closed by default; body size limit (#77) |
| Client API with a token | every user | reading others' data, privilege escalation, flooding | per-user checks on every user-scoped route, history visibility on room reads (#78), `requireAdmin` on admin routes, rate limits on messages, joins, invites, uploads, room creation |
| Authentication lifecycle | anyone holding a token | stolen or replayed tokens | refresh rotation with reuse detection (#66), old tokens end at once on every node (#55), single-use login tokens (#56), registration-token limits (#81), revocation broadcast to every node |
| OAuth 2.0 API and its web pages | browsers | CSRF, open redirects, code interception | registered redirect URIs, PKCE S256, CSRF tokens, `SameSite`/`HttpOnly` cookies, `Origin` checks, `Referrer-Policy: same-origin` (#71), `frame-ancestors 'none'` |
| Media | every user, and anyone opening a media URL | stored XSS, memory exhaustion, path traversal | `Content-Security-Policy: sandbox` and `nosniff` on every media response (#79), attachment disposition for active types, upload limit enforced while streaming (#77), sanitised storage keys |
| Outbound requests (URL previews, push gateways, identity servers, remote media) | users choose the URL | SSRF into the internal network | private and internal addresses blocked by default, checked at connect time (DNS rebinding) and on every redirect; URL previews off by default |
| Federation | other servers | forged events, hostile remote servers, resource exhaustion | off by default; signed requests and events, auth rules, server ACLs, linear-time glob matching (#2) |
| E2EE | — | the server sees metadata only | message content of encrypted rooms never reaches the server; it does see who talks to whom, when, and device lists |
| Several instances | — | split brain, stale caches | cluster locks with lost-lease fencing (#57), cache invalidation over the cluster channel |

## Checklist

**Pass** is verified for the library; **Operator** is yours to check for each deployment.

### Library (checked before each release)

| Requirement | Status | Evidence |
|---|---|---|
| No High or Critical security finding open | Pass | issues labelled `security`; CodeQL alerts triaged |
| Request bodies are bounded before they are buffered | Pass | `test/http/body.test.ts` (#77) |
| Single-use tokens are redeemed once, also under concurrency | Pass | `test/core/auth.test.ts` (#56, #81) |
| Token revocation and rotation reach every instance | Pass | `test/core/auth.test.ts` (#55) |
| Storage keeps the guarantees the server relies on | Pass | `test/storage/conformance.test.ts` on memory, SQLite and Postgres (#58) |
| Outbound requests cannot reach private addresses by default | Pass | `test/core/outbound.test.ts`, `test/api/preview.test.ts` |
| Media cannot run scripts on the server's origin | Pass | `test/api/media.test.ts` (#79) |
| Users cannot read rooms they may not see | Pass | `test/api/rooms.test.ts` (#78), Complement |
| Secure defaults: registration, guests, federation, URL previews off | Pass | `src/adapters/auth.ts`, `src/homeserver.ts` |
| Passwords stored with scrypt; no tokens, passwords or keys in logs | Pass | `src/core/crypto.ts`; reviewed with `grep` over logger calls |
| No runtime dependencies (zod is bundled); published with npm provenance | Pass | `package.json`, `.github/workflows/release.yml` |
| Dependency and code scanning on every change | Pass | CodeQL, Dependabot security updates, `npm audit` in reviews |
| An independent review of the critical paths | Pass | Strix scan of 2026-10-20 (#76–#79, #81, #83), earlier reviews (#54–#57) |

### Deployment (operator)

| Requirement | Status |
|---|---|
| TLS terminated in front of the server (the library speaks plain HTTP); HSTS on the public name | Operator |
| Only `/_matrix/`, `/_synapse/` and `/.well-known/matrix/` routed to the homeserver | Operator |
| Registration policy chosen on purpose: closed, tokens, or open with rate limits and a captcha in front | Operator |
| Federation turned on only if needed; then port 8448 (or delegation) reachable and the signing key backed up | Operator |
| The signing key passed as `signingKey` from a secret store, or the database protected like a secret (the key is stored in it otherwise) | Operator |
| Database and media backed up, and a restore tried at least once | Operator |
| Several instances only with Postgres (or MySQL) and `postgresCluster` | Operator |
| `maxUploadSize` set for your storage and memory; the reverse proxy's body limit no larger | Operator |
| Logs and the `request` event collected; alerts on error rates, 5xx and memory | Operator |
| `allowPrivateAddresses` left off unless the server must reach internal services, and then a list of them, not `true` | Operator |
| Updates applied when a release says "Security fix" | Operator |
