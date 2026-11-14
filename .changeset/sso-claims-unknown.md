---
"@katrix/server": patch
---

SSO checks what an identity provider returns: a discovery document without authorization and token endpoints, a token response or user info that is not a JSON object, and an ID token whose payload is not an object fail the login. `mapUser` receives claims typed `Record<string, unknown>`, and the default mapping ignores a `preferred_username` or `name` that is not a string. Breaking for `mapUser` functions that pass claims on without checking their type. ([#128](https://github.com/k18k/katrix/issues/128))
