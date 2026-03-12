# Friday Current Truth Audit

Snapshot date: 2026-03-11

This audit locks the repo state that existed before the marketplace actor-isolation repair and closeout refresh work in this batch.

| Bucket | Item | Current fact | Planned disposition |
| --- | --- | --- | --- |
| Done and on main | Canonical marketplace/source-of-truth docs | `docs/current-source-of-truth.md` already documents `/v1/marketplace/requests*`, creator support, and support-first marketplace semantics on `main` (`4cf0cd7`). | Keep as canonical truth unless the repaired runtime behavior requires a wording refresh. |
| Done but not on main | `codex/marketplace-final-proof-refresh` | Branch is `1` docs-only commit ahead of `main` at `3ebf359`; it refreshes marketplace proof files only. | Do not merge as-is. Regenerate marketplace proof on final post-fix `main`, then retire the stale proof branch as superseded. |
| Known bug still open | Marketplace request/support actor isolation | Request board and creator support currently collapse `tenantId` into `principalId`; private requests are not owner-only and request ownership checks only look at principal. | Fix in this closeout by adding auth tenant plumbing plus `MarketplaceActorContext { tenantId, principalId }`. |
| Evidence stale | `final-non-platform/latest.*` | Final non-platform closeout still reports `Git SHA: d322c61` even though `main` was `4cf0cd7` when this audit was taken. `check:closeout:truth:final` still passed because it only validates text fragments, not report SHA freshness. | Add evidence freshness guard and regenerate final closeout after targeted fixes pass. |
| Deferred by design | `competent-rosalind` | Branch is `12` commits ahead of `main`, carries unrelated fixes, and is attached to a live separate worktree. | Audit and track separately; do not merge, delete, or block this marketplace closeout on it. |
| Deferred by design | Broader marketplace tenant/principal cleanup | Marketplace commerce still contains other `tenantId = principalId` assumptions outside request board and creator support. | Leave outside this closeout unless they become direct blockers during validation. |
