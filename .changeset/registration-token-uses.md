---
"matrix-nodejs-homeserver": patch
---

Security fix: a registration token with `uses_allowed` could register more accounts than allowed, through concurrent registrations, or when the token stage was not the last registration stage (its use was then not counted). Uses are now checked and counted together when the account is created. [#81](https://github.com/k18k/matrix-nodejs-homeserver/issues/81)
