# Friday D1 Split-DB Acceptance Ledger

Date: 2026-06-18

Baseline: `732de1acb8dfdc50d11502ba8db60d8d283e3e8f`

Scope: registry D1, `friday.db` versus `rust-hub.sqlite` split-brain hardening. This ledger records the evidence for the D1 block-release acceptance bar:

1. boot schema-version handshake fails closed on mismatch;
2. default/live memory and session write legs no longer create new split-store rows in `friday.db`;
3. orphan in-flight crash recovery exists and is tested.

This is not a full registry completion claim. It does not mark A/B/C/D20 complete, does not flip any DARK capability live, and does not claim the legacy 27.5MB split-store backfill is migrated. That backfill remains a truth-labeled follow-on; D1 block-release is about preventing new live divergence before the first organic mission-spine write.

## Acceptance Status

`D1 block-release satisfied`

The currently shipped mainline satisfies the registry D1 block-release conditions on evidence below. The remaining legacy `memory_items` rows and read fallbacks are compatibility/backfill debt, not permission for default/live TypeScript durable memory writes.

## A. Schema Handshake

The TypeScript state runtime performs a Rust hub schema-version handshake before opening the split runtime:

- `src/state/sqlite/friday-rust-hub-schema-handshake.ts` sets `FRIDAY_EXPECTED_RUST_HUB_SCHEMA_VERSION = 39`.
- The handshake reads `schema_version.version` from the configured Rust hub database or `stateDir/rust-hub.sqlite`.
- Missing/invalid schema rows throw `RUST_HUB_SCHEMA_HANDSHAKE_FAILED`.
- Version mismatch throws `RUST_HUB_SCHEMA_VERSION_MISMATCH` with HTTP 500 details and refuses to open the split TypeScript runtime.

Behavior is covered by `test/unit/state/friday-rust-hub-schema-handshake.test.ts`.

Operational proof during the D20 W1 deploy: the hub refused to boot when the live Rust DB was at schema 34 while TypeScript expected 35. The deploy only proceeded after the Rust workspace migration advanced the DB to schema 35. This is a real fail-closed event, not just a unit assertion.

## B. New Write-Leg Closure

### Durable Memory Service

Default/live hub construction disables TypeScript durable memory writes:

- `src/hub/friday-hub-bootstrap.ts` constructs `createFridayMemoryService` with `tsMemoryWritesEnabled: config.allowTestOnlyTsMemoryWrites === true`.
- `src/api/runtime/friday-api-runtime.ts` passes the same default-false setting into the memory guard factory.
- `src/memory/services/friday-memory-service.ts` calls `assertTsDurableMemoryWriteEnabled(..., "memory.store")` before id generation, provider embedding, `memory_items` insert, embedding insert, or dedup advisory writes.
- The thrown code is `TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED` with HTTP 503 and replacement `rust_owned_memory_confirmation_spine`.

Coverage:

- `test/unit/memory/services/friday-memory-service.test.ts`
- `test/unit/memory/guard/services/friday-memory-guard-service-quota.test.ts`
- `test/unit/hub/friday-hub-bootstrap.test.ts`
- `test/unit/ops/run-real-green-gate.test.ts` manifest assertions for `memory_items_create`

### Session Writes

Default/live TypeScript session writes are fail-closed:

- `src/sessions/services/friday-session-service.ts` centralizes the guard in `assertLegacySessionWritesAllowed()`.
- The guard throws `TS_RUNTIME_SESSION_RETIRED` with HTTP 503 unless `allowTestOnlySessionExecution === true`.
- Boot-time legacy channel-session backfill only runs when `allowTestOnlySessionExecution` is explicitly true.
- Write-capable methods are guarded, including create/get-or-create write branches, message append, archive/prune/sweep, fork/merge/reset, focus/metadata, and send-policy writes.
- `src/api/http/routes/friday-session-routes.ts` routes fail closed before invoking retired service mutations.
- `src/hub/friday-hub-bootstrap.ts` also removed the recurring session lifecycle sweep from live scheduler registration so a retired method cannot busy-loop as a recurring failer.

Coverage:

- `test/unit/sessions/services/friday-session-memory-retirement-guard.test.ts`
- `test/unit/api/http/routes/friday-session-routes.test.ts`
- `test/unit/hub/friday-channel-natural-trigger-runtime.test.ts`
- `docs/ops/ts-runtime-retirement-manifest.json` session surface floors and route proofs

### File Reverse Import and Residual Maintenance

