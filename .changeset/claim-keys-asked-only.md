---
"@katrix/server": patch
---

Security: `/keys/claim` now keeps a remote server's one-time keys only for the users and devices that were asked of that server, and only when they are well-formed keys. Before, a malicious server could answer for other users, local users among them, and replace the keys a client received for them. ([#135](https://github.com/k18k/katrix/issues/135))
