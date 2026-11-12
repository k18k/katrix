---
"@katrix/server": patch
---

Push rules that match message text (mentions of your name, keyword rules) now find words the way the spec defines them: any character outside `A–Z`, `a–z`, `0–9` and `_` separates words. Names and keywords in Japanese or Chinese text, or next to accented letters, now notify; before, they did not (#118).
