# TODO

Ordinary follow-ups live here; promoted codebase-review findings live in
[review/BACKLOG.md](review/BACKLOG.md). Follow the
[queue guide](docket/TODO_GUIDE.md) when adding or claiming work.

## Needs triage

### Unprioritized

- [RELAY] `multi-server-discord-permissions` — **Support operator-defined Discord role grants for feed creation and destination-scoped routing and webhook registration.** Separate instance security policy from Discord configuration permissions, and protect subscribed feed URLs by requiring explicit adoption of replacement feeds.
  - Source: User design discussion and [permission design](docs/specs/2026-11-22-discord-permissions.md), 2026-11-22
  - Starting point: `src/admin-auth.ts`, `src/admin.ts`, `src/admin-store.ts`, `src/config.ts`, and `cli/admin.ts`; settle the remaining maintenance and upgrade details in the design before implementation.

- [RELAY] `web-admin-security` — **Review remaining administration request boundaries and secret/key lifecycle.** Discord authentication, revocable sessions, and server/role authorization are implemented; assess any additional controls separately without broadening this authentication change.
  - Source: User request, PR #14, and `task/discord-admin-auth`, 2026-11-21
  - Starting point: `src/admin.ts`, `src/admin-store.ts`, and `docs/WEB.md`; assess request boundaries and secret/key lifecycle before broadening access.

## Needs proof of concept

## Waiting

## Ready for separate work
