**Unified Backend Workflow Engine Design (Friday)**

This design extends the current runtime in `src/workflows/` and aligns with:
- `docs/friday-style-guide.md`
- `docs/distributed-architecture.md` (workflow engine + event model)
- existing `skills`, `sessions`, `plugins`, and SQLite migration patterns.

## 1. Constants + Canonical Types

```ts
// src/workflows/friday-workflow-engine.constants.ts
export const FRIDAY_WORKFLOW_TRIGGER_TYPES = {
  CRON: "cron",
  WEBHOOK: "webhook",
  EVENT: "event",
} as const;

export const FRIDAY_WORKFLOW_NODE_TYPES = {
  TRIGGER: "trigger",
  ACTION: "action",
  CONDITION: "condition",
  TRANSFORM: "transform",
  APPROVAL: "approval",
} as const;

export const FRIDAY_WORKFLOW_ACTION_TYPES = {
  SKILL: "skill",
  AI_COMPLETION: "ai_completion",
  HTTP_REQUEST: "http_request",
} as const;

export const FRIDAY_WORKFLOW_RUN_STATUSES = {
  PENDING: "pending",
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export const FRIDAY_WORKFLOW_NODE_STATUSES = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  WAITING_APPROVAL: "waiting_approval",
  CANCELLED: "cancelled",
  RETRYING: "retrying",
} as const;

export const FRIDAY_WORKFLOW_DEFAULT_NODE_TIMEOUT_MS = 300_000;
export const FRIDAY_WORKFLOW_DEFAULT_RUN_TIMEOUT_MS = 3_600_000;
export const FRIDAY_WORKFLOW_APPROVAL_DEFAULT_TIMEOUT_MS = 86_400_000;
export const FRIDAY_WORKFLOW_WEBHOOK_PATH_TOKEN_BYTES = 24;

export const FRIDAY_WORKFLOW_BUILTIN_SKILL_AI_COMPLETION = "friday.builtin.ai-completion";
export const FRIDAY_WORKFLOW_BUILTIN_SKILL_HTTP_REQUEST = "friday.builtin.http-request";
```

```ts
// src/workflows/model/friday-workflow-engine.types.ts
export type FridayWorkflowStatus = "draft" | "published" | "archived";
export type FridayWorkflowTriggerType = "cron" | "webhook" | "event";
export type FridayWorkflowNodeType = "trigger" | "action" | "condition" | "transform" | "approval";
export type FridayWorkflowActionType = "skill" | "ai_completion" | "http_request";
export type FridayWorkflowRunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
export type FridayWorkflowNodeStatus = "pending" | "running" | "completed" | "failed" | "waiting_approval" | "cancelled" | "retrying";

export interface FridayWorkflowVersionConfig {
  runTimeoutMs?: number;
  defaultNodeTimeoutMs?: number;
  maxParallelism?: number;
  failurePolicy: {
    onFailure: "fail_fast" | "continue_on_error" | "fallback_step" | "compensate" | "pause_for_approval";
    fallbackNodeId?: string;
  };
}

export type FridayWorkflowNodeConfig =
  | { triggerType: "cron"; cron: string; timezone: string }
  | { triggerType: "webhook"; method: "POST"; secretRef?: string; dedupeKeyPath?: string }
  | { triggerType: "event"; source: string; event: string; filterExpr?: string; pluginId?: string }
  | { actionType: "skill"; skillId: string; inputMapping?: Record<string, unknown> }
  | { actionType: "ai_completion"; prompt: string; model?: string; temperature?: number }
  | { actionType: "http_request"; method: string; url: string; headers?: Record<string, string>; body?: unknown }
  | { conditionType: "if" | "switch"; expression: string; cases?: Array<{ label: string; expression: string }> }
  | { transformType: "map" | "template" | "merge"; mapping?: Record<string, unknown>; expression?: string; outputKey?: string }
  | { approverUserId?: string; approverRole?: "owner" | "admin" | "operator"; timeoutMs?: number; onReject?: "fail" | "reject_branch" };

export interface FridayWorkflowNodeDefinition {
  id: string;
  type: FridayWorkflowNodeType;
  name: string;
  config: FridayWorkflowNodeConfig;
  timeoutMs?: number;
}

export interface FridayWorkflowEdgeDefinition {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  condition?: string;
  branch?: "true" | "false" | "success" | "failure" | "approve" | "reject";
}
```

