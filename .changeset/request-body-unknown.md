---
"@katrix/server": patch
---

Request bodies are typed `Record<string, unknown>` (`ctx.json()` no longer takes a type argument), so handlers check each field. The admin user API ignores a `password`, `displayname` or deletion `message` that is not a string; send_join/send_leave/send_knock and exchange_third_party_invite reject malformed events; and to-device messages for remote users are forwarded only when their device map is an object. Breaking for code that calls `ctx.json<T>()` in custom routes. ([#128](https://github.com/k18k/katrix/issues/128))
