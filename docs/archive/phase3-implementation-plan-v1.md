> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

Reading the four requested sources now and extracting the workflow/DAG constraints only. I’ll then produce a single-pass Phase 3 implementation plan aligned to the current schema and code layout.

---

I’ve captured the workflow table schema and current TypeScript module layout. Next I’m pulling the architecture §5-§6 details plus the existing sqlite type signatures so the plan matches current contracts exactly.

---

I’ve got the schema and architecture constraints; now I’m checking a couple of existing runtime/skills type files so the proposed DAG services align with established naming and wiring patterns.

---

**1. File Structure (New Files)**

```text
src/workflows/index.ts

src/workflows/model/friday-workflow-graph.types.ts
src/workflows/model/friday-workflow-entity.types.ts
src/workflows/model/friday-workflow-run.types.ts
src/workflows/model/friday-workflow-trigger.types.ts
src/workflows/model/friday-workflow-state-machine.types.ts
src/workflows/model/friday-workflow-persistence.types.ts

src/workflows/persistence/friday-workflow-definition-repository.ts
src/workflows/persistence/friday-workflow-version-repository.ts
src/workflows/persistence/friday-workflow-run-repository.ts
src/workflows/persistence/friday-workflow-run-node-repository.ts
src/workflows/persistence/friday-workflow-artifact-repository.ts
src/workflows/persistence/friday-workflow-trigger-cursor-repository.ts

src/workflows/services/friday-workflow-graph-validator.ts
src/workflows/services/friday-workflow-compiler-adapter.ts
src/workflows/services/friday-workflow-definition-service.ts
src/workflows/services/friday-workflow-versioning-service.ts
src/workflows/services/friday-workflow-run-service.ts
src/workflows/services/friday-workflow-state-machine.ts
src/workflows/services/friday-workflow-dispatcher-service.ts
src/workflows/services/friday-workflow-node-attempt-service.ts
src/workflows/services/friday-workflow-node-executor-service.ts
src/workflows/services/friday-workflow-artifact-service.ts
src/workflows/services/friday-workflow-trigger-service.ts
src/workflows/services/friday-workflow-schedule-trigger-service.ts
src/workflows/services/friday-workflow-event-trigger-service.ts
src/workflows/services/friday-workflow-recovery-service.ts

src/workflows/runtime/friday-workflow-runtime.types.ts
src/workflows/runtime/friday-workflow-runtime.ts

src/workflows/test/friday-workflow-graph-validator.test.ts
src/workflows/test/friday-workflow-definition-service.test.ts
src/workflows/test/friday-workflow-versioning-service.test.ts
src/workflows/test/friday-workflow-run-service.test.ts
src/workflows/test/friday-workflow-dispatcher-service.test.ts
src/workflows/test/friday-workflow-node-attempt-service.test.ts
src/workflows/test/friday-workflow-node-executor-service.test.ts
src/workflows/test/friday-workflow-trigger-service.test.ts
src/workflows/test/friday-workflow-recovery-service.test.ts
src/workflows/test/friday-workflow-state-machine.test.ts
src/workflows/test/friday-workflow-artifact-service.test.ts
src/workflows/test/friday-workflow-runtime.test.ts
```

**2. Type Definitions (Full Signatures)**

