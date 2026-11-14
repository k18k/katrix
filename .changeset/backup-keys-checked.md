---
"@katrix/server": patch
---

Key backups skip an uploaded session key that lacks the spec's fields (numeric `first_message_index` and `forwarded_count`, boolean `is_verified`, object `session_data`), as they already skipped malformed rooms. Before, such a key was stored and compared with the next upload as if its numbers were missing. ([#128](https://github.com/k18k/katrix/issues/128))
