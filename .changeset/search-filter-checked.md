---
"@katrix/server": patch
---

`POST /search` checks its `filter` as `/messages` and `/sync` do and answers `M_BAD_JSON` for a malformed one, where before it was used as far as it went. Event filters everywhere now also refuse `rel_types`/`not_rel_types` that are not lists of strings and `contains_url`, `lazy_load_members`, `include_redundant_members` or `unread_thread_notifications` that are not booleans. ([#128](https://github.com/k18k/katrix/issues/128))
