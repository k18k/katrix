---
"@katrix/server": patch
---

Event content is typed `Record<string, unknown>` in the server, so each field is checked where it is read. An event whose field has the wrong type (a non-string `membership`, `creator`, `displayname` or `join_rule`, for example) is now treated as if the field were missing, instead of the value being used as is. ([#128](https://github.com/k18k/katrix/issues/128))
