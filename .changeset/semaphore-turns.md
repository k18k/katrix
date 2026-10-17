---
"matrix-nodejs-homeserver": patch
---

On SQLite, sends stay fast while many `/sync` requests are answered. In the load test, sends took 6 ms at the median instead of 0.1 s, and 19 ms at the 95th percentile instead of 2.5 s. `maxConcurrentSyncs` now defaults to 16 instead of 4, which brings messages to other users sooner on both SQLite and Postgres ([#52](https://github.com/k18k/matrix-nodejs-homeserver/issues/52)).
