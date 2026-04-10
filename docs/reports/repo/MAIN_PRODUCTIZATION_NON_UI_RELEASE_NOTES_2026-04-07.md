# Friday Main Productization Non-UI Release Notes

Date: 2026-04-07

Workspace: `/path/to/friday-main-05bba7a`

This note covers retained changes that are not part of the primary visible UI story and should be reviewed separately from UI polish.

## Runtime / Correctness

### Durable rollback checkpoints

- Added persistent checkpoint manifests for per-run file rollback.
- Rollback availability now survives process restart.
- Canonical path tracking replaces raw-path-only bookkeeping.

### Explicit run metadata

- Added `run.metadata.packContext`.
- Agent-start execution context now accepts `packId`.
- Session and run attribution can now be explicit for pack-launched work.

### Run presentation model

- Runs can now expose `health`, `contextSummary`, and `rollbackAvailable`.
- This supports consistent behavior across Assistant, Command Center, and related read surfaces.

### Workflow generator failure semantics

- Generator status is no longer a single generic failed bucket.
- Retryable provider failures, draft repair states, and terminal failures are now separated.
- Workflow step-id validation is aligned across generator, validator, and compiler.

## Read Model / API

### Snapshot endpoints

- Added `GET /v1/uix/home-snapshot`
- Added `GET /v1/uix/assistant-inbox-snapshot`

These endpoints replace fragmented client polling with aggregated server summaries.

### Agent route input

- Agent-start routes now accept `executionContext.packId` as a validated optional field.

## Maintenance / Tooling

### Pack-context backfill CLI

- Added `friday runs backfill-pack-context --dry-run|--apply [--json]`
- Dry-run uses a temp DB copy so migrations and scans do not mutate the real state DB.
- Strict strategy currently finds no safe historical backfills on the real local database.

### Shared built-in pack catalog

- Added a shared catalog for built-in pack identity and default wizard mapping.
- The catalog is reused by UI, runtime, and CLI paths.

### Targeted browser-e2e helper

- Added a build-first helper for running filtered browser-e2e specs without stale `dist/ui`.
- New entrypoint: `npm run test:e2e:ui:file -- <spec/filter>`

## Assets

### Managed vertical-pack skills

- Added managed skills for the current six vertical-pack directions.
- These are product assets and should be tracked as such, not described as visual/UI only.

## Review Notes

These changes are intentionally retained, but they should be described separately from the UI narrative during review:

- `v065` rollback checkpoint manifest migration
- `v066` run metadata migration
- workflow generator correctness/state semantics
- CLI backfill tooling
- managed skills additions
