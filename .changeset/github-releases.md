---
"@katrix/server": patch
"@katrix/client": patch
---

Katrix is released on GitHub instead of the npm registry. Install the latest release with `npm install --allow-git=root github:k18k/katrix#server` (or `#client`), or a given one with `#server-X.Y.Z`; npm 12 needs `--allow-git=root` (or `allow-git=root` in `.npmrc`) to fetch git dependencies, and no token is needed. The package names and imports stay `@katrix/server` and `@katrix/client`. The old `matrix-nodejs-homeserver` package on npm gets no further releases.
