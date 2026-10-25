# CLAUDE.md

The repository is Katrix, an npm workspace: the published packages are `packages/server` (npm `@katrix/server`, the homeserver library) and `packages/client` (npm `@katrix/client`, the client SDK), released together with one version. `packages/shared` (`@katrix/shared`, private) holds what both need, the spec types of events and endpoints (`ClientEndpoints`) and portable helpers; tsdown builds it into both packages. `apps/` holds private apps built on them (`apps/public`, `apps/dev-idp`).

## Findings are documented where they are fixed

Every finding gets a GitHub issue first, before it is fixed. A finding is anything a security scan, code review or bug report turns up. Label the issue `security` for vulnerabilities and `bug` for other defects.

Each finding is then fixed in its own commit, which closes its issue (`Closes #N` in the message). Several findings from one scan are several issues and several commits, not one.

Then, at each place in the code that fixes it, add a short comment with:
- the issue link;
- in a sentence or two, what was wrong and why the code now looks the way it does.

For security issues, also give the class, for example "ReDoS, CWE-1333", and what an attacker could do.

Example: `packages/server/src/core/glob.ts` and its call sites, for issue #2.

Keep the exploit details out of the comment (no ready-made payloads); the issue describes the impact.

## Changes users should know about get a changeset

A change that users of the package would notice gets a changeset in `.changeset/` in the same commit: a feature, a fix, a behaviour change or a security fix. Write it with `npx changeset`, or as a file by hand.

Until 1.0, every changeset is a `patch` (releases go 0.4.1, 0.4.2, …) and backward compatibility is not kept: options, exports and adapters may change or go without deprecation. Say plainly in the changeset when a change breaks existing code. From 1.0 on, pick the bump by its effect on users: `patch` for fixes, `minor` for features, `major` for breaking changes.

Describe the effect in a sentence or two, for users rather than for maintainers. Link the issue when there is one.

Refactors, tests and CI changes need no changeset.
