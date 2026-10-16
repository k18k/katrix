---
"matrix-nodejs-homeserver": minor
---

Security ([#19](https://github.com/k18k/matrix-nodejs-homeserver/issues/19)): after an SSO login, the server no longer sends the login token straight to the address the login started from, which let a crafted link deliver a user's token to an attacker. Users now confirm the client on a page that names it; clients listed in the new `sso.clientAllowlist` option skip it. `redirectUrl`s with `javascript:`, `data:` and similar schemes are refused. The provider's discovery document must name the configured issuer, and with the `openid` scope the provider must return an ID token.
