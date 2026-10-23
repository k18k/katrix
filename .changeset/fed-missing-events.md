---
"matrix-nodejs-homeserver": patch
---

Security fix: over federation, `get_missing_events` could return events of another room than the one asked about, including message contents a remote server was not allowed to see. [#96](https://github.com/k18k/matrix-nodejs-homeserver/issues/96)
