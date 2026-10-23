---
"matrix-nodejs-homeserver": patch
---

Fix: right after joining a remote room (with a partial-state join), paginating back returned no history before the join, and clients stopped there. Backfill now also asks the servers the join reported. [#94](https://github.com/k18k/matrix-nodejs-homeserver/issues/94)
