---
"@katrix/server": patch
---

The stripped state of an invite or knock, which comes from the inviting or knocked server, is passed to clients in `/sync` and sliding sync without the entries that are not stripped state events (an event with a string `type`, `state_key` and `sender`, and an object `content`). Before, such entries reached clients with missing fields. ([#128](https://github.com/k18k/katrix/issues/128))
