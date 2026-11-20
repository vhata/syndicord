# Review index

Codebase reviews are immutable snapshots. The newest snapshot is the
current finding inventory; an empty index means no codebase review has
been recorded. Fixes supply evidence, and the next incremental review
verifies closure. Follow the
[review guide](../docket/CODE_REVIEW_GUIDE.md). Promoted work lives in
[BACKLOG.md](BACKLOG.md).

Newest reviews appear first. The top row is the next incremental
review's baseline; the newest Full row is the cumulative churn baseline.

| Review (UTC) | Type | Reviewed commit | Open findings at close |
| ------------ | ---- | --------------- | ---------------------- |

## Pending reconciliation

Record findings whose fixes have landed with independent verification.
The next incremental review verifies each and clears the list.

| Finding | Fix commit and PR | Reviewer | Evidence |
| ------- | ----------------- | -------- | -------- |
