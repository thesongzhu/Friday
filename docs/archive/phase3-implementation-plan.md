> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 3: Workflow Engine (DAG) — Implementation Plan

**Version:** 1.0  
**Date:** 2026-02-16  
**Status:** Ready for implementation by CC  
**Author:** CX (Codex design agent)

---

## 1. File Structure

All new files live under `src/workflows/`. No existing files are modified.

```
src/workflows/
  index.ts                                          # barrel export
  model/
    friday-workflow.types.ts                         # core domain types, enums, entity projections
    friday-workflow-graph.types.ts                   # compiled graph IR types (CompiledWorkflowGraphV2 etc.)
    friday-workflow-trigger.types.ts                 # trigger definitions
    friday-workflow-expression.types.ts              # expression DSL AST and evaluator contract
  persistence/
    friday-workflow-repository.ts                    # workflow + version CRUD repository
    friday-workflow-run-repository.ts                # workflow run CRUD repository
    friday-workflow-run-node-repository.ts           # run node attempt CRUD repository
    friday-workflow-artifact-repository.ts           # artifact CRUD repository
  compiler/
    friday-workflow-compiler.ts                      # WorkflowSpecV1 → CompiledWorkflowGraphV2
    friday-workflow-validator.ts                     # DAG validation (acyclic, connectivity, edge rules)
  engine/
    friday-workflow-dag-scheduler.ts                 # topological scheduling, ready-set computation
    friday-workflow-run-machine.ts                   # run-level state machine
    friday-workflow-node-machine.ts                  # node-level state machine
    friday-workflow-node-executor.ts                 # node execution dispatcher (skill, condition, data, ai, approval)
    friday-workflow-expression-evaluator.ts          # safe expression DSL evaluator
    friday-workflow-retry-manager.ts                 # per-node retry/backoff/lease logic
    friday-workflow-artifact-writer.ts               # artifact persistence helper
  services/
    friday-workflow-crud-service.ts                  # workflow definition CRUD + versioning + publish
    friday-workflow-execution-service.ts             # start/resume/cancel/retry runs
    friday-workflow-trigger-service.ts               # trigger registration and dispatch
  runtime/
    friday-workflow-runtime.ts                       # composite runtime (wires everything together)
    friday-workflow-runtime.types.ts                 # runtime interface

tests/
  workflows/
    friday-workflow-compiler.test.ts
    friday-workflow-validator.test.ts
    friday-workflow-dag-scheduler.test.ts
    friday-workflow-run-machine.test.ts
    friday-workflow-node-machine.test.ts
    friday-workflow-expression-evaluator.test.ts
    friday-workflow-retry-manager.test.ts
    friday-workflow-crud-service.test.ts
    friday-workflow-execution-service.test.ts
    friday-workflow-trigger-service.test.ts
    friday-workflow-repository.test.ts
    friday-workflow-run-repository.test.ts
    friday-workflow-run-node-repository.test.ts
    friday-workflow-artifact-repository.test.ts
    friday-workflow-artifact-writer.test.ts
    friday-workflow-node-executor.test.ts
```

---

## 2. Type Definitions

### 2.1 `src/workflows/model/friday-workflow.types.ts`

```ts
// Re-exports from architecture doc entity types that already exist in the codebase
// Imported from distributed-architecture.md §10.1 entity definitions

export type { UUID, ISODateTime, JsonValue, JsonObject } from "../../state/sqlite/friday-sqlite.types.js";
// NOTE: UUID/ISODateTime/JsonValue/JsonObject are not currently exported from friday-sqlite.types.ts.
// They are defined in distributed-architecture.md §10.1. Define them locally:

export type UUID = string;
export type ISODateTime = string;
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue; }

// ─── Workflow Run Status ───

export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "compensating"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Node Attempt Status ───

export type NodeAttemptStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "failed"
  | "blocked_offline"
  | "cancelled";

// ─── Failure Policy ───

export type WorkflowFailureStrategy =
  | "fail_fast"
  | "continue_on_error"
  | "fallback_step"
  | "compensate"
  | "pause_for_approval";

export interface WorkflowFailurePolicyV2 {
  onFailure: WorkflowFailureStrategy;
  fallbackStepId?: string;
  compensationWorkflowId?: string;
  notifyUser: boolean;
}

// ─── Workflow Node Types ───

export type WorkflowNodeType =
  | "trigger"
  | "action"
  | "condition"
  | "data"
  | "ai"
  | "approval";

// ─── Workflow Definition Row (DB shape) ───

export interface FridayWorkflowRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  tags_json: string;
  owner_user_id: string | null;
  latest_version_number: number;
  published_version_number: number | null;
  is_archived: number; // SQLite boolean
  revision: number;
  etag: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

// ─── Workflow Definition Entity (domain shape) ───

export interface FridayWorkflowEntity {
  id: UUID;
  slug: string;
  name: string;
  description?: string;
  tags: string[];
  ownerUserId?: UUID;
  latestVersionNumber: number;
  publishedVersionNumber?: number;
  isArchived: boolean;
  revision: number;
  etag: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  deletedAt?: ISODateTime;
  deletedBy?: string;
}

// ─── Workflow Version Row ───

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

// ─── Workflow Version Entity ───

export interface FridayWorkflowVersionEntity {
  id: UUID;
  workflowId: UUID;
  versionNumber: number;
  checksum: string;
  graphJson: JsonValue; // parsed CompiledWorkflowGraphV2
  createdByUserId?: UUID;
  isPublished: boolean;
  changeNote?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Run Row ───

export interface FridayWorkflowRunRow {
  id: string;
  workflow_id: string;
  workflow_version_id: string;
  status: string;
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

// ─── Workflow Run Entity ───

export interface FridayWorkflowRunEntity {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  status: WorkflowRunStatus;
  triggerType: string;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  startedBySatelliteId?: UUID;
  startedAt: ISODateTime;
  finishedAt?: ISODateTime;
  correlationId?: string;
  context?: JsonObject;
  failure?: {
    code: string;
    message: string;
    details?: JsonValue;
  };
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Run Node Row ───

export interface FridayWorkflowRunNodeRow {
  id: string;
  run_id: string;
  node_id: string;
  attempt: number;
  attempt_id: string;
  status: string;
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

// ─── Workflow Run Node Entity ───

export interface FridayWorkflowRunNodeEntity {
  id: UUID;
  runId: UUID;
  nodeId: string;
  attempt: number;
  attemptId: UUID;
  status: NodeAttemptStatus;
  satelliteId?: UUID;
  leaseOwner?: string;
  leaseExpiresAt?: ISODateTime;
  startedAt?: ISODateTime;
  finishedAt?: ISODateTime;
  input?: JsonValue;
  output?: JsonValue;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details?: JsonValue;
  };
  idempotencyKey: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Workflow Artifact Row ───

export interface FridayWorkflowArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  artifact_type: string;
  uri: string;
  checksum: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Workflow Artifact Entity ───

export interface FridayWorkflowArtifactEntity {
  id: UUID;
  runId: UUID;
  nodeId: string;
  artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
  uri: string;
  checksum?: string;
  metadata?: JsonObject;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

// ─── Create Workflow Input ───

export interface FridayWorkflowCreateInput {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  ownerUserId?: UUID;
}

// ─── Update Workflow Input ───

export interface FridayWorkflowUpdateInput {
  workflowId: UUID;
  expectedRevision: number;
  etag: string;
  name?: string;
  description?: string;
  tags?: string[];
}

// ─── List Workflows Input ───

export interface FridayWorkflowListInput {
  tag?: string;
  archived?: boolean;
  cursor?: string;
  limit?: number;
}

// ─── Start Run Input ───

export interface FridayWorkflowStartRunInput {
  workflowId: UUID;
  workflowVersionId?: UUID; // if omitted, resolves to latest published
  triggerType: string;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  startedBySatelliteId?: UUID;
  correlationId?: string;
  context?: JsonObject;
  dryRun?: boolean;
}

// ─── Node Outcome (internal) ───

export interface FridayNodeOutcome {
  nodeId: string;
  status: "completed" | "failed" | "cancelled";
  output?: JsonValue;
  error?: { code: string; message: string; retryable: boolean };
}

// ─── Row-to-entity mapper signature ───

export type RowMapper<TRow, TEntity> = (row: TRow) => TEntity;
```

### 2.2 `src/workflows/model/friday-workflow-graph.types.ts`

```ts
import type { JsonValue, WorkflowNodeType, WorkflowFailurePolicyV2 } from "./friday-workflow.types.js";

// ─── Compiled Graph Nodes ───

export interface FridayWorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  config: Record<string, JsonValue>;
  retryPolicy?: FridayNodeRetryPolicy;
  timeoutMs?: number;
}

export interface FridayNodeRetryPolicy {
  maxAttempts: number;
  backoff: "none" | "fixed" | "exponential";
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: string[]; // error codes that trigger retry
}

// ─── Compiled Graph Edges ───

export interface FridayWorkflowEdge {
  id: string;
  sourceNodeId: string;
  sourcePort?: string;
  targetNodeId: string;
  targetPort?: string;
  condition?: string; // expression DSL string
  priority?: number;
}

// ─── Compiled Workflow Graph V2 ───

export interface FridayCompiledWorkflowGraphV2 {
  schemaVersion: "2.0";
  workflowId: string;
  workflowVersionId: string;
  sourceSpecSchemaVersion: "1.0";
  graph: {
    nodes: FridayWorkflowNode[];
    edges: FridayWorkflowEdge[];
    variables?: Record<string, JsonValue>;
  };
  failurePolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowTest[];
  checksum: string;
}

// ─── Workflow Test ───

export interface FridayWorkflowTest {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<string, { output: Record<string, unknown>; status?: "completed" | "failed" }>;
  assertions: FridayWorkflowTestAssertion[];
}

export interface FridayWorkflowTestAssertion {
  path: string;
  operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
  expected: unknown;
}

// ─── Adjacency structures (produced by DAG scheduler) ───

export interface FridayDagAdjacency {
  /** nodeId → list of successor nodeIds */
  outbound: Map<string, string[]>;
  /** nodeId → list of predecessor nodeIds */
  inbound: Map<string, string[]>;
  /** nodes with zero inbound edges (entry points, including trigger nodes) */
  entryNodes: string[];
  /** topological order */
  topoOrder: string[];
}

// ─── Execution Plan (produced by compiler + scheduler for a run) ───

export interface FridayWorkflowExecutionPlan {
  runId: string;
  workflowId: string;
  workflowVersionId: string;
  compiledGraph: FridayCompiledWorkflowGraphV2;
  adjacency: FridayDagAdjacency;
  failurePolicy: WorkflowFailurePolicyV2;
  /** nodeId → FridayWorkflowNode lookup */
  nodeMap: Map<string, FridayWorkflowNode>;
}
```

