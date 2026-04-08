# Friday Main Productization Closeout

Date: 2026-04-07

Workspace: `/Users/jarvis/Projects/Friday-main-05bba7a`

Base commit: `05bba7ad1019d6b1b7e958727f31aa11d083d4d4`

## Executive Summary

This worktree is intentionally preserved as a mixed closeout batch. It is no longer accurate to describe it as "UI-only".

The retained changes fall into four layers:

1. `UI / Product Surface`
2. `Read Model / API`
3. `Runtime / Workflow Correctness`
4. `Maintenance / Assets`

The correct framing for this batch is:

> Main productization closeout for Friday's primary surfaces.

That framing includes UI polish and IA work, but also the runtime and read-model changes required to make the new product surface trustworthy and stable.

Final gate status for this closeout:

- `npm run release:verify` completed successfully again on 2026-04-07 after the final Builder instrumentation and warning-classification pass

## Layered Classification

### 1. UI / Product Surface

Purpose: make the visible product coherent, single-locale, lighter, and task-first.

Representative changes:

- Left rail shell, single-column main surfaces, reduced navigation noise
- `/home`, `/chat`, `/packs`, `/assistant`, `/flow/:wizardId` reshaping
- Shared pack quick sheet, product previews, assistant handoff cards
- Light-first token system, route-level layout consistency, visible page cleanup
- Workflow builder lazy mounting and route-shell split

Why it stays:

- This is the visible product surface the user asked to improve.
- It is now materially more stable, less noisy, and faster than the previous mixed shell/dashboard layout.

### 2. Read Model / API

Purpose: stop making the UI guess.

Representative changes:

- `GET /v1/uix/home-snapshot`
- `GET /v1/uix/assistant-inbox-snapshot`
- `executionContext.packId` accepted on agent-start routes
- Run records now expose machine-readable `health`, `contextSummary`, and `rollbackAvailable`

Why it stays:

- The new UI depends on server-shaped summary models instead of page-local polling fanout.
- `/assistant` and pack receipts now read real attribution and health state instead of inferring from weak client signals.

### 3. Runtime / Workflow Correctness

Purpose: make the new product surface truthful rather than decorative.

Representative changes:

- Rollback checkpoints now persist through `v065`
- Run metadata now persists through `v066`
- `packId` is written into session/run metadata for explicit attribution
- Tool-approval wait path is abort-aware
- Immediate deterministic runs force a passive checkpoint to reduce stale read visibility
- Workflow generator, validator, and compiler now share expression-safe step-id rules
- Workflow generation failure states are split into retryable, repairable, and terminal categories

Why it stays:

- These changes are not cosmetic; they fix concrete behavior gaps that the new UI would otherwise hide.
- They reduce guesswork, improve crash/consistency behavior, and make workflow generation states represent reality more accurately.

### 4. Maintenance / Assets

Purpose: make the system operable and the product entrypoints useful.

Representative changes:

- CLI backfill command for pack-context history
- Shared built-in pack catalog used by UI, runtime, and CLI
- Managed skills for the six vertical packs
- Build-first targeted browser-e2e helper
- Benchmark and performance regression coverage

Why it stays:

- These changes are not on the primary user path, but they support operability, testing, and vertical-pack usefulness.
- They should be documented separately from the main UI story, not reverted.

## High-Impact Retained Changes

These are the changes that materially affect system behavior and must be called out explicitly in review and release notes.

### `v065` rollback checkpoint persistence

- Before: rollback snapshots lived in memory only and were lost on restart.
- After: checkpoint manifests are persisted in SQLite and can be recovered after restart.
- Impact: file rollback is now durable and path-canonicalized.

### `v066` run metadata persistence

- Before: runs had no machine-readable metadata bucket for pack attribution.
- After: `friday_agent_runs.metadata_json` stores `packContext`.
- Impact: pack attribution is explicit, not reconstructed by UI guesses.

### Workflow generator status semantics

- Before: generation failures largely collapsed into generic `failed` / `generation_failed`.
- After: provider retryability and draft repairability are separated.
- Impact: workflow generation review flows can distinguish "try again later" from "fix the draft" from "hard failure".

### Pack attribution chain

- Before: pack ownership of runs was often inferred from session key or last-run heuristics.
- After: chat and guided-flow pack launches can persist explicit `packId` into session and run metadata.
- Impact: `/assistant` receipts and pack handoff views can bind to actual runs rather than unstable heuristics.

## What This Batch Explicitly Does Not Introduce

### No second product concept

- `/assistant` remains the user-facing inbox for approvals, issues, and recovery.
- `/command-center` remains an advanced/operator surface.
- The worktree does not introduce a parallel second product with conflicting vocabulary or navigation.

### No undocumented migration

- `v065` and `v066` are intentional and must be described anywhere this batch is reviewed.
- No other database migration was added in this batch.

### No hidden rollback of the new UI direction

- The worktree keeps the lighter, left-rail, task-first product surface.
- It does not revert to the earlier mixed dashboard + center-nav state.

## Final Layered Checklist

### UI / Product Surface

- Main surfaces are single-locale and no longer rely on visible bilingual rendering.
- Primary navigation is left-rail based on desktop.
- `/packs` and `/assistant` reflect current product intent rather than legacy starter-surface behavior.

### Read Model / API

- The new home and inbox surfaces use snapshot APIs instead of scattered page-level polling.
- Run presentation fields are supplied by shared server-side logic, not page-local heuristics.

### Runtime / Workflow Correctness

- Run attribution is explicit for new pack-origin runs.
- Rollback availability survives restart.
- Workflow generator state semantics align better with actual failure and repair paths.

### Maintenance / Assets

