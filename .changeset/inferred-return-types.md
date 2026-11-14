---
"@katrix/server": patch
"@katrix/client": patch
---

The published type declarations give functions their inferred return types instead of hand-written ones. Most are the same; some are now more precise, such as an object literal's exact fields instead of `Record<string, unknown>`. Code that relied on a wider declared type may need a type annotation of its own. ([#130](https://github.com/k18k/katrix/issues/130))
