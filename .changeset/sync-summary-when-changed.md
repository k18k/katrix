---
"@katrix/server": patch
---

Incremental `/sync` responses carry a room's `summary` only when its members, name or canonical alias changed, as Synapse does; clients keep the last summary they received. A room's first sync still has it. This saves rebuilding the summary from the room's whole state for every sync, about a tenth of the delivery time under load.
