---
"matrix-nodejs-homeserver": minor
---

License, packaging, request validation and security fixes.

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
