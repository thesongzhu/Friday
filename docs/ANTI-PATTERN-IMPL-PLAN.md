> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Friday Anti-Pattern Defense — Complete Implementation Plan

> Batch 1 (CX9): AP-1+6, AP-2, AP-3, AP-4
> Batch 2 (CX10): AP-5, AP-7, AP-8
> Migrations: v017-v022

---

## Batch 1: Infrastructure + Security (v017-v020)

### IMPL-1: Persisted Planning + Optional Review Gate (covers AP-1, AP-6)
**Files to modify**:
- `src/agent/runtime/friday-agent-runtime.types.ts`
- `src/agent/runtime/friday-agent-runtime.ts`
- `src/agent/model/friday-agent.types.ts`
- `src/agent/persistence/friday-agent-run-repository.ts`
- `src/api/http/routes/friday-agent-routes.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/hub/friday-hub-bootstrap.ts`
- `src/agent/index.ts`
- `src/state/sqlite/migrations/index.ts`

**Files to create**:
- `src/state/sqlite/migrations/v017-agent-run-plan-review.ts` (State/SQLite ownership)
- `src/agent/runtime/friday-agent-review-gate.ts` (Agent Runtime ownership)

**Migration**:
- Version: `17` (`v017-agent-run-plan-review`)
- SQL:
```sql
-- V017: Persist agent plan + review decision state
ALTER TABLE friday_agent_runs
ADD COLUMN plan_review_json TEXT;
```
- Single responsibility: add one persisted plan/review payload to `friday_agent_runs`.

**Hub bootstrap wiring**:
- At `src/hub/friday-hub-bootstrap.ts:530`, create `agentReviewGate` (default mode from env, e.g. `off|auto-approve|auto-reject`).
- At `src/hub/friday-hub-bootstrap.ts:599`, pass `reviewGate: agentReviewGate` into `createFridayAgentRuntime(...)`.
- At `src/hub/friday-hub-bootstrap.ts:623`, pass the same `reviewGate` for child runtimes.

**Code changes**:
- `src/agent/runtime/friday-agent-runtime.ts:118`  
  Current: planning transitions directly to executing.  
  Replacement: `buildExecutionPlan(...)` -> persist `plan_review_json` -> optional `reviewGate.review(...)` -> only then set status to `executing`.
- `src/agent/runtime/friday-agent-runtime.ts:110`  
  Current: fixed planning message only.  
  Replacement: emit planning message using persisted plan summary/step count.
- `src/agent/runtime/friday-agent-runtime.types.ts:10`  
  Current: no review input.  
  Replacement: add `reviewRequired?: boolean` on `executeRun(...)`.
- `src/agent/persistence/friday-agent-run-repository.ts:121`  
  Current: insert excludes plan/review payload.  
  Replacement: include `plan_review_json` in create/update mapping.
- `src/agent/model/friday-agent.types.ts:75`  
  Current: run record has no plan/review payload.  
  Replacement: add typed `planReview` structure.
- `src/api/http/routes/friday-agent-routes.ts:100`  
  Current: startRun payload excludes review flag.  
  Replacement: parse `requireReview` and forward it.
- `src/api/runtime/friday-api-runtime.ts:814`  
  Current: executeRun called without review flag.  
  Replacement: pass `reviewRequired`.

