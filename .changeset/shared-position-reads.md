---
"@katrix/server": patch
---

With a cluster adapter, `/sync` requests woken together share their reads of the cluster-wide stream position instead of each making its own. Under load these identical reads queued for the cluster's connection pool and delayed message delivery.
