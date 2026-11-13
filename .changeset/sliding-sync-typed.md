---
"@katrix/server": patch
---

Sliding sync checks its whole request: a list, room subscription or extension with a field of the wrong type is read as if that field were absent, where before a malformed filter could hide every room or fail the request. An extension is on only with `enabled: true`, and a hero's `displayname` and `avatar_url` are sent only when they are strings. ([#128](https://github.com/k18k/katrix/issues/128))
