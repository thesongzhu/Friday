# Friday Main Productization Commit Strategy

Date: 2026-04-07

Workspace: `/path/to/friday-main-05bba7a`

## Goal

Keep the retained mixed batch intact, but make review and merge understandable.

This strategy does **not** recommend rollback and reimplementation.

It recommends one of two review shapes:

1. one merge batch with layered review notes
2. one branch with multiple intentional commits before merge

## Recommended Review Framing

Do **not** describe this work as:

- UI polish only
- frontend cleanup
- visual refresh

Describe it as:

> Friday main productization closeout for the primary task-first surfaces.

That wording correctly includes:

- visible UI and IA changes
- read-model/API support
- runtime/workflow correctness fixes
- maintenance and asset support work

## Option A: Single Merge Batch With Layered Review

Use this if the priority is speed and the current branch is already validated.

Review order:

1. `UI / Product Surface`
2. `Read Model / API`
3. `Runtime / Workflow Correctness`
4. `Maintenance / Assets`

Why this is acceptable:

- the release gate is green
- the changes are already tightly coupled in behavior
- several UI outcomes rely on the retained non-UI changes being present

Main downside:

- larger review cognitive load

## Option B: One Branch, Multiple Intentional Commits

Use this if the priority is review clarity.

Recommended commit split:

### Commit 1: product surface and route reshaping

Include:

- shell / rail / primary route changes
- `Home / Chat / Packs / Assistant` reshaping
- single-locale rendering
- visual system and visible page cleanup

Why:

- this is the visible product story reviewers can understand first

### Commit 2: read-model support for the new product surface

Include:

- `home-snapshot`
- `assistant-inbox-snapshot`
- run presentation / health / context summary
- pack attribution route input (`executionContext.packId`)

Why:

- this explains why the UI no longer guesses

### Commit 3: runtime/workflow correctness support

Include:

- `v065` rollback checkpoint persistence
- `v066` run metadata persistence
- session/run pack attribution persistence
- workflow generator / validator / compiler contract alignment
- deterministic persistence and abort-path fixes

Why:

- these are the highest-impact behavior changes and should be reviewable as behavior changes

### Commit 4: packs, managed skills, and assistant handoff

Include:

- pack catalog
- vertical pack integration
- managed skills
- assistant receipt / handoff UI and related tests

Why:

- this is the productization layer on top of the runtime attribution work

### Commit 5: performance, warning cleanup, maintenance tools, and docs

Include:

- Builder performance work
- benchmark tests and reports
- build-first browser e2e helper
- warning classification / test-harness suppression
- CLI backfill and audit docs

Why:

- these changes improve operability and release hygiene, but are easier to review as support work

## Recommended Default

Default recommendation:

- keep one branch
- shape it into multiple intentional commits before merge

Why this is the best compromise:

- no rollback churn
- no reimplementation risk
- review remains tractable
- the branch still lands as one coherent productization effort

## Things That Should Not Be Split Away

These should stay logically attached to the main batch even if commit boundaries are used:

- pack attribution chain
- run presentation / health read model
- snapshot APIs used by the new surfaces
- workflow correctness fixes that directly support the surfaced UI states

Reason:

- without them, the product surface becomes less truthful

## Things That Can Be Explained Separately

These can have their own review note or commit, but still remain in the same branch:

- CLI backfill command
- managed skills
- benchmark helpers
- warning classification docs

Reason:

- they are not the core user path, even though they are worth keeping

## Final Recommendation

Keep all retained changes.

If the team wants the safest merge path:

- keep the branch as one delivery unit
- split commits by layer before review
- use the closeout report and non-UI release notes to frame the review correctly
