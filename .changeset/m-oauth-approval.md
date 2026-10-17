---
"matrix-nodejs-homeserver": patch
---

Security: with delegated OAuth, the `m.oauth` step for replacing cross-signing keys passed as soon as the client named it, without the user approving anything. Anyone holding a user's access token could replace their cross-signing identity. The step now passes only within 10 minutes after the user approved the reset. With `oauthServer` the approval comes from the account page. With a delegated provider it comes through `POST /_synapse/admin/v1/users/{userId}/_allow_cross_signing_replacement_without_uia`, which matrix-authentication-service calls. ([#65](https://github.com/k18k/matrix-nodejs-homeserver/issues/65))
