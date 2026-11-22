# TODO

Ordinary follow-ups live here; promoted codebase-review findings live in
[review/BACKLOG.md](review/BACKLOG.md). Follow the
[queue guide](docket/TODO_GUIDE.md) when adding or claiming work.

## Needs triage

### Unprioritized

- [RELAY] `initial-feed-entries` — **Design an option to send a few recent entries when a feed is added.** The first successful poll currently establishes a silent baseline, so a new subscription gives no immediate example of its content.
  - Source: User request, PR #25 and `task/docs-navigation`, 2026-11-22
  - Starting point: `docs/BEHAVIOR.md#baselines-and-entry-identity`, `src/ledger.ts`, and the browser/CLI subscription flows.
  - Decide the opt-in control, default and maximum entry count, selection/order when dates are absent or unreliable, and whether the option applies when adding a destination to an existing feed. Preserve duplicate prevention and retry behavior; distinguish first subscription from restoring a previous route.
  - Related: `busy-feed-delivery-policy`

- [RELAY] `busy-feed-delivery-policy` — **Design predictable delivery for busy feeds and document the reasons for polling limits.** Bursts and sustained traffic can outpace the shared delivery budget, while longer feed rotations can miss entries before they are observed.
  - Source: User request, PR #25 and `task/docs-navigation`, 2026-11-22
  - Starting point: `docs/BEHAVIOR.md#polling-limits`, `src/runner.ts`, `src/ledger.ts`, `src/http.ts`, `src/feed.ts`, and status reporting.
  - Decide pacing, batching or digests, ordering and fairness across feeds/destinations, retry and Discord cooldown interactions, and what happens to an excessive backlog; make any coalescing or dropped entries explicit to operators.
  - Assess polling cadence versus source retention, configuration and feed-size bounds, request/run deadlines, provider quotas, and growth of retained identities and pending payloads. Explain which limits protect runtime resources or correctness, how operators recognize approaching them, and the trade-offs of making them configurable or retaining less history.
  - Related: `initial-feed-entries`

- [RELAY] `web-admin-security` — **Review remaining administration request boundaries and secret/key lifecycle.** Discord authentication, revocable sessions, and server/role authorization are implemented; assess any additional controls separately without broadening this authentication change.
  - Source: User request, PR #14, and `task/discord-admin-auth`, 2026-11-21
  - Starting point: `src/admin.ts`, `src/admin-store.ts`, and `docs/WEB.md`; assess request boundaries and secret/key lifecycle before broadening access.

## Needs proof of concept

## Waiting

## Ready for separate work