### 2.3 `src/workflows/model/friday-workflow-trigger.types.ts`

```ts
import type { UUID, ISODateTime, JsonObject } from "./friday-workflow.types.js";

// ─── Trigger Types ───

export type FridayWorkflowTriggerType = "manual" | "schedule" | "event";

// ─── Manual Trigger ───

export interface FridayManualTrigger {
  type: "manual";
}

// ─── Schedule Trigger ───

export interface FridayScheduleTrigger {
  type: "schedule";
  cron: string;
  timezone: string;
}

// ─── Event Trigger ───

export interface FridayEventTrigger {
  type: "event";
  source: string;
  event: string;
}

export type FridayWorkflowTriggerDef =
  | FridayManualTrigger
  | FridayScheduleTrigger
  | FridayEventTrigger;

// ─── Trigger Registration ───

export interface FridayTriggerRegistration {
  id: UUID;
  workflowId: UUID;
  workflowVersionId: UUID;
  trigger: FridayWorkflowTriggerDef;
  enabled: boolean;
  lastFiredAt?: ISODateTime;
  nextFireAt?: ISODateTime;
  createdAt: ISODateTime;
}

// ─── Trigger Fire Input ───

export interface FridayTriggerFireInput {
  workflowId: UUID;
  workflowVersionId: UUID;
  triggerType: FridayWorkflowTriggerType;
  triggerPayload?: JsonObject;
  startedByUserId?: UUID;
  correlationId?: string;
}

// ─── Cron Tick Context (for schedule trigger evaluation) ───

export interface FridayCronTickContext {
  nowIso: ISODateTime;
  registrations: FridayTriggerRegistration[];
}

// ─── Event Match Context ───

export interface FridayEventMatchContext {
  source: string;
  event: string;
  payload: JsonObject;
}
```

### 2.4 `src/workflows/model/friday-workflow-expression.types.ts`

```ts
// ─── Expression AST ───

export type FridayExprNode =
  | FridayExprLiteral
  | FridayExprRef
  | FridayExprBinaryOp
  | FridayExprUnaryOp;

export interface FridayExprLiteral {
  kind: "literal";
  value: string | number | boolean | null;
}

export interface FridayExprRef {
  kind: "ref";
  path: string[]; // e.g., ["steps", "fetch_data", "output", "count"]
}

export interface FridayExprBinaryOp {
  kind: "binary";
  op: "==" | "!=" | ">" | "<" | ">=" | "<=" | "&&" | "||";
  left: FridayExprNode;
  right: FridayExprNode;
}

export interface FridayExprUnaryOp {
  kind: "unary";
  op: "!";
  operand: FridayExprNode;
}

// ─── Expression Context (variables available during evaluation) ───

export interface FridayExpressionContext {
  inputs: Record<string, unknown>;
  steps: Record<string, { output: Record<string, unknown> }>;
  env?: Record<string, unknown>;
}

// ─── Expression Evaluator Contract ───

export interface FridayExpressionEvaluator {
  /** Parse an expression string into an AST. Throws on syntax error. */
  parse(expr: string): FridayExprNode;
  /** Evaluate a parsed AST against a context. Returns a primitive value. */
  evaluate(ast: FridayExprNode, ctx: FridayExpressionContext): unknown;
  /** Convenience: parse + evaluate in one call. */
  exec(expr: string, ctx: FridayExpressionContext): unknown;
}
```

---

## 3. Persistence Layer

All repositories take `FridaySqliteLayer` as a dependency. They operate on the V001 DDL tables with no schema changes.

### 3.1 `src/workflows/persistence/friday-workflow-repository.ts`

```ts
import type Database from "better-sqlite3";
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type {
  FridayWorkflowRow,
  FridayWorkflowEntity,
  FridayWorkflowVersionRow,
  FridayWorkflowVersionEntity,
  FridayWorkflowCreateInput,
  FridayWorkflowUpdateInput,
  FridayWorkflowListInput,
  UUID,
} from "../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";

export interface FridayWorkflowRepository {
  // ─── Workflow Definition ───

  /** Insert a new workflow definition. Returns the created entity. */
  insertWorkflow(db: Database.Database, id: UUID, input: FridayWorkflowCreateInput, etag: string, nowIso: string): FridayWorkflowEntity;

  /** Get workflow by id. Returns null if not found or soft-deleted. */
  getWorkflowById(db: Database.Database, id: UUID): FridayWorkflowEntity | null;

  /** Get workflow by slug. Returns null if not found or soft-deleted. */
  getWorkflowBySlug(db: Database.Database, slug: string): FridayWorkflowEntity | null;

  /** List workflows with optional filters. */
  listWorkflows(db: Database.Database, input: FridayWorkflowListInput): FridayWorkflowEntity[];

  /** Update workflow metadata. Checks expectedRevision + etag. Throws on conflict. Returns updated entity. */
  updateWorkflow(db: Database.Database, input: FridayWorkflowUpdateInput, newEtag: string, nowIso: string): FridayWorkflowEntity;

  /** Soft-delete (archive) a workflow. */
  archiveWorkflow(db: Database.Database, id: UUID, deletedBy: string, nowIso: string): void;

  /** Increment latest_version_number and return the new number. */
  incrementVersionNumber(db: Database.Database, workflowId: UUID, nowIso: string): number;

  /** Set published_version_number on the workflow. */
  setPublishedVersion(db: Database.Database, workflowId: UUID, versionNumber: number, nowIso: string): void;

  // ─── Workflow Versions ───

  /** Insert a new workflow version. */
  insertVersion(db: Database.Database, id: UUID, workflowId: UUID, versionNumber: number, checksum: string, graphJson: string, createdByUserId: UUID | undefined, changeNote: string | undefined, nowIso: string): FridayWorkflowVersionEntity;

  /** Get version by id. */
  getVersionById(db: Database.Database, id: UUID): FridayWorkflowVersionEntity | null;

  /** Get latest version for a workflow. */
  getLatestVersion(db: Database.Database, workflowId: UUID): FridayWorkflowVersionEntity | null;

  /** Get published version for a workflow. */
  getPublishedVersion(db: Database.Database, workflowId: UUID): FridayWorkflowVersionEntity | null;

  /** List all versions for a workflow, ordered by version_number DESC. */
  listVersions(db: Database.Database, workflowId: UUID, limit?: number): FridayWorkflowVersionEntity[];

  /** Mark a version as published; unmark all other versions for same workflow. */
  publishVersion(db: Database.Database, workflowId: UUID, versionId: UUID, nowIso: string): void;
}

export interface CreateWorkflowRepositoryDeps {
  db: FridaySqliteLayer;
}

export function createFridayWorkflowRepository(deps: CreateWorkflowRepositoryDeps): FridayWorkflowRepository;
```

**SQL Operations:**

| Method | SQL |
|---|---|
| `insertWorkflow` | `INSERT INTO workflows (id, slug, name, description, tags_json, owner_user_id, latest_version_number, published_version_number, is_archived, revision, etag, created_at, updated_at) VALUES (?,?,?,?,?,?,1,NULL,0,1,?,?,?)` |
| `getWorkflowById` | `SELECT * FROM workflows WHERE id = ? AND deleted_at IS NULL` |
| `getWorkflowBySlug` | `SELECT * FROM workflows WHERE slug = ? AND deleted_at IS NULL` |
| `listWorkflows` | `SELECT * FROM workflows WHERE deleted_at IS NULL [AND tags_json LIKE ?] [AND is_archived = ?] ORDER BY updated_at DESC LIMIT ? OFFSET ?` |
| `updateWorkflow` | `UPDATE workflows SET name = COALESCE(?, name), description = COALESCE(?, description), tags_json = COALESCE(?, tags_json), revision = revision + 1, etag = ?, updated_at = ? WHERE id = ? AND revision = ? AND etag = ? AND deleted_at IS NULL` — if `changes === 0` throw `WORKFLOW_VERSION_CONFLICT` |
| `archiveWorkflow` | `UPDATE workflows SET is_archived = 1, deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL` |
| `incrementVersionNumber` | `UPDATE workflows SET latest_version_number = latest_version_number + 1, updated_at = ? WHERE id = ? RETURNING latest_version_number` |
| `setPublishedVersion` | `UPDATE workflows SET published_version_number = ?, updated_at = ? WHERE id = ?` |
| `insertVersion` | `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, created_by_user_id, is_published, change_note, created_at, updated_at) VALUES (?,?,?,?,?,?,0,?,?,?)` |
| `getVersionById` | `SELECT * FROM workflow_versions WHERE id = ?` |
| `getLatestVersion` | `SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT 1` |
| `getPublishedVersion` | `SELECT wv.* FROM workflow_versions wv JOIN workflows w ON w.id = wv.workflow_id AND w.published_version_number = wv.version_number WHERE wv.workflow_id = ? AND wv.is_published = 1 LIMIT 1` |
| `listVersions` | `SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version_number DESC LIMIT ?` |
| `publishVersion` | `UPDATE workflow_versions SET is_published = 0, updated_at = ? WHERE workflow_id = ? AND is_published = 1; UPDATE workflow_versions SET is_published = 1, updated_at = ? WHERE id = ?` |


### 3.2 `src/workflows/persistence/friday-workflow-run-repository.ts`