```ts
// src/workflows/model/friday-workflow-graph.types.ts
export type FridayWorkflowNodeType = "trigger" | "action" | "condition" | "data" | "ai" | "approval";
export type FridayWorkflowFailureStrategy =
  | "fail_fast"
  | "continue_on_error"
  | "fallback_step"
  | "compensate"
  | "pause_for_approval";

export interface FridayWorkflowFailurePolicy {
  onFailure: FridayWorkflowFailureStrategy;
  fallbackStepId?: string;
  compensationWorkflowId?: string;
  notifyUser: boolean;
}

export interface FridayWorkflowRetryPolicy {
  maxAttempts: number;
  backoff: "none" | "fixed" | "exponential";
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: string[];
}

export interface FridayWorkflowNodeExecutionTargetPolicy {
  strategy: "auto" | "pin" | "affinity";
  requiredCapabilities: string[];
  preferredSatelliteIds?: string[];
  prohibitedSatelliteIds?: string[];
  dataResidency?: "local_only" | "same_region" | "any";
}

export interface FridayWorkflowNode {
  id: string;
  type: FridayWorkflowNodeType;
  label: string;
  config: Record<string, unknown>;
  retryPolicy?: FridayWorkflowRetryPolicy;
  timeoutMs?: number;
  executionTarget?: FridayWorkflowNodeExecutionTargetPolicy;
}

export interface FridayWorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  condition?: string;
  priority?: number;
}

export interface FridayCompiledWorkflowGraphV2 {
  schemaVersion: "2.0";
  workflowId: string;
  workflowVersionId: string;
  sourceSpecSchemaVersion: "1.0";
  graph: {
    nodes: FridayWorkflowNode[];
    edges: FridayWorkflowEdge[];
    variables?: Record<string, unknown>;
  };
  failurePolicy: FridayWorkflowFailurePolicy;
  tests: Array<{
    name: string;
    description?: string;
    inputs: Record<string, unknown>;
    mocks?: Record<string, { output: Record<string, unknown>; status?: "completed" | "failed" }>;
    assertions: Array<{
      path: string;
      operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
      expected: unknown;
    }>;
  }>;
  checksum: string;
}
```

```ts
// src/workflows/model/friday-workflow-run.types.ts
export type FridayWorkflowRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "compensating"
  | "completed"
  | "failed"
  | "cancelled";

export type FridayWorkflowNodeAttemptStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "blocked_offline"
  | "cancelled";

export type FridayWorkflowTriggerType = "manual" | "schedule" | "event";

export interface FridayWorkflowRunCreateInput {
  workflowId: string;
  workflowVersionId?: string;
  triggerType: FridayWorkflowTriggerType | string;
  triggerPayload?: Record<string, unknown>;
  startedByUserId?: string;
  startedBySatelliteId?: string;
  correlationId?: string;
  context?: Record<string, unknown>;
}

export interface FridayWorkflowRunFailure {
  code: string;
  message: string;
  details?: unknown;
}

export interface FridayWorkflowNodeAttemptError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface FridayWorkflowNodeExecutionRequest {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  node: FridayWorkflowNode;
  attempt: number;
  attemptId: string;
  input: unknown;
  idempotencyKey: string;
  startedAt: string;
}

export interface FridayWorkflowNodeExecutionResult {
  status: "completed" | "failed" | "blocked_offline" | "cancelled";
  output?: unknown;
  error?: FridayWorkflowNodeAttemptError;
  artifacts?: FridayWorkflowArtifactWriteInput[];
  selectedSatelliteId?: string;
  leaseExtensionMs?: number;
}

export interface FridayWorkflowArtifactWriteInput {
  id: string;
  runId: string;
  nodeId: string;
  artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
  uri: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
}
```

```ts
// src/workflows/model/friday-workflow-trigger.types.ts
export interface FridayWorkflowScheduleTriggerConfig {
  kind: "cron";
  expression: string;
  timezone?: string;
}

export interface FridayWorkflowEventTriggerConfig {
  kind: "event";
  eventType: string;
  filterExpression?: string;
}

export interface FridayWorkflowTriggerCursor {
  workflowVersionId: string;
  nodeId: string;
  triggerKind: "cron" | "event";
  lastCursor?: string;
  lastFiredAt?: string;
  updatedAt: string;
}
```

```ts
// src/workflows/model/friday-workflow-persistence.types.ts
export interface FridayWorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tags_json: string;
  owner_user_id: string | null;
  latest_version_number: number;
  published_version_number: number | null;
  is_archived: number;
  revision: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface FridayWorkflowVersionRow {
  id: string;
  workflow_id: string;
  version_number: number;
  checksum: string;
  graph_json: string;
  created_by_user_id: string | null;
  is_published: number;
  change_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayWorkflowRunRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: FridayWorkflowRunStatus;
  trigger_type: string;
  trigger_payload_json: string | null;
  started_by_user_id: string | null;
  started_by_satellite_id: string | null;
  started_at: string;
  finished_at: string | null;
  correlation_id: string | null;
  context_json: string | null;
  failure_code: string | null;
  failure_message: string | null;
  failure_details_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface FridayWorkflowRunNodeRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  attempt_id: string;
  status: FridayWorkflowNodeAttemptStatus;
  satellite_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
}

export interface FridayWorkflowArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  artifact_type: "json" | "text" | "file" | "image" | "audio" | "video";
  uri: string;
  checksum: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}
```