```ts
// src/workflows/model/friday-workflow-editor.types.ts (React Flow compatible)
export interface FridayWorkflowEditorGraphV1 {
  schemaVersion: "1.0";
  reactFlowVersion: "11";
  nodes: Array<{
    id: string;
    type: "workflow_node";
    position: { x: number; y: number };
    width?: number;
    height?: number;
    data: FridayWorkflowNodeDefinition;
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    sourceHandle?: string;
    targetHandle?: string;
    data?: { condition?: string; branch?: string };
  }>;
  viewport?: { x: number; y: number; zoom: number };
}
```

Compatibility note: keep reading existing `queued` as `pending` and `blocked_offline` as `waiting_approval` during transition.

---

## 2. Migration DDL (V009)

```sql
-- src/state/sqlite/migrations/v009-workflow-engine-triggers-approvals.ts

ALTER TABLE workflow_versions ADD COLUMN editor_graph_json TEXT;
ALTER TABLE workflow_versions ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';

ALTER TABLE workflow_runs ADD COLUMN trigger_node_id TEXT;
ALTER TABLE workflow_runs ADD COLUMN timeout_ms INTEGER;
ALTER TABLE workflow_runs ADD COLUMN deadline_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN paused_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN resumed_at TEXT;

ALTER TABLE workflow_run_nodes ADD COLUMN node_type TEXT;
ALTER TABLE workflow_run_nodes ADD COLUMN timeout_ms INTEGER;
ALTER TABLE workflow_run_nodes ADD COLUMN approval_request_id TEXT;

CREATE TABLE IF NOT EXISTS workflow_trigger_registrations (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  trigger_node_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('cron','webhook','event')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  cron_expression TEXT,
  cron_timezone TEXT,
  webhook_path_token TEXT,
  webhook_secret_ref TEXT,
  webhook_signature_header TEXT,
  event_source TEXT,
  event_name TEXT,
  event_filter_expr TEXT,
  plugin_id TEXT REFERENCES plugins(id) ON DELETE SET NULL,
  dedupe_window_sec INTEGER NOT NULL DEFAULT 300,
  last_fired_at TEXT,
  next_fire_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workflow_version_id, trigger_node_id),
  UNIQUE(webhook_path_token)
);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_registrations_due
  ON workflow_trigger_registrations(trigger_type, enabled, next_fire_at);

CREATE INDEX IF NOT EXISTS idx_workflow_trigger_registrations_event
  ON workflow_trigger_registrations(event_source, event_name, enabled);

CREATE TABLE IF NOT EXISTS workflow_trigger_deliveries (
  id TEXT PRIMARY KEY,
  trigger_registration_id TEXT NOT NULL REFERENCES workflow_trigger_registrations(id) ON DELETE CASCADE,
  dedupe_key TEXT NOT NULL,
  run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','duplicate','failed')),
  error_code TEXT,
  error_message TEXT,
  delivered_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(trigger_registration_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS workflow_run_checkpoints (
  run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id) ON DELETE CASCADE,
  checkpoint_seq INTEGER NOT NULL,
  run_status TEXT NOT NULL,
  active_node_ids_json TEXT NOT NULL DEFAULT '[]',
  completed_node_ids_json TEXT NOT NULL DEFAULT '[]',
  failed_node_ids_json TEXT NOT NULL DEFAULT '[]',
  waiting_approval_node_ids_json TEXT NOT NULL DEFAULT '[]',
  context_json TEXT NOT NULL DEFAULT '{}',
  last_node_id TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_checkpoints_status
  ON workflow_run_checkpoints(run_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_approval_requests (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  workflow_version_id TEXT NOT NULL REFERENCES workflow_versions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  run_node_attempt_id TEXT NOT NULL REFERENCES workflow_run_nodes(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  approver_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  approver_role TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  request_payload_json TEXT NOT NULL DEFAULT '{}',
  timeout_at TEXT,
  decided_at TEXT,
  decided_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  decision_comment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(run_node_attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_approval_requests_approver
  ON workflow_approval_requests(approver_user_id, status, timeout_at);

CREATE INDEX IF NOT EXISTS idx_workflow_approval_requests_run
  ON workflow_approval_requests(run_id, status);
```

