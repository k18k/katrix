---
"matrix-nodejs-homeserver": patch
---

The OAuth 2.0 API's server metadata and issuer are also served at MSC2965's unstable paths (`/_matrix/client/unstable/org.matrix.msc2965/auth_metadata`, `…/auth_issuer`). Clients that use those before spec v1.15, such as Element X, now find the OAuth login. ([#73](https://github.com/k18k/matrix-nodejs-homeserver/issues/73))
