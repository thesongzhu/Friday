> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

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