---

## 3. Repository Interfaces

```ts
export interface FridayWorkflowTriggerRepository {
  upsertManyForVersion(input: FridayWorkflowTriggerRegistrationEntity[]): void;
  listByWorkflow(workflowId: string): FridayWorkflowTriggerRegistrationEntity[];
  listDueCron(nowIso: string, limit: number): FridayWorkflowTriggerRegistrationEntity[];
  getByWebhookToken(pathToken: string): FridayWorkflowTriggerRegistrationEntity | null;
  listByEvent(source: string, event: string): FridayWorkflowTriggerRegistrationEntity[];
  markFired(id: string, firedAt: string, nextFireAt?: string): void;
  setEnabled(id: string, enabled: boolean, nowIso: string): void;
  deleteByWorkflowVersion(workflowVersionId: string): void;
}

export interface FridayWorkflowTriggerDeliveryRepository {
  tryInsert(input: {
    id: string;
    triggerRegistrationId: string;
    dedupeKey: string;
    status: "accepted" | "duplicate" | "failed";
    deliveredAt: string;
  }): boolean;
  markAccepted(triggerRegistrationId: string, dedupeKey: string, runId: string): void;
  markFailed(triggerRegistrationId: string, dedupeKey: string, code: string, message: string): void;
}

export interface FridayWorkflowRunCheckpointRepository {
  upsert(checkpoint: FridayWorkflowRunCheckpointEntity): void;
  get(runId: string): FridayWorkflowRunCheckpointEntity | null;
  delete(runId: string): void;
  listRecoverableRuns(limit: number): FridayWorkflowRunCheckpointEntity[];
}

export interface FridayWorkflowApprovalRepository {
  insert(request: FridayWorkflowApprovalRequestEntity): FridayWorkflowApprovalRequestEntity;
  getById(id: string): FridayWorkflowApprovalRequestEntity | null;
  getByRunNodeAttemptId(runNodeAttemptId: string): FridayWorkflowApprovalRequestEntity | null;
  listPending(input: { approverUserId?: string; limit?: number; cursor?: string }): FridayWorkflowApprovalRequestEntity[];
  resolvePending(input: {
    id: string;
    status: "approved" | "rejected";
    decidedByUserId: string;
    comment?: string;
    nowIso: string;
  }): FridayWorkflowApprovalRequestEntity | null;
  expirePending(nowIso: string, limit: number): FridayWorkflowApprovalRequestEntity[];
}
```

---

## 4. Service Interfaces

```ts
export interface FridayWorkflowExecutionEngineService {
  startRun(input: FridayWorkflowStartRunInput): Promise<FridayWorkflowRunEntity>;
  resumeRun(runId: string): Promise<FridayWorkflowRunEntity>;
  cancelRun(runId: string, reason?: string): Promise<FridayWorkflowRunEntity>;
  retryRun(runId: string, nodeIds?: string[]): Promise<FridayWorkflowRunEntity>;
  recoverActiveRuns(limit?: number): Promise<number>;
  sweepTimedOutRuns(nowIso?: string): Promise<number>;
  sweepTimedOutNodes(nowIso?: string): Promise<number>;
}
```

```ts
export interface FridayWorkflowTriggerService {
  syncPublishedVersionTriggers(workflowId: string): Promise<void>;
  syncAllPublishedWorkflowTriggers(): Promise<void>;
  tickCron(nowIso: string, limit?: number): Promise<number>;
  handleWebhook(input: FridayWorkflowWebhookInvokeInput): Promise<FridayWorkflowWebhookInvokeResult>;
  handleEvent(input: FridayWorkflowTriggerEventInput): Promise<number>;
  listRegistrations(workflowId: string): FridayWorkflowTriggerRegistrationEntity[];
  setRegistrationEnabled(registrationId: string, enabled: boolean): Promise<void>;
}
```