```ts
import type Database from "better-sqlite3";
import type {
  FridayWorkflowRunRow,
  FridayWorkflowRunEntity,
  WorkflowRunStatus,
  UUID,
} from "../model/friday-workflow.types.js";

export interface FridayWorkflowRunRepository {
  /** Insert a new run record. */
  insertRun(db: Database.Database, entity: FridayWorkflowRunEntity): void;

  /** Get run by id. */
  getRunById(db: Database.Database, id: UUID): FridayWorkflowRunEntity | null;

  /** Update run status and optional failure info. */
  updateRunStatus(db: Database.Database, id: UUID, status: WorkflowRunStatus, nowIso: string, failure?: { code: string; message: string; details?: unknown }): void;

  /** Set run finished_at and status. */
  finalizeRun(db: Database.Database, id: UUID, status: WorkflowRunStatus, nowIso: string, failure?: { code: string; message: string; details?: unknown }): void;

  /** List runs by workflow id, optionally filtered by status. */
  listRunsByWorkflow(db: Database.Database, workflowId: UUID, status?: WorkflowRunStatus, limit?: number): FridayWorkflowRunEntity[];

  /** List all active (non-terminal) runs. Used for crash recovery. */
  listActiveRuns(db: Database.Database): FridayWorkflowRunEntity[];

  /** Update context_json (merge). */
  mergeRunContext(db: Database.Database, id: UUID, context: Record<string, unknown>, nowIso: string): void;
}

export interface CreateWorkflowRunRepositoryDeps {
  // no extra deps; operates on raw db handle
}

export function createFridayWorkflowRunRepository(): FridayWorkflowRunRepository;
```

**SQL Operations:**

| Method | SQL |
|---|---|
| `insertRun` | `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, trigger_payload_json, started_by_user_id, started_by_satellite_id, started_at, finished_at, correlation_id, context_json, failure_code, failure_message, failure_details_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)` |
| `getRunById` | `SELECT * FROM workflow_runs WHERE id = ?` |
| `updateRunStatus` | `UPDATE workflow_runs SET status = ?, failure_code = ?, failure_message = ?, failure_details_json = ?, updated_at = ? WHERE id = ?` |
| `finalizeRun` | `UPDATE workflow_runs SET status = ?, finished_at = ?, failure_code = ?, failure_message = ?, failure_details_json = ?, updated_at = ? WHERE id = ?` |
| `listRunsByWorkflow` | `SELECT * FROM workflow_runs WHERE workflow_id = ? [AND status = ?] ORDER BY started_at DESC LIMIT ?` |
| `listActiveRuns` | `SELECT * FROM workflow_runs WHERE status IN ('queued', 'running', 'pausing', 'compensating')` |
| `mergeRunContext` | Read current `context_json`, JSON.parse, merge, `UPDATE workflow_runs SET context_json = ?, updated_at = ? WHERE id = ?` |


### 3.3 `src/workflows/persistence/friday-workflow-run-node-repository.ts`

```ts
import type Database from "better-sqlite3";
import type {
  FridayWorkflowRunNodeRow,
  FridayWorkflowRunNodeEntity,
  NodeAttemptStatus,
  UUID,
} from "../model/friday-workflow.types.js";

export interface FridayWorkflowRunNodeRepository {
  /** Insert a new node attempt record. */
  insertNodeAttempt(db: Database.Database, entity: FridayWorkflowRunNodeEntity): void;

  /** Get node attempt by id. */
  getNodeAttemptById(db: Database.Database, id: UUID): FridayWorkflowRunNodeEntity | null;

  /** Get the latest attempt for a given run+nodeId. */
  getLatestAttempt(db: Database.Database, runId: UUID, nodeId: string): FridayWorkflowRunNodeEntity | null;

  /** List all attempts for a given run+nodeId, ordered by attempt ASC. */
  listAttemptsByNode(db: Database.Database, runId: UUID, nodeId: string): FridayWorkflowRunNodeEntity[];

  /** List all node attempts for a run, optionally filtered by status. */
  listNodesByRun(db: Database.Database, runId: UUID, status?: NodeAttemptStatus): FridayWorkflowRunNodeEntity[];

  /** Update node attempt status, timestamps, output, error. */
  updateNodeAttempt(db: Database.Database, id: UUID, update: {
    status: NodeAttemptStatus;
    satelliteId?: UUID;
    leaseOwner?: string;
    leaseExpiresAt?: string;
    startedAt?: string;
    finishedAt?: string;
    output?: unknown;
    error?: { code: string; message: string; retryable: boolean; details?: unknown };
    nowIso: string;
  }): void;

  /** Acquire lease on a node attempt. Sets lease_owner, lease_expires_at, status='running'. Returns true if acquired. */
  acquireLease(db: Database.Database, id: UUID, leaseOwner: string, leaseExpiresAt: string, nowIso: string): boolean;

  /** List all node attempts with expired leases (lease_expires_at < now, status='running'). */
  listExpiredLeases(db: Database.Database, nowIso: string): FridayWorkflowRunNodeEntity[];

  /** Bulk cancel all non-terminal node attempts for a run. */
  cancelAllPendingNodes(db: Database.Database, runId: UUID, nowIso: string): number;

  /** Count completed nodes for a run (for progress tracking). */
  countByStatus(db: Database.Database, runId: UUID): Record<NodeAttemptStatus, number>;
}

export function createFridayWorkflowRunNodeRepository(): FridayWorkflowRunNodeRepository;
```

**SQL Operations:**

| Method | SQL |
|---|---|
| `insertNodeAttempt` | `INSERT INTO workflow_run_nodes (id, run_id, node_id, attempt, attempt_id, status, satellite_id, lease_owner, lease_expires_at, started_at, finished_at, input_json, output_json, error_json, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)` |
| `getNodeAttemptById` | `SELECT * FROM workflow_run_nodes WHERE id = ?` |
| `getLatestAttempt` | `SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ? ORDER BY attempt DESC LIMIT 1` |
| `listAttemptsByNode` | `SELECT * FROM workflow_run_nodes WHERE run_id = ? AND node_id = ? ORDER BY attempt ASC` |
| `listNodesByRun` | `SELECT * FROM workflow_run_nodes WHERE run_id = ? [AND status = ?] ORDER BY created_at ASC` |
| `updateNodeAttempt` | `UPDATE workflow_run_nodes SET status = ?, satellite_id = COALESCE(?, satellite_id), lease_owner = ?, lease_expires_at = ?, started_at = COALESCE(?, started_at), finished_at = ?, output_json = ?, error_json = ?, updated_at = ? WHERE id = ?` |
| `acquireLease` | `UPDATE workflow_run_nodes SET lease_owner = ?, lease_expires_at = ?, status = 'running', started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ? AND status IN ('queued', 'retrying') AND (lease_expires_at IS NULL OR lease_expires_at < ?)` — returns `changes > 0` |
| `listExpiredLeases` | `SELECT * FROM workflow_run_nodes WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?` |
| `cancelAllPendingNodes` | `UPDATE workflow_run_nodes SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running', 'retrying', 'blocked_offline')` |
| `countByStatus` | `SELECT status, COUNT(*) as cnt FROM workflow_run_nodes WHERE run_id = ? GROUP BY status` — returned as latest attempt per node only: subquery `WHERE (run_id, node_id, attempt) IN (SELECT run_id, node_id, MAX(attempt) FROM workflow_run_nodes WHERE run_id = ? GROUP BY run_id, node_id)` |


### 3.4 `src/workflows/persistence/friday-workflow-artifact-repository.ts`

```ts
import type Database from "better-sqlite3";
import type { FridayWorkflowArtifactEntity, UUID } from "../model/friday-workflow.types.js";

export interface FridayWorkflowArtifactRepository {
  /** Insert a new artifact. */
  insertArtifact(db: Database.Database, entity: FridayWorkflowArtifactEntity): void;

  /** Get artifact by id. */
  getArtifactById(db: Database.Database, id: UUID): FridayWorkflowArtifactEntity | null;

  /** List artifacts for a run, optionally filtered by nodeId. */
  listArtifactsByRun(db: Database.Database, runId: UUID, nodeId?: string): FridayWorkflowArtifactEntity[];

  /** Delete all artifacts for a run (for cleanup). */
  deleteArtifactsByRun(db: Database.Database, runId: UUID): number;
}

export function createFridayWorkflowArtifactRepository(): FridayWorkflowArtifactRepository;
```

**SQL Operations:**

| Method | SQL |
|---|---|
| `insertArtifact` | `INSERT INTO workflow_artifacts (id, run_id, node_id, artifact_type, uri, checksum, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)` |
| `getArtifactById` | `SELECT * FROM workflow_artifacts WHERE id = ?` |
| `listArtifactsByRun` | `SELECT * FROM workflow_artifacts WHERE run_id = ? [AND node_id = ?] ORDER BY created_at ASC` |
| `deleteArtifactsByRun` | `DELETE FROM workflow_artifacts WHERE run_id = ?` |


---

## 4. Service Layer

### 4.1 `src/workflows/services/friday-workflow-crud-service.ts`

```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type {
  FridayWorkflowEntity,
  FridayWorkflowVersionEntity,
  FridayWorkflowCreateInput,
  FridayWorkflowUpdateInput,
  FridayWorkflowListInput,
  UUID,
} from "../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";

export interface FridayWorkflowCrudService {
  /** Create a new workflow definition. Does NOT create a version. */
  createWorkflow(input: FridayWorkflowCreateInput): FridayWorkflowEntity;

  /** Get workflow by id. */
  getWorkflow(id: UUID): FridayWorkflowEntity | null;

  /** Get workflow by slug. */
  getWorkflowBySlug(slug: string): FridayWorkflowEntity | null;

  /** List workflows with optional filters. */
  listWorkflows(input?: FridayWorkflowListInput): FridayWorkflowEntity[];

  /** Update workflow metadata. Throws WORKFLOW_VERSION_CONFLICT on revision/etag mismatch. */
  updateWorkflow(input: FridayWorkflowUpdateInput): FridayWorkflowEntity;

  /** Archive (soft-delete) a workflow. */
  archiveWorkflow(id: UUID, deletedBy: string): void;

  /** Create a new version from a compiled graph. Increments version number.
   *  Validates graph (acyclic, connected, edge rules) before persisting.
   *  Returns the created version. */
  createVersion(workflowId: UUID, compiledGraph: FridayCompiledWorkflowGraphV2, createdByUserId?: UUID, changeNote?: string): FridayWorkflowVersionEntity;

  /** Publish a specific version number. Unpublishes any previously published version.
   *  If versionNumber is omitted, publishes the latest version. */
  publishVersion(workflowId: UUID, versionNumber?: number): FridayWorkflowVersionEntity;

  /** Get a specific version by id. */
  getVersion(versionId: UUID): FridayWorkflowVersionEntity | null;

  /** List versions for a workflow. */
  listVersions(workflowId: UUID, limit?: number): FridayWorkflowVersionEntity[];

  /** Get the published version for a workflow, or null. */
  getPublishedVersion(workflowId: UUID): FridayWorkflowVersionEntity | null;
}

export interface CreateWorkflowCrudServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
  computeEtag: () => string;
}

export function createFridayWorkflowCrudService(deps: CreateWorkflowCrudServiceDeps): FridayWorkflowCrudService;
```

