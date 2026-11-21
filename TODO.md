# TODO

Ordinary follow-ups live here; promoted codebase-review findings live in
[review/BACKLOG.md](review/BACKLOG.md). Follow the
[queue guide](docket/TODO_GUIDE.md) when adding or claiming work.

## Needs triage

### Unprioritized

- [RELAY] `web-admin-security` — **Review and harden web administration security.** The initial interface uses the shared password requested for now; define and implement the next security controls separately.
  - Source: User request and PR #14, 2026-11-20
  - Starting point: `src/admin.ts`, `src/admin-store.ts`, and `docs/WEB.md`; assess authentication, request boundaries, and secret/key lifecycle before broadening access.

## Needs proof of concept

## Waiting

## Ready for separate work
