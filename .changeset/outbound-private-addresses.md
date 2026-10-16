---
"matrix-nodejs-homeserver": minor
---

Security ([#22](https://github.com/k18k/matrix-nodejs-homeserver/issues/22)): requests to addresses that users or remote servers choose (federation destinations, push gateways, identity servers, URL previews, remote media) no longer reach private addresses such as localhost, the LAN or cloud metadata. A deployment that federates over a LAN, or runs a push gateway on the same machine, allows them with the new `allowPrivateAddresses` option: `true` for all, or a list of ranges such as `["127.0.0.1/32"]`. URL previews are also protected against DNS rebinding and unchecked redirects of their images.
