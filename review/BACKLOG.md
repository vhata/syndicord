# Review backlog

Only work promoted from codebase reviews belongs here. Entries are ready
for separate work and carry a `Findings:` line naming the review findings
they cover. Each finding maps to at most one entry. Follow the
[queue guide](../docket/TODO_GUIDE.md) for claims and resolution, and the
[review guide](../docket/CODE_REVIEW_GUIDE.md) for promotion.

## P0 Critical

## P1 High

## P2 Normal

## P3 Low

## Unprioritized

- [RELAY] `preserve-webhooks-during-admin-upgrade` — **Preserve delivery when upgrading pre-web-admin configuration.** Populated D1 routes survive migration but their existing WEBHOOKS secret is no longer consumed.
  - Source: [Full review, 2026-11-21](2026-11-21-1240-full.md), 2026-11-21
  - Starting point: `migrations/0004_web_admin.sql`, `src/admin-store.ts`, deployment entrypoints and setup guidance; provide a validated transition or preflight before replacing a working runtime, and verify existing routes remain deliverable without exposing secrets.
  - Findings: `legacy-webhook-configuration-upgrade`

- [RELAY] `normalize-atom-html-mime-content` — **Normalize Atom HTML content expressed with MIME types.** Valid content currently displays literal markup in Discord excerpts.
  - Source: [Full review, 2026-11-20](2026-11-20-1045-full.md), 2026-11-20
  - Starting point: `src/feed.ts` and `test/feed.test.ts`; cover `text/html`, `application/xhtml+xml`, and plain text while preserving existing fallback identities.
  - Findings: `atom-content-mime-html`
