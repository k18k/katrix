# Security policy

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[k18k/katrix](https://github.com/k18k/katrix/security/advisories/new).
Please do not open a public issue for it.

The aim is to answer within 7 days. A confirmed vulnerability is fixed in a patch release, as fast as
its severity calls for: critical and high ones within days. The fix ships with a changeset that
says it is a security fix, and the advisory is published once the release is out.

## Supported versions

Until 1.0, only the latest release gets fixes (there are no backports).

## How the project handles findings

Every finding (from a report, a scan or a review) gets an issue labelled `security`, then a commit
that fixes it, closes the issue and comments the fix where it is made. Security checks run on every
change: CodeQL, secret scanning with push protection, Dependabot security updates, and a regression test for each fixed vulnerability.

For running a server in production, see the threat model and checklist in
[packages/server/PRODUCTION.md](packages/server/PRODUCTION.md).