```ts
export interface FridayWorkflowApprovalService {
  requestForNode(input: FridayWorkflowApprovalRequestCreateInput): Promise<FridayWorkflowApprovalRequestEntity>;
  listPending(input: FridayWorkflowApprovalListInput): FridayWorkflowApprovalRequestEntity[];
  approve(input: FridayWorkflowApprovalDecisionInput): Promise<FridayWorkflowApprovalDecisionResult>;
  reject(input: FridayWorkflowApprovalDecisionInput): Promise<FridayWorkflowApprovalDecisionResult>;
  expirePending(nowIso: string, limit?: number): Promise<number>;
}
```

```ts
export interface FridayWorkflowSkillNodeAdapter {
  assertWorkflowInvocable(skillId: string): void;
  execute(input: FridayWorkflowSkillActionExecutionInput): Promise<FridayWorkflowSkillActionExecutionOutput>;
  listWorkflowInvocableSkills(): Array<{
    skillId: string;
    name: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
  }>;
}
```

Design choice for Decision #1: `action` execution is unified through skills.
- `actionType: "skill"` -> direct skill.
- `actionType: "ai_completion"` -> built-in skill `friday.builtin.ai-completion`.
- `actionType: "http_request"` -> built-in skill `friday.builtin.http-request`.

---

## 5. Execution Model

1. Publish flow compiles and validates graph DAG, stores immutable `graph_json` + `editor_graph_json` + `config_json`, then syncs trigger registrations from trigger nodes.
2. Trigger fires create run with `trigger_node_id` and run context payload.
3. Scheduler executes only nodes reachable from `trigger_node_id`, topological and parallel (respecting `maxParallelism`).
4. Node transitions: `pending -> running -> completed|failed|waiting_approval`.
5. Run transitions: `pending -> running -> paused|completed|failed`.
6. Approval node creates `workflow_approval_requests`, emits realtime event, writes approver session message via `FridaySessionService`, and pauses run.
7. Approve:
   - mark node `completed`;
   - continue graph from approve branch (or normal outbound if unbranched).
8. Reject:
   - if reject branch edge exists, mark node `failed` and continue reject branch;
   - else fail run with `APPROVAL_REJECTED`.
9. Checkpoint after every node terminal transition and every run status transition.
10. Recovery on process restart:
    - reload runs in `pending|running|paused` from checkpoints;
    - resume runnable runs;
    - keep paused runs paused.
11. Timeout handling:
    - node timeout from node config/default;
    - run timeout from version config/default;
    - sweeper marks timeout failures and applies failure policy.

---

## 6. Trigger System Details

1. `cron` trigger:
   - persisted registration with `cron_expression`, `cron_timezone`, `next_fire_at`;
   - job `tickCron()` scans due rows and starts runs;
   - dedupe via `workflow_trigger_deliveries`.
2. `webhook` trigger:
   - unique tokenized endpoint `/v1/workflow-webhooks/:pathToken`;
   - optional HMAC verification using `secretRef`;
   - run created on `POST` with raw body + selected headers in trigger payload;
   - dedupe key from header/path expression.
3. `event` trigger:
   - subscription source can be internal hub events or plugin events;
   - `source` + `event` matching with optional `filterExpr`;
   - plugin bridge publishes `source = plugin:<pluginId>` events into trigger service.
4. Plugin integration:
   - channel plugin callbacks (`onInboundMessage`, `onDeliveryEvent`) are bridged to workflow event triggers;
   - non-channel plugins may emit workflow events through a narrow host bridge API.

---

## 7. API Routes

