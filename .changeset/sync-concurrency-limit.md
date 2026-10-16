---
"matrix-nodejs-homeserver": patch
---

Under load, sends and joins no longer wait behind the `/sync` requests that a message wakes: a process builds at most `maxConcurrentSyncs` (default 4) sync responses at once ([#35](https://github.com/k18k/matrix-nodejs-homeserver/issues/35)). In the Postgres load test, send p50 went from ~9 s to ~50 ms.
