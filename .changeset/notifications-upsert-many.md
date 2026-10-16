---
"matrix-nodejs-homeserver": patch
---

Push notifications of an event are written with a few multi-row statements instead of one per room member, which takes load off the database when messages are sent in large rooms. Database adapters can provide the new optional `upsertMany(model, rows)`; without it, rows are upserted one by one ([#39](https://github.com/k18k/matrix-nodejs-homeserver/issues/39)).
