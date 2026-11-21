# Review index

Codebase reviews are immutable snapshots. The newest snapshot is the
current finding inventory; an empty index means no codebase review has
been recorded. Fixes supply evidence, and the next incremental review
verifies closure. Follow the
[review guide](../docket/CODE_REVIEW_GUIDE.md). Promoted work lives in
[BACKLOG.md](BACKLOG.md).

Newest reviews appear first. The top row is the next incremental
review's baseline; the newest Full row is the cumulative churn baseline.

| Review (UTC)                                | Type | Reviewed commit                            | Open findings at close |
| ------------------------------------------- | ---- | ------------------------------------------ | ---------------------- |
| [2026-11-21 12:40](2026-11-21-1240-full.md) | Full | `81a9e9a529407e64bbc104ef773b0eb349c00ef5` | 6                      |
| [2026-11-20 10:45](2026-11-20-1045-full.md) | Full | `f9833b9836f3881b40717c4d8bccfeba42c82046` | 5                      |

The first snapshot records reviewed branch commit
`b4e3bb11e600ef3fe28b5ede3b5853c55e2151a3`, preserved by
[PR #8](https://github.com/vhata/syndicord/pull/8). Its Git tree exactly
matches the squash commit `f9833b9836f3881b40717c4d8bccfeba42c82046`
on main. The index uses that main commit as the baseline; the historical
snapshot and its findings remain unchanged.

## Pending reconciliation

Record findings whose fixes have landed with independent verification.
The next incremental review verifies each and clears the list.

| Finding | Fix commit and PR | Reviewer | Evidence |
| ------- | ----------------- | -------- | -------- |
