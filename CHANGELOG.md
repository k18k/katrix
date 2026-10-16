# matrix-nodejs-homeserver

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