**Tests**:
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`: plan is persisted before execution; review reject path returns failed run with review metadata.
- `test/unit/agent/persistence/friday-agent-run-repository.test.ts`: `plan_review_json` round-trip create/update/read.
- `test/unit/api/http/routes/friday-agent-routes.test.ts`: `requireReview` validation/forwarding.
- `test/unit/agent/runtime/friday-agent-review-gate.test.ts` (new): mode behavior (`off`, `auto-approve`, `auto-reject`).

**Verification**:
- Run targeted tests above.
- Start a run with `requireReview=true`; confirm `friday_agent_runs.plan_review_json` is non-null and review decision is recorded.
- Confirm execution starts only after review decision is approved.

---

### IMPL-2: Actual Routed Model/Provider/Cost Persistence (covers AP-2)
**Files to modify**:
- `src/agent/runtime/friday-agent-llm-client.types.ts`
- `src/agent/runtime/friday-agent-runtime.types.ts`
- `src/agent/runtime/friday-agent-runtime.ts`
- `src/agent/model/friday-agent.types.ts`
- `src/agent/persistence/friday-agent-run-repository.ts`
- `src/hub/friday-hub-bootstrap.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/state/sqlite/migrations/index.ts`

**Files to create**:
- `src/state/sqlite/migrations/v018-agent-run-actual-execution.ts` (State/SQLite ownership)

**Migration**:
- Version: `18` (`v018-agent-run-actual-execution`)
- SQL:
```sql
-- V018: Persist actual routed execution metadata (provider/model/cost/usage)
ALTER TABLE friday_agent_runs
ADD COLUMN actual_execution_json TEXT;
```
- Single responsibility: store actual routed execution snapshot separately from requested defaults.

**Hub bootstrap wiring**:
- At `src/hub/friday-hub-bootstrap.ts:534`, upgrade `agentLlmClient` wrapper:
  - keep `runWithFallback(...)` route/routingDecision
  - compute per-call cost with provider pricing calculator
  - enrich `message_end` event with actual provider/model/cost metadata.

**Code changes**:
- `src/hub/friday-hub-bootstrap.ts:539`  
  Current: only `{ result: events }`.  
  Replacement: capture `{ result: events, route, routingDecision }`, enrich final event metadata.
- `src/agent/runtime/friday-agent-llm-client.types.ts:21`  
  Current: `message_end` has tokens only.  
  Replacement: add optional `actualProviderId`, `actualModel`, `actualProviderKind`, `actualProviderApi`, `costUsd`.
- `src/agent/runtime/friday-agent-runtime.ts:131`  
  Current: stream result excludes route/cost metadata.  
  Replacement: aggregate actual provider/model/cost from `message_end` metadata across turns.
- `src/agent/runtime/friday-agent-runtime.ts:239`  
  Current: final update writes `usage_input`/`usage_output` only.  
  Replacement: also write `actual_execution_json` and `cost_usd`.
- `src/api/runtime/friday-api-runtime.ts:814`  
  Current: requested `providerId`/`model` from route layer are dropped.  
  Replacement: pass `providerId` and `model` through to runtime request.
- `src/agent/persistence/friday-agent-run-repository.ts:37`  
  Current: no mapping for actual execution JSON.  
  Replacement: parse/serialize `actual_execution_json`.

**Tests**:
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`: metadata from `message_end` persists into run record (`actualExecution`, `costUsd`).
- `test/unit/agent/persistence/friday-agent-run-repository.test.ts`: `actual_execution_json` round-trip.
- `test/unit/agent/runtime/friday-agent-llm-client.test.ts`: message_end remains backward-compatible when metadata absent.

**Verification**:
- Trigger a run with fallback routing enabled.
- Verify `friday_agent_runs.actual_execution_json` contains routed provider/model and non-zero cost where pricing applies.
- Confirm `provider_id/model` remain requested/default values while actual route is tracked separately.

---

