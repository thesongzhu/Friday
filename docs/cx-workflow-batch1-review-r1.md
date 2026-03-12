> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# CX Workflow Batch 1 Review — R1

**Date:** 2026-02-18
**Reviewer:** CX (gpt-5.3-codex)
**Scope:** Workflow Engine Batch 1: constants, types, migration V009, 4 repositories

---

## Findings

1. **[High] Repository interfaces do not match Section 3 contracts** — all methods require an explicit `db` parameter, while design interfaces are connection-agnostic. Contract drift that will force service-layer divergence from design spec.
   - `src/workflows/persistence/friday-workflow-trigger-repository.ts:10`
   - `src/workflows/persistence/friday-workflow-trigger-delivery-repository.ts:10`
   - `src/workflows/persistence/friday-workflow-run-checkpoint-repository.ts:10`
   - `src/workflows/persistence/friday-workflow-approval-repository.ts:10`

2. **[High] FridayWorkflowTriggerDeliveryRepository diverges from Section 3 method shape** — `tryInsert` requires `createdAt` (not in design), and `getByDedupeKey` is an extra interface method not in spec.
   - `src/workflows/persistence/friday-workflow-trigger-delivery-repository.ts:11, 19, 38`

3. **[Medium] `tryInsert` treats any UNIQUE violation as dedupe duplicate** — can mask duplicate-primary-key bugs (`id`) as a benign dedupe false result.
   - `src/workflows/persistence/friday-workflow-trigger-delivery-repository.ts:84, 86`

4. **[Low] Test coverage gap** — no cursor-path assertion for approvals pagination and no explicit duplicate-`id` (non-dedupe) path for delivery insert behavior.
   - `test/unit/workflows/friday-workflow-approval-repository.test.ts:169`
   - `test/unit/workflows/friday-workflow-trigger-delivery-repository.test.ts:66`

## Passed

- Check #11: `FridayWorkflowEngineTriggerType` rename is correct to avoid collision with existing `FridayWorkflowTriggerType`
- Constants match design
- Types match design
- Migration V009 DDL correct
- Style guide compliance

## Verdict

**NOT APPROVED** — 2 High issues must be fixed before R2.
