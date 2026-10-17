---
"matrix-nodejs-homeserver": patch
---

After a restart on a persistent database without the Postgres cluster adapter, audit log entries, content reports and application service transactions failed with a unique constraint error until their IDs passed the ones already stored. Audit entries were lost in that time. Startup now continues every such sequence after the stored IDs. ([#70](https://github.com/k18k/matrix-nodejs-homeserver/issues/70))
