---
"@katrix/server": patch
---

Faster `/sync` while many users come online: on a single instance a sync reads only the presence of the users it shares a room with whose presence changed, instead of every recent presence change on the server, and stream position reads no longer scan every entry of the in-process key-value store.
