---
"matrix-nodejs-homeserver": patch
---

The admin API answers 403 to users who are not server admins before it looks at the request body; some endpoints answered with a body error instead ([#24](https://github.com/k18k/matrix-nodejs-homeserver/issues/24)).
