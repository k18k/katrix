---
"@katrix/server": patch
---

`/createRoom` checks the whole request before it creates anything: a malformed `initial_state` event, `room_alias_name` or `power_level_content_override` now fails the request without leaving a half-created room behind, where before the room existed already when the error came. ([#128](https://github.com/k18k/katrix/issues/128))
