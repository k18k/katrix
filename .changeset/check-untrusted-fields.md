---
"@katrix/server": patch
"@katrix/client": patch
---

Fields of incoming JSON are now checked before use. The server rejects a `createRoom` `initial_state` event whose `state_key` is not a string (it was stored as is). The client ignores call signalling with a malformed `party_id`, ICE candidate, stream metadata or negotiate description instead of adopting it, and reads verification MACs only when they are a map of strings. ([#128](https://github.com/k18k/katrix/issues/128))
