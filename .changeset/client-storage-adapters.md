---
"@katrix/client": patch
---

Durable storage for the client (#117), so sessions, encryption keys and rooms survive restarts:

- `@katrix/client/sqlite` (`sqliteStorage`): SQLite through any library with `run` and `all`. That covers node:sqlite and better-sqlite3, and op-sqlite and expo-sqlite in React Native with a few lines of glue.
- `@katrix/client/indexeddb` (`indexedDbStorage`): browsers.

Both apply each batch atomically.
