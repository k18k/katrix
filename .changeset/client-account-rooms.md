---
"@katrix/client": patch
---

The client covers much more of the Client-Server API (#117):

- account management on `client.account`: password, deactivation, 3PIDs, account data, ignored users, filters, OpenID and login tokens;
- devices on `client.devices`, profiles (any field) on `client.profile`, presence on `client.presence`;
- aliases, the public room directory, room summaries, user search and third-party networks on `client.directory`;
- admin endpoints on `client.admin`;
- on `MatrixClient`, knocking, room upgrades, state helpers, fetching events, context, relations and threads, timestamp lookups, read markers, threaded receipts, search, peeking, tags and reports.

`Auth` now also registers guests, checks usernames and registration tokens, requests email and phone tokens, resets passwords, and lists support contacts. User-interactive authentication goes through `withUserInteractiveAuth` with a callback such as `passwordAuth`.

Breaking: `whoami()` moved to `client.account`, `getProfile()` and `setDisplayName()` to `client.profile`, and `setAccountData()` to `client.account`.
