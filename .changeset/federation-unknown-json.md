---
"@katrix/server": patch
---

Federation responses are checked before use: a `/state_ids` answer whose `pdu_ids` are not event IDs counts as having no state, a make_join/make_leave/make_knock template that is not a valid event is rejected, and a legacy-format event without an `event_id` is rejected as malformed. ([#128](https://github.com/k18k/katrix/issues/128))