**3. Persistence Repositories**

- `src/workflows/persistence/friday-workflow-definition-repository.ts`
  - `insertWorkflow(db, input)`
  - `getWorkflowById(db, workflowId)`
  - `getWorkflowBySlug(db, slug)`
  - `listWorkflows(db, filter)`
  - `updateWorkflowWithRevision(db, input)` (checks `expectedRevision` + `etag`)
  - `archiveWorkflow(db, input)`
  - `setVersionPointers(db, input)` (`latest_version_number`, `published_version_number`, `revision`, `etag`)

- `src/workflows/persistence/friday-workflow-version-repository.ts`
  - `insertVersion(db, input)` into `workflow_versions`
  - `getVersionById(db, versionId)`
  - `getLatestVersion(db, workflowId)`
  - `getPublishedVersion(db, workflowId)`
  - `listVersions(db, workflowId, cursor, limit)`
  - `publishVersion(db, workflowId, versionId)` (clear existing `is_published`, set target `is_published=1`)

- `src/workflows/persistence/friday-workflow-run-repository.ts`
  - `insertRun(db, input)` into `workflow_runs`
  - `getRunById(db, runId)`
  - `listRunsByStatus(db, statuses)`
  - `updateRunStatus(db, input)`
  - `finishRun(db, input)` (`finished_at`, failure fields)
  - `findRunByCorrelation(db, workflowId, correlationId)` for trigger dedupe

- `src/workflows/persistence/friday-workflow-run-node-repository.ts`
  - `insertAttempt(db, input)` into `workflow_run_nodes`
  - `getAttempt(db, runId, nodeId, attempt)`
  - `getLatestAttemptForNode(db, runId, nodeId)`
  - `listAttemptsByRun(db, runId)`
  - `claimRunnableAttempts(db, input)` (lease CAS update for `queued`/`retrying`)
  - `extendLease(db, attemptId, leaseOwner, leaseExpiresAt)`
  - `completeAttempt(db, input)`
  - `failAttempt(db, input)`
  - `cancelOpenAttemptsByRun(db, runId)`
  - `listExpiredLeases(db, nowIso)`

- `src/workflows/persistence/friday-workflow-artifact-repository.ts`
  - `insertArtifact(db, input)` into `workflow_artifacts`
  - `listArtifactsByRun(db, runId)`
  - `listArtifactsByNode(db, runId, nodeId)`

- `src/workflows/persistence/friday-workflow-trigger-cursor-repository.ts`
  - Uses `hub_settings` (no new migration) with key prefix `workflow.trigger.cursor.*`
  - `getCursor(db, workflowVersionId, nodeId)`
  - `upsertCursor(db, cursor)` (revision bump on `hub_settings` row)

All service-level persistence flows use `FridaySqliteLayer.withWriteTransaction` and `withReadConnection`.

**4. Services**

- `src/workflows/services/friday-workflow-graph-validator.ts`
  - DAG validation: unique ids, missing refs, cycle detection, trigger/action constraints.

- `src/workflows/services/friday-workflow-compiler-adapter.ts`
  - Compile authoring graph/spec into `FridayCompiledWorkflowGraphV2`.
  - Normalize failure policy and compute checksum.

- `src/workflows/services/friday-workflow-definition-service.ts`
  - Create/update/archive/list/get workflows.
  - On graph change: create new immutable `workflow_versions` row and increment workflow revision/etag.

- `src/workflows/services/friday-workflow-versioning-service.ts`
  - Publish workflow version (atomic pointer update in `workflows` + `workflow_versions` flags).
  - Rollback = publish older version.

- `src/workflows/services/friday-workflow-run-service.ts`
  - Start run, resolve latest published version if not provided.
  - Cancel run (`running`/`queued` → `cancelled`).
  - Retry run/node(s) with policy checks.

- `src/workflows/services/friday-workflow-state-machine.ts`
  - Central transition guards for run status and node attempt status.

- `src/workflows/services/friday-workflow-dispatcher-service.ts`
  - Runtime scheduler loop, topological readiness, parallel dispatch, join handling, finalize run.

