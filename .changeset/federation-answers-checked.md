---
"@katrix/server": patch
---

Answers from other servers are checked where they are used: a remote alias resolves only to a valid room ID, the signatures a server adds to a restricted join or an invite are taken only when they are well-formed, and a `make_leave` or `make_knock` answer without an event fails with an error instead of a crash. ([#128](https://github.com/k18k/katrix/issues/128))
