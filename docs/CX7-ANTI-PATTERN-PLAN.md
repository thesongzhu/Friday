> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

### AP-1: Mixed architecture and execution in same context
**Friday current state**: Partial only. `planning`/`executing` statuses exist in types (`src/agent/model/friday-agent.types.ts:5`, `src/agent/model/friday-agent.types.ts:6`), but runtime emits a fixed planning message (`src/agent/runtime/friday-agent-runtime.ts:110`) and immediately switches to execution (`src/agent/runtime/friday-agent-runtime.ts:119`) with no persisted plan artifact/table (`src/state/sqlite/migrations/v012-agent-runtime.ts:7`).

**OpenClaw reference**: OpenClaw isolates execution attempts (`src/agents/pi-embedded-runner/run.ts:425`) and repairs/sanitizes transcript before each attempt (`src/agents/pi-embedded-runner/run/attempt.ts:481`, `src/agents/pi-embedded-runner/run/attempt.ts:631`, `src/agents/pi-embedded-runner/run/attempt.ts:654`), reducing context corruption between phases.

**Gap**: Friday has no enforced architecture/execution boundary and no durable plan artifact.

**Implementation plan**:
1. Create plan persistence and explicit phase machine.
- Create `src/state/sqlite/migrations/v017-agent-run-plans-events.ts` with `friday_agent_run_plans`.
- Create `src/agent/persistence/friday-agent-run-plan-repository.ts`.
- Create `src/agent/runtime/friday-agent-run-machine.ts` (pending -> planning -> reviewing -> executing -> testing -> terminal).
2. Split runtime into two contexts.
- Modify `src/agent/runtime/friday-agent-runtime.ts` to run a planning pass with tools disabled, persist structured plan, then start execution with a compact plan summary context.
3. Extend events/types.
- Update `src/agent/model/friday-agent.types.ts` with `agent.run.plan_created` and `reviewing` status.
4. Wire migration index.
- Update `src/state/sqlite/migrations/index.ts`.

```ts
// src/agent/runtime/friday-agent-runtime.ts
const plan = await runPlanningPass({ task: params.task, model: selectedModel, tools: [] });
planRepo.upsert(writer, { runId, planJson: JSON.stringify(plan), createdAt: nowIso() });
repo.update(writer, { id: runId, status: "reviewing" });
eventEmitter.emit("agent.run.plan_created", { runId, stepCount: plan.steps.length });
```

**Test cases**:
1. `test/unit/agent/runtime/friday-agent-runtime.plan-phase.test.ts`: run must persist plan before first execute step.  
- FAIL today: no plan table/write.  
- PASS after: plan row exists and first `executing` event has higher seq than `plan_created`.
2. `test/unit/agent/runtime/friday-agent-runtime.plan-phase.test.ts`: invalid/empty plan must fail before tool execution.  
- FAIL today: execution starts regardless.  
- PASS after: status `failed`, `toolCallCount=0`.

---

### AP-2: Trusting UI over logs
**Friday current state**: UI/API accepts `providerId`/`model` (`src/api/http/routes/friday-agent-routes.ts:85`, `src/api/http/routes/friday-agent-routes.ts:86`), but runtime invocation drops them (`src/api/runtime/friday-api-runtime.ts:814`). Run records are created with boot defaults (`src/agent/runtime/friday-agent-runtime.ts:64`, `src/agent/runtime/friday-agent-runtime.ts:65`; defaults set in `src/hub/friday-hub-bootstrap.ts:593`, `src/hub/friday-hub-bootstrap.ts:594`). Cost field exists (`src/agent/persistence/friday-agent-run-repository.ts:206`) but agent runtime never writes it.

**OpenClaw reference**: OpenClaw resolves provider/model at runtime (`src/agents/pi-embedded-runner/run.ts:201`, `src/agents/pi-embedded-runner/run.ts:202`) and returns actual provider/model/usage in `agentMeta` (`src/agents/pi-embedded-runner/run.ts:878`, `src/agents/pi-embedded-runner/run.ts:887`, `src/agents/pi-embedded-runner/run.ts:889`).

**Gap**: Friday records requested/default model, not actual routed model; no per-run cost fidelity.

