---
"matrix-nodejs-homeserver": patch
---

A homeserver running as the only instance on its database (no `cluster` adapter) now keeps track of where each user's, device's and room's data last changed. `/sync` uses it to skip most database reads that would find nothing new, such as to-device messages, account data, presence, receipts, membership changes and key counts. Memory use is bounded. With a cluster adapter, nothing changes ([#51](https://github.com/k18k/matrix-nodejs-homeserver/issues/51)).
