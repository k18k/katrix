---
"matrix-nodejs-homeserver": patch
---

The user directory search no longer reads every room's state and every remote member one by one for each request: the members of public rooms are reused for up to 30 seconds (changes on the same instance show at once), and remote members are read in a batch. [#107](https://github.com/k18k/matrix-nodejs-homeserver/issues/107)
