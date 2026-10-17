---
"matrix-nodejs-homeserver": patch
---

The homeserver can serve the spec's OAuth 2.0 API itself (`oauthServer` option). Clients such as Element X register on their own, and users sign in, register, approve clients and manage their account on the server's web pages. Covered: dynamic client registration, the authorization code grant with PKCE, the device authorization grant, refresh tokens, revocation, `prompt=create`, account management actions, and `m.oauth` for cross-signing resets. The legacy login API stays available unless `legacyApi: false`.

Upstream identity providers no longer need OpenID Connect: a provider can give its endpoints directly. `githubProvider({ clientId, clientSecret })` sets up GitHub, so a server can offer GitHub as its only login.

Breaking: tokens from OAuth (this server's or a delegated provider's) can no longer call endpoints that need User-Interactive Authentication (deleting devices, changing the password, deactivating, adding addresses). They get 403 with `account_management_uri` and are sent to account management, as the spec intends. `POST /keys/device_signing/upload` is the exception, through `m.oauth`.