**Implementation plan**:
1. Pass through requested routing params.
- Modify `src/agent/runtime/friday-agent-runtime.types.ts` to include `providerId?`, `model?`.
- Modify `src/api/runtime/friday-api-runtime.ts` to forward `providerId`/`model` into `executeRun`.
2. Emit route metadata from LLM bridge.
- Extend `src/agent/runtime/friday-agent-llm-client.types.ts` with `route` stream event.
- Modify `src/hub/friday-hub-bootstrap.ts` LLM bridge to emit final route details from `runWithFallback`.
3. Persist actual route + cost per run.
- Modify `src/agent/runtime/friday-agent-runtime.ts` to capture route metadata and update run with actual provider/model/cost.
- Modify `src/agent/persistence/friday-agent-run-repository.ts` `update()` to support provider/model updates.
- Add columns in `v017` for `route_strategy`, `fallback_attempts`, `actual_provider_id`, `actual_model` (or repurpose existing with overwrite-on-actual).
4. Record provider usage per run.
- Inject `providerService.recordUsage` callback into runtime deps from `src/hub/friday-hub-bootstrap.ts`.

```ts
// src/api/runtime/friday-api-runtime.ts
const result = await deps.agentRuntime!.executeRun({
  task: input.task,
  providerId: input.providerId,
  model: input.model,
  runId,
  timeoutMs: input.timeoutMs,
  signal: abortController.signal,
});
```

**Test cases**:
1. `test/unit/api/runtime/friday-api-runtime-agent-routing.test.ts`: provider/model must be forwarded to runtime.  
- FAIL today: omitted.  
- PASS after: spy sees exact values.
2. `test/unit/agent/runtime/friday-agent-runtime.routing-metadata.test.ts`: run record model/provider must match actual fallback route, not requested default.  
- FAIL today: always default boot values.  
- PASS after: persisted actual route.
3. `test/unit/agent/runtime/friday-agent-runtime.routing-metadata.test.ts`: `costUsd` persisted per run.  
- FAIL today: null/undefined.  
- PASS after: numeric value.

---

### AP-3: Agent doesn’t explain its reasoning step-by-step
**Friday current state**: `agent.run.executing` payload exists (`src/agent/model/friday-agent.types.ts:136`) and is in event map (`src/agent/model/friday-agent.types.ts:212`), but runtime never emits it (only started/planning/tool/text/completed). Emitter is in-memory only (`src/agent/runtime/friday-agent-event-emitter.ts:23`, `src/agent/runtime/friday-agent-event-emitter.ts:45`). SSE is live-only and terminal runs return one status frame (`src/api/http/routes/friday-agent-routes.ts:215`, `src/api/http/routes/friday-agent-routes.ts:261`).

**OpenClaw reference**: OpenClaw emits lifecycle/assistant/tool phases (`src/agents/pi-embedded-subscribe.handlers.lifecycle.ts:14`, `src/agents/pi-embedded-subscribe.handlers.messages.ts:167`, `src/agents/pi-embedded-subscribe.handlers.tools.ts:99`, `src/agents/pi-embedded-subscribe.handlers.tools.ts:241`) and uses monotonic run-local seq (`src/infra/agent-events.ts:20`, `src/infra/agent-events.ts:57`, `src/infra/agent-events.ts:68`).

**Gap**: Friday lacks durable, ordered, replayable step-level audit trail.

**Implementation plan**:
1. Add durable agent run event store.
- Create table `friday_agent_run_events` in `v017`.
- Create `src/agent/persistence/friday-agent-run-event-repository.ts`.
2. Emit step-level events.
- Modify `src/agent/runtime/friday-agent-runtime.ts` to emit `agent.run.executing` before each LLM pass and each tool execution.
3. Add seq and replay.
- Extend emitter or add wrapper to assign per-run sequence numbers.
- Modify `src/api/http/routes/friday-agent-routes.ts` SSE endpoint to replay stored events first, then tail live events (`afterSeq` support).
4. Optional: expose REST pull for audit.
- Add `GET /v1/agent/runs/:runId/events?afterSeq=` route for non-SSE consumers.

```ts
const seq = eventRepo.append(db, { runId, event: name, payloadJson, occurredAt: nowIso() });
rawRes.write(`data: ${JSON.stringify({ seq, type: name, ...payload })}\n\n`);
```