**Key behaviors:**
- `createVersion` calls `FridayWorkflowValidator.validate()` before persisting. Throws `WORKFLOW_GRAPH_INVALID` or `WORKFLOW_CYCLE_DETECTED` on failure.
- `createVersion` generates checksum from `JSON.stringify(compiledGraph)`.
- `publishVersion` runs in a write transaction: unpublishes all versions → publishes target → updates workflow's `published_version_number`.
- `createWorkflow` generates etag via `computeEtag()` (e.g., random hex).
- `updateWorkflow` generates new etag on each successful update.


### 4.2 `src/workflows/services/friday-workflow-execution-service.ts`

```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowRunEntity, FridayWorkflowRunNodeEntity, FridayWorkflowStartRunInput, UUID, WorkflowRunStatus } from "../model/friday-workflow.types.js";
import type { FridayWorkflowExecutionPlan } from "../model/friday-workflow-graph.types.js";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type { FridayWorkflowRunRepository } from "../persistence/friday-workflow-run-repository.js";
import type { FridayWorkflowRunNodeRepository } from "../persistence/friday-workflow-run-node-repository.js";
import type { FridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";

export interface FridayWorkflowExecutionService {
  /** Start a new workflow run. Resolves version if not provided. Creates run + initial node attempts. Begins execution. */
  startRun(input: FridayWorkflowStartRunInput): Promise<FridayWorkflowRunEntity>;

  /** Resume a paused run. Re-enters the execution loop from the paused state. */
  resumeRun(runId: UUID): Promise<FridayWorkflowRunEntity>;

  /** Cancel a running/paused run. Cancels all pending nodes. */
  cancelRun(runId: UUID, reason?: string): Promise<FridayWorkflowRunEntity>;

  /** Retry failed nodes in a failed run. Creates new attempts for specified nodes (or all failed). Re-enters execution loop. */
  retryRun(runId: UUID, nodeIds?: string[]): Promise<FridayWorkflowRunEntity>;

  /** Get current run state. */
  getRun(runId: UUID): FridayWorkflowRunEntity | null;

  /** List runs for a workflow. */
  listRuns(workflowId: UUID, status?: WorkflowRunStatus, limit?: number): FridayWorkflowRunEntity[];

  /** Get all node attempts for a run. */
  getRunNodes(runId: UUID, status?: string): FridayWorkflowRunNodeEntity[];

  /** Recover active runs after Hub restart. Reloads plans, reclaims expired leases, resumes execution loops. */
  recoverActiveRuns(): Promise<void>;

  /** Reap expired node leases and re-queue them. Called periodically. */
  reapExpiredLeases(): Promise<number>;
}

export interface CreateWorkflowExecutionServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  runRepo: FridayWorkflowRunRepository;
  nodeRepo: FridayWorkflowRunNodeRepository;
  artifactRepo: FridayWorkflowArtifactRepository;
  dagScheduler: import("../engine/friday-workflow-dag-scheduler.js").FridayWorkflowDagScheduler;
  runMachine: import("../engine/friday-workflow-run-machine.js").FridayWorkflowRunMachine;
  nodeMachine: import("../engine/friday-workflow-node-machine.js").FridayWorkflowNodeMachine;
  nodeExecutor: import("../engine/friday-workflow-node-executor.js").FridayWorkflowNodeExecutor;
  retryManager: import("../engine/friday-workflow-retry-manager.js").FridayWorkflowRetryManager;
  artifactWriter: import("../engine/friday-workflow-artifact-writer.js").FridayWorkflowArtifactWriter;
  expressionEvaluator: import("../engine/friday-workflow-expression-evaluator.js").FridayExpressionEvaluator;
  idGenerator: () => string;
  nowIso: () => string;
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

export function createFridayWorkflowExecutionService(deps: CreateWorkflowExecutionServiceDeps): FridayWorkflowExecutionService;
```


### 4.3 `src/workflows/services/friday-workflow-trigger-service.ts`

```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../model/friday-workflow.types.js";
import type {
  FridayTriggerRegistration,
  FridayTriggerFireInput,
  FridayWorkflowTriggerDef,
  FridayCronTickContext,
  FridayEventMatchContext,
} from "../model/friday-workflow-trigger.types.js";
import type { FridayWorkflowExecutionService } from "./friday-workflow-execution-service.js";

export interface FridayWorkflowTriggerService {
  /** Register a trigger for a workflow version. Stored in memory (triggers are derived from compiled graph trigger nodes). */
  register(workflowId: UUID, workflowVersionId: UUID, trigger: FridayWorkflowTriggerDef): FridayTriggerRegistration;

  /** Unregister all triggers for a workflow. */
  unregister(workflowId: UUID): void;

  /** Fire a manual trigger. Returns the created run id. */
  fireManual(input: FridayTriggerFireInput): Promise<UUID>;

  /** Evaluate cron triggers. Returns list of run ids created. Called periodically (e.g., every 60s). */
  tickCron(ctx: FridayCronTickContext): Promise<UUID[]>;

  /** Match an incoming event against registered event triggers. Returns list of run ids created. */
  matchEvent(ctx: FridayEventMatchContext): Promise<UUID[]>;

  /** List all active trigger registrations. */
  listRegistrations(): FridayTriggerRegistration[];

  /** Reload triggers from all published workflow versions. */
  reloadFromPublishedVersions(): Promise<void>;
}

export interface CreateWorkflowTriggerServiceDeps {
  db: FridaySqliteLayer;
  executionService: FridayWorkflowExecutionService;
  workflowRepo: import("../persistence/friday-workflow-repository.js").FridayWorkflowRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayWorkflowTriggerService(deps: CreateWorkflowTriggerServiceDeps): FridayWorkflowTriggerService;
```

**Key behaviors:**
- Trigger registrations are held **in memory** (Map<workflowId, TriggerRegistration[]>). They are rebuilt on startup from published workflow versions' compiled graphs (by inspecting trigger nodes).
- `tickCron` iterates all schedule registrations, evaluates cron expressions against `nowIso`, and fires matching workflows. Cron evaluation uses a simple next-match algorithm — no external cron library. The cron parser supports standard 5-field cron syntax (`minute hour day-of-month month day-of-week`).
- `matchEvent` iterates all event registrations, checks `source` and `event` match, and fires matching workflows.
- `fireManual` calls `executionService.startRun(...)`.
- Trigger deduplication: for scheduled triggers, computes a fingerprint `sha256(workflowId + versionId + triggerType + fireTimeIso)` and checks against recent run `correlation_id` to prevent duplicate fires within the same minute.

---

## 5. DAG Execution Algorithm

### 5.1 `src/workflows/engine/friday-workflow-dag-scheduler.ts`

```ts
import type { FridayCompiledWorkflowGraphV2, FridayDagAdjacency, FridayWorkflowExecutionPlan, FridayWorkflowNode } from "../model/friday-workflow-graph.types.js";
import type { NodeAttemptStatus } from "../model/friday-workflow.types.js";

export interface FridayWorkflowDagScheduler {
  /** Build adjacency structures from a compiled graph. Runs topological sort. Throws WORKFLOW_CYCLE_DETECTED if cycle found. */
  buildAdjacency(graph: FridayCompiledWorkflowGraphV2): FridayDagAdjacency;

  /** Build a full execution plan for a run. */
  buildExecutionPlan(runId: string, graph: FridayCompiledWorkflowGraphV2): FridayWorkflowExecutionPlan;

  /** Given current finished node set and adjacency, compute the next set of ready nodes.
   *  A node is "ready" when ALL its inbound predecessors have a terminal status (completed or — under continue_on_error — failed).
   *  Condition-edge filtering: if an edge has a condition expression, evaluate it; only count the predecessor as
   *  "enabling" the successor if the condition is truthy. If no condition edges lead to a successor, it is skipped. */
  computeReadyNodes(
    adjacency: FridayDagAdjacency,
    nodeStatuses: Map<string, NodeAttemptStatus>,
    graph: FridayCompiledWorkflowGraphV2,
    expressionContext: import("../model/friday-workflow-expression.types.js").FridayExpressionContext,
    expressionEvaluator: import("../model/friday-workflow-expression.types.js").FridayExpressionEvaluator,
  ): string[];
}

export function createFridayWorkflowDagScheduler(): FridayWorkflowDagScheduler;
```

**Algorithm — `buildAdjacency`:**

```
1. Initialize outbound: Map<nodeId, nodeId[]>, inbound: Map<nodeId, nodeId[]>
2. For each node in graph.nodes: outbound.set(node.id, []), inbound.set(node.id, [])
3. For each edge in graph.edges:
     outbound.get(edge.sourceNodeId).push(edge.targetNodeId)
     inbound.get(edge.targetNodeId).push(edge.sourceNodeId)
4. Compute entryNodes: nodes where inbound[node].length === 0
5. Topological sort via Kahn's algorithm:
     a. queue = [...entryNodes]
     b. topoOrder = []
     c. inDegree = Map<nodeId, number> from inbound sizes
     d. while queue not empty:
          node = queue.shift()
          topoOrder.push(node)
          for each successor in outbound[node]:
            inDegree[successor]--
            if inDegree[successor] === 0: queue.push(successor)
     e. if topoOrder.length !== nodes.length: throw WORKFLOW_CYCLE_DETECTED
6. Return { outbound, inbound, entryNodes, topoOrder }
```

**Algorithm — `computeReadyNodes`:**

```
1. For each node in adjacency.topoOrder:
     if nodeStatuses.get(node) is not undefined (already has an attempt): skip
     predecessors = adjacency.inbound.get(node) ?? []
     if predecessors.length === 0: add to ready (this is an entry node)
     else:
       // Check all predecessors
       allSatisfied = true
       anyEnabledEdge = false
       for each pred in predecessors:
         predStatus = nodeStatuses.get(pred)
         if predStatus is not terminal (completed, failed, cancelled): allSatisfied = false; break
         // Check edge condition
         edge = find edge from pred → node
         if edge.condition:
           condResult = expressionEvaluator.exec(edge.condition, expressionContext)
           if condResult is truthy: anyEnabledEdge = true
         else:
           anyEnabledEdge = true  // unconditional edge
       if allSatisfied AND anyEnabledEdge: add to ready
2. Return ready set
```

