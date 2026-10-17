---
"matrix-nodejs-homeserver": patch
---

`device_lists.changed` in `/sync` no longer lists room members whose membership was only rewritten, for example when a partial-state join completes. Only users who actually joined after the sync token are listed, as Synapse does ([#53](https://github.com/k18k/matrix-nodejs-homeserver/issues/53)).
