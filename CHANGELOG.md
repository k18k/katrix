# matrix-nodejs-homeserver

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
