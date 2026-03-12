# Friday Closeout Evidence

This directory stores generated evidence for the non-platform closeout program.

## Status Vocabulary

- `validated and keep`: the surface is active, supported, and part of the steady-state product contract.
- `validated but temporary`: the surface works today but is intentionally transitional.
- `deferred`: the capability is intentionally out of the current closeout boundary.

## Evidence Layout

- `phase1-canonical-truth/`
- `phase2-fleet-satellite/`
- `phase3-autonomous-loop/`
- `phase4-acceptance-retry-rules/`
- `phase5-skills-lifecycle/`
- `marketplace-creator-ecosystem/`
- `final-non-platform/`

Each directory stores:

- `latest.json`: machine-readable evidence
- `latest.md`: human-readable summary

Use `npm run check:closeout:evidence:freshness` to verify that generated `latest.*` evidence files still match the current git head.

## Phases

### Phase 1

Canonical truth unification across route contracts, README, source-of-truth, and historical SSD materials.

### Phase 2

Fleet, satellite, and distributed execution closeout.

### Phase 3

Autonomous loop v2 closeout under supervised autonomy defaults.

### Phase 4

Acceptance, retry, and rules operational closeout.

### Phase 5

Skills lifecycle and marketplace-source hardening.

### Phase 6

Final non-platform closeout evidence, including `release:verify`, phase closeouts, and UI bundle health.

### Marketplace Creator Ecosystem

Final truth alignment and repeatable closeout evidence for the skills-first, creator-support, request-board marketplace direction.