**Parallel branches:** Nodes with no dependencies among each other (siblings in the DAG) are all added to the ready set simultaneously. The execution service processes them with `Promise.allSettled()`.

**Join nodes (barrier/fan-in):** A node with multiple inbound edges is a join node. It only becomes ready when ALL predecessors have terminal status AND at least one enabled edge exists.


### 5.2 Execution Loop (in `friday-workflow-execution-service.ts`)

The core execution loop is an async function `executeRun(plan: FridayWorkflowExecutionPlan)`:

```
1. Set run status = 'running'
2. Initialize nodeStatuses: Map<string, NodeAttemptStatus> from existing node attempts in DB (for recovery)
3. Initialize expressionContext with run inputs and empty steps
4. Compute readyNodes = dagScheduler.computeReadyNodes(...)
5. WHILE readyNodes.length > 0 AND run is not aborted/paused:
     a. Create node attempt records for all ready nodes (status='queued')
     b. Emit 'workflow.node.queued' events
     c. For each ready node, determine execution target:
        - If node requires satellite capabilities: enqueue to outbox for satellite dispatch
        - Otherwise: execute locally
     d. Execute batch with Promise.allSettled():
        For each node:
          i.   Acquire lease (acquireLease in nodeRepo)
          ii.  Set node status = 'running', emit 'workflow.node.started'
          iii. Call nodeExecutor.executeNode(node, inputs)
          iv.  On success: set status = 'completed', persist output, emit 'workflow.node.completed'
                           Update expressionContext.steps[nodeId].output
          v.   On failure: call retryManager.handleFailure(node, error, attemptCount)
                           If retryable: set status = 'retrying', emit 'workflow.node.retrying'
                           If exhausted: set status = 'failed', emit 'workflow.node.failed'
                                         Apply failure policy (see §6)
     e. Update nodeStatuses map
     f. Recompute readyNodes
6. Compute final run status from nodeStatuses + failure policy
7. Finalize run (set finished_at, final status)
8. Emit run-level event ('workflow.run.completed' | 'workflow.run.failed' | etc.)
```

**Satellite dispatch integration:**
When a node's compiled config contains `executionTargets.requiredCapabilities`, the execution service:
1. Queries satellite capabilities via Phase 2's `FridaySatelliteCapabilityService`
2. Selects a suitable online satellite
3. Enqueues a `workflow.node.dispatch` message to the outbox via `FridayOutboxQueueService`
4. Sets node status to `queued` with the satellite_id
5. Waits for the satellite to report completion (via sync push → node result ack)

For MVP (Phase 3), all nodes execute locally (Hub-side). Satellite dispatch is wired but operational only when satellites are available.


---

## 6. State Machine

### 6.1 Workflow Run State Machine

**`src/workflows/engine/friday-workflow-run-machine.ts`:**

```ts
import type { WorkflowRunStatus } from "../model/friday-workflow.types.js";

export interface FridayWorkflowRunMachine {
  /** Validate that a transition from `from` to `to` is legal. Returns true if valid. */
  canTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean;

  /** Perform transition, throwing if invalid. */
  assertTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): void;

  /** Check if a status is terminal. */
  isTerminal(status: WorkflowRunStatus): boolean;
}

export function createFridayWorkflowRunMachine(): FridayWorkflowRunMachine;
```

**Valid transitions:**

```
queued       → running
queued       → cancelled

running      → pausing
running      → completed
running      → failed
running      → cancelled
running      → compensating

pausing      → paused
pausing      → failed        (if draining nodes fail)
pausing      → cancelled

paused       → running       (resume)
paused       → cancelled

compensating → completed     (compensation succeeded)
compensating → failed        (compensation also failed)
compensating → cancelled

completed    → (terminal, no outbound transitions)
failed       → running       (retry)
failed       → (terminal if no retry)
cancelled    → (terminal, no outbound transitions)
```

**Terminal statuses:** `completed`, `failed` (when not retrying), `cancelled`.


### 6.2 Node Attempt State Machine

**`src/workflows/engine/friday-workflow-node-machine.ts`:**

```ts
import type { NodeAttemptStatus } from "../model/friday-workflow.types.js";

export interface FridayWorkflowNodeMachine {
  /** Validate that a transition from `from` to `to` is legal. */
  canTransition(from: NodeAttemptStatus, to: NodeAttemptStatus): boolean;

  /** Perform transition, throwing if invalid. */
  assertTransition(from: NodeAttemptStatus, to: NodeAttemptStatus): void;

  /** Check if a status is terminal. */
  isTerminal(status: NodeAttemptStatus): boolean;
}

export function createFridayWorkflowNodeMachine(): FridayWorkflowNodeMachine;
```

**Valid transitions:**

```
queued          → running
queued          → cancelled
queued          → blocked_offline

running         → completed
running         → failed
running         → cancelled
running         → blocked_offline   (satellite went offline mid-execution)

retrying        → running          (new attempt picked up)
retrying        → cancelled
retrying        → blocked_offline

failed          → retrying         (when retry policy allows)
failed          → (terminal if retries exhausted)

blocked_offline → running          (satellite came back online)
blocked_offline → cancelled
blocked_offline → failed           (timeout while offline)

completed       → (terminal)
cancelled       → (terminal)
```

**Terminal statuses:** `completed`, `failed` (when retries exhausted), `cancelled`.


---

## 7. Retry & Idempotency

### 7.1 `src/workflows/engine/friday-workflow-retry-manager.ts`

```ts
import type { FridayWorkflowRunNodeEntity, NodeAttemptStatus, UUID } from "../model/friday-workflow.types.js";
import type { FridayNodeRetryPolicy } from "../model/friday-workflow-graph.types.js";

export interface FridayRetryDecision {
  shouldRetry: boolean;
  nextAttemptNumber: number;
  delayMs: number;
  reason: string;
}

export interface FridayWorkflowRetryManager {
  /** Determine whether a failed node attempt should be retried.
   *  Considers: retry policy, current attempt count, error code matching, max delay. */
  evaluateRetry(
    nodeAttempt: FridayWorkflowRunNodeEntity,
    retryPolicy: FridayNodeRetryPolicy | undefined,
    errorCode: string,
  ): FridayRetryDecision;

  /** Compute backoff delay for a given attempt number and policy. */
  computeBackoffMs(
    attemptNumber: number,
    policy: FridayNodeRetryPolicy,
  ): number;

  /** Generate idempotency key for a node attempt.
   *  Format: `wfrun:<runId>:node:<nodeId>:attempt:<attemptNumber>`
   *  This ensures each attempt has a unique, deterministic key. */
  generateIdempotencyKey(runId: UUID, nodeId: string, attemptNumber: number): string;

  /** Generate attempt id (UUID). */
  generateAttemptId(): UUID;

  /** Check if an error code matches any retry-on patterns in the policy. */
  isRetryableError(errorCode: string, retryOn: string[]): boolean;
}

export interface CreateRetryManagerDeps {
  idGenerator: () => string;
}

export function createFridayWorkflowRetryManager(deps: CreateRetryManagerDeps): FridayWorkflowRetryManager;
```

**Backoff algorithm:**

```ts
computeBackoffMs(attemptNumber: number, policy: FridayNodeRetryPolicy): number {
  switch (policy.backoff) {
    case "none": return 0;
    case "fixed": return Math.min(policy.baseDelayMs, policy.maxDelayMs);
    case "exponential": {
      const delay = policy.baseDelayMs * Math.pow(2, attemptNumber - 1);
      // Add jitter: ±25%
      const jitter = delay * 0.25 * (Math.random() * 2 - 1);
      return Math.min(Math.round(delay + jitter), policy.maxDelayMs);
    }
  }
}
```

**Retry evaluation:**

```
evaluateRetry(nodeAttempt, retryPolicy, errorCode):
  1. If retryPolicy is undefined: return { shouldRetry: false, reason: "no retry policy" }
  2. If nodeAttempt.attempt >= retryPolicy.maxAttempts: return { shouldRetry: false, reason: "max attempts exceeded" }
  3. If retryPolicy.retryOn.length > 0 AND !isRetryableError(errorCode, retryPolicy.retryOn):
       return { shouldRetry: false, reason: "error code not in retryOn list" }
  4. delayMs = computeBackoffMs(nodeAttempt.attempt, retryPolicy)
  5. return { shouldRetry: true, nextAttemptNumber: nodeAttempt.attempt + 1, delayMs, reason: "retry eligible" }
```

**Idempotency key format:** `wfrun:{runId}:node:{nodeId}:attempt:{attemptNumber}`

This deterministic format ensures:
- Each attempt has a unique key
- Replayed attempts (crash recovery) produce the same key → the DB unique constraint prevents duplicate inserts
- The key encodes enough context for debugging

**Lease expiry flow:**
1. `reapExpiredLeases()` is called periodically (every 30s) by the execution service
2. It queries `listExpiredLeases(nowIso)` from the node repo
3. For each expired lease:
   a. Check retry policy → if retryable, create new attempt with status `retrying`
   b. If not retryable, mark as `failed` with error code `NODE_TIMEOUT`
   c. Emit appropriate events

**Dead-lettering:**
A node attempt is considered dead-lettered when:
- All retry attempts are exhausted (attempt >= maxAttempts)
- Error is non-retryable (not in retryOn list)
- Node has been `blocked_offline` beyond the configured timeout

Dead-lettered nodes are set to `failed` status with the final error preserved. The run-level failure policy then determines next steps.

---

## 8. Node Executor

### 8.1 `src/workflows/engine/friday-workflow-node-executor.ts`

```ts
import type { FridayWorkflowNode } from "../model/friday-workflow-graph.types.js";
import type { FridayExpressionContext, FridayExpressionEvaluator } from "../model/friday-workflow-expression.types.js";
import type { JsonValue, UUID } from "../model/friday-workflow.types.js";
import type { FridaySkill } from "../../skills/model/friday-skill-runtime.types.js";

export interface FridayNodeExecutionInput {
  runId: UUID;
  nodeId: string;
  attemptId: UUID;
  node: FridayWorkflowNode;
  inputData: Record<string, unknown>;
  expressionContext: FridayExpressionContext;
}

export interface FridayNodeExecutionOutput {
  output: JsonValue;
  artifacts?: Array<{
    artifactType: "json" | "text" | "file" | "image" | "audio" | "video";
    uri: string;
    checksum?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface FridayWorkflowNodeExecutor {
  /** Execute a single node. Dispatches to the appropriate handler based on node type. */
  executeNode(input: FridayNodeExecutionInput): Promise<FridayNodeExecutionOutput>;
}

export interface CreateNodeExecutorDeps {
  expressionEvaluator: FridayExpressionEvaluator;
  /** Resolve a skill by id for action nodes. */
  resolveSkill: (skillId: string) => FridaySkill<unknown, unknown, unknown> | null;
  /** Invoke a skill in workflow mode. Returns output. */
  invokeSkill: (skillId: string, runId: UUID, nodeId: string, payload: Record<string, unknown>) => Promise<unknown>;
  nowIso: () => string;
}

export function createFridayWorkflowNodeExecutor(deps: CreateNodeExecutorDeps): FridayWorkflowNodeExecutor;
```

