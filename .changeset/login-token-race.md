---
"matrix-nodejs-homeserver": patch
---

Security fix: an `m.login.token` sent in several concurrent login requests could log in more than once. Exactly one of them now gets a session. [#56](https://github.com/k18k/matrix-nodejs-homeserver/issues/56)
