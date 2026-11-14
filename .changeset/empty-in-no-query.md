---
"@katrix/server": patch
---

The SQL adapters answer a read with an empty `in` list without asking the database. Under load, every second `/sync` made such a read (the presence of users newly sharing a room, usually none), a round trip for nothing; message delivery in the load test got about a fifth faster.
