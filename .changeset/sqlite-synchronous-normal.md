---
"matrix-nodejs-homeserver": patch
---

The SQLite adapter sets `synchronous = NORMAL`, which SQLite recommends with WAL. Commits no longer wait for an fsync on the main thread, so a commit survives a crash of the process, but a power loss can roll back the last few commits. To wait for the disk on every commit, pass `sqliteAdapter(db, { synchronous: "full" })` ([#46](https://github.com/k18k/matrix-nodejs-homeserver/issues/46)).