**Test cases**:
1. `test/unit/agent/runtime/friday-agent-runtime.audit-events.test.ts`: at least one `agent.run.executing` event per LLM loop iteration.  
- FAIL today: zero executing events.  
- PASS after: >=1 and ordered.
2. `test/unit/api/http/routes/friday-agent-routes.events-replay.test.ts`: SSE subscriber attaching after completion receives full historical stream from DB.  
- FAIL today: only terminal status event.  
- PASS after: replayed planning/executing/tool/completed with seq.
3. `test/unit/agent/persistence/friday-agent-run-event-repository.test.ts`: per-run seq monotonic and gap-free.

---

### AP-4: Agent optimizes everything without boundaries
**Friday current state**: Strong filesystem/exec sandboxing exists (`src/agent/tools/friday-agent-exec-tool.ts:74`, `src/agent/tools/friday-agent-exec-tool.ts:97`, `src/agent/tools/friday-agent-file-tools.ts:37`, `src/agent/tools/friday-agent-file-tools.ts:81`). But no confirmation gate for mutating actions, and `web_fetch` has no SSRF/private-network guard (`src/agent/tools/friday-agent-web-fetch-tool.ts:66`). Agent routes still reuse `workflow.run` scope with TODO for dedicated scope (`src/api/http/routes/friday-agent-routes.ts:72`, `src/api/http/routes/friday-agent-routes.ts:74`).

**OpenClaw reference**: Layered tool policy enforcement (`src/agents/pi-tools.ts:198`, `src/agents/pi-tools.ts:241`, `src/agents/pi-tools.ts:426`), owner-only policy (`src/agents/tool-policy.ts:61`, `src/agents/tool-policy.ts:91`), explicit exec approvals (`src/agents/bash-tools.exec.ts:453`, `src/agents/bash-tools.exec.ts:633`, `src/infra/exec-approvals.ts:417`), SSRF-guarded fetch (`src/agents/tools/web-fetch.ts:4`, `src/agents/tools/web-fetch.ts:416`, `src/infra/net/ssrf.ts:351`, `src/infra/net/ssrf.ts:373`).

**Gap**: Friday lacks explicit confirmation boundaries and network boundary hardening.

**Implementation plan**:
1. Add per-run policy envelope.
- Extend start run input with `constraints` (`readOnly`, `allowedPaths`, `allowedHosts`, `requireMutatingApproval`).
- Enforce in `src/agent/runtime/friday-agent-runtime.ts` before tool execute.
2. Add confirmation gate APIs.
- Add `POST /v1/agent/runs/:runId/approvals` + `POST /v1/agent/runs/:runId/approvals/:id/resolve`.
3. Add SSRF guard to web fetch.
- Add `src/agent/tools/friday-agent-ssrf-guard.ts` and use in `src/agent/tools/friday-agent-web-fetch-tool.ts`.
4. Add dedicated auth scopes.
- Extend `src/api/model/friday-api-auth.types.ts` with `agent.run` and `agent.approve`.
- Update `src/api/http/routes/friday-agent-routes.ts` auth scope usage.

```ts
if (constraints.readOnly && isMutatingTool(toolUse.name)) {
  throw new FridayDomainError("AGENT_POLICY_VIOLATION", "Mutating tool blocked in readOnly mode", { httpStatus: 403 });
}
```

**Test cases**:
1. `test/unit/agent/tools/friday-agent-web-fetch-tool.test.ts`: block `http://127.0.0.1` and `http://localhost`.  
- FAIL today: request allowed.  
- PASS after: returns policy error.
2. `test/unit/agent/runtime/friday-agent-runtime.boundary.test.ts`: `readOnly=true` blocks `write/edit/exec`.  
- FAIL today: tools run.  
- PASS after: run fails or pauses with policy violation.
3. `test/unit/api/http/routes/friday-agent-routes.auth.test.ts`: agent routes require `agent.run` scope.  
- FAIL today: `workflow.run`.  
- PASS after: dedicated scope enforced.

---

### AP-5: False success (looks connected but only partially works)
**Friday current state**: Runtime marks success without explicit criteria, hardcoding `testsPassed: true` and empty artifacts (`src/agent/runtime/friday-agent-runtime.ts:253`, `src/agent/runtime/friday-agent-runtime.ts:254`). It finalizes `completed` directly (`src/agent/runtime/friday-agent-runtime.ts:241`). A self-test service exists (`src/agent/testing/friday-agent-self-test-service.ts:20`) but is not wired into runtime. Workflow engine has explicit failure criteria/policies (`src/workflows/services/friday-workflow-execution-service.ts:513`, `src/workflows/services/friday-workflow-execution-service.ts:575`).

