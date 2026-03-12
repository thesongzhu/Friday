# Friday Archive Index

This index marks the historical audit, plan, review, report, and task material
that should no longer be used as the primary architecture source of truth.

## Current decision entrypoints

Use these documents for current work:

- [`docs/README.md`](../README.md) — single documentation entrypoint
- [`docs/current-source-of-truth.md`](../current-source-of-truth.md) — active architecture and contract baseline
- [`docs/VISION.md`](../VISION.md) — current product direction and deferred boundaries
- [`docs/ops/friday-capability-matrix.md`](../ops/friday-capability-matrix.md) — capability and maturity summary
- [`docs/reports/closeout/final-non-platform/latest.md`](../reports/closeout/final-non-platform/latest.md) — latest closeout evidence

## Archive policy

- Historical audits, plans, reviews, reports, and one-off tasklists remain in
  their existing paths for permalink stability.
- Former root-level markdown documents now live under:
  - [`docs/reference/README.md`](../reference/README.md)
  - [`docs/reports/repo/README.md`](../reports/repo/README.md)
  - [`docs/archive/root-docs/README.md`](root-docs/README.md)
- Those files are archived in place and marked at the top with an `Archived` or
  `Superseded` banner.
- Archived files may still be useful for archaeology, but they are not the
  source of truth for current architecture or contract decisions.

## Archived material families

The following families are archived and should be treated as historical:

- `docs/*plan*.md`
- `docs/*audit*.md`
- `docs/*review*.md`
- `docs/*report*.md`
- `docs/phase*-implementation-plan*.md`
- `docs/phase*-code-review-package*.md`
- `docs/reports/**/*.md`
- `docs/task/*.md`

When a historical file conflicts with current behavior, the current behavior and
`docs/current-source-of-truth.md` win.
