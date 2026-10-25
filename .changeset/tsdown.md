---
"@katrix/server": patch
"@katrix/client": patch
---

The packages are built with tsdown again (unbundled: one module per source file, as before). They now ship source maps and declaration maps, so stack traces and "go to definition" lead to the TypeScript sources, and `@katrix/server`'s declarations no longer contain `#` imports, which some TypeScript setups could not resolve. No API changes.