**Node type dispatch:**

| Node Type | Execution Logic |
|---|---|
| `trigger` | No-op at execution time. Trigger nodes are entry points; they were already "fired" by the trigger service. Their config is passed through as output (trigger payload). Output: trigger payload from run context. |
| `action` | Resolve skill by `config.skillId` (or `config.ref`). Call `deps.invokeSkill(skillId, runId, nodeId, resolvedArgs)`. Args are resolved from `config.args` using expression evaluator against the expression context. Output: skill execution result. |
| `condition` | Evaluate `config.condition` expression against expression context. Output: `{ result: boolean }`. The DAG scheduler uses this output to determine which outbound edges are enabled. |
| `data` | Evaluate `config.transform` expression or apply `config.mapping` (key-value transform from expression context). Output: transformed data object. |
| `ai` | Construct prompt from `config.prompt` template (variable interpolation from expression context). Call `deps.invokeSkill("ai-inference", runId, nodeId, { prompt, model: config.model })`. Output: AI response. |
| `approval` | Set node to `blocked` status and emit an approval request event. Execution pauses. Output: `{ approved: boolean, comment?: string }` (set when user responds). The execution loop detects approval nodes and transitions the run to `paused` state. Resumption provides the approval result. |

**Input resolution for action nodes:**
```
For each key in node.config.args:
  value = node.config.args[key]
  if value is a string starting with "$":
    resolved = expressionEvaluator.exec(value, expressionContext)
  else:
    resolved = value
  inputData[key] = resolved
```


### 8.2 `src/workflows/engine/friday-workflow-expression-evaluator.ts`

```ts
import type { FridayExprNode, FridayExpressionContext, FridayExpressionEvaluator as IFridayExpressionEvaluator } from "../model/friday-workflow-expression.types.js";

export type { IFridayExpressionEvaluator as FridayExpressionEvaluator };

export function createFridayExpressionEvaluator(): IFridayExpressionEvaluator;
```

**Parser implementation (recursive descent):**

The parser implements the grammar from the architecture doc §3.3.2.4:

```
expr        = logical_or
logical_or  = logical_and ( "||" logical_and )*
logical_and = not_expr ( "&&" not_expr )*
not_expr    = "!" not_expr | compare
compare     = primary ( OP primary )?
primary     = ref | literal | "(" expr ")"
ref         = "$" path
path        = IDENT ( "." IDENT )*
literal     = STRING | NUMBER | BOOLEAN | NULL
OP          = "==" | "!=" | ">" | "<" | ">=" | "<="
```

**Tokenizer produces tokens:**
- `$identifier.path` → `REF` token
- `"string"` or `'string'` → `STRING` token
- `123`, `45.6` → `NUMBER` token
- `true`, `false` → `BOOLEAN` token
- `null` → `NULL` token
- `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`, `(`, `)` → operator tokens

**Evaluator:**
- `FridayExprLiteral` → return `.value`
- `FridayExprRef` → resolve path against context: `context[path[0]][path[1]]...`
  - `$inputs.x` → `ctx.inputs.x`
  - `$steps.nodeId.output.field` → `ctx.steps.nodeId.output.field`
  - `$env.key` → `ctx.env.key`
  - Undefined paths return `undefined` (not an error)
- `FridayExprBinaryOp` → evaluate left and right, apply operator
  - `==`/`!=`: strict equality
  - `>`, `<`, `>=`, `<=`: numeric comparison (coerce to number)
  - `&&`: short-circuit logical AND
  - `||`: short-circuit logical OR
- `FridayExprUnaryOp` → evaluate operand, apply `!` (logical NOT, truthiness)

**Safety guarantees:**
- No function calls
- No assignment
- No property setting
- No prototype access
- Maximum expression length: 4096 characters
- Maximum nesting depth: 32 levels
- Parse timeout: none needed (recursive descent on bounded input is O(n))


### 8.3 `src/workflows/engine/friday-workflow-artifact-writer.ts`

```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";
import type { FridayWorkflowArtifactEntity, UUID } from "../model/friday-workflow.types.js";

export interface FridayWorkflowArtifactWriter {
  /** Persist node output as a JSON artifact. Returns artifact entity. */
  writeJsonArtifact(runId: UUID, nodeId: string, output: unknown): FridayWorkflowArtifactEntity;

  /** Persist an arbitrary artifact (file, image, etc.). */
  writeArtifact(runId: UUID, nodeId: string, artifactType: string, uri: string, checksum?: string, metadata?: Record<string, unknown>): FridayWorkflowArtifactEntity;
}

export interface CreateArtifactWriterDeps {
  db: FridaySqliteLayer;
  artifactRepo: FridayWorkflowArtifactRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayWorkflowArtifactWriter(deps: CreateArtifactWriterDeps): FridayWorkflowArtifactWriter;
```

**`writeJsonArtifact` behavior:**
1. Serialize output to JSON string
2. Store as `uri = "data:application/json;base64,<base64-encoded-json>"` for small payloads (< 64KB)
3. For larger payloads, write to `${stateDir}/artifacts/${runId}/${nodeId}.json` and store `uri = "file://<path>"`
4. Compute SHA-256 checksum of the serialized content
5. Insert into `workflow_artifacts` table via `artifactRepo.insertArtifact`

---

## 9. Compiler & Validator

### 9.1 `src/workflows/compiler/friday-workflow-validator.ts`

```ts
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";

export interface FridayWorkflowValidationError {
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface FridayWorkflowValidationResult {
  valid: boolean;
  errors: FridayWorkflowValidationError[];
}

export interface FridayWorkflowValidator {
  /** Validate a compiled workflow graph. */
  validate(graph: FridayCompiledWorkflowGraphV2): FridayWorkflowValidationResult;
}

export function createFridayWorkflowValidator(): FridayWorkflowValidator;
```

**Validation rules (from architecture doc §5.2 + skill-system-design §3.3.2.7):**

1. **Non-empty graph:** At least one node exists.
2. **Unique node ids:** No duplicate `node.id` values.
3. **Unique edge ids:** No duplicate `edge.id` values.
4. **Edge references valid:** Every `edge.sourceNodeId` and `edge.targetNodeId` must exist in `graph.nodes`.
5. **Acyclic (DAG):** DFS-based cycle detection. Error code: `WORKFLOW_CYCLE_DETECTED`.
6. **Connected graph:** Every node is reachable from at least one entry node (node with no inbound edges). Error code: `WORKFLOW_GRAPH_DISCONNECTED`.
7. **At least one entry node:** The graph must have at least one node with no inbound edges.
8. **At least one terminal path:** At least one path from an entry node reaches a node with no outbound edges.
9. **Condition nodes have condition edges:** If a node has `type === "condition"`, it must have at least one outbound edge (typically with condition expressions or ports for true/false routing).
10. **Action nodes have ref:** If node type is `action`, `config.skillId` or `config.ref` must be a non-empty string.
11. **Edge condition syntax:** If an edge has a `condition` string, it must parse successfully via the expression evaluator. Error code: `WORKFLOW_EXPRESSION_INVALID`.
12. **Schema version check:** `graph.schemaVersion` must be `"2.0"`.
13. **Checksum present:** `graph.checksum` must be a non-empty string.


### 9.2 `src/workflows/compiler/friday-workflow-compiler.ts`

```ts
import type { FridayCompiledWorkflowGraphV2 } from "../model/friday-workflow-graph.types.js";
import type { FridayWorkflowValidationResult } from "./friday-workflow-validator.js";

/** WorkflowSpecV1 is the authoring DSL input. Defined in skill-system-design.md §3.3.3. */
export interface FridayWorkflowSpecV1 {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger:
    | { type: "manual" }
    | { type: "schedule"; cron: string; timezone: string }
    | { type: "event"; source: string; event: string };
  inputs: Array<{
    key: string;
    type: "string" | "number" | "boolean" | "object" | "array";
    required: boolean;
    defaultValue?: unknown;
  }>;
  steps: Array<{
    id: string;
    type: "skill_call" | "tool_call" | "condition" | "transform" | "human_approval";
    ref?: string;
    args?: Record<string, unknown>;
    condition?: string;
    timeoutSec?: number;
    retry?: { maxAttempts: number; backoffMs: number };
  }>;
  edges: Array<{
    from: string;
    to: string;
    when?: "success" | "failure" | "true" | "false";
  }>;
  outputs: Array<{
    key: string;
    fromStep: string;
    path: string;
  }>;
  errorPolicy: import("../model/friday-workflow.types.js").WorkflowFailurePolicyV2;
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
}

export interface FridayWorkflowCompiler {
  /** Compile a WorkflowSpecV1 into a CompiledWorkflowGraphV2.
   *  Validates the spec, maps step types to node types, generates edge ids, computes checksum.
   *  Returns the compiled graph. Throws on validation failure. */
  compile(spec: FridayWorkflowSpecV1, workflowVersionId: string): FridayCompiledWorkflowGraphV2;

  /** Validate a WorkflowSpecV1 without compiling. */
  validateSpec(spec: FridayWorkflowSpecV1): FridayWorkflowValidationResult;
}

export interface CreateWorkflowCompilerDeps {
  computeChecksum: (content: string) => string;
  idGenerator: () => string;
}

export function createFridayWorkflowCompiler(deps: CreateWorkflowCompilerDeps): FridayWorkflowCompiler;
```

**Compilation mapping (step type → node type):**

| `WorkflowSpecV1` step type | `CompiledWorkflowGraphV2` node type |
|---|---|
| `skill_call` | `action` |
| `tool_call` | `action` |
| `condition` | `condition` |
| `transform` | `data` |
| `human_approval` | `approval` |

