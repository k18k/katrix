---
"matrix-nodejs-homeserver": patch
---

Refreshing tokens no longer logs a client out when the refresh response gets lost: the old refresh token keeps working until the new access token is first used. A refresh token used again after that is treated as leaked and logs the device out. ([#66](https://github.com/k18k/matrix-nodejs-homeserver/issues/66))

Refresh tokens no longer stop working after a week without use. The cleanup deleted them together with expired access tokens. ([#67](https://github.com/k18k/matrix-nodejs-homeserver/issues/67))
