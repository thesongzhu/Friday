# Friday Non-Platform Release Blockers

## Status

- Total release blockers: `0`
- Severity basis: blocks the required final release-closeout gate

## Cleared blocker history

### Marketplace final truth wording mismatch

- Previous classification: `Release blocker`
- Area: docs / truth / release evidence
- Previous impact:
  - `npm run check:closeout:truth:final` failed
  - `npm run closeout:final` failed
- Root cause:
  - [friday-capability-matrix.md](./docs/ops/friday-capability-matrix.md) used `Plugin marketplace / commerce`
  - the final truth audit required `Plugin marketplace and commerce`
- Resolution:
  - aligned the capability matrix wording
  - aligned the final truth checker
  - reran both final gates successfully
- Verification:
  - `npm run check:closeout:truth:final`: passed
  - `npm run closeout:final`: passed

## Current blocker state

No open release blockers remain for the non-platform scope.

## Not blockers

These were reviewed and are **not** currently classified as release blockers:

- bounded plugin marketplace / commerce maturity
- `Validated but temporary` rows in the capability matrix
- deferred fleet federation / mesh features
- deferred unrestricted autonomy
- UI bundle size warning as long as `npm run check:ui-bundle-health` remains green
