---
"matrix-nodejs-homeserver": patch
---

On SQLite, the homeserver keeps taking new requests while it answers many `/sync` requests at once. Database calls now yield to the event loop every 10 ms, where under load the event loop could be blocked for seconds. In the load test, sends took 0.1 s instead of 0.74 s, and the server kept up with twice as many messages ([#47](https://github.com/k18k/matrix-nodejs-homeserver/issues/47)).
