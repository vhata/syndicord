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

- [RELAY] `protect-relative-entry-links` — **Keep private feed credentials out of resolved entry links.** Fragment and path-relative links currently inherit configured access tokens and publish them in Discord.
  - Source: [Full review, 2026-11-21](2026-11-21-1240-full.md), 2026-11-21
  - Starting point: `src/feed.ts`, `src/discord.ts`, and associated tests; cover fragment-only and path-relative links with synthetic query/path tokens while preserving entry identities and safe public links.
  - Findings: `relative-entry-links-inherit-feed-credentials`

- [RELAY] `bound-xml-prevalidation` — **Bound XML preprocessing for malformed documents.** Repeated unterminated comment or CDATA openers cause quadratic CPU work before rejection.
  - Source: [Full review, 2026-11-21](2026-11-21-1240-full.md), 2026-11-21
  - Starting point: `src/feed.ts:308` and `test/feed.test.ts`; use forward scans and adversarial scaling probes under the existing byte limit, preserving declaration rejection and valid comment/CDATA behavior.
  - Findings: `quadratic-xml-prevalidation`

- [RELAY] `preserve-webhooks-during-admin-upgrade` — **Preserve delivery when upgrading pre-web-admin configuration.** Populated D1 routes survive migration but their existing WEBHOOKS secret is no longer consumed.
  - Source: [Full review, 2026-11-21](2026-11-21-1240-full.md), 2026-11-21
  - Starting point: `migrations/0004_web_admin.sql`, `src/admin-store.ts`, deployment entrypoints and setup guidance; provide a validated transition or preflight before replacing a working runtime, and verify existing routes remain deliverable without exposing secrets.
  - Findings: `legacy-webhook-configuration-upgrade`

- [RELAY] `normalize-atom-html-mime-content` — **Normalize Atom HTML content expressed with MIME types.** Valid content currently displays literal markup in Discord excerpts.
  - Source: [Full review, 2026-11-20](2026-11-20-1045-full.md), 2026-11-20
  - Starting point: `src/feed.ts` and `test/feed.test.ts`; cover `text/html`, `application/xhtml+xml`, and plain text while preserving existing fallback identities.
  - Findings: `atom-content-mime-html`