- `src/workflows/services/friday-workflow-node-attempt-service.ts`
  - Lease claim/renew/reclaim.
  - Retry scheduling with backoff.
  - Deterministic idempotency keys.

- `src/workflows/services/friday-workflow-node-executor-service.ts`
  - Node-type adapters:
  - `trigger`: hydrate trigger payload.
  - `action`: invoke skill in workflow mode.
  - `condition`: evaluate expression and branch.
  - `data`: transform/merge vars.
  - `ai`: invoke provider routing service.
  - `approval`: pause/poll approval input.

- `src/workflows/services/friday-workflow-artifact-service.ts`
  - Persist artifact metadata in `workflow_artifacts`.
  - Persist inline output in `workflow_run_nodes.output_json`.
  - File artifact URIs under state dir path when needed.

- `src/workflows/services/friday-workflow-trigger-service.ts`
  - Unified trigger API: manual, schedule, event.

- `src/workflows/services/friday-workflow-schedule-trigger-service.ts`
  - Poll published trigger nodes (`kind=cron`) and fire due runs.

- `src/workflows/services/friday-workflow-event-trigger-service.ts`
  - Subscribe to hub events, filter against trigger expressions, start runs.

- `src/workflows/services/friday-workflow-recovery-service.ts`
  - On boot: recover `running`/`pausing` runs, reclaim expired leases, restart dispatcher.

**5. DAG Execution Algorithm**

1. Load run + pinned `workflowVersionId` + `graph_json`.
2. Validate checksum and DAG invariants.
3. Build `inboundMap`/`outboundMap`; precompute topological order.
4. Reconcile current state from DB attempts.
5. Enqueue ready nodes:
   - Root node: no inbound edges.
   - Other nodes: all active inbound predecessors have terminal success.
   - Active inbound edge = condition true using predecessor output.
6. Claim attempts with lease (`queued`/`retrying` and due by `lease_expires_at`).
7. Execute claimed nodes in parallel (bounded by runtime max concurrency).
8. Persist result:
   - success: `completed`, output/artifacts.
   - retryable failure: create next attempt row with delayed `retrying`.
   - non-retryable failure: `failed`.
   - offline target: `blocked_offline`.
9. Apply run failure strategy:
   - `fail_fast`: stop new scheduling, finalize failed.
   - `continue_on_error`: keep scheduling independent paths.
   - `fallback_step`: enqueue fallback node.
   - `compensate`: set run `compensating`, trigger compensation workflow.
   - `pause_for_approval`: run `pausing` then `paused`.
10. Finalize run when no runnable/leased nodes remain.
11. Emit events for run/node transitions.

**6. State Machines**

Run transitions:

| From | To | Guard |
|---|---|---|
| `queued` | `running` | dispatcher started |
| `running` | `pausing` | pause requested/failure policy |
| `pausing` | `paused` | all active nodes drained |
| `running` | `compensating` | failure strategy = compensate |
| `running` | `completed` | all required nodes terminal success |
| `running` | `failed` | terminal failure outcome |
| `running` | `cancelled` | cancel requested |
| `paused` | `running` | resume/retry API |
| `compensating` | `completed` | compensation succeeded |
| `compensating` | `failed` | compensation failed |

Node attempt transitions:

| From | To | Guard |
|---|---|---|
| `queued` | `running` | lease claimed |
| `retrying` | `running` | backoff elapsed + lease claimed |
| `running` | `completed` | executor success |
| `running` | `retrying` | retryable error and attempts left |
| `running` | `failed` | non-retryable error or attempts exhausted |
| `running` | `blocked_offline` | target unavailable |
| `blocked_offline` | `retrying` | target recovered and retry policy allows |
| `queued` | `cancelled` | run cancelled |
| `retrying` | `cancelled` | run cancelled |
| `running` | `cancelled` | cancellation preemption |

**7. Retry & Idempotency**

- Retry policy source: node-level `retryPolicy`, default policy from runtime config.
- Backoff:
  - `none`: `0`
  - `fixed`: `baseDelayMs`
  - `exponential`: `min(maxDelayMs, baseDelayMs * 2^(attempt-1))`
- Attempt rows:
  - Keep one DB row per attempt (`run_id + node_id + attempt` unique).
  - Retry creates next attempt with incremented `attempt` and status `retrying` until due.
