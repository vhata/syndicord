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

- [RELAY] `protect-feed-access-urls` — **Keep configured feed credentials out of Discord links.** Query and path tokens currently appear in source links and entry-link fallbacks.
  - Source: [Full review, 2026-11-20](2026-11-20-1045-full.md), 2026-11-20
  - Starting point: `src/discord.ts` (`buildMessage`) and `test/discord.test.ts`; verify both token forms and absent entry links without changing feed identity.
  - Findings: `feed-credential-source-links`

- [RELAY] `bound-feed-html-cleanup` — **Make feed HTML cleanup linear in input size.** Repeated unterminated tags consume quadratic CPU inside the existing feed-size bound.
  - Source: [Full review, 2026-11-20](2026-11-20-1045-full.md), 2026-11-20
  - Starting point: `src/feed.ts` (`text`) and `test/feed.test.ts`; use adversarial scaling cases while preserving stored fallback identities.
  - Findings: `quadratic-feed-html-cleanup`

- [TOOLING] `isolate-package-test-git-state` — **Keep package-installation fixtures independent of caller Git state.** Inherited Git selectors can redirect fixture commits into the enclosing repository.
  - Source: [Full review, 2026-11-20](2026-11-20-1045-full.md), 2026-11-20
  - Starting point: `test/package-acceptance.ts`; clear Git-local environment variables and prove a disposable parent repository's HEAD, index, worktree, and configuration remain unchanged.
  - Findings: `package-test-inherits-git-selectors`

- [RELAY] `normalize-atom-html-mime-content` — **Normalize Atom HTML content expressed with MIME types.** Valid content currently displays literal markup in Discord excerpts.
  - Source: [Full review, 2026-11-20](2026-11-20-1045-full.md), 2026-11-20
  - Starting point: `src/feed.ts` and `test/feed.test.ts`; cover `text/html`, `application/xhtml+xml`, and plain text while preserving existing fallback identities.
  - Findings: `atom-content-mime-html`