### IMPL-3: Durable Run Event Store + Step-Level Executing Events (covers AP-3)
**Files to modify**:
- `src/agent/runtime/friday-agent-runtime.types.ts`
- `src/agent/runtime/friday-agent-runtime.ts`
- `src/agent/index.ts`
- `src/api/runtime/friday-api-runtime.types.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/api/http/routes/friday-agent-routes.ts`
- `src/hub/friday-hub-bootstrap.ts`
- `src/state/sqlite/migrations/index.ts`
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`
- `test/unit/api/http/routes/friday-agent-routes.test.ts`
- `test/integration/state/sqlite/friday-migration-chain.test.ts`
- `test/unit/state/friday-state-index.test.ts`

**Files to create**:
- `src/state/sqlite/migrations/v019-agent-run-events.ts` (State/SQLite ownership)
- `src/agent/persistence/friday-agent-run-event-repository.ts` (Agent Persistence ownership)
- `test/unit/agent/persistence/friday-agent-run-event-repository.test.ts` (test ownership)

**Migration**:
- Version: `19` (`v019-agent-run-events`)
- SQL:
```sql
-- V019: Durable per-run agent event log
CREATE TABLE IF NOT EXISTS friday_agent_run_events (
  event_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES friday_agent_runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  event_name   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  emitted_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_friday_agent_run_events_run_seq
  ON friday_agent_run_events (run_id, seq);

CREATE INDEX IF NOT EXISTS idx_friday_agent_run_events_run_emitted
  ON friday_agent_run_events (run_id, emitted_at);
```
- Single responsibility: one durable audit table for run events.

**Hub bootstrap wiring**:
- At `src/hub/friday-hub-bootstrap.ts:530`, instantiate `agentRunEventRepository`.
- At `src/hub/friday-hub-bootstrap.ts:599` and `src/hub/friday-hub-bootstrap.ts:623`, pass `runEventRepository` into runtimes.
- At `src/hub/friday-hub-bootstrap.ts:744`, pass `agentRunEventRepository` into `createFridayApiRuntime(...)`.

**Code changes**:
- `src/agent/runtime/friday-agent-runtime.ts:95`  
  Current: direct `eventEmitter.emit(...)` calls only.  
  Replacement: `emitRunEvent(...)` helper persists to `friday_agent_run_events` then emits.
- `src/agent/runtime/friday-agent-runtime.ts:125`  
  Current: loop increments silently.  
  Replacement: emit `agent.run.executing` every iteration with step/description.
- `src/agent/runtime/friday-agent-runtime.ts:391`  
  Current: tool events are transient only.  
  Replacement: tool start/end go through durable emit helper.
- `src/api/http/routes/friday-agent-routes.ts:221`  
  Current: SSE subscribes live only.  
  Replacement: replay persisted events first (`afterSeq` support), then subscribe live.
- `src/api/runtime/friday-api-runtime.ts:835`  
  Current: routes deps exclude durable event reader.  
  Replacement: pass `listRunEvents` callback backed by run event repository.
- `src/agent/runtime/friday-agent-runtime.types.ts:32`  
  Current: runtime deps have no event store.  
  Replacement: add `runEventRepository` dependency (keeps deps lean by adding one focused dependency).

**Tests**:
- `test/unit/agent/persistence/friday-agent-run-event-repository.test.ts` (new): append/list ordering, sequence monotonicity.
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`: `agent.run.executing` emitted and persisted.
- `test/unit/api/http/routes/friday-agent-routes.test.ts`: SSE replay path includes persisted events.
- `test/integration/state/sqlite/friday-migration-chain.test.ts`: migration count/version updates and `friday_agent_run_events` table presence.
- `test/unit/state/friday-state-index.test.ts`: expected migration count/version updates.

**Verification**:
- Run one agent task, then query:
  - `SELECT seq,event_name FROM friday_agent_run_events WHERE run_id=? ORDER BY seq;`
- Confirm sequence continuity and presence of `agent.run.executing`.
- Reconnect to `/v1/agent/runs/:runId/events` and confirm replay works for completed runs.

---

### IMPL-4: SSRF Guard + Per-Run ReadOnly Constraints (covers AP-4)
**Files to modify**:
- `src/agent/runtime/friday-agent-runtime.types.ts`
- `src/agent/runtime/friday-agent-runtime.ts`
- `src/agent/model/friday-agent.types.ts`
- `src/agent/persistence/friday-agent-run-repository.ts`
- `src/agent/tools/friday-agent-tool-registry.ts`
- `src/agent/tools/friday-agent-web-fetch-tool.ts`
- `src/api/http/routes/friday-agent-routes.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/hub/friday-hub-bootstrap.ts`
- `src/agent/index.ts`
- `src/state/sqlite/migrations/index.ts`

**Files to create**:
- `src/state/sqlite/migrations/v020-agent-run-constraints.ts` (State/SQLite ownership)
- `src/agent/security/friday-agent-ssrf-guard.ts` (Agent Security ownership)
- `src/agent/runtime/friday-agent-tool-mutation.ts` (Agent Runtime ownership)

**Migration**:
- Version: `20` (`v020-agent-run-constraints`)
- SQL:
```sql
-- V020: Persist per-run execution constraints
ALTER TABLE friday_agent_runs
ADD COLUMN constraints_json TEXT NOT NULL DEFAULT '{}';
```
- Single responsibility: persist run-level constraints (starting with `readOnly`).

**Hub bootstrap wiring**:
- At `src/hub/friday-hub-bootstrap.ts:582`, instantiate SSRF guard service.
- At `src/hub/friday-hub-bootstrap.ts:583`, pass `ssrfGuard` to `createFridayAgentToolRegistry(...)`.
- At `src/hub/friday-hub-bootstrap.ts:616`, pass same `ssrfGuard` for child tool registry.

**Code changes**:
- `src/agent/tools/friday-agent-web-fetch-tool.ts:21`  
  Current: no guard options.  
  Replacement: accept `ssrfGuard` dependency.
- `src/agent/tools/friday-agent-web-fetch-tool.ts:66`  
  Current: direct `fetch(url, ...)`.  
  Replacement: guarded fetch flow with hostname/IP checks and redirect validation.
- `src/agent/tools/friday-agent-tool-registry.ts:21`  
  Current: registry options have no SSRF guard.  
  Replacement: add `ssrfGuard` option and forward to web_fetch tool.
- `src/agent/runtime/friday-agent-runtime.types.ts:10`  
  Current: no run constraints input.  
  Replacement: add `constraints?: { readOnly?: boolean }`.
- `src/agent/runtime/friday-agent-runtime.ts:176`  
  Current: all tool calls execute if resolved.  
  Replacement: call `isMutatingToolCall(...)`; if readOnly + mutating, block and emit tool_end error without execution.
- `src/api/http/routes/friday-agent-routes.ts:85`  
  Current: request validation excludes constraints.  
  Replacement: validate `constraints.readOnly` and pass through.
- `src/api/runtime/friday-api-runtime.ts:814`  
  Current: constraints not forwarded.  
  Replacement: forward `constraints` to runtime.
- `src/agent/persistence/friday-agent-run-repository.ts:121`  
  Current: no constraints persistence.  
  Replacement: map `constraints_json` in create/update/read.
- Pattern alignment references:
  - SSRF: `openclaw-dev/src/infra/net/ssrf.ts:337`, `openclaw-dev/src/infra/net/fetch-guard.ts:74`
  - Mutation classifier: `openclaw-dev/src/agents/tool-mutation.ts:98`

**Tests**:
- `test/unit/agent/tools/friday-agent-web-fetch-tool.test.ts`: blocks localhost/private/internal targets and allows normal public URL.
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`: readOnly run blocks mutating tools (`write`, `edit`, `exec`, `memory_store`, `workflow_run`, `skill_run`, mutating browser/xhs actions).
- `test/unit/api/http/routes/friday-agent-routes.test.ts`: constraints validation and forwarding.
- `test/unit/agent/runtime/friday-agent-tool-mutation.test.ts` (new): classifier cases for current tool set.

**Verification**:
- Start run with `constraints: { "readOnly": true }` and prompt to modify files; confirm blocked tool_end errors and unchanged filesystem.
- Call `web_fetch` for `http://localhost` / private IP; confirm blocked error.
- Call `web_fetch` for a public HTTPS URL; confirm success path still works.

---

## Batch 2: Quality + Persistence (v021-v022)

### IMPL-5: Runtime Validation Gate (covers AP-5)
**Files to modify**:  
`src/agent/runtime/friday-agent-runtime.types.ts`  
`src/agent/runtime/friday-agent-runtime.ts`  
`src/hub/friday-hub-bootstrap.ts`  
`src/agent/index.ts`  

**Files to create**:  
None (can be done inline in runtime + hub wiring)

**Migration**:  
None (uses existing `test_results` field; no schema change required)

**Hub bootstrap wiring**:  
At `src/hub/friday-hub-bootstrap.ts:528-633`, add construction of `FridayAgentSelfTestService` and inject it into both runtime factories (`createFridayAgentRuntime` for parent at `:599-609` and child at `:623-633`).

**Code changes**:  
- `src/agent/runtime/friday-agent-runtime.types.ts:32-42`  
Current: deps end at `nowIso`.  
Replacement: add optional, narrow self-test dependency and runtime workdir (keep lean, not full service graph).  
- `src/agent/runtime/friday-agent-runtime.ts:236-265`  
Current: unconditional success path, hardcoded `testsPassed: true` and `artifacts: []` at `:253-254`.  
Replacement:  
1. Transition to `testing`.  
2. Run `selfTestService.runTests(...)`.  
3. Evaluate explicit criteria object per run (`hasResponse`, `testsPassed`).  
4. Only set `completed` when criteria pass; otherwise persist failure (`status: "failed"`, `errorCode: AGENT_VALIDATION_ERROR`, criteria reason).  
5. Emit `agent.run.completed` only on pass, with real `testsPassed` + artifact list.  
- `src/hub/friday-hub-bootstrap.ts:50-63, 528-633`  
Current: runtime created without self-test.  
Replacement: create and pass self-test dependency into both parent and child runtime creation.

**Tests**:  
`test/unit/agent/runtime/friday-agent-runtime.test.ts`  
- Add case: failing self-test returns failed terminal status and no completed event.  
- Add case: empty final response fails completion criteria.  
- Add case: passing self-test emits completed with `testsPassed: true` from real result (not hardcoded).  

**Verification**:  
- Run: `npm test -- test/unit/agent/runtime/friday-agent-runtime.test.ts`  
- Confirm DB run row is never `completed` when criteria fail.  
- Confirm SSE still gets terminal event via `agent.run.failed`.

---

### IMPL-6: Durable Run Response + Session Mirror (covers AP-7)
**Files to modify**:  
`src/state/sqlite/migrations/index.ts`  
`src/agent/model/friday-agent.types.ts`  
`src/agent/persistence/friday-agent-run-repository.ts`  
`src/agent/runtime/friday-agent-runtime.types.ts`  
`src/agent/runtime/friday-agent-runtime.ts`  
`src/hub/friday-hub-bootstrap.ts`  
`src/api/runtime/friday-api-runtime.types.ts`  
`src/api/runtime/friday-api-runtime.ts`  
`test/integration/state/sqlite/friday-migration-chain.test.ts`  
`test/unit/agent/persistence/friday-agent-run-repository.test.ts`  
`test/unit/agent/runtime/friday-agent-runtime.test.ts`  
`test/unit/api/runtime/friday-api-runtime-session-registration.test.ts`  

**Files to create**:  
`src/state/sqlite/migrations/v021-agent-run-response-text-summary.ts`  
`test/unit/state/sqlite/friday-v021-agent-run-response-text-summary-schema.test.ts`

**Migration**:  
`v021` (single responsibility: persist final text fields on `friday_agent_runs`)  
```sql
-- V021: Persist final agent response text and summary
ALTER TABLE friday_agent_runs ADD COLUMN response_text TEXT;
ALTER TABLE friday_agent_runs ADD COLUMN summary TEXT;
```

**Hub bootstrap wiring**:  
- Create one shared `sessionService` instance in `src/hub/friday-hub-bootstrap.ts` (near shared utilities around `:396-405`).  
- Inject message mirror callback into `createFridayAgentRuntime` at `:599-609` and `:623-633`.  
- Pass same `sessionService` into API runtime creation at `src/hub/friday-hub-bootstrap.ts:703-747`.

**Code changes**:  
- `src/agent/runtime/friday-agent-runtime.ts:260`  
Current: final response only returned in-memory.  
Replacement: persist `response_text` + `summary` in run update before return.  
- `src/agent/runtime/friday-agent-runtime.ts:214-233, 238-247, 273-283`  
Current: terminal updates omit response fields.  
Replacement: include `responseText` and derived `summary` in all terminal DB updates.  
- `src/agent/runtime/friday-agent-runtime.types.ts:32-42`  
Add narrow optional sink callback for session mirroring (not full `FridaySessionService` type to keep deps lean).  
- `src/agent/persistence/friday-agent-run-repository.ts:15-35, 37-63, 86-103, 178-209`  
Add `response_text`, `summary` row mapping and update setters.  
- `src/agent/model/friday-agent.types.ts:75-95`  
Add `responseText?: string`, `summary?: string` to `FridayAgentRunRecord`.  
- `src/api/runtime/friday-api-runtime.types.ts:52-92` + `src/api/runtime/friday-api-runtime.ts:763-767`  
Allow optional injected `sessionService`, fallback to current constructor path.  
- Mirror final assistant response via `sessionService.addMessage()` (`src/sessions/services/friday-session-service.ts:212`) with deterministic `idempotencyKey`.

**Tests**:  
- `test/unit/agent/persistence/friday-agent-run-repository.test.ts`: round-trip for `responseText` and `summary`.  
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`: verifies mirror callback called with final response and run metadata.  
- `test/unit/api/runtime/friday-api-runtime-session-registration.test.ts`: API runtime reuses injected session service.  
- `test/unit/state/sqlite/friday-v021-agent-run-response-text-summary-schema.test.ts`: columns exist and migration row recorded.  
- `test/integration/state/sqlite/friday-migration-chain.test.ts`: replace hardcoded “16” expectations with `FRIDAY_SQLITE_MIGRATIONS.length` and dynamic version list.

**Verification**:  
1. POST `/v1/agent/runs`  
2. GET `/v1/agent/runs/:runId` shows `responseText` + `summary`.  
3. DB check: `SELECT response_text, summary FROM friday_agent_runs WHERE id=?`  
4. DB check: `SELECT role, content_text FROM session_messages WHERE session_key=? ORDER BY sequence DESC LIMIT 1` contains mirrored assistant reply.

---

### IMPL-7: Disk Artifact Ledger + `artifact_dir` Persistence (covers AP-8)
**Files to modify**:  
`src/state/sqlite/migrations/index.ts`  
`src/agent/model/friday-agent.types.ts`  
`src/agent/persistence/friday-agent-run-repository.ts`  
`src/agent/runtime/friday-agent-runtime.types.ts`  
`src/agent/runtime/friday-agent-runtime.ts`  
`src/hub/friday-hub-bootstrap.ts`  
`src/agent/index.ts`  
`test/integration/state/sqlite/friday-migration-chain.test.ts`  
`test/unit/agent/runtime/friday-agent-runtime.test.ts`  

**Files to create**:  
`src/state/sqlite/migrations/v022-agent-run-artifact-dir.ts`  
`src/agent/services/friday-agent-artifact-writer.ts`  
`test/unit/agent/services/friday-agent-artifact-writer.test.ts`  
`test/unit/state/sqlite/friday-v022-agent-run-artifact-dir-schema.test.ts`

**Migration**:  
`v022` (single responsibility: persist artifact root path for run)  
```sql
-- V022: Persist run artifact directory
ALTER TABLE friday_agent_runs ADD COLUMN artifact_dir TEXT;
```

**Hub bootstrap wiring**:  
At `src/hub/friday-hub-bootstrap.ts:566-589`, create artifact writer using `workspaceRoot`.  
Inject writer into runtime creation at `:599-609` and child runtime creation at `:623-633`.

**Code changes**:  
- `src/agent/runtime/friday-agent-runtime.ts:249-255`  
Current: emits empty artifacts.  
Replacement: use artifact writer output (`artifactDir`, concrete artifact list) and persist both to DB.  
- `src/agent/runtime/friday-agent-runtime.ts`  
Add step to persist run files into `.friday/agent-runs/<runId>/` before terminal update; write deterministic records (`run.json`, `tool-calls.json`, `test-results.json`, `response.md`, `artifacts.json`).  
- `src/agent/services/friday-agent-artifact-writer.ts`  
New service that performs file-based sync pattern (idempotent file writes, no git operations, no auto-commit), aligned with OpenClaw’s memory/session file approach.  
- `src/agent/persistence/friday-agent-run-repository.ts:15-35, 37-63, 86-103, 170-209`  
Add `artifact_dir` mapping + update setter.  
- `src/agent/model/friday-agent.types.ts:75-95`  
Add `artifactDir?: string`.

**Tests**:  
- `test/unit/agent/services/friday-agent-artifact-writer.test.ts`: directory layout, deterministic rewrites, path safety, no VCS side effects.  
- `test/unit/agent/runtime/friday-agent-runtime.test.ts`: runtime stores non-empty artifacts and `artifactDir`.  
- `test/unit/state/sqlite/friday-v022-agent-run-artifact-dir-schema.test.ts`: column and migration metadata.  
- `test/integration/state/sqlite/friday-migration-chain.test.ts`: includes v021/v022 chain.

**Verification**:  
1. Run an agent task that writes/edits files.  
2. Confirm `.friday/agent-runs/<runId>/` exists with expected records.  
3. Confirm DB `artifact_dir` is set and `artifacts` JSON is populated.  
4. Confirm no git behavior is introduced (`rg "git\\s+commit|git\\s+add"` in new agent artifact code returns none).