| Method | Path | Operation ID | Scope |
|---|---|---|---|
| `GET` | `/v1/workflows/:workflowId/triggers` | `workflows.triggers.list` | `workflow.read` |
| `PATCH` | `/v1/workflow-triggers/:registrationId` | `workflows.triggers.update` | `workflow.write` |
| `POST` | `/v1/workflows/:workflowId/triggers/resync` | `workflows.triggers.resync` | `workflow.write` |
| `POST` | `/v1/workflow-webhooks/:pathToken` | `workflows.webhooks.invoke` | public |
| `GET` | `/v1/workflow-approvals` | `workflows.approvals.list` | `workflow.run` |
| `GET` | `/v1/workflow-approvals/:approvalId` | `workflows.approvals.get` | `workflow.run` |
| `POST` | `/v1/workflow-approvals/:approvalId/approve` | `workflows.approvals.approve` | `workflow.run` |
| `POST` | `/v1/workflow-approvals/:approvalId/reject` | `workflows.approvals.reject` | `workflow.run` |
| `POST` | `/v1/workflow-runs/:runId/resume` | `workflows.runs.resume` | `workflow.run` |

Add realtime event names:
- `workflow.approval.requested`
- `workflow.approval.approved`
- `workflow.approval.rejected`
- `workflow.approval.expired`

---

## 8. File Plan (New Files)

1. `src/workflows/friday-workflow-engine.constants.ts`
2. `src/workflows/model/friday-workflow-engine.types.ts`
3. `src/workflows/model/friday-workflow-editor.types.ts`
4. `src/workflows/persistence/friday-workflow-trigger-repository.ts`
5. `src/workflows/persistence/friday-workflow-trigger-delivery-repository.ts`
6. `src/workflows/persistence/friday-workflow-run-checkpoint-repository.ts`
7. `src/workflows/persistence/friday-workflow-approval-repository.ts`
8. `src/workflows/services/friday-workflow-approval-service.types.ts`
9. `src/workflows/services/friday-workflow-approval-service.ts`
10. `src/workflows/services/friday-workflow-skill-node-adapter.types.ts`
11. `src/workflows/services/friday-workflow-skill-node-adapter.ts`
12. `src/workflows/services/friday-workflow-action-executor-registry.ts`
13. `src/workflows/services/friday-workflow-event-trigger-bridge.ts`
14. `src/api/http/routes/friday-workflow-trigger-routes.ts`
15. `src/api/http/routes/friday-workflow-approval-routes.ts`
16. `src/api/http/routes/friday-workflow-webhook-routes.ts`
17. `src/jobs/workflows/friday-workflow-cron-trigger-job.ts`
18. `src/jobs/workflows/friday-workflow-timeout-job.ts`
19. `src/state/sqlite/migrations/v009-workflow-engine-triggers-approvals.ts`

Expected updates to existing files:
- `src/workflows/services/friday-workflow-execution-service.ts`
- `src/workflows/services/friday-workflow-trigger-service.ts`
- `src/workflows/engine/friday-workflow-node-executor.ts`
- `src/workflows/runtime/friday-workflow-runtime.ts`
- `src/workflows/index.ts`
- `src/api/model/friday-api-workflow.types.ts`
- `src/api/model/friday-api-realtime.types.ts`
- `src/api/runtime/friday-api-runtime.ts`
- `src/state/sqlite/migrations/index.ts`

---

## 9. Test Plan

1. Unit: trigger repository CRUD + due cron query + webhook lookup + dedupe delivery constraints.
2. Unit: approval repository resolution rules (`pending` only, idempotent expire path).
3. Unit: skill adapter rejects non-`workflow` invocation mode skills.
4. Unit: action registry maps `ai_completion` and `http_request` to built-in skills.
5. Unit: execution state machine transitions for `waiting_approval` and `paused`.
6. Unit: timeout sweeper for node and run deadlines.
7. Unit: reject-branch behavior (`reject_branch` vs fail run).
8. Integration: publish workflow with trigger nodes -> trigger registrations created.
9. Integration: cron tick produces run exactly once per dedupe key.
10. Integration: webhook POST starts run and stores payload.
11. Integration: event trigger fired from plugin-source event bridge.
12. Integration: approval request creates session notification message and realtime event.
13. Integration: approve/reject API resumes workflow correctly.
14. Integration: crash recovery resumes from `workflow_run_checkpoints`.
15. Migration: v009 schema test validates new tables/columns/indexes exist and are usable.

This gives a single backend architecture that satisfies all 4 decisions while reusing Friday’s current workflow/compiler/runtime foundation.
