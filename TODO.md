# TODO

Ordinary follow-ups live here; promoted codebase-review findings live in
[review/BACKLOG.md](review/BACKLOG.md). Follow the
[queue guide](docket/TODO_GUIDE.md) when adding or claiming work.

## Needs triage

### Unprioritized

- [RELAY] `web-admin-security` — **Review remaining administration request boundaries and secret/key lifecycle.** Discord authentication, revocable sessions, and server/role authorization are implemented; assess any additional controls separately without broadening this authentication change.
  - Source: User request, PR #14, and `task/discord-admin-auth`, 2026-11-21
  - Starting point: `src/admin.ts`, `src/admin-store.ts`, and `docs/WEB.md`; assess request boundaries and secret/key lifecycle before broadening access.

## Needs proof of concept

## Waiting

## Ready for separate work