**OpenClaw reference**: OpenClaw converts timeout/overflow/error conditions into explicit error payloads instead of silent success (`src/agents/pi-embedded-runner/run.ts:654`, `src/agents/pi-embedded-runner/run.ts:910`, `src/agents/pi-embedded-runner/run.ts:918`).

**Gap**: Agent runtime has no explicit success/failure contract beyond “loop ended”.

**Implementation plan**:
1. Add `successCriteria` to run input.
- Example: required artifacts, tests required, required changed files.
2. Wire self-test service into runtime.
- Inject `FridayAgentSelfTestService` in deps and run after execution.
3. Infer/persist artifacts.
- Derive artifacts from successful mutating tool calls and persist to run row.
4. Finalize by criteria.
- Status `completed` only if criteria + tests pass; otherwise `failed_tests`.

```ts
const testResults = await selfTest.runTests({ artifacts, workdir: params.workdir });
const testsPassed = testResults.every((r) => r.passed);
const finalStatus = testsPassed && criteriaPassed ? "completed" : "failed_tests";
repo.update(writer, { id: runId, status: finalStatus, testResults, artifacts });
```

**Test cases**:
1. `test/unit/agent/runtime/friday-agent-runtime.success-criteria.test.ts`: syntax-invalid generated file must produce `failed_tests`.  
- FAIL today: `completed`.  
- PASS after: `failed_tests`.
2. `test/unit/agent/runtime/friday-agent-runtime.success-criteria.test.ts`: missing required artifact type fails run.  
- FAIL today: still `completed`.  
- PASS after: `failed_tests`.
3. `test/unit/agent/runtime/friday-agent-runtime.success-criteria.test.ts`: completion event `testsPassed` reflects actual results.  
- FAIL today: always true.  
- PASS after: true/false as computed.

---

### AP-6: Coding before understanding
**Friday current state**: Planning is non-blocking text only (`src/agent/runtime/friday-agent-runtime.ts:110`) and execution starts immediately (`src/agent/runtime/friday-agent-runtime.ts:119`). Workflow engine already supports true approval gating (`src/workflows/services/friday-workflow-execution-service.ts:314`, `src/workflows/services/friday-workflow-execution-service.ts:704`), but agent runtime does not.

**OpenClaw reference**: OpenClaw enforces pre-execution context hygiene (session repair/sanitize/turn validation) before run (`src/agents/pi-embedded-runner/run/attempt.ts:481`, `src/agents/pi-embedded-runner/run/attempt.ts:631`, `src/agents/pi-embedded-runner/run/attempt.ts:645`).

**Gap**: No mandatory planning/review checkpoint in Friday’s agent runtime.

**Implementation plan**:
1. Add mandatory review gate for agent runs.
- Extend runtime input with `requireReview`.
- Add `reviewing` status and transitions in run machine.
2. Add review APIs.
- `GET /v1/agent/runs/:runId/plan`
- `POST /v1/agent/runs/:runId/review` (approve/reject)
3. Resume only after review approval.
- Execution loop starts only after approved review decision.
4. Optional integration: delegate review to workflow approval service for consistency.

```ts
if (params.requireReview && !reviewRepo.isApproved(runId)) {
  repo.update(writer, { id: runId, status: "reviewing" });
  return { runId, status: "pending_review", ...emptyResult };
}
```

**Test cases**:
1. `test/unit/agent/runtime/friday-agent-runtime.review-gate.test.ts`: `requireReview=true` must not execute tools until approved.  
- FAIL today: executes immediately.  
- PASS after: remains `reviewing`.
2. `test/unit/api/http/routes/friday-agent-routes.review.test.ts`: approve endpoint transitions run to executing and eventually terminal.
3. `test/unit/api/http/routes/friday-agent-routes.review.test.ts`: reject endpoint marks run failed with `REVIEW_REJECTED`.

---

### AP-7: Results only in chat, not in files
**Friday current state**: Final response is returned in-memory (`src/agent/runtime/friday-agent-runtime.ts:260`) but not persisted in run schema (`src/state/sqlite/migrations/v012-agent-runtime.ts:7`). SSE is ephemeral/live (`src/api/http/routes/friday-agent-routes.ts:261`). Session message persistence exists (`src/sessions/services/friday-session-service.ts:212`) but agent runtime does not write into it.

