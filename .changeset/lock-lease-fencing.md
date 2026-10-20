---
"matrix-nodejs-homeserver": patch
---

`postgresCluster`: an instance that lost a cluster lock's lease (it could not renew it for 30 seconds, for example while the database was unreachable, or another instance took it over) carried on as if it still held the lock. Its database transactions under that lock now fail and roll back instead of committing alongside the new owner's. [#57](https://github.com/k18k/matrix-nodejs-homeserver/issues/57)