Legacy file-to-memory reverse import remains present only as a test oracle:

- `src/memory/sync/friday-memory-file-sync-repository.ts` gates `upsertMemoryItemsFromExport()` and `deleteMemoryNamespace()` behind `allowTestOnlyMemoryFileImport`.
- `src/memory/sync/friday-memory-file-sync-service.ts` is covered by unit tests that prove reverse import is retired by default.

Expired `memory_items` cleanup is no longer a TypeScript delete leg:

- `src/learning/services/friday-system-health-monitor.ts` reports expired rows but the maintenance action throws `TS_RUNTIME_DURABLE_MEMORY_WRITE_RETIRED` and instructs operators to use the Rust memory owner/migration path.
- `test/unit/learning/services/friday-system-health-monitor.test.ts` proves the maintenance receipt records failure rather than deleting rows.

### Rehomed Ancillary Writers

The following writer families were rehomed out of `memory_items` or had residual cleanup deletes retired:

- workflow-builder drafts/templates/test artifacts: PR #827
- skill run snapshots and retention: PR #828
- skill-generator sessions, turns, drafts, and delete cleanup: PR #829 and PR #832
- workflow-generator sessions, turns, drafts, approvals, and delete cleanup: PR #830 and PR #832
- template-harness artifacts: PR #831

Compatibility reads from legacy `memory_items` remain for old data. New writes go to dedicated tables or fail closed unless a test-only oracle flag is explicitly set.

## C. Orphan Crash Recovery

Rust mission-spine crash recovery is hard-enabled before accepting connections:

- `rust-core/crates/friday-hub/src/bin/hub_agent_run_server.rs` calls `run_boot_crash_recovery(&db_path)` before the accept loop.
- The sweep reconciles genuinely orphaned in-flight work items to `FailedTerminal` with the `crash_recovery_abort` marker.
- Waiting/provider-paused rows are deliberately preserved.
- The sweep is fail-safe for boot: scan/open errors are logged by category and swallowed so the server still comes up.

Coverage:

- `rust-core/crates/friday-hub/tests/crash_recovery.rs`
- `rust-core/crates/friday-hub/src/crash_recovery.rs`

TypeScript stale-run cleanup also runs on hub startup:

- `src/hub/friday-hub-bootstrap.ts` calls `subagentRegistry.resumeOnBoot()` and `agentRuntime.resumeStaleRunsOnBoot()`.
- `test/integration/hub/friday-hub-bootstrap-integration.test.ts` covers startup cleanup of stale persisted agent and subagent runs.
- `test/unit/agent/runtime/friday-agent-runtime.test.ts` and `test/unit/agent/subagent/friday-subagent-registry.test.ts` cover the underlying cleanup methods.

## Residual Truth Labels

- The legacy split-store backfill is not complete. Existing `memory_items` data can still be read for compatibility and migration.
- Migrations can still contain `memory_items` statements by design.
- Tests can seed `memory_items` rows through explicit fixture/test-only paths.
- This ledger does not authorize any new organic mission-spine write before the shipped D1 safeguards above are present in prod.
- This ledger does not mark `FRIDAY_OUTCOME_CHECKED_PROOF` live; it remains DARK unless separately proven with a real `outcome://` instance.

## Verification

Local verification inherited from the landed D1 slices:

```sh
npm test -- --run test/unit/skills/generator/persistence/friday-skill-generation-session-repository.test.ts test/unit/skills/generator/services/friday-skill-generator-service.test.ts test/unit/workflows/generator/persistence/friday-workflow-generation-session-repository.test.ts test/unit/workflows/generator/services/friday-workflow-generator-service.test.ts test/unit/learning/services/friday-system-health-monitor.test.ts
npm test -- --run test/integration/state/sqlite/friday-migration-chain.test.ts
npm test -- --run test/unit/memory/services/friday-memory-service.test.ts test/unit/memory/guard/persistence/friday-memory-guard-quota-repository.test.ts test/unit/memory/sync/friday-memory-file-sync-service.test.ts test/unit/quality/workspace-memory-facts.test.ts
npm run build
```

Remote CI on PR #832 was green across build, test, security, contracts, migrations, ts-runtime-retirement, real-green-gate, and quality-gate before merge.

Production deployment proof after #832:

- prod HEAD: `732de1acb8dfdc50d11502ba8db60d8d283e3e8f`
- `launchctl kickstart -k gui/501/com.friday.hub`
- `/health` returned OK with version `1.0.3`
- `com.friday.hub` was running with last exit code 0
