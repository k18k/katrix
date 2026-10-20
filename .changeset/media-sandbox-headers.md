---
"matrix-nodejs-homeserver": patch
---

Security fix: thumbnails were served without the sandboxing `Content-Security-Policy` that downloads carry. With a thumbnailer that passes some formats through (such as SVG), an uploaded script could run on the homeserver's origin. All media responses now carry the sandbox and `X-Content-Type-Options: nosniff`. [#79](https://github.com/k18k/matrix-nodejs-homeserver/issues/79)
