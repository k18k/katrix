# CLAUDE.md

## Findings are documented where they are fixed

Every finding gets a GitHub issue first, before it is fixed. A finding is anything a security scan, code review or bug report turns up. Label the issue `security` for vulnerabilities and `bug` for other defects.

Then, at each place in the code that fixes it, add a short comment with:
- the issue link;
- in a sentence or two, what was wrong and why the code now looks the way it does.

For security issues, also give the class, for example "ReDoS, CWE-1333", and what an attacker could do.

Example: `src/core/glob.ts` and its call sites, for issue #2.

Keep the exploit details out of the comment (no ready-made payloads); the issue describes the impact.

## Changes users should know about get a changeset

A change that users of the package would notice gets a changeset in `.changeset/` in the same commit: a feature, a fix, a behaviour change or a security fix. Write it with `npx changeset`, or as a file by hand. Pick the bump by its effect on users:
- `patch`: fixes;
- `minor`: new features, and breaking changes while the version is 0.x;
- `major`: breaking changes from 1.0 on.

Describe the effect in a sentence or two, for users rather than for maintainers. Link the issue when there is one.

Refactors, tests and CI changes need no changeset.