The trigger from the spec is compiled into a separate `trigger` node injected as the first node with an edge to the `startStepId` node.

**Edge mapping:**
- Spec edges `{ from, to, when }` are mapped to graph edges with generated `id` values.
- `when: "success"` → edge with no condition (default path)
- `when: "failure"` → edge with `condition: "$steps.<from>.status == \"failed\""`  (or handled via separate failure routing in the scheduler)
- `when: "true"` → edge with `condition: "$steps.<from>.output.result == true"`
- `when: "false"` → edge with `condition: "$steps.<from>.output.result == false"`
- No `when` → unconditional edge

**Retry mapping:**
- Step `retry: { maxAttempts, backoffMs }` → node `retryPolicy: { maxAttempts, backoff: "exponential", baseDelayMs: backoffMs, maxDelayMs: backoffMs * 8, retryOn: ["NODE_EXECUTION_FAILED", "NODE_TIMEOUT"] }`

**Timeout mapping:**
- Step `timeoutSec` → node `timeoutMs = timeoutSec * 1000`

---

## 10. Runtime Compositor

### 10.1 `src/workflows/runtime/friday-workflow-runtime.types.ts`

```ts
import type { FridayWorkflowCrudService } from "../services/friday-workflow-crud-service.js";
import type { FridayWorkflowExecutionService } from "../services/friday-workflow-execution-service.js";
import type { FridayWorkflowTriggerService } from "../services/friday-workflow-trigger-service.js";

/**
 * Composite runtime surface that exposes all Phase 3 services
 * for integration with hub gateway and other hub services.
 */
export interface FridayWorkflowRuntime {
  crud: FridayWorkflowCrudService;
  execution: FridayWorkflowExecutionService;
  triggers: FridayWorkflowTriggerService;
}
```

### 10.2 `src/workflows/runtime/friday-workflow-runtime.ts`

```ts
import type { FridaySqliteLayer } from "../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowRuntime } from "./friday-workflow-runtime.types.js";

export interface CreateWorkflowRuntimeDeps {
  db: FridaySqliteLayer;
  /** Function to generate UUIDs */
  idGenerator: () => string;
  /** Function to get current ISO timestamp */
  nowIso: () => string;
  /** SHA-256 checksum function */
  computeChecksum: (content: string) => string;
  /** Resolve a skill by id */
  resolveSkill: (skillId: string) => import("../../skills/model/friday-skill-runtime.types.js").FridaySkill<unknown, unknown, unknown> | null;
  /** Invoke a skill in workflow mode */
  invokeSkill: (skillId: string, runId: string, nodeId: string, payload: Record<string, unknown>) => Promise<unknown>;
  /** Optional: publish WS events */
  publishEvent?: (event: string, payload: unknown) => Promise<void>;
}

export function createFridayWorkflowRuntime(deps: CreateWorkflowRuntimeDeps): FridayWorkflowRuntime;
```

**Wiring order:**

```
1. Create repositories:
   workflowRepo     = createFridayWorkflowRepository({ db })
   runRepo          = createFridayWorkflowRunRepository()
   nodeRepo         = createFridayWorkflowRunNodeRepository()
   artifactRepo     = createFridayWorkflowArtifactRepository()

2. Create engine components:
   expressionEval   = createFridayExpressionEvaluator()
   dagScheduler     = createFridayWorkflowDagScheduler()
   runMachine       = createFridayWorkflowRunMachine()
   nodeMachine      = createFridayWorkflowNodeMachine()
   retryManager     = createFridayWorkflowRetryManager({ idGenerator })
   nodeExecutor     = createFridayWorkflowNodeExecutor({ expressionEval, resolveSkill, invokeSkill, nowIso })
   artifactWriter   = createFridayWorkflowArtifactWriter({ db, artifactRepo, idGenerator, nowIso })
   compiler         = createFridayWorkflowCompiler({ computeChecksum, idGenerator })
   validator        = createFridayWorkflowValidator()

3. Create services:
   crudService      = createFridayWorkflowCrudService({ db, workflowRepo, idGenerator, nowIso, computeChecksum, computeEtag: () => idGenerator().slice(0, 16) })
   executionService = createFridayWorkflowExecutionService({ db, workflowRepo, runRepo, nodeRepo, artifactRepo, dagScheduler, runMachine, nodeMachine, nodeExecutor, retryManager, artifactWriter, expressionEval, idGenerator, nowIso, publishEvent })
   triggerService   = createFridayWorkflowTriggerService({ db, executionService, workflowRepo, idGenerator, nowIso })

4. Return composite:
   { crud: crudService, execution: executionService, triggers: triggerService }
```


### 10.3 `src/workflows/index.ts`

Barrel export:

```ts
// Model types
export * from "./model/friday-workflow.types.js";
export * from "./model/friday-workflow-graph.types.js";
export * from "./model/friday-workflow-trigger.types.js";
export * from "./model/friday-workflow-expression.types.js";

// Persistence
export { createFridayWorkflowRepository } from "./persistence/friday-workflow-repository.js";
export type { FridayWorkflowRepository } from "./persistence/friday-workflow-repository.js";
export { createFridayWorkflowRunRepository } from "./persistence/friday-workflow-run-repository.js";
export type { FridayWorkflowRunRepository } from "./persistence/friday-workflow-run-repository.js";
export { createFridayWorkflowRunNodeRepository } from "./persistence/friday-workflow-run-node-repository.js";
export type { FridayWorkflowRunNodeRepository } from "./persistence/friday-workflow-run-node-repository.js";
export { createFridayWorkflowArtifactRepository } from "./persistence/friday-workflow-artifact-repository.js";
export type { FridayWorkflowArtifactRepository } from "./persistence/friday-workflow-artifact-repository.js";

// Compiler
export { createFridayWorkflowCompiler } from "./compiler/friday-workflow-compiler.js";
export type { FridayWorkflowCompiler, FridayWorkflowSpecV1 } from "./compiler/friday-workflow-compiler.js";
export { createFridayWorkflowValidator } from "./compiler/friday-workflow-validator.js";
export type { FridayWorkflowValidator } from "./compiler/friday-workflow-validator.js";

// Engine
export { createFridayWorkflowDagScheduler } from "./engine/friday-workflow-dag-scheduler.js";
export { createFridayWorkflowRunMachine } from "./engine/friday-workflow-run-machine.js";
export { createFridayWorkflowNodeMachine } from "./engine/friday-workflow-node-machine.js";
export { createFridayWorkflowNodeExecutor } from "./engine/friday-workflow-node-executor.js";
export { createFridayExpressionEvaluator } from "./engine/friday-workflow-expression-evaluator.js";
export { createFridayWorkflowRetryManager } from "./engine/friday-workflow-retry-manager.js";
export { createFridayWorkflowArtifactWriter } from "./engine/friday-workflow-artifact-writer.js";

// Services
export { createFridayWorkflowCrudService } from "./services/friday-workflow-crud-service.js";
export type { FridayWorkflowCrudService } from "./services/friday-workflow-crud-service.js";
export { createFridayWorkflowExecutionService } from "./services/friday-workflow-execution-service.js";
export type { FridayWorkflowExecutionService } from "./services/friday-workflow-execution-service.js";
export { createFridayWorkflowTriggerService } from "./services/friday-workflow-trigger-service.js";
export type { FridayWorkflowTriggerService } from "./services/friday-workflow-trigger-service.js";

// Runtime
export { createFridayWorkflowRuntime } from "./runtime/friday-workflow-runtime.js";
export type { FridayWorkflowRuntime } from "./runtime/friday-workflow-runtime.types.js";
```

---

## 11. Unit Test Plan

### 11.1 Test Files & Required Cases

#### `tests/workflows/friday-workflow-validator.test.ts`
1. **Valid DAG** — accepts a simple linear graph (A→B→C)
2. **Valid DAG with branches** — accepts diamond graph (A→B, A→C, B→D, C→D)
3. **Cycle detection** — rejects graph with cycle A→B→C→A, error code `WORKFLOW_CYCLE_DETECTED`
4. **Self-loop detection** — rejects node with edge to itself
5. **Disconnected graph** — rejects graph with unreachable nodes, error code `WORKFLOW_GRAPH_DISCONNECTED`
6. **Empty graph** — rejects graph with no nodes
7. **Duplicate node ids** — rejects
8. **Edge references missing node** — rejects with descriptive error
9. **Condition node without outbound edges** — rejects
10. **Action node without skillId/ref** — rejects
11. **Invalid expression in edge condition** — rejects with `WORKFLOW_EXPRESSION_INVALID`
12. **Valid complex graph** — accepts graph with 20+ nodes, multiple branches, joins, conditions

#### `tests/workflows/friday-workflow-compiler.test.ts`
1. **Compile minimal spec** — single step, manual trigger → valid CompiledWorkflowGraphV2
2. **Step type mapping** — skill_call→action, tool_call→action, condition→condition, transform→data, human_approval→approval
3. **Trigger injection** — trigger node added as entry point with edge to startStepId
4. **Edge when mapping** — success/failure/true/false → correct condition expressions
5. **Retry policy mapping** — step retry → node retryPolicy with exponential backoff
6. **Timeout mapping** — timeoutSec → timeoutMs
7. **Checksum generation** — deterministic checksum for same input
8. **Invalid spec rejection** — missing startStepId, missing refs, cycles → throws
9. **Test cases preserved** — spec tests are passed through to compiled graph
10. **Schedule trigger compilation** — cron + timezone preserved in trigger node config

#### `tests/workflows/friday-workflow-dag-scheduler.test.ts`
1. **Linear DAG ordering** — A→B→C produces topoOrder [A,B,C] and entry [A]
2. **Diamond DAG** — A→B, A→C, B→D, C→D → entry [A], D ready only when B and C done
3. **Fan-out** — A→B, A→C, A→D → B,C,D all ready after A completes
4. **Fan-in (barrier)** — B→D, C→D → D ready only when both B and C have terminal status
5. **Condition edge filtering** — edge with false condition does not enable successor
6. **Entry nodes computation** — correctly identifies nodes with no inbound edges
7. **Complex graph readiness** — 10-node graph: correct progression of ready sets through execution
8. **Already-started nodes skipped** — nodes with existing attempts are not returned as ready
9. **Continue-on-error** — failed predecessor still enables successors under continue_on_error policy