- CLI backfill exists, is strict by design, and currently reports zero safe historical updates on the real DB.
- Managed skills and pack catalog are preserved as product assets, not treated as UI-only noise.

## Remaining Open Items

These are open, but they are not reasons to revert this batch.

### Workflow Builder is still slower than the primary surfaces

Current benchmark medians still show builder shell/canvas noticeably behind Home, Packs, and Assistant.

Latest interaction report:

- Home median: `60ms`
- Packs median: `37ms`
- Assistant median: `37ms`
- Builder draft data ready median: `337ms`
- Builder graph transformed median: `339ms`
- Builder shell median: `366ms`
- Builder React Flow mounted median: `368ms`
- Builder canvas median: `369ms`
- Builder first interactive canvas median: `372ms`

Interpretation:

- The fourth, fifth, sixth, and final closeout optimization rounds reduced unnecessary first-mount work:
  - builder chrome and inspector are deferred more aggressively
  - React Flow now uses `onlyRenderVisibleElements`
  - template groups stay deferred longer on deep-linked draft opens
  - the right sidebar was split out of the main builder workspace chunk and lazy-loaded behind the deferred inspector/template gates
- The sixth and later rounds also stabilized the canvas interaction context, deferred the left-rail heavy content until after deep-linked draft canvas boot, avoided rebuilding node/edge arrays when no issue/drop decoration is active, simplified compact node/edge rendering, delayed skill catalog loading until the inspector is actually mounted, moved initial history/secondary hydrate work out of the first draft-apply layout pass, and added explicit Builder phase markers.
- The final benchmark shows a real but modest improvement versus the earlier `381ms / 384ms` shell/canvas median baseline.
- The new phase markers show that the current bottleneck is not sidebar/catalog fan-out anymore:
  - draft data becomes available at roughly `337ms`
  - graph transformation completes at roughly `339ms`
  - React Flow mount adds only about `29ms`
- The largest remaining structural constraint is still the React Flow stack and route-local draft hydration cost, but the evidence now shows the draft fetch + transform path dominates more than the remaining canvas chrome.

### Release output still contains noisy test-environment warnings

This is now classified in a dedicated report:

- `docs/reports/repo/RELEASE_VERIFY_WARNING_CLASSIFICATION_2026-04-07.md`

Current conclusion:

- the release gate still passes
- the short token secret / missing limiter / passwordless bootstrap fixture warnings are now largely suppressed in explicit test harness mode
- the remaining stderr is mostly degraded-path evidence, negative-path mock noise, and smaller amounts of low-signal runtime noise
- this batch intentionally does not globally silence fallback-path evidence

### Historical pack recovery remains intentionally conservative

The strict backfill strategy leaves old runs unattributed unless a strong, structured evidence chain exists.

## Validation Results

Validated on 2026-04-07 in `/Users/jarvis/Projects/Friday-main-05bba7a`.

Passed:

- `npm run typecheck`
- `npm run lint`
- `npm run build`
- `npm run test:contracts:routes`
- `npx vitest run test/unit/api/auth/friday-auth-service.test.ts test/unit/hub/friday-hub-bootstrap.test.ts test/unit/agent/tools/friday-agent-web-fetch-tool.test.ts test/unit/ui/workflow-builder-page.test.ts`
- `npx vitest run test/unit/agent/runtime/friday-agent-runtime.test.ts test/unit/workflows/generator/services/friday-workflow-generator-service.test.ts test/unit/api/runtime/friday-api-runtime-session-registration.test.ts test/unit/cli/friday-cli.test.ts`
- `npm run test:e2e:ui:file -- test/e2e/ui/friday-agent-os-browser-journeys.test.ts`
- `npm run test:e2e:ui:file -- test/e2e/ui/friday-workflow-builder-performance.test.ts`
- `npm run test:e2e:ui:file -- test/e2e/ui/friday-surface-interaction-benchmark.test.ts`
- `npm run check:ui-bundle-health`
- `npm run release:verify`

Current benchmark artifact:

- `artifacts/browser-benchmarks/ui-surface-interaction-latest.md`

Maintenance validation:

- `friday runs backfill-pack-context --apply` completed successfully against the real state DB
- A follow-up strict dry-run remained stable and idempotent:
  - `scannedRuns = 1704`
  - `eligibleRuns = 0`
  - `updatedRuns = 0`
  - `skippedRuns = 1704`

Interpretation:

- The retained runtime/API changes are not just theoretically compatible with the UI work; they passed the full release gate together.
- Historical pack backfill remains intentionally conservative because the real DB does not contain enough structured evidence for safe recovery.
- Release stderr now has a written classification, so later review can separate test noise from real product risk.

## Release Framing

Recommended release framing:

- Primary note: Friday main productization closeout for the task-first surfaces
- Separate note: non-UI retained support changes that make the new surfaces trustworthy

Do not describe this batch as:

- `UI polish only`
- `visual refresh only`
- `frontend-only cleanup`

That wording would hide the deliberate runtime, metadata, workflow, and maintenance changes that now support the visible product.

## Split-Later Guidance

If this worktree is later split for review or merge hygiene, the split should happen at review/package level, not by backing out working code and reimplementing it.

Recommended split lines:

1. `UI / Product Surface`
2. `Read Model / API`
3. `Runtime / Workflow Correctness`
4. `Maintenance / Assets`

The following should stay grouped with the UI line because they are direct support for the visible product:

- pack attribution write path
- run health/context presentation
- UI snapshot routes
- main-surface performance/stability fixes

The following can be reviewed separately later if desired:

- CLI backfill and history audit tooling
- managed skills additions
- benchmark and targeted browser-e2e helper scripts
