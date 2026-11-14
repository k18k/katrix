---
"@katrix/server": patch
---

The public room directory describes rooms as `/hierarchy` and room summaries do: an empty room name, topic, alias or avatar is left out, and a `join_rule` that is not a string is reported as `invite`. ([#128](https://github.com/k18k/katrix/issues/128))