#### `tests/workflows/friday-workflow-run-machine.test.ts`
1. **Valid transitions** — all valid transitions from §6.1 accepted
2. **Invalid transitions** — completed→running rejected, queued→completed rejected, etc.
3. **Terminal status check** — completed, cancelled are terminal; failed is terminal unless retrying
4. **Pause flow** — running→pausing→paused→running (resume)
5. **Compensation flow** — running→compensating→completed, running→compensating→failed

#### `tests/workflows/friday-workflow-node-machine.test.ts`
1. **Valid transitions** — all valid transitions from §6.2 accepted
2. **Invalid transitions** — completed→running rejected, queued→completed not directly valid (must go through running)
3. **Terminal status check** — completed, cancelled are terminal
4. **Retry flow** — failed→retrying→running→completed
5. **Offline flow** — running→blocked_offline→running→completed
6. **Offline timeout** — blocked_offline→failed

#### `tests/workflows/friday-workflow-expression-evaluator.test.ts`
1. **Literal evaluation** — string, number, boolean, null
2. **Reference resolution** — `$inputs.name` → "Alice", `$steps.fetch.output.count` → 42
3. **Comparison operators** — ==, !=, >, <, >=, <= with correct results
4. **Logical AND** — short-circuit behavior, `true && false` → false
5. **Logical OR** — short-circuit behavior, `false || true` → true
6. **Negation** — `!true` → false, `!$steps.check.output.valid` → negated
7. **Parentheses** — `(a || b) && c` vs `a || (b && c)`
8. **Complex expression** — `$inputs.env == "production" && $steps.check.output.healthy == true`
9. **Undefined ref** — `$steps.missing.output.x` → undefined (not error)
10. **Syntax error** — `$inputs.x ==` → throws parse error
11. **Max length enforcement** — >4096 chars → throws
12. **Nested depth enforcement** — >32 levels of nesting → throws
13. **No function calls** — `$inputs.x.toString()` → throws

#### `tests/workflows/friday-workflow-retry-manager.test.ts`
1. **No retry policy** — shouldRetry = false
2. **Under max attempts** — shouldRetry = true, correct next attempt number
3. **At max attempts** — shouldRetry = false
4. **Error code matching** — retryOn includes error code → retry, doesn't include → no retry
5. **Fixed backoff** — correct delay for fixed policy
6. **Exponential backoff** — delay doubles per attempt, capped at maxDelayMs
7. **Jitter** — delay varies (non-deterministic, but within ±25% range)
8. **Idempotency key format** — correct deterministic format
9. **Empty retryOn list** — all errors are retryable (wildcard)

#### `tests/workflows/friday-workflow-crud-service.test.ts`
1. **Create workflow** — insert + return entity with correct defaults
2. **Get workflow by id** — returns entity or null
3. **Get workflow by slug** — returns entity or null
4. **Update workflow** — revision/etag check, increments revision, new etag
5. **Update conflict** — wrong revision/etag → throws WORKFLOW_VERSION_CONFLICT
6. **Archive workflow** — soft-deletes, sets deleted_at
7. **Create version** — validates graph, increments version number, persists
8. **Create version with invalid graph** — throws validation error
9. **Publish version** — marks version published, updates workflow
10. **Publish unpublishes previous** — only one version published at a time
11. **List workflows with filters** — tag filter, archived filter, pagination

#### `tests/workflows/friday-workflow-execution-service.test.ts`
1. **Start run — linear workflow** — creates run + node attempts, executes in order, completes
2. **Start run — parallel branches** — fan-out nodes execute concurrently
3. **Start run — diamond join** — barrier node waits for all predecessors
4. **Start run — condition routing** — condition node routes to correct branch
5. **Start run — version resolution** — omitted versionId resolves to published version
6. **Start run — no published version** — throws error
7. **Fail fast** — first node failure aborts run
8. **Continue on error** — node failure doesn't abort, subsequent nodes still run
9. **Pause for approval** — approval node pauses run
10. **Resume after pause** — run continues from paused state
11. **Cancel run** — all pending nodes cancelled, run status cancelled
12. **Retry run** — failed nodes get new attempts, execution resumes
13. **Crash recovery** — recoverActiveRuns reloads plans and resumes
14. **Lease expiry reaping** — expired leases are requeued or failed
15. **Dry run** — no persistence, returns simulation result
16. **Node timeout** — times out and applies retry/failure policy
17. **Expression context propagation** — node outputs available to subsequent nodes via $steps

#### `tests/workflows/friday-workflow-trigger-service.test.ts`
1. **Register manual trigger** — stores registration
2. **Fire manual trigger** — creates run via execution service
3. **Register schedule trigger** — stores with cron expression
4. **Tick cron — match** — fires workflow when cron matches
5. **Tick cron — no match** — does nothing
6. **Tick cron — dedup** — same minute fires only once
7. **Register event trigger** — stores with source/event
8. **Match event — match** — fires workflow on matching event
9. **Match event — no match** — does nothing
10. **Unregister** — removes all triggers for workflow
11. **Reload from published versions** — rebuilds trigger registrations

#### `tests/workflows/friday-workflow-repository.test.ts`
1. **Insert and get workflow** — round-trip
2. **Slug uniqueness** — duplicate slug throws
3. **Update with correct revision** — succeeds
4. **Update with wrong revision** — throws conflict
5. **Archive and get** — archived workflow returns null from getById
6. **Insert and get version** — round-trip with graph JSON
7. **Version number uniqueness** — duplicate (workflowId, versionNumber) throws
8. **Get latest version** — returns highest version number
9. **Publish version** — sets is_published, clears other versions
10. **List versions ordered** — DESC by version_number

#### `tests/workflows/friday-workflow-run-repository.test.ts`
1. **Insert and get run** — round-trip
2. **Update status** — status changes persisted
3. **Finalize run** — sets finished_at and final status
4. **List active runs** — returns only non-terminal runs
5. **List by workflow** — filtered correctly
6. **Merge context** — JSON merge behavior correct

#### `tests/workflows/friday-workflow-run-node-repository.test.ts`
1. **Insert and get node attempt** — round-trip
2. **Unique constraint** — duplicate (run_id, node_id, attempt) throws
3. **Get latest attempt** — returns highest attempt number
4. **List attempts by node** — ordered by attempt ASC
5. **Acquire lease** — sets running + lease fields; returns true
6. **Acquire lease conflict** — already-leased node returns false
7. **List expired leases** — returns nodes past lease_expires_at
8. **Cancel all pending** — bulk cancel with correct count
9. **Count by status** — correct aggregation per latest attempt

#### `tests/workflows/friday-workflow-artifact-repository.test.ts`
1. **Insert and get artifact** — round-trip
2. **List by run** — all artifacts for a run
3. **List by run + nodeId** — filtered by node
4. **Delete by run** — removes all, returns count

#### `tests/workflows/friday-workflow-artifact-writer.test.ts`
1. **Write JSON artifact — small** — data URI format
2. **Write JSON artifact — large** — file URI format (>64KB)
3. **Checksum computation** — correct SHA-256
4. **Write non-JSON artifact** — correct type and URI preserved

#### `tests/workflows/friday-workflow-node-executor.test.ts`
1. **Execute trigger node** — returns trigger payload
2. **Execute action node** — resolves skill, invokes with resolved args
3. **Execute condition node** — evaluates expression, returns boolean result
4. **Execute data node** — evaluates transform, returns mapped data
5. **Execute approval node** — returns pending indicator
6. **Skill not found** — throws descriptive error
7. **Expression resolution in args** — `$inputs.x` resolved before skill invocation
8. **Node timeout enforcement** — execution cancelled after timeoutMs

---

## 12. Failure Policy Integration (Cross-cutting)

The execution loop in `friday-workflow-execution-service.ts` applies the run-level failure policy after each node failure:

| Strategy | Behavior in execution loop |
|---|---|
| `fail_fast` | Set `aborted = true`, break out of ready-node loop. Cancel all pending nodes. Set run status = `failed`. |
| `continue_on_error` | Mark node as failed, continue. Failed predecessor still enables successors (their inbound count is satisfied by terminal status). If no successors are reachable, run completes with `failed` status. |
| `fallback_step` | Add `failurePolicy.fallbackStepId` to the ready set. Execute it. If it succeeds, run may complete normally. If it fails, run fails. |
| `compensate` | Set run status = `compensating`. Load compensation workflow. Execute it. If compensation succeeds, run status = `completed`. If it fails, run status = `failed`. |
| `pause_for_approval` | Set run status = `paused`. Emit `workflow.run.paused` event with failed node info. Wait for `resumeRun()` call. On resume, re-evaluate readiness. |

---

## 13. Integration Points with Existing Phases

### 13.1 Phase 0 — SQLite Layer

- All repositories use `FridaySqliteLayer` (`src/state/sqlite/friday-sqlite.types.ts`)
- `withWriteTransaction` for all mutations
- `withReadConnection` for all reads
- All tables from V001 DDL used as-is (no migration changes)

### 13.2 Phase 1 — Skill Runtime

- `FridaySkill` interface (`src/skills/model/friday-skill-runtime.types.ts`) used by node executor
- `resolveSkill` dependency: looks up skills from `FridaySkillRegistry` (`src/skills/registry/friday-skill-registry.ts`)
- `invokeSkill` dependency: creates `SkillInitContext`, calls `skill.init()`, then `skill.execute()` in workflow mode
- Skill manifest `invocation.modes` checked: only skills with `"workflow"` mode can be used as action nodes

### 13.3 Phase 2 — Satellite Runtime

- `FridayOutboxQueueService` (`src/satellites/services/friday-outbox-queue-service.ts`) used for dispatching node execution to satellites
- `FridaySatelliteCapabilityService` (`src/satellites/services/friday-satellite-capability-service.ts`) used for capability-based satellite selection
- Node results from satellites arrive via `FridaySatelliteSyncService.push()` and are routed back to the execution service
- `FridaySkillRunCheckpointWriter` pattern reused: workflow execution atomically persists run state + learning events in a single transaction

### 13.4 Hub Services

- `FridayHubGatewayIngressService` (`src/hub/services/friday-hub-gateway-ingress.types.ts`): workflow runtime registers gateway methods for workflow CRUD and run management
- `FridayHubMemoryStateService` (`src/hub/services/friday-hub-memory-state.types.ts`): audit log writes for workflow lifecycle events
- Event publishing via `publishEvent` dependency for real-time WS updates

---

*End of Phase 3 Implementation Plan.*
