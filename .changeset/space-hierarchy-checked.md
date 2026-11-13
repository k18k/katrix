---
"@katrix/server": patch
---

The space hierarchy reads the children a remote server lists only when they have a string `state_key` and a `via` list of server names; a malformed child is skipped, where before it could fail the whole request. Room summaries report a `join_rule` that is not a string as `invite`. ([#128](https://github.com/k18k/katrix/issues/128))
