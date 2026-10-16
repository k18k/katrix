---
"matrix-nodejs-homeserver": minor
---

The Redis cluster adapter (`redisCluster`, with the `RedisLike` and `RedisSubscriberLike` types) is removed. Run several instances with `postgresCluster`, which coordinates them through the Postgres database they already share, or implement `ClusterAdapter` for another backend.
