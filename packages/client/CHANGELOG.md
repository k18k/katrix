# @katrix/client

## 0.4.0

### Minor Changes

- edb1286: The project is now Katrix (https://github.com/k18k/katrix). **This breaks existing code:** the homeserver library moved from `matrix-nodejs-homeserver` to `@katrix/server` (the audit bot from `matrix-nodejs-homeserver/auditbot` to `@katrix/server/auditbot`); install the new package and change your imports. The API itself is unchanged. The server now calls itself `@katrix/server` in `/_matrix/federation/v1/version` and sends `katrix` as its User-Agent for URL previews and SSO.
  
  New: `@katrix/client`, a Matrix client SDK for Node.js, browsers and React Native (Hermes) with end-to-end encryption (Olm and Megolm on `@noble/*`). Its crypto has not had an outside security review yet.
  
  From now on both packages are released together, with one version.
