---
"@katrix/server": patch
---

With delegated authentication (`oauth`), a token counts as active only when the introspection answer has `active: true`; an answer with any other value, such as the string `"true"`, is refused. `localpartFromClaims` receives claims typed `Record<string, unknown>`, and a `username`, `sub` or `name` that is not a string is ignored. Breaking for `localpartFromClaims` functions that read claims without checking their type. ([#128](https://github.com/k18k/katrix/issues/128))