**OpenClaw reference**: Assistant output is appended to durable transcript via `SessionManager.appendMessage` (`src/config/sessions/transcript.ts:121`, `src/config/sessions/transcript.ts:122`) and transcript updates are emitted (`src/config/sessions/transcript.ts:159`, `src/sessions/transcript-events.ts:16`).

**Gap**: Friday agent outputs/events are not durably captured as transcript artifacts.

**Implementation plan**:
1. Persist final response + summary.
- Add `response_text` and `summary_json` columns in `v017`.
- Update `src/agent/persistence/friday-agent-run-repository.ts` mappings.
2. Persist run transcript/events.
- Reuse AP-3 run event table for full replayable audit.
3. Mirror final assistant response into session store.
- Inject `sessionService` into runtime deps and append `assistant` message with `metadata.runId`.
4. Add retrieval route.
- `GET /v1/agent/runs/:runId/transcript` (assembled from event log + response).

```ts
repo.update(writer, { id: runId, responseText: responseText, summaryJson: JSON.stringify(summary) });
await deps.sessionService?.addMessage(sessionKey, {
  role: "assistant",
  content: responseText,
  metadata: { runId },
});
```

**Test cases**:
1. `test/unit/agent/runtime/friday-agent-runtime.persistence.test.ts`: completed run stores `response_text`.  
- FAIL today: no field.  
- PASS after: non-empty persisted value.
2. `test/unit/agent/runtime/friday-agent-runtime.persistence.test.ts`: session store gets assistant message tagged with runId.
3. `test/unit/api/http/routes/friday-agent-routes.events-replay.test.ts`: reconnect can rebuild run transcript from durable events.

---

### AP-8: Model memory vs Git memory
**Friday current state**: Agent runtime emits empty artifact list on completion (`src/agent/runtime/friday-agent-runtime.ts:254`) and has no built-in decision/artifact checkpoint pipeline. Workflow artifacts exist (`src/workflows/engine/friday-workflow-artifact-writer.ts:48`) but agent runtime does not use analogous durable artifacts.

**OpenClaw reference**: OpenClaw continuously syncs durable memory/session files into indexed storage (`src/memory/sync-memory-files.ts:16`, `src/memory/sync-session-files.ts:21`, `src/memory/session-files.ts:74`), reducing reliance on transient model context.

**Gap**: Friday lacks mandatory disk-backed decision records and optional VCS checkpointing for agent runs.

**Implementation plan**:
1. Add mandatory run artifact pack on disk.
- Create `src/agent/services/friday-agent-artifact-writer.ts`.
- Write `.friday/agent-runs/<runId>/plan.json`, `execution-log.jsonl`, `final-response.md`, `decision-record.json`.
2. Persist artifact location in DB.
- Add `artifact_dir` column in `v017`.
3. Add optional git checkpoint mode.
- Add `gitCheckpointMode` (`off|staged|commit`) in runtime input.
- Implement `src/agent/services/friday-agent-git-checkpoint.ts` and store `git_commit_sha`.
4. Enforce policy.
- Disallow `commit` mode without explicit approval (tie into AP-4 confirmation flow).

```ts
const artifactDir = path.join(workspaceRoot, ".friday", "agent-runs", runId);
await artifactWriter.writeDecisionRecord(artifactDir, { runId, task, plan, outcome });
if (params.gitCheckpointMode === "commit") {
  const sha = await gitCheckpoint.commit({ cwd: workspaceRoot, message: `agent(${runId}): ${summary}` });
  repo.update(writer, { id: runId, gitCommitSha: sha });
}
```

**Test cases**:
1. `test/unit/agent/runtime/friday-agent-runtime.artifacts.test.ts`: run creates artifact directory and files.  
- FAIL today: no artifact pack.  
- PASS after: files exist + DB `artifact_dir` set.
2. `test/unit/agent/runtime/friday-agent-runtime.git-checkpoint.test.ts`: commit mode stores `git_commit_sha`.  
- FAIL today: no git checkpoint flow.  
- PASS after: SHA persisted.
3. `test/unit/agent/runtime/friday-agent-runtime.git-checkpoint.test.ts`: commit mode without approval is blocked.

---

Note: OpenClaw repo does not currently have `src/workspace/`; equivalent durability/boundary behavior is implemented in `src/agents/*`, `src/config/sessions/*`, and `src/memory/*` (references above).
