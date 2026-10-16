---
"matrix-nodejs-homeserver": patch
---

`/sync` builds the changed rooms concurrently, and reads each room's timeline, state, receipts, account data and unread counts together rather than one after another. Each changed room also needs two fewer queries. Syncs on Postgres finish sooner and new messages arrive faster ([#38](https://github.com/k18k/matrix-nodejs-homeserver/issues/38)).
