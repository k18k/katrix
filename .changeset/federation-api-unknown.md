---
"@katrix/server": patch
---

The federation API checks fields of incoming requests before use: `/3pid/onbind` skips invites that are not objects, the room hierarchy lists only `allowed_room_ids` that are room IDs, and stripped invite state entries that are not objects are ignored. ([#128](https://github.com/k18k/katrix/issues/128))
