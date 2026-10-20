---
"matrix-nodejs-homeserver": patch
---

Application services can create their users' devices with `PUT /devices/{deviceId}` (answered with 201) and delete them without User-Interactive Authentication, as spec v1.17 (MSC4190) allows. Bridges no longer need `/login` to get devices. [#85](https://github.com/k18k/matrix-nodejs-homeserver/issues/85)
