# Friday Non-Platform Release Remediation Roadmap

## Decision

Current release recommendation: `Go`

The previously confirmed blocker has been cleared. The remaining items are closure refinement and ongoing product polish, not release-stop conditions.

## Priority 1 — Preserve truth alignment

### Work item

- Keep marketplace, autonomy, and fleet wording aligned across:
  - [README.md](./README.md)
  - [current-source-of-truth.md](./docs/current-source-of-truth.md)
  - [friday-capability-matrix.md](./docs/ops/friday-capability-matrix.md)
  - [SSD-GAP-REPORT.md](./docs/SSD-GAP-REPORT.md)

### Why first

- Truth drift is now the fastest path back to a fake-closeout state.
- The release gates are green because the canonical wording is currently aligned.

### Success criteria

- final truth audit stays green
- no doc reintroduces marketplace or autonomy wording that outruns the code reality

## Priority 2 — Tighten bounded-maturity wording

### Work item

- Review `Validated but temporary` marketplace rows and ensure they remain intentionally temporary rather than accidentally vague.

### Areas to inspect

- marketplace assets catalog
- request board
- plugin marketplace and commerce

### Why second

- Not a release blocker
- But it affects expectation quality and user trust

### Success criteria

- every temporary row is either:
  - explicitly justified
  - promoted
  - or moved to deferred

## Priority 3 — Preserve beginner-friendly wording

### Work item

- Recheck that `/assistant`, `/marketplace`, `/skills`, `/fleet`, and `/observability` still describe actions in beginner-friendly language after future truth or UI edits.

### Why third

- The runtime is connected, but wording drift can recreate “Friday feels dumb” expectations even when the code is correct.

### Success criteria

- no core path requires route/API literacy
- no docs suggest more autonomy or more federation than the product actually provides

## Priority 4 — Continue polish, not release blocking

### Non-blocking items

- keep UI main chunk size under the current enforced threshold
- continue smoothing marketplace and operator wording
- continue expanding adversarial and click-path E2E where useful

### Why later

- These are worthwhile
- They are not the reason the release gate is green or red anymore

## Deferred by Design

These remain deferred and should not be pulled into non-platform release-closeout work unless they become unexpectedly required:

- platform rollout
- unrestricted autonomy
- richer fleet federation / mesh discovery
- deeper offline autonomy
- ML-heavy quality / anomaly / rules features

## Exit Rule

Keep the release recommendation at `Go` only while:

1. `npm run check:closeout:truth:final` stays green
2. `npm run closeout:final` stays green
3. refreshed closeout evidence remains committed
4. no new release blocker is introduced