- Lease-based execution:
  - Claim by CAS update on status + lease expiry.
  - Heartbeat extends `lease_expires_at`.
  - Recovery reclaims expired leases.
- Node idempotency:
  - Deterministic key: `sha256(runId:nodeId:attempt:workflowVersionId)`.
  - Store in `workflow_run_nodes.idempotency_key`.
  - Pass key into skill/action executors and external side effects.
- Trigger idempotency:
  - Use `workflow_runs.correlation_id` from event/schedule key.
  - Pre-insert dedupe lookup in same write transaction.

**8. Triggers**

- Manual:
  - API path creates run directly (`trigger_type="manual"`).
- Scheduled:
  - Parse `trigger` nodes with cron config from published versions.
  - Poll every minute.
  - Persist per-trigger cursor in `hub_settings` (`workflow.trigger.cursor.<version>.<node>`).
- Event-driven:
  - Subscribe to internal event classes (e.g., `session.message.appended`, `workflow.node.failed`).
  - Match trigger config `eventType` + optional filter expression.
  - Start run with `trigger_type="event"` and event payload snapshot.

**9. Runtime Compositor**

- `src/workflows/runtime/friday-workflow-runtime.types.ts`

```ts
export interface FridayWorkflowRuntime {
  definitions: FridayWorkflowDefinitionService;
  versioning: FridayWorkflowVersioningService;
  runs: FridayWorkflowRunService;
  dispatcher: FridayWorkflowDispatcherService;
  triggers: FridayWorkflowTriggerService;
  recovery: FridayWorkflowRecoveryService;
  artifacts: FridayWorkflowArtifactService;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

- `src/workflows/runtime/friday-workflow-runtime.ts`
  - `createFridayWorkflowRuntime(options)` wires repositories + services.
  - Injects `FridaySqliteLayer`, skill registry/executor, event bus adapter, `idGenerator`, `nowIso`.
  - Starts background loops:
  - dispatcher poller
  - schedule trigger poller
  - lease recovery/reclaimer
  - shutdown drains leases and stops loops cleanly.

**10. Unit Test Plan (Files + Cases)**

- `src/workflows/test/friday-workflow-graph-validator.test.ts`
  - acyclic valid DAG, cycle detection, missing node refs, duplicate node ids.
- `src/workflows/test/friday-workflow-definition-service.test.ts`
  - create draft workflow, update metadata, update graph -> new version, revision/etag conflict, archive.
- `src/workflows/test/friday-workflow-versioning-service.test.ts`
  - publish latest, publish explicit version, rollback publish, no-published-version error paths.
- `src/workflows/test/friday-workflow-run-service.test.ts`
  - start run with explicit version, resolve latest published version, cancel, retry node subset.
- `src/workflows/test/friday-workflow-dispatcher-service.test.ts`
  - topological scheduling, parallel branch execution, join barrier waits all active inbounds, fail-fast abort, continue-on-error completion.
- `src/workflows/test/friday-workflow-node-attempt-service.test.ts`
  - lease claim CAS, lease extension, expired lease reclaim, retry scheduling/backoff, max-attempt handling.
- `src/workflows/test/friday-workflow-node-executor-service.test.ts`
  - action skill invocation mode routing, condition branch evaluation, data transform node, approval pause.
- `src/workflows/test/friday-workflow-artifact-service.test.ts`
  - artifact row insert, uri/checksum persistence, inline output persistence.
- `src/workflows/test/friday-workflow-trigger-service.test.ts`
  - manual trigger, cron due detection + cursor update, event trigger filter match, dedupe by correlation id.
- `src/workflows/test/friday-workflow-state-machine.test.ts`
  - all valid transitions accepted, invalid transitions rejected for run/node states.
- `src/workflows/test/friday-workflow-recovery-service.test.ts`
  - restart recovery of `running`/`pausing` runs, expired leases reclaimed, dispatcher resume.
- `src/workflows/test/friday-workflow-runtime.test.ts`
  - compositor wiring, startup/shutdown lifecycle, service surface availability.

This plan is fully compatible with V001 schema, uses `FridaySqliteLayer` for all persistence, keeps `friday-*`/`Friday*` naming, and adds no new dependencies.