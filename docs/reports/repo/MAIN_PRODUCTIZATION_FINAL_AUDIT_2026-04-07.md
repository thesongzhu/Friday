# Friday Main Productization Final Audit

Date: 2026-04-07

Workspace: `/Users/jarvis/Projects/Friday-main-05bba7a`

Base commit: `05bba7ad1019d6b1b7e958727f31aa11d083d4d4`

## Scope

This audit is the final layered check for the retained mixed batch. It does not reopen product scope.

The audit checks four things:

1. whether the retained changes still fit one coherent product direction
2. whether the batch contains undocumented behavioral changes or migrations
3. whether visible UI cleanup left behind obvious dead paths or legacy presentation residue
4. whether the remaining open risks justify rollback

## Confirmed Facts

### Release gate status

- `npm run release:verify` was green before this audit started
- the same gate was rerun again during this audit cycle and completed successfully on 2026-04-07
- all narrow verification for the latest Builder round passed before the full gate rerun:
  - `npm run typecheck`
  - `npx vitest run test/unit/ui/workflow-builder-page.test.ts`
  - `npm run build:ui`
  - `npm run check:ui-bundle-health`
  - `npm run test:e2e:ui:file -- test/e2e/ui/friday-workflow-builder-performance.test.ts`
  - `npm run test:e2e:ui:file -- test/e2e/ui/friday-surface-interaction-benchmark.test.ts`

### Builder benchmark status

Latest benchmark artifact:

- `/Users/jarvis/Projects/Friday-main-05bba7a/artifacts/browser-benchmarks/ui-surface-interaction-latest.md`

Latest medians:

- `Home`: `60ms`
- `Packs`: `37ms`
- `Assistant`: `37ms`
- `Builder draft data ready`: `337ms`
- `Builder graph transformed`: `339ms`
- `Builder shell ready`: `366ms`
- `Builder React Flow mounted`: `368ms`
- `Builder canvas ready`: `369ms`
- `Builder first interactive canvas`: `372ms`

Interpretation:

- Builder is still materially slower than the main surfaces.
- The newest phase markers show the main cost is now concentrated in draft load + graph transform, not in the previously deferred sidebars/catalog.
- React Flow still contributes cost, but it is no longer the only plausible suspect.

### Legacy / cleanup checks

Targeted scan results:

- no active `assistant-page` route references were found
- no active `BilingualText` or `inlineLocalizedText` references were found
- no active old brand-layer `sky-* / emerald-* / amber-* / red-* / slate-* / zinc-*` utility classes were found in `ui/src/routes` or `ui/src/components`

What remains intentionally present:

- Builder benchmark marks:
  - `friday-workflow-builder-shell-ready`
  - `friday-workflow-builder-canvas-ready`
  - `friday-workflow-builder-first-interactive-canvas`

These are instrumentation, not dead code.

### Timing-sensitive test checks

The known Builder timing fix remains in place:

- the unit test now waits for real node-library content before asserting delayed-mounted palette state
- this changed test waiting behavior, not product semantics

No additional obviously timing-fragile Builder assertions were identified in the targeted audit sample.

### Migration checks

Documented migrations in this batch:

- `v065-agent-run-checkpoint-manifest`
- `v066-agent-run-metadata`

Audit result:

- these migrations are still the only database schema changes introduced by this batch
- both are already documented in the closeout report and should remain explicitly called out in any review

## Layered Risk Review

### 1. UI / Product Surface

Status: acceptable to retain

Why:

- main surfaces now share one visual system and one navigation model
- single-locale rendering is consistent with current product direction
- the old mixed dashboard / top-bar model is not partially left behind in active routes

Remaining risk:

- Builder still feels heavier than the rest of the product

### 2. Read Model / API

Status: acceptable to retain

Why:

- the current UI relies on server-shaped snapshot/read models instead of page-local polling guesses
- pack attribution and run health are now explicit and machine-readable

Remaining risk:

- none found in this audit cycle that would justify rollback

### 3. Runtime / Workflow Correctness

Status: acceptable to retain

Why:

- rollback durability and run metadata are real behavior fixes, not speculative refactors
- workflow generation state semantics are more truthful than the previous collapsed failure model

Remaining risk:

- historical pack attribution remains intentionally conservative
- this is a product continuity gap, not a correctness regression

### 4. Maintenance / Assets

Status: acceptable to retain

Why:

- CLI backfill, managed skills, benchmark coverage, and build-first browser helpers support operability
- they are orthogonal to the visible product direction and do not introduce a second product concept

Remaining risk:

- the worktree diff is large, so review ergonomics are the main risk, not hidden runtime behavior

## Open Items That Still Exist

These remain open after the final audit, but none currently justify reverting the batch.

### Workflow Builder is still the clear UX outlier

- the Builder got modestly faster
- it did not become comparable to `Home / Packs / Assistant`
- further work, if any, should target draft hydration and graph transformation first

### Release stderr is cleaner, but not empty

This is already classified in:

- `/Users/jarvis/Projects/Friday-main-05bba7a/docs/reports/repo/RELEASE_VERIFY_WARNING_CLASSIFICATION_2026-04-07.md`

The still-visible warnings are now mostly:

- degraded-path evidence
- negative-path evidence
- smaller amounts of low-signal runtime noise

### The diff is large enough to require explicit review framing

This is not a code rollback issue.

It is a review and merge hygiene issue:

- reviewers should not be told this is a UI-only batch
- the retained changes need to be framed as a layered productization closeout

## Final Audit Verdict

The current state is coherent enough to keep.

The strongest reason not to roll anything back is that the non-UI changes are not random spillover. They are mostly the runtime, read-model, and maintenance support needed to make the new product surface truthful and stable.

The remaining weakness is not "this batch changed too much core logic and should be reverted."

The remaining weakness is:

- Builder still underperforms the other main surfaces
- the worktree diff needs disciplined review framing before merge
