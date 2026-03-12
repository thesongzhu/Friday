> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 5 Code Review Package

## Build & Test Results
- TypeScript: CLEAN
- 703 tests passed (80 files), 0 failures

## Source Code (Phase 5)

### `src/workflows/builder/index.ts`
```ts
// Model types
export * from "./model/friday-workflow-builder-canvas.types.js";
export * from "./model/friday-workflow-builder-template.types.js";
export * from "./model/friday-workflow-builder-draft.types.js";
export * from "./model/friday-workflow-builder-validation.types.js";
export * from "./model/friday-workflow-builder-test.types.js";
export * from "./model/friday-workflow-builder-collaboration.types.js";
export * from "./model/friday-workflow-builder-io.types.js";
export * from "./model/friday-workflow-builder-runtime.types.js";

// Persistence
export { createFridayWorkflowBuilderDraftRepository } from "./persistence/friday-workflow-builder-draft-repository.js";
export type { FridayWorkflowBuilderDraftRepository } from "./persistence/friday-workflow-builder-draft-repository.js";
export { createFridayWorkflowBuilderTemplateRepository } from "./persistence/friday-workflow-builder-template-repository.js";
export type { FridayWorkflowBuilderTemplateRepository } from "./persistence/friday-workflow-builder-template-repository.js";
export { createFridayWorkflowBuilderSpecVersionRepository } from "./persistence/friday-workflow-builder-spec-version-repository.js";
export type { FridayWorkflowBuilderSpecVersionRepository } from "./persistence/friday-workflow-builder-spec-version-repository.js";
export { createFridayWorkflowBuilderTestRunRepository } from "./persistence/friday-workflow-builder-test-run-repository.js";
export type { FridayWorkflowBuilderTestRunRepository } from "./persistence/friday-workflow-builder-test-run-repository.js";
export { createFridayWorkflowBuilderLockRepository } from "./persistence/friday-workflow-builder-lock-repository.js";
export type { FridayWorkflowBuilderLockRepository } from "./persistence/friday-workflow-builder-lock-repository.js";

// Services
export { createFridayWorkflowBuilderCollaborationService } from "./services/friday-workflow-builder-collaboration-service.js";
export type { FridayWorkflowBuilderCollaborationService } from "./services/friday-workflow-builder-collaboration-service.js";
export { createFridayWorkflowBuilderDraftService } from "./services/friday-workflow-builder-draft-service.js";
export type { FridayWorkflowBuilderDraftService } from "./services/friday-workflow-builder-draft-service.js";
export { createFridayWorkflowBuilderTemplateService } from "./services/friday-workflow-builder-template-service.js";
export type { FridayWorkflowBuilderTemplateService } from "./services/friday-workflow-builder-template-service.js";
export { createFridayWorkflowBuilderValidationService } from "./services/friday-workflow-builder-validation-service.js";
export type { FridayWorkflowBuilderValidationService } from "./services/friday-workflow-builder-validation-service.js";
export { createFridayWorkflowBuilderTestRunnerService } from "./services/friday-workflow-builder-test-runner-service.js";
export type { FridayWorkflowBuilderTestRunnerService } from "./services/friday-workflow-builder-test-runner-service.js";
export { createFridayWorkflowBuilderImportExportService } from "./services/friday-workflow-builder-import-export-service.js";
export type { FridayWorkflowBuilderImportExportService } from "./services/friday-workflow-builder-import-export-service.js";
export { createFridayWorkflowBuilderCompositorService } from "./services/friday-workflow-builder-compositor-service.js";
export type { FridayWorkflowBuilderCompositorService } from "./services/friday-workflow-builder-compositor-service.js";

// Templates
export { getFridayBuiltinWorkflowTemplates } from "./templates/friday-workflow-builder-builtin-templates.js";

// Runtime
export { createFridayWorkflowBuilderRuntime } from "./runtime/friday-workflow-builder-runtime.js";
export type { FridayWorkflowBuilderRuntime } from "./runtime/friday-workflow-builder-runtime.js";
```

### `src/workflows/builder/model/friday-workflow-builder-canvas.types.ts`
```ts
import type { UUID } from "../../model/friday-workflow.types.js";

// ─── Viewport ───

export interface FridayWorkflowCanvasViewportV1 {
  x: number;
  y: number;
  zoom: number;
}

// ─── Panel Layout ───

export interface FridayWorkflowCanvasPanelLayoutV1 {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

// ─── Node Layout ───

export interface FridayWorkflowBuilderNodeLayoutV1 {
  nodeId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex?: number;
}

// ─── Edge Layout ───

export interface FridayWorkflowBuilderEdgeLayoutV1 {
  edgeKey: string; // `${from}:${to}:${when ?? "any"}`
  sourceHandle?: string;
  targetHandle?: string;
  bendPoints?: Array<{ x: number; y: number }>;
}

// ─── Visual Graph ───

export interface FridayWorkflowVisualGraphV1 {
  schemaVersion: "1.0";
  workflowId: UUID;
  viewport: FridayWorkflowCanvasViewportV1;
  selectedNodeId?: string;
  selectedEdgeKey?: string;
  panelLayout: FridayWorkflowCanvasPanelLayoutV1;
  nodes: FridayWorkflowBuilderNodeLayoutV1[];
  edges: FridayWorkflowBuilderEdgeLayoutV1[];
}
```

### `src/workflows/builder/model/friday-workflow-builder-collaboration.types.ts`
```ts
import type { UUID, ISODateTime } from "../../model/friday-workflow.types.js";

// ─── Edit Lock ───

export interface FridayWorkflowEditLock {
  workflowId: UUID;
  lockToken: string;
  ownerUserId: UUID;
  ownerSessionId?: string;
  acquiredAt: ISODateTime;
  heartbeatAt: ISODateTime;
  expiresAt: ISODateTime;
}

// ─── Lock Acquire Input ───

export interface FridayWorkflowLockAcquireInput {
  workflowId: UUID;
  ownerUserId: UUID;
  ownerSessionId?: string;
  ttlSec: number;
}

// ─── Lock Acquire Result ───

export interface FridayWorkflowLockAcquireResult {
  acquired: boolean;
  lock?: FridayWorkflowEditLock;
  conflict?: FridayWorkflowEditLock;
}
```

### `src/workflows/builder/model/friday-workflow-builder-draft.types.ts`
```ts
import type { UUID, ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "./friday-workflow-builder-canvas.types.js";

// ─── Draft Status ───

export type FridayWorkflowDraftStatus = "active" | "archived" | "published" | "conflicted";

// ─── Autosave State ───

export interface FridayWorkflowDraftAutosaveState {
  enabled: boolean;
  intervalMs: number;
  lastSavedAt?: ISODateTime;
}

// ─── Draft Entity ───

export interface FridayWorkflowDraftEntity {
  draftId: UUID;
  workflowId: UUID;
  ownerUserId?: UUID;
  title: string;
  status: FridayWorkflowDraftStatus;
  revision: number;
  baseWorkflowVersionId?: UUID;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  publishedVersionId?: UUID;
  autosave: FridayWorkflowDraftAutosaveState;
}

// ─── Draft Save Input ───

export interface FridayWorkflowDraftSaveInput {
  draftId: UUID;
  expectedRevision: number;
  lockToken: string;
  spec?: FridayWorkflowSpecV1;
  visual?: FridayWorkflowVisualGraphV1;
  title?: string;
  autosave?: Partial<FridayWorkflowDraftAutosaveState>;
}
```

### `src/workflows/builder/model/friday-workflow-builder-io.types.ts`
```ts
import type { UUID, ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "./friday-workflow-builder-canvas.types.js";
import type { FridayWorkflowDraftEntity } from "./friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderValidationReport } from "./friday-workflow-builder-validation.types.js";

// ─── Export Bundle ───

export interface FridayWorkflowSpecBundleV1 {
  bundleSchemaVersion: "1.0";
  exportedAt: ISODateTime;
  source: { type: "draft" | "workflow_version"; id: UUID; workflowId: UUID };
  workflow: { slug?: string; name: string; description?: string; tags?: string[] };
  draft?: { draftId: UUID; revision: number; title: string };
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  checksum: string;
}

// ─── Import Result ───

export interface FridayWorkflowImportResult {
  draft: FridayWorkflowDraftEntity;
  validation: FridayWorkflowBuilderValidationReport;
  warnings: string[];
}
```

### `src/workflows/builder/model/friday-workflow-builder-runtime.types.ts`
```ts
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowBuilderValidationReport } from "./friday-workflow-builder-validation.types.js";

// ─── Publish Input ───

export interface FridayWorkflowBuilderPublishInput {
  draftId: UUID;
  workflowId: UUID;
  lockToken: string;
  createdByUserId?: UUID;
  changeNote?: string;
  publishNow: boolean;
}

// ─── Publish Result ───

export interface FridayWorkflowBuilderPublishResult {
  workflowId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}
```

### `src/workflows/builder/model/friday-workflow-builder-template.types.ts`
```ts
import type { UUID, ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "./friday-workflow-builder-canvas.types.js";

// ─── Template Kinds ───

export type FridayWorkflowTemplateKind = "builtin" | "skill" | "user";
export type FridayWorkflowTemplateScope = "global" | "user";

// ─── Template Entity ───

export interface FridayWorkflowTemplateEntity {
  templateId: string;
  kind: FridayWorkflowTemplateKind;
  scope: FridayWorkflowTemplateScope;
  ownerUserId?: UUID;
  name: string;
  description?: string;
  tags: string[];
  sourceSkillId?: string;
  spec: FridayWorkflowSpecV1;
  visual: FridayWorkflowVisualGraphV1;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
```

### `src/workflows/builder/model/friday-workflow-builder-test.types.ts`
```ts
import type { UUID, ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecTestAssertionOperator } from "../../model/friday-workflow-spec.types.js";

// ─── Test Case Status ───

export type FridayWorkflowTestCaseStatus = "passed" | "failed" | "skipped";

// ─── Assertion Result ───

export interface FridayWorkflowTestAssertionResult {
  path: string;
  operator: FridayWorkflowSpecTestAssertionOperator;
  expected: unknown;
  actual: unknown;
  passed: boolean;
  message?: string;
}

// ─── Test Case Result ───

export interface FridayWorkflowTestCaseResult {
  name: string;
  status: FridayWorkflowTestCaseStatus;
  durationMs: number;
  assertionResults: FridayWorkflowTestAssertionResult[];
  error?: { code: string; message: string };
}

// ─── Test Run Result ───

export interface FridayWorkflowTestRunResult {
  runId: UUID;
  workflowId: UUID;
  draftId?: UUID;
  startedAt: ISODateTime;
  finishedAt: ISODateTime;
  passed: boolean;
  caseResults: FridayWorkflowTestCaseResult[];
}
```

### `src/workflows/builder/model/friday-workflow-builder-validation.types.ts`
```ts
import type { ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../model/friday-workflow-graph.types.js";

// ─── Validation Severity and Stage ───

export type FridayWorkflowValidationSeverity = "error" | "warning" | "info";

export type FridayWorkflowValidationStage =
  | "spec_schema"
  | "graph_compile"
  | "compiled_graph"
  | "skill_refs"
  | "expressions"
  | "tests"
  | "canvas";

// ─── Validation Issue ───

export interface FridayWorkflowBuilderValidationIssue {
  code: string;
  stage: FridayWorkflowValidationStage;
  severity: FridayWorkflowValidationSeverity;
  message: string;
  jsonPath?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: "success" | "failure" | "true" | "false" };
}

// ─── Validation Report ───

export interface FridayWorkflowBuilderValidationReport {
  valid: boolean;
  issues: FridayWorkflowBuilderValidationIssue[];
  compiledGraphPreview?: FridayCompiledWorkflowGraphV2;
  generatedAt: ISODateTime;
}
```

### `src/workflows/builder/persistence/friday-workflow-builder-draft-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowDraftStatus,
} from "../model/friday-workflow-builder-draft.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderDraftRepository {
  create(db: Database.Database, draft: FridayWorkflowDraftEntity): void;
  getById(db: Database.Database, draftId: UUID): FridayWorkflowDraftEntity | null;
  listByWorkflow(db: Database.Database, workflowId: UUID): FridayWorkflowDraftEntity[];
  listByStatus(db: Database.Database, status: FridayWorkflowDraftStatus): FridayWorkflowDraftEntity[];
  update(db: Database.Database, draft: FridayWorkflowDraftEntity): void;
  updateStatus(db: Database.Database, draftId: UUID, status: FridayWorkflowDraftStatus, nowIso: string): void;
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_drafts";

function draftKey(workflowId: UUID, draftId: UUID): string {
  return `${workflowId}:${draftId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderDraftRepository(): FridayWorkflowBuilderDraftRepository {
  return {
    create(db, draft) {
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        draft.draftId,
        NAMESPACE,
        draftKey(draft.workflowId, draft.draftId),
        JSON.stringify(draft),
        JSON.stringify([draft.status]),
        draft.createdAt,
        draft.updatedAt,
      );
    },

    getById(db, draftId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
        )
        .get(NAMESPACE, `%:${draftId}`) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowDraftEntity) : null;
    },

    listByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`,
        )
        .all(NAMESPACE, `${workflowId}:%`) as Array<{ value_json: string }>;
      return rows.map((r) => JSON.parse(r.value_json) as FridayWorkflowDraftEntity);
    },

    listByStatus(db, status) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? ORDER BY updated_at DESC`,
        )
        .all(NAMESPACE) as Array<{ value_json: string }>;
      return rows
        .map((r) => JSON.parse(r.value_json) as FridayWorkflowDraftEntity)
        .filter((d) => d.status === status);
    },

    update(db, draft) {
      const result = db
        .prepare(
          `UPDATE memory_items SET value_json = ?, tags_json = ?, updated_at = ?
           WHERE namespace = ? AND key = ?`,
        )
        .run(
          JSON.stringify(draft),
          JSON.stringify([draft.status]),
          draft.updatedAt,
          NAMESPACE,
          draftKey(draft.workflowId, draft.draftId),
        );
      if (result.changes === 0) {
        throw new Error("DRAFT_NOT_FOUND");
      }
    },

    updateStatus(db, draftId, status, nowIso) {
      const existing = this.getById(db, draftId);
      if (!existing) throw new Error("DRAFT_NOT_FOUND");
      existing.status = status;
      existing.updatedAt = nowIso;
      this.update(db, existing);
    },
  };
}
```

### `src/workflows/builder/persistence/friday-workflow-builder-lock-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowEditLock } from "../model/friday-workflow-builder-collaboration.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderLockRepository {
  getLock(db: Database.Database, workflowId: UUID): FridayWorkflowEditLock | null;
  setLock(db: Database.Database, lock: FridayWorkflowEditLock): void;
  deleteLock(db: Database.Database, workflowId: UUID): void;
}

// ─── Constants ───

function lockKey(workflowId: UUID): string {
  return `workflow_builder_lock:${workflowId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderLockRepository(): FridayWorkflowBuilderLockRepository {
  return {
    getLock(db, workflowId) {
      const row = db
        .prepare(`SELECT value_json FROM hub_settings WHERE key = ?`)
        .get(lockKey(workflowId)) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowEditLock) : null;
    },

    setLock(db, lock) {
      const key = lockKey(lock.workflowId);
      const json = JSON.stringify(lock);
      const now = lock.acquiredAt;

      // Upsert into hub_settings
      const existing = db
        .prepare(`SELECT key FROM hub_settings WHERE key = ?`)
        .get(key) as { key: string } | undefined;

      if (existing) {
        db.prepare(
          `UPDATE hub_settings SET value_json = ?, revision = revision + 1, updated_at = ?, updated_by = ?
           WHERE key = ?`,
        ).run(json, now, lock.ownerUserId, key);
      } else {
        db.prepare(
          `INSERT INTO hub_settings (key, value_json, revision, created_at, updated_at, created_by, updated_by)
           VALUES (?, ?, 1, ?, ?, ?, ?)`,
        ).run(key, json, now, now, lock.ownerUserId, lock.ownerUserId);
      }
    },

    deleteLock(db, workflowId) {
      db.prepare(`DELETE FROM hub_settings WHERE key = ?`).run(lockKey(workflowId));
    },
  };
}
```

### `src/workflows/builder/persistence/friday-workflow-builder-spec-version-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { UUID, ISODateTime } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";

// ─── Spec Version Record ───

export interface FridayWorkflowSpecVersionRecord {
  workflowId: UUID;
  workflowVersionId: UUID;
  spec: FridayWorkflowSpecV1;
  checksum: string;
  createdAt: ISODateTime;
}

// ─── Interface ───

export interface FridayWorkflowBuilderSpecVersionRepository {
  create(db: Database.Database, record: FridayWorkflowSpecVersionRecord): void;
  getByVersionId(db: Database.Database, workflowVersionId: UUID): FridayWorkflowSpecVersionRecord | null;
  listByWorkflow(db: Database.Database, workflowId: UUID): FridayWorkflowSpecVersionRecord[];
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_spec_versions";

function specVersionKey(workflowId: UUID, workflowVersionId: UUID): string {
  return `${workflowId}:${workflowVersionId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderSpecVersionRepository(): FridayWorkflowBuilderSpecVersionRepository {
  return {
    create(db, record) {
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.workflowVersionId,
        NAMESPACE,
        specVersionKey(record.workflowId, record.workflowVersionId),
        JSON.stringify(record),
        "[]",
        record.createdAt,
        record.createdAt,
      );
    },

    getByVersionId(db, workflowVersionId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
        )
        .get(NAMESPACE, `%:${workflowVersionId}`) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowSpecVersionRecord) : null;
    },

    listByWorkflow(db, workflowId) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at DESC`,
        )
        .all(NAMESPACE, `${workflowId}:%`) as Array<{ value_json: string }>;
      return rows.map((r) => JSON.parse(r.value_json) as FridayWorkflowSpecVersionRecord);
    },
  };
}
```

### `src/workflows/builder/persistence/friday-workflow-builder-template-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type {
  FridayWorkflowTemplateEntity,
  FridayWorkflowTemplateScope,
} from "../model/friday-workflow-builder-template.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTemplateRepository {
  create(db: Database.Database, template: FridayWorkflowTemplateEntity): void;
  getById(db: Database.Database, templateId: string): FridayWorkflowTemplateEntity | null;
  list(db: Database.Database, scope?: FridayWorkflowTemplateScope, ownerUserId?: UUID): FridayWorkflowTemplateEntity[];
  update(db: Database.Database, template: FridayWorkflowTemplateEntity): void;
  delete(db: Database.Database, templateId: string): void;
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_templates";

function templateKey(scope: FridayWorkflowTemplateScope, ownerUserId: UUID | undefined, templateId: string): string {
  return `${scope}:${ownerUserId ?? "global"}:${templateId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTemplateRepository(): FridayWorkflowBuilderTemplateRepository {
  return {
    create(db, template) {
      const key = templateKey(template.scope, template.ownerUserId, template.templateId);
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        template.templateId,
        NAMESPACE,
        key,
        JSON.stringify(template),
        JSON.stringify(template.tags),
        template.createdAt,
        template.updatedAt,
      );
    },

    getById(db, templateId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ?`,
        )
        .get(NAMESPACE, `%:${templateId}`) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowTemplateEntity) : null;
    },

    list(db, scope, ownerUserId) {
      let query: string;
      let params: unknown[];

      if (scope && ownerUserId) {
        query = `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`;
        params = [NAMESPACE, `${scope}:${ownerUserId}:%`];
      } else if (scope) {
        query = `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY updated_at DESC`;
        params = [NAMESPACE, `${scope}:%`];
      } else {
        query = `SELECT value_json FROM memory_items WHERE namespace = ? ORDER BY updated_at DESC`;
        params = [NAMESPACE];
      }

      const rows = db.prepare(query).all(...params) as Array<{ value_json: string }>;
      return rows.map((r) => JSON.parse(r.value_json) as FridayWorkflowTemplateEntity);
    },

    update(db, template) {
      const key = templateKey(template.scope, template.ownerUserId, template.templateId);
      const result = db
        .prepare(
          `UPDATE memory_items SET value_json = ?, tags_json = ?, updated_at = ?
           WHERE namespace = ? AND key = ?`,
        )
        .run(
          JSON.stringify(template),
          JSON.stringify(template.tags),
          template.updatedAt,
          NAMESPACE,
          key,
        );
      if (result.changes === 0) {
        throw new Error("TEMPLATE_NOT_FOUND");
      }
    },

    delete(db, templateId) {
      const result = db
        .prepare(`DELETE FROM memory_items WHERE namespace = ? AND key LIKE ?`)
        .run(NAMESPACE, `%:${templateId}`);
      if (result.changes === 0) {
        throw new Error("TEMPLATE_NOT_FOUND");
      }
    },
  };
}
```

### `src/workflows/builder/persistence/friday-workflow-builder-test-run-repository.ts`
```ts
import type Database from "better-sqlite3";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowTestRunResult } from "../model/friday-workflow-builder-test.types.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTestRunRepository {
  create(db: Database.Database, result: FridayWorkflowTestRunResult): void;
  getById(db: Database.Database, runId: UUID): FridayWorkflowTestRunResult | null;
  listByDraft(db: Database.Database, draftId: UUID, limit?: number): FridayWorkflowTestRunResult[];
}

// ─── Constants ───

const NAMESPACE = "workflow_builder_test_runs";

function testRunKey(draftId: UUID, runId: UUID): string {
  return `${draftId}:${runId}`;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTestRunRepository(): FridayWorkflowBuilderTestRunRepository {
  return {
    create(db, result) {
      db.prepare(
        `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        result.runId,
        NAMESPACE,
        testRunKey(result.draftId ?? result.workflowId, result.runId),
        JSON.stringify(result),
        JSON.stringify([result.passed ? "passed" : "failed"]),
        result.startedAt,
        result.finishedAt,
      );
    },

    getById(db, runId) {
      const row = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND id = ?`,
        )
        .get(NAMESPACE, runId) as { value_json: string } | undefined;
      return row ? (JSON.parse(row.value_json) as FridayWorkflowTestRunResult) : null;
    },

    listByDraft(db, draftId, limit) {
      const rows = db
        .prepare(
          `SELECT value_json FROM memory_items WHERE namespace = ? AND key LIKE ? ORDER BY created_at DESC LIMIT ?`,
        )
        .all(NAMESPACE, `${draftId}:%`, limit ?? 50) as Array<{ value_json: string }>;
      return rows.map((r) => JSON.parse(r.value_json) as FridayWorkflowTestRunResult);
    },
  };
}
```

### `src/workflows/builder/runtime/friday-workflow-builder-runtime.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowCrudService } from "../../services/friday-workflow-crud-service.js";

import { createFridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../compiler/friday-workflow-validator.js";

import { createFridayWorkflowBuilderDraftRepository } from "../persistence/friday-workflow-builder-draft-repository.js";
import { createFridayWorkflowBuilderTemplateRepository } from "../persistence/friday-workflow-builder-template-repository.js";
import { createFridayWorkflowBuilderSpecVersionRepository } from "../persistence/friday-workflow-builder-spec-version-repository.js";
import { createFridayWorkflowBuilderTestRunRepository } from "../persistence/friday-workflow-builder-test-run-repository.js";
import { createFridayWorkflowBuilderLockRepository } from "../persistence/friday-workflow-builder-lock-repository.js";

import { createFridayWorkflowBuilderCollaborationService } from "../services/friday-workflow-builder-collaboration-service.js";
import { createFridayWorkflowBuilderDraftService } from "../services/friday-workflow-builder-draft-service.js";
import { createFridayWorkflowBuilderTemplateService } from "../services/friday-workflow-builder-template-service.js";
import { createFridayWorkflowBuilderValidationService } from "../services/friday-workflow-builder-validation-service.js";
import { createFridayWorkflowBuilderTestRunnerService } from "../services/friday-workflow-builder-test-runner-service.js";
import { createFridayWorkflowBuilderImportExportService } from "../services/friday-workflow-builder-import-export-service.js";
import { createFridayWorkflowBuilderCompositorService } from "../services/friday-workflow-builder-compositor-service.js";
import { getFridayBuiltinWorkflowTemplates } from "../templates/friday-workflow-builder-builtin-templates.js";

import type { FridayWorkflowBuilderCollaborationService } from "../services/friday-workflow-builder-collaboration-service.js";
import type { FridayWorkflowBuilderDraftService } from "../services/friday-workflow-builder-draft-service.js";
import type { FridayWorkflowBuilderTemplateService } from "../services/friday-workflow-builder-template-service.js";
import type { FridayWorkflowBuilderValidationService } from "../services/friday-workflow-builder-validation-service.js";
import type { FridayWorkflowBuilderTestRunnerService } from "../services/friday-workflow-builder-test-runner-service.js";
import type { FridayWorkflowBuilderImportExportService } from "../services/friday-workflow-builder-import-export-service.js";
import type { FridayWorkflowBuilderCompositorService } from "../services/friday-workflow-builder-compositor-service.js";

// ─── Builder Runtime Interface ───

export interface FridayWorkflowBuilderRuntime {
  drafts: FridayWorkflowBuilderDraftService;
  templates: FridayWorkflowBuilderTemplateService;
  validation: FridayWorkflowBuilderValidationService;
  testRunner: FridayWorkflowBuilderTestRunnerService;
  collaboration: FridayWorkflowBuilderCollaborationService;
  importExport: FridayWorkflowBuilderImportExportService;
  compositor: FridayWorkflowBuilderCompositorService;
}

// ─── Dependencies ───

export interface CreateWorkflowBuilderRuntimeDeps {
  db: FridaySqliteLayer;
  crudService: FridayWorkflowCrudService;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderRuntime(
  deps: CreateWorkflowBuilderRuntimeDeps,
): FridayWorkflowBuilderRuntime {
  // Repositories
  const draftRepo = createFridayWorkflowBuilderDraftRepository();
  const templateRepo = createFridayWorkflowBuilderTemplateRepository();
  const specVersionRepo = createFridayWorkflowBuilderSpecVersionRepository();
  const testRunRepo = createFridayWorkflowBuilderTestRunRepository();
  const lockRepo = createFridayWorkflowBuilderLockRepository();

  // Compiler + validator
  const compiler = createFridayWorkflowCompiler({
    computeChecksum: deps.computeChecksum,
    idGenerator: deps.idGenerator,
  });
  const validator = createFridayWorkflowValidator();

  // Services
  const collaboration = createFridayWorkflowBuilderCollaborationService({
    db: deps.db,
    lockRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const drafts = createFridayWorkflowBuilderDraftService({
    db: deps.db,
    draftRepo,
    collaborationService: collaboration,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    computeChecksum: deps.computeChecksum,
  });

  const templates = createFridayWorkflowBuilderTemplateService({
    db: deps.db,
    templateRepo,
    draftService: drafts,
    builtinTemplates: getFridayBuiltinWorkflowTemplates(),
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const validation = createFridayWorkflowBuilderValidationService({
    compiler,
    validator,
    nowIso: deps.nowIso,
    idGenerator: deps.idGenerator,
  });

  const testRunner = createFridayWorkflowBuilderTestRunnerService({
    db: deps.db,
    testRunRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const importExport = createFridayWorkflowBuilderImportExportService({
    db: deps.db,
    draftService: drafts,
    validationService: validation,
    computeChecksum: deps.computeChecksum,
    nowIso: deps.nowIso,
    idGenerator: deps.idGenerator,
  });

  const compositor = createFridayWorkflowBuilderCompositorService({
    db: deps.db,
    compiler,
    crudService: deps.crudService,
    draftService: drafts,
    draftRepo,
    validationService: validation,
    collaborationService: collaboration,
    specVersionRepo,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
    computeChecksum: deps.computeChecksum,
  });

  return {
    drafts,
    templates,
    validation,
    testRunner,
    collaboration,
    importExport,
    compositor,
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-collaboration-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../model/friday-workflow.types.js";
import type {
  FridayWorkflowEditLock,
  FridayWorkflowLockAcquireInput,
  FridayWorkflowLockAcquireResult,
} from "../model/friday-workflow-builder-collaboration.types.js";
import type { FridayWorkflowBuilderLockRepository } from "../persistence/friday-workflow-builder-lock-repository.js";

// ─── Interface ───

export interface FridayWorkflowBuilderCollaborationService {
  acquireLock(input: FridayWorkflowLockAcquireInput): FridayWorkflowLockAcquireResult;
  renewLock(workflowId: UUID, lockToken: string, ttlSec: number): FridayWorkflowEditLock;
  releaseLock(workflowId: UUID, lockToken: string): void;
  getLock(workflowId: UUID): FridayWorkflowEditLock | null;
  assertLock(workflowId: UUID, lockToken: string): void;
}

// ─── Dependencies ───

export interface CreateCollaborationServiceDeps {
  db: FridaySqliteLayer;
  lockRepo: FridayWorkflowBuilderLockRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderCollaborationService(
  deps: CreateCollaborationServiceDeps,
): FridayWorkflowBuilderCollaborationService {
  function isExpired(lock: FridayWorkflowEditLock): boolean {
    return lock.expiresAt <= deps.nowIso();
  }

  return {
    acquireLock(input) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.lockRepo.getLock(db, input.workflowId);

        // If an unexpired lock is held by a different owner, conflict
        if (existing && !isExpired(existing) && existing.ownerUserId !== input.ownerUserId) {
          return { acquired: false, conflict: existing };
        }

        const now = deps.nowIso();
        const expiresAt = new Date(new Date(now).getTime() + input.ttlSec * 1000).toISOString();

        const lock: FridayWorkflowEditLock = {
          workflowId: input.workflowId,
          lockToken: deps.idGenerator(),
          ownerUserId: input.ownerUserId,
          ownerSessionId: input.ownerSessionId,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt,
        };

        deps.lockRepo.setLock(db, lock);
        return { acquired: true, lock };
      });
    },

    renewLock(workflowId, lockToken, ttlSec) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.lockRepo.getLock(db, workflowId);
        if (!existing || existing.lockToken !== lockToken) {
          throw new Error("WORKFLOW_EDIT_LOCK_MISMATCH");
        }

        const now = deps.nowIso();
        const expiresAt = new Date(new Date(now).getTime() + ttlSec * 1000).toISOString();

        const renewed: FridayWorkflowEditLock = {
          ...existing,
          heartbeatAt: now,
          expiresAt,
        };

        deps.lockRepo.setLock(db, renewed);
        return renewed;
      });
    },

    releaseLock(workflowId, lockToken) {
      deps.db.withWriteTransaction((db) => {
        const existing = deps.lockRepo.getLock(db, workflowId);
        if (!existing) return;
        if (existing.lockToken !== lockToken) {
          throw new Error("WORKFLOW_EDIT_LOCK_MISMATCH");
        }
        deps.lockRepo.deleteLock(db, workflowId);
      });
    },

    getLock(workflowId) {
      return deps.db.withReadConnection((db) => {
        const lock = deps.lockRepo.getLock(db, workflowId);
        if (lock && isExpired(lock)) return null;
        return lock;
      });
    },

    assertLock(workflowId, lockToken) {
      const lock = deps.db.withReadConnection((db) =>
        deps.lockRepo.getLock(db, workflowId),
      );
      if (!lock) throw new Error("WORKFLOW_EDIT_LOCK_REQUIRED");
      if (isExpired(lock)) throw new Error("WORKFLOW_EDIT_LOCK_EXPIRED");
      if (lock.lockToken !== lockToken) throw new Error("WORKFLOW_EDIT_LOCK_MISMATCH");
    },
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-compositor-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "../../model/friday-workflow-graph.types.js";
import type { FridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import type { FridayWorkflowCrudService } from "../../services/friday-workflow-crud-service.js";
import type {
  FridayWorkflowBuilderPublishInput,
  FridayWorkflowBuilderPublishResult,
} from "../model/friday-workflow-builder-runtime.types.js";
import type { FridayWorkflowBuilderValidationReport } from "../model/friday-workflow-builder-validation.types.js";
import type { FridayWorkflowBuilderDraftService } from "./friday-workflow-builder-draft-service.js";
import type { FridayWorkflowBuilderValidationService } from "./friday-workflow-builder-validation-service.js";
import type { FridayWorkflowBuilderCollaborationService } from "./friday-workflow-builder-collaboration-service.js";
import type { FridayWorkflowBuilderDraftRepository } from "../persistence/friday-workflow-builder-draft-repository.js";
import type { FridayWorkflowBuilderSpecVersionRepository } from "../persistence/friday-workflow-builder-spec-version-repository.js";

// ─── Interface ───

export interface FridayWorkflowBuilderCompositorService {
  compileDraft(draftId: UUID): {
    compiled: FridayCompiledWorkflowGraphV2;
    validation: FridayWorkflowBuilderValidationReport;
  };
  publishDraft(input: FridayWorkflowBuilderPublishInput): FridayWorkflowBuilderPublishResult;
}

// ─── Dependencies ───

export interface CreateCompositorServiceDeps {
  db: FridaySqliteLayer;
  compiler: FridayWorkflowCompiler;
  crudService: FridayWorkflowCrudService;
  draftService: FridayWorkflowBuilderDraftService;
  draftRepo: FridayWorkflowBuilderDraftRepository;
  validationService: FridayWorkflowBuilderValidationService;
  collaborationService: FridayWorkflowBuilderCollaborationService;
  specVersionRepo: FridayWorkflowBuilderSpecVersionRepository;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderCompositorService(
  deps: CreateCompositorServiceDeps,
): FridayWorkflowBuilderCompositorService {
  return {
    compileDraft(draftId) {
      const draft = deps.draftService.getDraft(draftId);
      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      const validation = deps.validationService.validateDraft(draft);

      if (!validation.compiledGraphPreview) {
        throw new Error("DRAFT_COMPILATION_FAILED");
      }

      return {
        compiled: validation.compiledGraphPreview,
        validation,
      };
    },

    publishDraft(input) {
      // 1. Assert lock
      deps.collaborationService.assertLock(input.workflowId, input.lockToken);

      // 2. Load draft
      const draft = deps.draftService.getDraft(input.draftId);
      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      // 3. Validate for publish
      const validation = deps.validationService.validateForPublish(draft);
      if (!validation.valid) {
        return {
          workflowId: input.workflowId,
          workflowVersionId: "",
          versionNumber: 0,
          published: false,
          checksum: "",
          validation,
        };
      }

      // 4. Compile spec → CompiledWorkflowGraphV2
      const versionId = deps.idGenerator();
      const compiled = deps.compiler.compile(draft.spec, versionId);

      // 5. Create runtime version via Phase 3 CRUD
      const version = deps.crudService.createVersion(
        input.workflowId,
        compiled,
        input.createdByUserId,
        input.changeNote,
      );

      // 6. Store source spec snapshot
      deps.db.withWriteTransaction((db) => {
        deps.specVersionRepo.create(db, {
          workflowId: input.workflowId,
          workflowVersionId: version.id,
          spec: draft.spec,
          checksum: compiled.checksum,
          createdAt: deps.nowIso(),
        });
      });

      // 7. Publish if requested
      if (input.publishNow) {
        deps.crudService.publishVersion(input.workflowId, version.versionNumber);
      }

      // 8. Mark draft as published
      deps.db.withWriteTransaction((db) => {
        const updated = {
          ...draft,
          status: "published" as const,
          publishedVersionId: version.id,
          updatedAt: deps.nowIso(),
        };
        deps.draftRepo.update(db, updated);
      });

      return {
        workflowId: input.workflowId,
        workflowVersionId: version.id,
        versionNumber: version.versionNumber,
        published: input.publishNow,
        checksum: compiled.checksum,
        validation,
      };
    },
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-draft-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowDraftSaveInput,
  FridayWorkflowDraftStatus,
} from "../model/friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderDraftRepository } from "../persistence/friday-workflow-builder-draft-repository.js";
import type { FridayWorkflowBuilderCollaborationService } from "./friday-workflow-builder-collaboration-service.js";

// ─── Interface ───

export interface FridayWorkflowBuilderDraftService {
  createDraft(input: {
    workflowId: UUID;
    title: string;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
    ownerUserId?: UUID;
    baseWorkflowVersionId?: UUID;
  }): FridayWorkflowDraftEntity;

  getDraft(draftId: UUID): FridayWorkflowDraftEntity | null;
  listDrafts(workflowId: UUID): FridayWorkflowDraftEntity[];

  saveDraft(input: FridayWorkflowDraftSaveInput): FridayWorkflowDraftEntity;

  autosaveDraft(input: {
    draftId: UUID;
    lockToken: string;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
  }): FridayWorkflowDraftEntity | null;

  archiveDraft(draftId: UUID, lockToken: string): void;

  forkDraft(sourceDraftId: UUID, newTitle: string): FridayWorkflowDraftEntity;
}

// ─── Dependencies ───

export interface CreateDraftServiceDeps {
  db: FridaySqliteLayer;
  draftRepo: FridayWorkflowBuilderDraftRepository;
  collaborationService: FridayWorkflowBuilderCollaborationService;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderDraftService(
  deps: CreateDraftServiceDeps,
): FridayWorkflowBuilderDraftService {
  return {
    createDraft(input) {
      const now = deps.nowIso();
      const draft: FridayWorkflowDraftEntity = {
        draftId: deps.idGenerator(),
        workflowId: input.workflowId,
        ownerUserId: input.ownerUserId,
        title: input.title,
        status: "active",
        revision: 1,
        baseWorkflowVersionId: input.baseWorkflowVersionId,
        spec: input.spec,
        visual: input.visual,
        createdAt: now,
        updatedAt: now,
        autosave: { enabled: true, intervalMs: 30000 },
      };

      deps.db.withWriteTransaction((db) => {
        deps.draftRepo.create(db, draft);
      });

      return draft;
    },

    getDraft(draftId) {
      return deps.db.withReadConnection((db) => {
        return deps.draftRepo.getById(db, draftId);
      });
    },

    listDrafts(workflowId) {
      return deps.db.withReadConnection((db) => {
        return deps.draftRepo.listByWorkflow(db, workflowId);
      });
    },

    saveDraft(input) {
      // Look up draft to get workflowId for lock assertion
      const draft = deps.db.withReadConnection((db) =>
        deps.draftRepo.getById(db, input.draftId),
      );
      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      // Assert lock against the workflow
      deps.collaborationService.assertLock(draft.workflowId, input.lockToken);

      return deps.db.withWriteTransaction((db) => {
        const existing = deps.draftRepo.getById(db, input.draftId);
        if (!existing) throw new Error("DRAFT_NOT_FOUND");

        // Optimistic revision check
        if (existing.revision !== input.expectedRevision) {
          throw new Error("DRAFT_VERSION_CONFLICT");
        }

        const now = deps.nowIso();
        const updated: FridayWorkflowDraftEntity = {
          ...existing,
          spec: input.spec ?? existing.spec,
          visual: input.visual ?? existing.visual,
          title: input.title ?? existing.title,
          revision: existing.revision + 1,
          updatedAt: now,
          autosave: input.autosave
            ? { ...existing.autosave, ...input.autosave }
            : existing.autosave,
        };

        deps.draftRepo.update(db, updated);
        return updated;
      });
    },

    autosaveDraft(input) {
      // Assert lock for autosave too
      const draft = deps.db.withReadConnection((db) =>
        deps.draftRepo.getById(db, input.draftId),
      );
      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      deps.collaborationService.assertLock(draft.workflowId, input.lockToken);

      // Skip write if content unchanged
      const newChecksum = deps.computeChecksum(
        JSON.stringify({ spec: input.spec, visual: input.visual }),
      );
      const oldChecksum = deps.computeChecksum(
        JSON.stringify({ spec: draft.spec, visual: draft.visual }),
      );
      if (newChecksum === oldChecksum) return null;

      return deps.db.withWriteTransaction((db) => {
        // Re-fetch inside transaction
        const current = deps.draftRepo.getById(db, input.draftId)!;
        const now = deps.nowIso();
        const updated: FridayWorkflowDraftEntity = {
          ...current,
          spec: input.spec,
          visual: input.visual,
          revision: current.revision + 1,
          updatedAt: now,
          autosave: { ...current.autosave, lastSavedAt: now },
        };

        deps.draftRepo.update(db, updated);
        return updated;
      });
    },

    archiveDraft(draftId, lockToken) {
      const draft = deps.db.withReadConnection((db) =>
        deps.draftRepo.getById(db, draftId),
      );
      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      deps.collaborationService.assertLock(draft.workflowId, lockToken);

      deps.db.withWriteTransaction((db) => {
        deps.draftRepo.updateStatus(db, draftId, "archived", deps.nowIso());
      });
    },

    forkDraft(sourceDraftId, newTitle) {
      const source = deps.db.withReadConnection((db) =>
        deps.draftRepo.getById(db, sourceDraftId),
      );
      if (!source) throw new Error("DRAFT_NOT_FOUND");

      const now = deps.nowIso();
      const forked: FridayWorkflowDraftEntity = {
        ...source,
        draftId: deps.idGenerator(),
        title: newTitle,
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        publishedVersionId: undefined,
        autosave: { enabled: true, intervalMs: 30000 },
      };

      deps.db.withWriteTransaction((db) => {
        deps.draftRepo.create(db, forked);
      });

      return forked;
    },
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-import-export-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type { FridayWorkflowDraftEntity } from "../model/friday-workflow-builder-draft.types.js";
import type {
  FridayWorkflowSpecBundleV1,
  FridayWorkflowImportResult,
} from "../model/friday-workflow-builder-io.types.js";
import type { FridayWorkflowBuilderDraftService } from "./friday-workflow-builder-draft-service.js";
import type { FridayWorkflowBuilderValidationService } from "./friday-workflow-builder-validation-service.js";

// ─── Interface ───

export interface FridayWorkflowBuilderImportExportService {
  exportDraft(draftId: UUID): FridayWorkflowSpecBundleV1;
  exportWorkflowVersion(input: {
    workflowId: UUID;
    versionId: UUID;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
    slug?: string;
    name: string;
    description?: string;
    tags?: string[];
  }): FridayWorkflowSpecBundleV1;
  importBundle(bundle: FridayWorkflowSpecBundleV1, workflowId: UUID, ownerUserId?: UUID): FridayWorkflowImportResult;
}

// ─── Dependencies ───

export interface CreateImportExportServiceDeps {
  db: FridaySqliteLayer;
  draftService: FridayWorkflowBuilderDraftService;
  validationService: FridayWorkflowBuilderValidationService;
  computeChecksum: (content: string) => string;
  nowIso: () => string;
  idGenerator: () => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderImportExportService(
  deps: CreateImportExportServiceDeps,
): FridayWorkflowBuilderImportExportService {
  function computeBundleChecksum(spec: FridayWorkflowSpecV1, visual: FridayWorkflowVisualGraphV1): string {
    return deps.computeChecksum(JSON.stringify({ spec, visual }));
  }

  return {
    exportDraft(draftId) {
      const draft = deps.draftService.getDraft(draftId);
      if (!draft) throw new Error("DRAFT_NOT_FOUND");

      const checksum = computeBundleChecksum(draft.spec, draft.visual);

      return {
        bundleSchemaVersion: "1.0",
        exportedAt: deps.nowIso(),
        source: { type: "draft", id: draft.draftId, workflowId: draft.workflowId },
        workflow: {
          name: draft.spec.name,
          description: draft.spec.description,
        },
        draft: {
          draftId: draft.draftId,
          revision: draft.revision,
          title: draft.title,
        },
        spec: draft.spec,
        visual: draft.visual,
        checksum,
      };
    },

    exportWorkflowVersion(input) {
      const checksum = computeBundleChecksum(input.spec, input.visual);

      return {
        bundleSchemaVersion: "1.0",
        exportedAt: deps.nowIso(),
        source: { type: "workflow_version", id: input.versionId, workflowId: input.workflowId },
        workflow: {
          slug: input.slug,
          name: input.name,
          description: input.description,
          tags: input.tags,
        },
        spec: input.spec,
        visual: input.visual,
        checksum,
      };
    },

    importBundle(bundle, workflowId, ownerUserId) {
      const warnings: string[] = [];

      // Validate bundle schema
      if (bundle.bundleSchemaVersion !== "1.0") {
        throw new Error(`IMPORT_UNSUPPORTED_SCHEMA: expected '1.0', got '${bundle.bundleSchemaVersion}'`);
      }

      // Verify checksum
      const computedChecksum = computeBundleChecksum(bundle.spec, bundle.visual);
      if (computedChecksum !== bundle.checksum) {
        warnings.push("Bundle checksum mismatch — content may have been modified");
      }

      // Clone spec with new workflowId
      const importedSpec: FridayWorkflowSpecV1 = {
        ...(JSON.parse(JSON.stringify(bundle.spec)) as FridayWorkflowSpecV1),
        workflowId,
      };

      const importedVisual: FridayWorkflowVisualGraphV1 = {
        ...(JSON.parse(JSON.stringify(bundle.visual)) as FridayWorkflowVisualGraphV1),
        workflowId,
      };

      // Create draft from imported bundle
      const title = bundle.draft?.title ?? bundle.workflow.name ?? "Imported Workflow";
      const draft = deps.draftService.createDraft({
        workflowId,
        title,
        spec: importedSpec,
        visual: importedVisual,
        ownerUserId,
      });

      // Run validation
      const validation = deps.validationService.validateDraft(draft);
      if (!validation.valid) {
        warnings.push("Imported workflow has validation issues");
      }

      return { draft, validation, warnings };
    },
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-template-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type {
  FridayWorkflowTemplateEntity,
  FridayWorkflowTemplateScope,
} from "../model/friday-workflow-builder-template.types.js";
import type { FridayWorkflowDraftEntity } from "../model/friday-workflow-builder-draft.types.js";
import type { FridayWorkflowBuilderTemplateRepository } from "../persistence/friday-workflow-builder-template-repository.js";
import type { FridayWorkflowBuilderDraftService } from "./friday-workflow-builder-draft-service.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTemplateService {
  listTemplates(scope?: FridayWorkflowTemplateScope, ownerUserId?: UUID): FridayWorkflowTemplateEntity[];
  getTemplate(templateId: string): FridayWorkflowTemplateEntity | null;
  createUserTemplate(input: {
    name: string;
    description?: string;
    tags: string[];
    ownerUserId: UUID;
    spec: FridayWorkflowSpecV1;
    visual: FridayWorkflowVisualGraphV1;
  }): FridayWorkflowTemplateEntity;
  updateUserTemplate(templateId: string, update: {
    name?: string;
    description?: string;
    tags?: string[];
  }): FridayWorkflowTemplateEntity;
  deleteUserTemplate(templateId: string): void;
  instantiateTemplate(templateId: string, workflowId: UUID, title: string, ownerUserId?: UUID): FridayWorkflowDraftEntity;
}

// ─── Dependencies ───

export interface CreateTemplateServiceDeps {
  db: FridaySqliteLayer;
  templateRepo: FridayWorkflowBuilderTemplateRepository;
  draftService: FridayWorkflowBuilderDraftService;
  builtinTemplates: FridayWorkflowTemplateEntity[];
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTemplateService(
  deps: CreateTemplateServiceDeps,
): FridayWorkflowBuilderTemplateService {
  return {
    listTemplates(scope, ownerUserId) {
      const userTemplates = deps.db.withReadConnection((db) =>
        deps.templateRepo.list(db, scope, ownerUserId),
      );

      // Merge with builtins if no scope filter or scope is "global"
      if (!scope || scope === "global") {
        const builtinFiltered = deps.builtinTemplates.filter((bt) => {
          // Don't include if user has one with same name (user overrides)
          return !userTemplates.some((ut) => ut.name === bt.name);
        });
        return [...builtinFiltered, ...userTemplates];
      }

      return userTemplates;
    },

    getTemplate(templateId) {
      // Check builtins first
      const builtin = deps.builtinTemplates.find((t) => t.templateId === templateId);
      if (builtin) return builtin;

      return deps.db.withReadConnection((db) =>
        deps.templateRepo.getById(db, templateId),
      );
    },

    createUserTemplate(input) {
      const now = deps.nowIso();
      const template: FridayWorkflowTemplateEntity = {
        templateId: deps.idGenerator(),
        kind: "user",
        scope: "user",
        ownerUserId: input.ownerUserId,
        name: input.name,
        description: input.description,
        tags: input.tags,
        spec: input.spec,
        visual: input.visual,
        createdAt: now,
        updatedAt: now,
      };

      deps.db.withWriteTransaction((db) => {
        deps.templateRepo.create(db, template);
      });

      return template;
    },

    updateUserTemplate(templateId, update) {
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.templateRepo.getById(db, templateId);
        if (!existing) throw new Error("TEMPLATE_NOT_FOUND");
        if (existing.kind !== "user") throw new Error("TEMPLATE_NOT_USER_OWNED");

        const updated: FridayWorkflowTemplateEntity = {
          ...existing,
          name: update.name ?? existing.name,
          description: update.description ?? existing.description,
          tags: update.tags ?? existing.tags,
          updatedAt: deps.nowIso(),
        };

        deps.templateRepo.update(db, updated);
        return updated;
      });
    },

    deleteUserTemplate(templateId) {
      deps.db.withWriteTransaction((db) => {
        const existing = deps.templateRepo.getById(db, templateId);
        if (!existing) throw new Error("TEMPLATE_NOT_FOUND");
        if (existing.kind !== "user") throw new Error("TEMPLATE_NOT_USER_OWNED");
        deps.templateRepo.delete(db, templateId);
      });
    },

    instantiateTemplate(templateId, workflowId, title, ownerUserId) {
      const template = this.getTemplate(templateId);
      if (!template) throw new Error("TEMPLATE_NOT_FOUND");

      // Clone spec and visual, rebind workflowId
      const spec: FridayWorkflowSpecV1 = {
        ...JSON.parse(JSON.stringify(template.spec)) as FridayWorkflowSpecV1,
        workflowId,
      };

      const visual: FridayWorkflowVisualGraphV1 = {
        ...JSON.parse(JSON.stringify(template.visual)) as FridayWorkflowVisualGraphV1,
        workflowId,
      };

      return deps.draftService.createDraft({
        workflowId,
        title,
        spec,
        visual,
        ownerUserId,
      });
    },
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-test-runner-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
import type { FridayWorkflowSpecV1, FridayWorkflowSpecTestCase } from "../../model/friday-workflow-spec.types.js";
import type {
  FridayWorkflowTestRunResult,
  FridayWorkflowTestCaseResult,
  FridayWorkflowTestAssertionResult,
  FridayWorkflowTestCaseStatus,
} from "../model/friday-workflow-builder-test.types.js";
import type { FridayWorkflowBuilderTestRunRepository } from "../persistence/friday-workflow-builder-test-run-repository.js";

// ─── Interface ───

export interface FridayWorkflowBuilderTestRunnerService {
  runTests(input: {
    spec: FridayWorkflowSpecV1;
    draftId?: string;
    persist?: boolean;
  }): FridayWorkflowTestRunResult;

  runSingleTest(input: {
    spec: FridayWorkflowSpecV1;
    testName: string;
  }): FridayWorkflowTestCaseResult;
}

// ─── Dependencies ───

export interface CreateTestRunnerServiceDeps {
  db: FridaySqliteLayer;
  testRunRepo: FridayWorkflowBuilderTestRunRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Assertion Evaluator ───

function resolveValue(data: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = data;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

function evaluateAssertion(
  data: Record<string, unknown>,
  assertion: { path: string; operator: string; expected: unknown },
): FridayWorkflowTestAssertionResult {
  const actual = resolveValue(data, assertion.path);

  let passed = false;
  switch (assertion.operator) {
    case "==":
      passed = actual === assertion.expected;
      break;
    case "!=":
      passed = actual !== assertion.expected;
      break;
    case ">":
      passed = Number(actual) > Number(assertion.expected);
      break;
    case "<":
      passed = Number(actual) < Number(assertion.expected);
      break;
    case "contains":
      if (typeof actual === "string" && typeof assertion.expected === "string") {
        passed = actual.includes(assertion.expected);
      } else if (Array.isArray(actual)) {
        passed = actual.includes(assertion.expected);
      }
      break;
    case "matches":
      if (typeof actual === "string" && typeof assertion.expected === "string") {
        passed = new RegExp(assertion.expected).test(actual);
      }
      break;
  }

  return {
    path: assertion.path,
    operator: assertion.operator as FridayWorkflowTestAssertionResult["operator"],
    expected: assertion.expected,
    actual,
    passed,
    message: passed ? undefined : `Expected ${assertion.path} ${assertion.operator} ${JSON.stringify(assertion.expected)}, got ${JSON.stringify(actual)}`,
  };
}

// ─── Simulate workflow execution ───

function simulateWorkflow(
  spec: FridayWorkflowSpecV1,
  testCase: FridayWorkflowSpecTestCase,
): Record<string, unknown> {
  const stepOutputs: Record<string, Record<string, unknown>> = {};

  // Build adjacency from edges
  const adjacency = new Map<string, string[]>();
  for (const step of spec.steps) {
    adjacency.set(step.id, []);
  }
  for (const edge of spec.edges) {
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  // BFS from startStepId
  const visited = new Set<string>();
  const queue = [spec.startStepId];

  while (queue.length > 0) {
    const stepId = queue.shift()!;
    if (visited.has(stepId)) continue;
    visited.add(stepId);

    // Get mock or generate no-op output
    if (testCase.mocks && testCase.mocks[stepId]) {
      stepOutputs[stepId] = testCase.mocks[stepId].output;
    } else {
      stepOutputs[stepId] = {};
    }

    // Add successors
    for (const succ of adjacency.get(stepId) ?? []) {
      if (!visited.has(succ)) queue.push(succ);
    }
  }

  // Build result context
  return {
    inputs: testCase.inputs,
    steps: Object.fromEntries(
      Object.entries(stepOutputs).map(([id, output]) => [
        id,
        { output, status: testCase.mocks?.[id]?.status ?? "completed" },
      ]),
    ),
    outputs: Object.fromEntries(
      spec.outputs.map((o) => [o.key, resolveValue(stepOutputs[o.fromStep] ?? {}, o.path)]),
    ),
  };
}

// ─── Factory ───

export function createFridayWorkflowBuilderTestRunnerService(
  deps: CreateTestRunnerServiceDeps,
): FridayWorkflowBuilderTestRunnerService {
  function runOneTest(
    spec: FridayWorkflowSpecV1,
    testCase: FridayWorkflowSpecTestCase,
  ): FridayWorkflowTestCaseResult {
    const startTime = Date.now();

    try {
      const context = simulateWorkflow(spec, testCase);
      const assertionResults = testCase.assertions.map((a) =>
        evaluateAssertion(context as Record<string, unknown>, a),
      );

      const allPassed = assertionResults.every((r) => r.passed);
      const status: FridayWorkflowTestCaseStatus = allPassed ? "passed" : "failed";

      return {
        name: testCase.name,
        status,
        durationMs: Date.now() - startTime,
        assertionResults,
      };
    } catch (err) {
      return {
        name: testCase.name,
        status: "failed",
        durationMs: Date.now() - startTime,
        assertionResults: [],
        error: {
          code: "TEST_EXECUTION_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return {
    runTests(input) {
      const startedAt = deps.nowIso();
      const caseResults = input.spec.tests.map((testCase) =>
        runOneTest(input.spec, testCase),
      );
      const finishedAt = deps.nowIso();
      const passed = caseResults.every((r) => r.status === "passed");

      const result: FridayWorkflowTestRunResult = {
        runId: deps.idGenerator(),
        workflowId: input.spec.workflowId,
        draftId: input.draftId,
        startedAt,
        finishedAt,
        passed,
        caseResults,
      };

      if (input.persist) {
        deps.db.withWriteTransaction((db) => {
          deps.testRunRepo.create(db, result);
        });
      }

      return result;
    },

    runSingleTest(input) {
      const testCase = input.spec.tests.find((t) => t.name === input.testName);
      if (!testCase) throw new Error("TEST_CASE_NOT_FOUND");
      return runOneTest(input.spec, testCase);
    },
  };
}
```

### `src/workflows/builder/services/friday-workflow-builder-validation-service.ts`
```ts
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type { FridayWorkflowDraftEntity } from "../model/friday-workflow-builder-draft.types.js";
import type {
  FridayWorkflowBuilderValidationIssue,
  FridayWorkflowBuilderValidationReport,
  FridayWorkflowValidationStage,
} from "../model/friday-workflow-builder-validation.types.js";
import type { FridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import type { FridayWorkflowValidator } from "../../compiler/friday-workflow-validator.js";

// ─── Interface ───

export interface FridayWorkflowBuilderValidationService {
  validateSpec(spec: FridayWorkflowSpecV1): FridayWorkflowBuilderValidationReport;
  validateDraft(draft: FridayWorkflowDraftEntity): FridayWorkflowBuilderValidationReport;
  validateForPublish(draft: FridayWorkflowDraftEntity): FridayWorkflowBuilderValidationReport;
}

// ─── Dependencies ───

export interface CreateValidationServiceDeps {
  compiler: FridayWorkflowCompiler;
  validator: FridayWorkflowValidator;
  nowIso: () => string;
  idGenerator: () => string;
}

// ─── Spec Schema Validation ───

function validateSpecSchema(spec: FridayWorkflowSpecV1): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  if (spec.schemaVersion !== "1.0") {
    issues.push({
      code: "SPEC_INVALID_SCHEMA_VERSION",
      stage: "spec_schema",
      severity: "error",
      message: `Expected schemaVersion '1.0', got '${spec.schemaVersion}'`,
    });
  }

  if (!spec.workflowId) {
    issues.push({
      code: "SPEC_MISSING_WORKFLOW_ID",
      stage: "spec_schema",
      severity: "error",
      message: "workflowId is required",
    });
  }

  if (!spec.name) {
    issues.push({
      code: "SPEC_MISSING_NAME",
      stage: "spec_schema",
      severity: "error",
      message: "name is required",
    });
  }

  if (!spec.startStepId) {
    issues.push({
      code: "SPEC_MISSING_START_STEP",
      stage: "spec_schema",
      severity: "error",
      message: "startStepId is required",
    });
  }

  if (!spec.steps || spec.steps.length === 0) {
    issues.push({
      code: "SPEC_NO_STEPS",
      stage: "spec_schema",
      severity: "error",
      message: "At least one step is required",
    });
  }

  // Verify startStepId references an existing step
  if (spec.startStepId && spec.steps.length > 0) {
    const stepIds = new Set(spec.steps.map((s) => s.id));
    if (!stepIds.has(spec.startStepId)) {
      issues.push({
        code: "SPEC_START_STEP_NOT_FOUND",
        stage: "spec_schema",
        severity: "error",
        message: `startStepId '${spec.startStepId}' does not reference any step`,
      });
    }

    // Check for duplicate step IDs
    const seen = new Set<string>();
    for (const step of spec.steps) {
      if (seen.has(step.id)) {
        issues.push({
          code: "SPEC_DUPLICATE_STEP_ID",
          stage: "spec_schema",
          severity: "error",
          message: `Duplicate step id '${step.id}'`,
          stepId: step.id,
        });
      }
      seen.add(step.id);
    }

    // Verify edge references
    for (const edge of spec.edges) {
      if (!stepIds.has(edge.from)) {
        issues.push({
          code: "SPEC_EDGE_MISSING_SOURCE",
          stage: "spec_schema",
          severity: "error",
          message: `Edge references missing source step '${edge.from}'`,
          edgeRef: { from: edge.from, to: edge.to, when: edge.when },
        });
      }
      if (!stepIds.has(edge.to)) {
        issues.push({
          code: "SPEC_EDGE_MISSING_TARGET",
          stage: "spec_schema",
          severity: "error",
          message: `Edge references missing target step '${edge.to}'`,
          edgeRef: { from: edge.from, to: edge.to, when: edge.when },
        });
      }
    }

    // Verify output references
    for (const output of spec.outputs) {
      if (!stepIds.has(output.fromStep)) {
        issues.push({
          code: "SPEC_OUTPUT_MISSING_STEP",
          stage: "spec_schema",
          severity: "error",
          message: `Output '${output.key}' references missing step '${output.fromStep}'`,
        });
      }
    }
  }

  // Validate trigger
  if (!spec.trigger || !spec.trigger.type) {
    issues.push({
      code: "SPEC_MISSING_TRIGGER",
      stage: "spec_schema",
      severity: "error",
      message: "trigger is required",
    });
  }

  return issues;
}

// ─── Canvas Validation ───

function validateCanvas(
  spec: FridayWorkflowSpecV1,
  visual: FridayWorkflowVisualGraphV1,
): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  const stepIds = new Set(spec.steps.map((s) => s.id));

  for (const nodeLayout of visual.nodes) {
    if (!stepIds.has(nodeLayout.nodeId) && nodeLayout.nodeId !== "__trigger__") {
      issues.push({
        code: "CANVAS_ORPHAN_NODE",
        stage: "canvas",
        severity: "warning",
        message: `Visual node '${nodeLayout.nodeId}' does not reference a spec step`,
      });
    }
  }

  if (visual.viewport.zoom < 0.1 || visual.viewport.zoom > 10) {
    issues.push({
      code: "CANVAS_INVALID_ZOOM",
      stage: "canvas",
      severity: "warning",
      message: `Viewport zoom ${visual.viewport.zoom} is outside reasonable range [0.1, 10]`,
    });
  }

  return issues;
}

// ─── Test Validation ───

function validateTests(spec: FridayWorkflowSpecV1): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];
  const stepIds = new Set(spec.steps.map((s) => s.id));
  const validOperators = new Set(["==", "!=", ">", "<", "contains", "matches"]);

  for (let i = 0; i < spec.tests.length; i++) {
    const test = spec.tests[i]!;
    if (!test.name) {
      issues.push({
        code: "TEST_MISSING_NAME",
        stage: "tests",
        severity: "error",
        message: `Test at index ${i} is missing a name`,
        jsonPath: `tests[${i}].name`,
      });
    }

    // Validate mock references
    if (test.mocks) {
      for (const stepId of Object.keys(test.mocks)) {
        if (!stepIds.has(stepId)) {
          issues.push({
            code: "TEST_MOCK_UNKNOWN_STEP",
            stage: "tests",
            severity: "warning",
            message: `Test '${test.name}' mocks unknown step '${stepId}'`,
            stepId,
            jsonPath: `tests[${i}].mocks.${stepId}`,
          });
        }
      }
    }

    // Validate assertion operators
    for (let j = 0; j < test.assertions.length; j++) {
      const assertion = test.assertions[j]!;
      if (!validOperators.has(assertion.operator)) {
        issues.push({
          code: "TEST_INVALID_OPERATOR",
          stage: "tests",
          severity: "error",
          message: `Test '${test.name}' assertion ${j} has invalid operator '${assertion.operator}'`,
          jsonPath: `tests[${i}].assertions[${j}].operator`,
        });
      }
    }
  }

  return issues;
}

// ─── Factory ───

export function createFridayWorkflowBuilderValidationService(
  deps: CreateValidationServiceDeps,
): FridayWorkflowBuilderValidationService {
  function runFullValidation(
    spec: FridayWorkflowSpecV1,
    visual?: FridayWorkflowVisualGraphV1,
    forPublish = false,
  ): FridayWorkflowBuilderValidationReport {
    const issues: FridayWorkflowBuilderValidationIssue[] = [];

    // Stage 1: spec_schema
    issues.push(...validateSpecSchema(spec));

    // Stage 6: tests
    issues.push(...validateTests(spec));

    // Stage 7: canvas
    if (visual) {
      issues.push(...validateCanvas(spec, visual));
    }

    // If spec schema has errors, skip compilation
    const hasSchemaErrors = issues.some(
      (i) => i.stage === "spec_schema" && i.severity === "error",
    );

    let compiledPreview = undefined;

    if (!hasSchemaErrors) {
      // Stage 2: graph_compile
      try {
        const compiled = deps.compiler.compile(spec, deps.idGenerator());
        compiledPreview = compiled;

        // Stage 3: compiled_graph (Phase 3 validator)
        const validation = deps.validator.validate(compiled);
        if (!validation.valid) {
          for (const error of validation.errors) {
            issues.push({
              code: error.code,
              stage: "compiled_graph",
              severity: "error",
              message: error.message,
              stepId: error.nodeId,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        issues.push({
          code: "GRAPH_COMPILATION_FAILED",
          stage: "graph_compile",
          severity: "error",
          message,
        });
      }

      // Stage 5: expressions — validate conditions in steps
      for (const step of spec.steps) {
        if (step.condition) {
          try {
            deps.compiler.validateSpec({
              ...spec,
              steps: [{ ...step, id: "validate-expr-only" }],
              edges: [],
              startStepId: "validate-expr-only",
              outputs: [],
              tests: [],
            });
          } catch {
            issues.push({
              code: "EXPRESSION_INVALID",
              stage: "expressions",
              severity: "error",
              message: `Step '${step.id}' has invalid condition expression: '${step.condition}'`,
              stepId: step.id,
            });
          }
        }
      }
    }

    // For publish: enforce no errors
    const hasErrors = issues.some((i) => i.severity === "error");
    if (forPublish && hasErrors) {
      issues.push({
        code: "PUBLISH_BLOCKED_BY_ERRORS",
        stage: "spec_schema",
        severity: "error",
        message: "Cannot publish: validation errors must be resolved first",
      });
    }

    return {
      valid: !issues.some((i) => i.severity === "error"),
      issues,
      compiledGraphPreview: compiledPreview,
      generatedAt: deps.nowIso(),
    };
  }

  return {
    validateSpec(spec) {
      return runFullValidation(spec);
    },

    validateDraft(draft) {
      return runFullValidation(draft.spec, draft.visual);
    },

    validateForPublish(draft) {
      return runFullValidation(draft.spec, draft.visual, true);
    },
  };
}
```

### `src/workflows/builder/templates/friday-workflow-builder-builtin-templates.ts`
```ts
import type { FridayWorkflowTemplateEntity } from "../model/friday-workflow-builder-template.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";

// ─── Helper ───

function makeDefaultVisual(workflowId: string, stepIds: string[]): FridayWorkflowVisualGraphV1 {
  const nodes = [
    { nodeId: "__trigger__", x: 100, y: 100 },
    ...stepIds.map((id, i) => ({ nodeId: id, x: 100 + (i + 1) * 250, y: 100 })),
  ];

  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes,
    edges: [],
  };
}

// ─── Blank Template ───

function createBlankTemplate(): FridayWorkflowTemplateEntity {
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: "template-blank",
    name: "Blank Workflow",
    description: "An empty workflow to start from scratch",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      { id: "step-1", type: "transform", args: {} },
    ],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
  };

  return {
    templateId: "builtin-blank",
    kind: "builtin",
    scope: "global",
    name: "Blank Workflow",
    description: "Start from scratch with an empty workflow",
    tags: ["blank", "starter"],
    spec,
    visual: makeDefaultVisual("template-blank", ["step-1"]),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Simple Action Template ───

function createSimpleActionTemplate(): FridayWorkflowTemplateEntity {
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: "template-simple-action",
    name: "Simple Action",
    description: "A workflow with a single action step",
    startStepId: "action-1",
    trigger: { type: "manual" },
    inputs: [
      { key: "input_data", type: "string", required: true },
    ],
    steps: [
      { id: "action-1", type: "skill_call", ref: "example-skill", args: { data: "$inputs.input_data" } },
    ],
    edges: [],
    outputs: [
      { key: "result", fromStep: "action-1", path: "result" },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: true },
    tests: [
      {
        name: "basic test",
        inputs: { input_data: "test" },
        mocks: { "action-1": { output: { result: "ok" } } },
        assertions: [{ path: "steps.action-1.output.result", operator: "==", expected: "ok" }],
      },
    ],
  };

  return {
    templateId: "builtin-simple-action",
    kind: "builtin",
    scope: "global",
    name: "Simple Action",
    description: "A workflow with a single action step",
    tags: ["simple", "action"],
    spec,
    visual: makeDefaultVisual("template-simple-action", ["action-1"]),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Conditional Branch Template ───

function createConditionalTemplate(): FridayWorkflowTemplateEntity {
  const spec: FridayWorkflowSpecV1 = {
    schemaVersion: "1.0",
    workflowId: "template-conditional",
    name: "Conditional Branch",
    description: "A workflow that branches based on a condition",
    startStepId: "check",
    trigger: { type: "manual" },
    inputs: [
      { key: "value", type: "number", required: true },
    ],
    steps: [
      { id: "check", type: "condition", condition: "$inputs.value > 10" },
      { id: "high-path", type: "transform", args: { label: "high" } },
      { id: "low-path", type: "transform", args: { label: "low" } },
    ],
    edges: [
      { from: "check", to: "high-path", when: "true" },
      { from: "check", to: "low-path", when: "false" },
    ],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [
      {
        name: "high value",
        inputs: { value: 20 },
        mocks: {
          check: { output: { result: true } },
          "high-path": { output: { label: "high" } },
        },
        assertions: [
          { path: "steps.check.output.result", operator: "==", expected: true },
        ],
      },
    ],
  };

  return {
    templateId: "builtin-conditional",
    kind: "builtin",
    scope: "global",
    name: "Conditional Branch",
    description: "Branch workflow logic based on conditions",
    tags: ["conditional", "branching"],
    spec,
    visual: makeDefaultVisual("template-conditional", ["check", "high-path", "low-path"]),
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
  };
}

// ─── Export all built-in templates ───

export function getFridayBuiltinWorkflowTemplates(): FridayWorkflowTemplateEntity[] {
  return [
    createBlankTemplate(),
    createSimpleActionTemplate(),
    createConditionalTemplate(),
  ];
}
```

### `src/workflows/model/friday-workflow-spec.types.ts`
```ts
import type { WorkflowFailurePolicyV2, UUID, ISODateTime } from "./friday-workflow.types.js";

// ─── Spec Trigger ───

export type FridayWorkflowSpecTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "event"; source: string; event: string };

// ─── Spec Input ───

export type FridayWorkflowSpecInputType = "string" | "number" | "boolean" | "object" | "array";

export interface FridayWorkflowSpecInput {
  key: string;
  type: FridayWorkflowSpecInputType;
  required: boolean;
  defaultValue?: unknown;
}

// ─── Spec Step ───

export type FridayWorkflowSpecStepType =
  | "skill_call"
  | "tool_call"
  | "condition"
  | "transform"
  | "human_approval";

export interface FridayWorkflowSpecStep {
  id: string;
  type: FridayWorkflowSpecStepType;
  ref?: string;
  args?: Record<string, unknown>;
  condition?: string;
  timeoutSec?: number;
  retry?: { maxAttempts: number; backoffMs: number };
}

// ─── Spec Edge ───

export type FridayWorkflowSpecEdgeWhen = "success" | "failure" | "true" | "false";

export interface FridayWorkflowSpecEdge {
  from: string;
  to: string;
  when?: FridayWorkflowSpecEdgeWhen;
}

// ─── Spec Output ───

export interface FridayWorkflowSpecOutput {
  key: string;
  fromStep: string;
  path: string;
}

// ─── Spec Test ───

export type FridayWorkflowSpecTestAssertionOperator = "==" | "!=" | ">" | "<" | "contains" | "matches";

export interface FridayWorkflowSpecMockStepResult {
  output: Record<string, unknown>;
  status?: "completed" | "failed";
}

export interface FridayWorkflowSpecTestAssertion {
  path: string;
  operator: FridayWorkflowSpecTestAssertionOperator;
  expected: unknown;
}

export interface FridayWorkflowSpecTestCase {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<string, FridayWorkflowSpecMockStepResult>;
  assertions: FridayWorkflowSpecTestAssertion[];
}

// ─── WorkflowSpecV1 ───

export interface FridayWorkflowSpecV1 {
  schemaVersion: "1.0";
  workflowId: string;
  name: string;
  description: string;
  startStepId: string;
  trigger: FridayWorkflowSpecTrigger;
  inputs: FridayWorkflowSpecInput[];
  steps: FridayWorkflowSpecStep[];
  edges: FridayWorkflowSpecEdge[];
  outputs: FridayWorkflowSpecOutput[];
  errorPolicy: WorkflowFailurePolicyV2;
  tests: FridayWorkflowSpecTestCase[];
}
```

## Test Code

### `test/unit/workflows/builder/_helpers/create-test-spec.ts`
```ts
import type { FridayWorkflowSpecV1 } from "../../../../../src/workflows/model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../../../../../src/workflows/builder/model/friday-workflow-builder-canvas.types.js";

/**
 * Creates a minimal valid FridayWorkflowSpecV1 for testing.
 */
export function createTestSpec(overrides?: Partial<FridayWorkflowSpecV1>): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-test",
    name: "Test Workflow",
    description: "A test workflow",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [],
    steps: [
      { id: "step-1", type: "skill_call", ref: "test-skill" },
    ],
    edges: [],
    outputs: [],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    ...overrides,
  };
}

/**
 * Creates a minimal valid FridayWorkflowVisualGraphV1 for testing.
 */
export function createTestVisual(workflowId = "wf-test"): FridayWorkflowVisualGraphV1 {
  return {
    schemaVersion: "1.0",
    workflowId,
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: [
      { nodeId: "__trigger__", x: 0, y: 0 },
      { nodeId: "step-1", x: 250, y: 0 },
    ],
    edges: [],
  };
}

/**
 * Creates a spec with two steps and an edge for testing.
 */
export function createTestSpecWithEdge(overrides?: Partial<FridayWorkflowSpecV1>): FridayWorkflowSpecV1 {
  return {
    schemaVersion: "1.0",
    workflowId: "wf-test",
    name: "Test Workflow With Edge",
    description: "A test workflow with two steps",
    startStepId: "step-1",
    trigger: { type: "manual" },
    inputs: [
      { key: "data", type: "string", required: true },
    ],
    steps: [
      { id: "step-1", type: "skill_call", ref: "skill-a" },
      { id: "step-2", type: "skill_call", ref: "skill-b" },
    ],
    edges: [
      { from: "step-1", to: "step-2" },
    ],
    outputs: [
      { key: "result", fromStep: "step-2", path: "output" },
    ],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [
      {
        name: "basic test",
        inputs: { data: "hello" },
        mocks: {
          "step-1": { output: { value: "processed" } },
          "step-2": { output: { output: "done" } },
        },
        assertions: [
          { path: "steps.step-2.output.output", operator: "==", expected: "done" },
        ],
      },
    ],
    ...overrides,
  };
}
```

### `test/unit/workflows/builder/friday-workflow-builder-compositor-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderCompositorService } from "../../../../src/workflows/builder/services/friday-workflow-builder-compositor-service.js";
import { createFridayWorkflowBuilderDraftService } from "../../../../src/workflows/builder/services/friday-workflow-builder-draft-service.js";
import { createFridayWorkflowBuilderValidationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-validation-service.js";
import { createFridayWorkflowBuilderCollaborationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-collaboration-service.js";
import { createFridayWorkflowBuilderDraftRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-draft-repository.js";
import { createFridayWorkflowBuilderLockRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-lock-repository.js";
import { createFridayWorkflowBuilderSpecVersionRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-spec-version-repository.js";
import { createFridayWorkflowCompiler } from "../../../../src/workflows/compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../../../src/workflows/compiler/friday-workflow-validator.js";
import { createFridayWorkflowCrudService } from "../../../../src/workflows/services/friday-workflow-crud-service.js";
import { createFridayWorkflowRepository } from "../../../../src/workflows/persistence/friday-workflow-repository.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderCompositorService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createAllServices() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const draftRepo = createFridayWorkflowBuilderDraftRepository();
    const specVersionRepo = createFridayWorkflowBuilderSpecVersionRepository();

    const compiler = createFridayWorkflowCompiler({
      computeChecksum,
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();

    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });

    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo,
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });

    const validationService = createFridayWorkflowBuilderValidationService({
      compiler,
      validator,
      nowIso: () => NOW,
      idGenerator: idGen,
    });

    const workflowRepo = createFridayWorkflowRepository({ db });
    const crudService = createFridayWorkflowCrudService({
      db,
      workflowRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
      computeEtag: () => idGen().slice(0, 16),
    });

    const compositorService = createFridayWorkflowBuilderCompositorService({
      db,
      compiler,
      crudService,
      draftService,
      draftRepo,
      validationService,
      collaborationService,
      specVersionRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });

    return {
      draftService,
      collaborationService,
      compositorService,
      crudService,
      specVersionRepo,
    };
  }

  it("compiles a valid draft", () => {
    const { draftService, compositorService } = createAllServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Test Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const result = compositorService.compileDraft(draft.draftId);

    expect(result.compiled).toBeDefined();
    expect(result.compiled.schemaVersion).toBe("2.0");
    expect(result.validation.valid).toBe(true);
  });

  it("throws when compiling nonexistent draft", () => {
    const { compositorService } = createAllServices();
    expect(() => compositorService.compileDraft("nonexistent")).toThrow("DRAFT_NOT_FOUND");
  });

  it("publish blocks when validation fails", () => {
    const { draftService, collaborationService, compositorService } = createAllServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Invalid Draft",
      spec: createTestSpec({ workflowId: "wf-1", name: "" }), // invalid
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: "wf-1",
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
    });

    expect(result.published).toBe(false);
    expect(result.validation.valid).toBe(false);
    expect(result.workflowVersionId).toBe("");
  });

  it("publishes a valid draft and creates a version", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
    } = createAllServices();

    // Create a workflow first
    const workflow = crudService.createWorkflow({
      slug: "my-wf",
      name: "My Workflow",
    });

    const draft = draftService.createDraft({
      workflowId: workflow.id,
      title: "Publish Draft",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
      createdByUserId: "test-user",
      changeNote: "Initial publish",
    });

    expect(result.published).toBe(true);
    expect(result.workflowVersionId).toBeTruthy();
    expect(result.versionNumber).toBeGreaterThan(0);
    expect(result.checksum).toBeTruthy();
    expect(result.validation.valid).toBe(true);

    // Verify the version exists
    const version = crudService.getVersion(result.workflowVersionId);
    expect(version).not.toBeNull();
    expect(version!.isPublished).toBe(true);
  });

  it("creates version without publishing when publishNow is false", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
    } = createAllServices();

    const workflow = crudService.createWorkflow({
      slug: "my-wf",
      name: "My Workflow",
    });

    const draft = draftService.createDraft({
      workflowId: workflow.id,
      title: "Draft Only",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: false,
    });

    expect(result.published).toBe(false);
    expect(result.workflowVersionId).toBeTruthy();

    const version = crudService.getVersion(result.workflowVersionId);
    expect(version).not.toBeNull();
    expect(version!.isPublished).toBe(false);
  });

  it("stores source spec snapshot on publish", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
      specVersionRepo,
    } = createAllServices();

    const workflow = crudService.createWorkflow({
      slug: "my-wf",
      name: "My Workflow",
    });

    const draft = draftService.createDraft({
      workflowId: workflow.id,
      title: "Spec Snapshot Test",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = compositorService.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
    });

    const specVersion = db.withReadConnection((readerDb) =>
      specVersionRepo.getByVersionId(readerDb, result.workflowVersionId),
    );

    expect(specVersion).not.toBeNull();
    expect(specVersion!.workflowId).toBe(workflow.id);
    expect(specVersion!.spec.schemaVersion).toBe("1.0");
  });

  it("publish requires a lock", () => {
    const { draftService, compositorService } = createAllServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "No Lock",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    expect(() =>
      compositorService.publishDraft({
        draftId: draft.draftId,
        workflowId: "wf-1",
        lockToken: "bad-token",
        publishNow: true,
      }),
    ).toThrow();
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-draft-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderDraftRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-draft-repository.js";
import type { FridayWorkflowDraftEntity } from "../../../../src/workflows/builder/model/friday-workflow-builder-draft.types.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderDraftRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeDraft(overrides?: Partial<FridayWorkflowDraftEntity>): FridayWorkflowDraftEntity {
    return {
      draftId: "draft-1",
      workflowId: "wf-1",
      ownerUserId: "test-user",
      title: "My Draft",
      status: "active",
      revision: 1,
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      createdAt: NOW,
      updatedAt: NOW,
      autosave: { enabled: true, intervalMs: 30000 },
      ...overrides,
    };
  }

  it("creates and retrieves a draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched).not.toBeNull();
    expect(fetched!.draftId).toBe("draft-1");
    expect(fetched!.title).toBe("My Draft");
    expect(fetched!.status).toBe("active");
    expect(fetched!.revision).toBe(1);
  });

  it("returns null for missing draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "nonexistent"));
    expect(fetched).toBeNull();
  });

  it("lists drafts by workflow", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeDraft({ draftId: "draft-1", workflowId: "wf-1" }));
      repo.create(writerDb, makeDraft({ draftId: "draft-2", workflowId: "wf-1" }));
      repo.create(writerDb, makeDraft({ draftId: "draft-3", workflowId: "wf-2" }));
    });

    const wf1Drafts = db.withReadConnection((readerDb) => repo.listByWorkflow(readerDb, "wf-1"));
    expect(wf1Drafts).toHaveLength(2);

    const wf2Drafts = db.withReadConnection((readerDb) => repo.listByWorkflow(readerDb, "wf-2"));
    expect(wf2Drafts).toHaveLength(1);
  });

  it("lists drafts by status", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeDraft({ draftId: "draft-1", status: "active" }));
      repo.create(writerDb, makeDraft({ draftId: "draft-2", workflowId: "wf-2", status: "archived" }));
    });

    const activeDrafts = db.withReadConnection((readerDb) => repo.listByStatus(readerDb, "active"));
    expect(activeDrafts).toHaveLength(1);
    expect(activeDrafts[0]!.draftId).toBe("draft-1");
  });

  it("updates a draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const updated = { ...draft, title: "Updated Title", revision: 2, updatedAt: "2025-06-15T11:00:00.000Z" };
    db.withWriteTransaction((writerDb) => {
      repo.update(writerDb, updated);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched!.title).toBe("Updated Title");
    expect(fetched!.revision).toBe(2);
  });

  it("throws on update of missing draft", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft({ draftId: "nonexistent" });

    expect(() =>
      db.withWriteTransaction((writerDb) => repo.update(writerDb, draft)),
    ).toThrow("DRAFT_NOT_FOUND");
  });

  it("updates draft status", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
      repo.updateStatus(writerDb, "draft-1", "archived", "2025-06-15T12:00:00.000Z");
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched!.status).toBe("archived");
  });

  it("stores namespace and key correctly", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    // Verify raw row
    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT namespace, key FROM memory_items WHERE id = ?")
        .get("draft-1"),
    ) as { namespace: string; key: string };

    expect(row.namespace).toBe("workflow_builder_drafts");
    expect(row.key).toBe("wf-1:draft-1");
  });

  it("round-trips JSON correctly", () => {
    const repo = createFridayWorkflowBuilderDraftRepository();
    const draft = makeDraft();
    draft.spec.inputs = [{ key: "test_input", type: "string", required: true }];

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, draft);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "draft-1"));
    expect(fetched!.spec.inputs).toHaveLength(1);
    expect(fetched!.spec.inputs[0]!.key).toBe("test_input");
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-draft-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderDraftService } from "../../../../src/workflows/builder/services/friday-workflow-builder-draft-service.js";
import { createFridayWorkflowBuilderDraftRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-draft-repository.js";
import { createFridayWorkflowBuilderLockRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-lock-repository.js";
import { createFridayWorkflowBuilderCollaborationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-collaboration-service.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderDraftService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createServices() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });

    return { draftService, collaborationService };
  }

  it("creates a draft", () => {
    const { draftService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    expect(draft.title).toBe("My Draft");
    expect(draft.status).toBe("active");
    expect(draft.revision).toBe(1);
    expect(draft.autosave.enabled).toBe(true);
  });

  it("gets a draft by id", () => {
    const { draftService } = createServices();
    const created = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const fetched = draftService.getDraft(created.draftId);
    expect(fetched).not.toBeNull();
    expect(fetched!.draftId).toBe(created.draftId);
  });

  it("lists drafts by workflow", () => {
    const { draftService } = createServices();
    draftService.createDraft({
      workflowId: "wf-1",
      title: "Draft 1",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });
    draftService.createDraft({
      workflowId: "wf-1",
      title: "Draft 2",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const drafts = draftService.listDrafts("wf-1");
    expect(drafts).toHaveLength(2);
  });

  it("save requires lock", () => {
    const { draftService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    expect(() =>
      draftService.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 1,
        lockToken: "bad-token",
        title: "Updated",
      }),
    ).toThrow();
  });

  it("saves draft with valid lock and revision", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const saved = draftService.saveDraft({
      draftId: draft.draftId,
      expectedRevision: 1,
      lockToken: lockResult.lock!.lockToken,
      title: "Updated Title",
    });

    expect(saved.title).toBe("Updated Title");
    expect(saved.revision).toBe(2);
  });

  it("save throws on revision conflict", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    expect(() =>
      draftService.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 99, // wrong revision
        lockToken: lockResult.lock!.lockToken,
        title: "Updated",
      }),
    ).toThrow("DRAFT_VERSION_CONFLICT");
  });

  it("autosave skips when content unchanged", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const result = draftService.autosaveDraft({
      draftId: draft.draftId,
      lockToken: lockResult.lock!.lockToken,
      spec: draft.spec,
      visual: draft.visual,
    });

    expect(result).toBeNull(); // no-op
  });

  it("autosave saves when content changed", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    const modifiedSpec = { ...draft.spec, name: "Modified Name" };
    const result = draftService.autosaveDraft({
      draftId: draft.draftId,
      lockToken: lockResult.lock!.lockToken,
      spec: modifiedSpec,
      visual: draft.visual,
    });

    expect(result).not.toBeNull();
    expect(result!.spec.name).toBe("Modified Name");
    expect(result!.autosave.lastSavedAt).toBe(NOW);
  });

  it("archives a draft", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "To Archive",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    draftService.archiveDraft(draft.draftId, lockResult.lock!.lockToken);

    const fetched = draftService.getDraft(draft.draftId);
    expect(fetched!.status).toBe("archived");
  });

  it("forks a draft", () => {
    const { draftService } = createServices();
    const original = draftService.createDraft({
      workflowId: "wf-1",
      title: "Original",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const forked = draftService.forkDraft(original.draftId, "Forked Draft");

    expect(forked.draftId).not.toBe(original.draftId);
    expect(forked.title).toBe("Forked Draft");
    expect(forked.workflowId).toBe("wf-1");
    expect(forked.revision).toBe(1);
    expect(forked.status).toBe("active");
    expect(forked.spec.name).toBe(original.spec.name);
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-import-export-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderImportExportService } from "../../../../src/workflows/builder/services/friday-workflow-builder-import-export-service.js";
import { createFridayWorkflowBuilderDraftService } from "../../../../src/workflows/builder/services/friday-workflow-builder-draft-service.js";
import { createFridayWorkflowBuilderValidationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-validation-service.js";
import { createFridayWorkflowBuilderDraftRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-draft-repository.js";
import { createFridayWorkflowBuilderLockRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-lock-repository.js";
import { createFridayWorkflowBuilderCollaborationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-collaboration-service.js";
import { createFridayWorkflowCompiler } from "../../../../src/workflows/compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../../../src/workflows/compiler/friday-workflow-validator.js";
import type { FridayWorkflowSpecBundleV1 } from "../../../../src/workflows/builder/model/friday-workflow-builder-io.types.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderImportExportService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createServices() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
    });
    const compiler = createFridayWorkflowCompiler({
      computeChecksum,
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();
    const validationService = createFridayWorkflowBuilderValidationService({
      compiler,
      validator,
      nowIso: () => NOW,
      idGenerator: idGen,
    });
    const importExportService = createFridayWorkflowBuilderImportExportService({
      db,
      draftService,
      validationService,
      computeChecksum,
      nowIso: () => NOW,
      idGenerator: idGen,
    });

    return { draftService, importExportService };
  }

  it("exports a draft as a bundle", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Export Test",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const bundle = importExportService.exportDraft(draft.draftId);

    expect(bundle.bundleSchemaVersion).toBe("1.0");
    expect(bundle.source.type).toBe("draft");
    expect(bundle.source.workflowId).toBe("wf-1");
    expect(bundle.spec.workflowId).toBe("wf-1");
    expect(bundle.checksum).toBeTruthy();
    expect(bundle.draft).toBeDefined();
    expect(bundle.draft!.draftId).toBe(draft.draftId);
  });

  it("export checksum is deterministic", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Checksum Test",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });

    const bundle1 = importExportService.exportDraft(draft.draftId);
    const bundle2 = importExportService.exportDraft(draft.draftId);

    expect(bundle1.checksum).toBe(bundle2.checksum);
  });

  it("exports a workflow version as a bundle", () => {
    const { importExportService } = createServices();

    const bundle = importExportService.exportWorkflowVersion({
      workflowId: "wf-1",
      versionId: "wv-1",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      slug: "my-wf",
      name: "My Workflow",
      description: "A workflow",
      tags: ["test"],
    });

    expect(bundle.source.type).toBe("workflow_version");
    expect(bundle.workflow.slug).toBe("my-wf");
  });

  it("imports a valid bundle", () => {
    const { draftService, importExportService } = createServices();

    // Create and export
    const draft = draftService.createDraft({
      workflowId: "wf-original",
      title: "Original",
      spec: createTestSpec({ workflowId: "wf-original" }),
      visual: createTestVisual("wf-original"),
    });
    const bundle = importExportService.exportDraft(draft.draftId);

    // Import into different workflow
    const result = importExportService.importBundle(bundle, "wf-imported", "test-user");

    expect(result.draft.workflowId).toBe("wf-imported");
    expect(result.draft.spec.workflowId).toBe("wf-imported");
    expect(result.draft.visual.workflowId).toBe("wf-imported");
    expect(result.draft.status).toBe("active");
    expect(result.warnings.length).toBe(0);
  });

  it("rejects bundle with bad schema version", () => {
    const { importExportService } = createServices();

    const bundle = {
      bundleSchemaVersion: "99.0",
      exportedAt: NOW,
      source: { type: "draft" as const, id: "d1", workflowId: "wf-1" },
      workflow: { name: "Test" },
      spec: createTestSpec(),
      visual: createTestVisual(),
      checksum: "abc",
    } as unknown as FridayWorkflowSpecBundleV1;

    expect(() =>
      importExportService.importBundle(bundle, "wf-new"),
    ).toThrow("IMPORT_UNSUPPORTED_SCHEMA");
  });

  it("warns on checksum mismatch", () => {
    const { draftService, importExportService } = createServices();

    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "Tampered",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
    });
    const bundle = importExportService.exportDraft(draft.draftId);

    // Tamper with the bundle
    bundle.checksum = "tampered-checksum";

    const result = importExportService.importBundle(bundle, "wf-new");
    expect(result.warnings.some((w) => w.includes("checksum mismatch"))).toBe(true);
  });

  it("throws on export of nonexistent draft", () => {
    const { importExportService } = createServices();
    expect(() => importExportService.exportDraft("nonexistent")).toThrow("DRAFT_NOT_FOUND");
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-lock-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderLockRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-lock-repository.js";
import type { FridayWorkflowEditLock } from "../../../../src/workflows/builder/model/friday-workflow-builder-collaboration.types.js";
import { createTestDb } from "../_helpers/create-test-db.js";

describe("FridayWorkflowBuilderLockRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeLock(overrides?: Partial<FridayWorkflowEditLock>): FridayWorkflowEditLock {
    return {
      workflowId: "wf-1",
      lockToken: "lock-token-1",
      ownerUserId: "test-user",
      acquiredAt: "2025-06-15T10:00:00.000Z",
      heartbeatAt: "2025-06-15T10:00:00.000Z",
      expiresAt: "2025-06-15T10:30:00.000Z",
      ...overrides,
    };
  }

  it("sets and gets a lock", () => {
    const repo = createFridayWorkflowBuilderLockRepository();
    const lock = makeLock();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, lock);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "wf-1"));
    expect(fetched).not.toBeNull();
    expect(fetched!.lockToken).toBe("lock-token-1");
    expect(fetched!.ownerUserId).toBe("test-user");
  });

  it("returns null for no lock", () => {
    const repo = createFridayWorkflowBuilderLockRepository();
    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "nonexistent"));
    expect(fetched).toBeNull();
  });

  it("updates an existing lock (upsert)", () => {
    const repo = createFridayWorkflowBuilderLockRepository();
    const lock1 = makeLock();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, lock1);
    });

    const lock2 = makeLock({
      lockToken: "lock-token-2",
      ownerUserId: "user-2",
      heartbeatAt: "2025-06-15T10:15:00.000Z",
    });

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, lock2);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "wf-1"));
    expect(fetched!.lockToken).toBe("lock-token-2");
    expect(fetched!.ownerUserId).toBe("user-2");
  });

  it("deletes a lock", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    db.withWriteTransaction((writerDb) => {
      repo.deleteLock(writerDb, "wf-1");
    });

    const fetched = db.withReadConnection((readerDb) => repo.getLock(readerDb, "wf-1"));
    expect(fetched).toBeNull();
  });

  it("stores lock in hub_settings with correct key", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT key, revision FROM hub_settings WHERE key = ?")
        .get("workflow_builder_lock:wf-1"),
    ) as { key: string; revision: number } | undefined;

    expect(row).not.toBeUndefined();
    expect(row!.key).toBe("workflow_builder_lock:wf-1");
    expect(row!.revision).toBe(1);
  });

  it("increments revision on update", () => {
    const repo = createFridayWorkflowBuilderLockRepository();

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock());
    });

    db.withWriteTransaction((writerDb) => {
      repo.setLock(writerDb, makeLock({ lockToken: "renewed" }));
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT revision FROM hub_settings WHERE key = ?")
        .get("workflow_builder_lock:wf-1"),
    ) as { revision: number };

    expect(row.revision).toBe(2);
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-runtime.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderRuntime } from "../../../../src/workflows/builder/runtime/friday-workflow-builder-runtime.js";
import { createFridayWorkflowCrudService } from "../../../../src/workflows/services/friday-workflow-crud-service.js";
import { createFridayWorkflowRepository } from "../../../../src/workflows/persistence/friday-workflow-repository.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderRuntime", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";
  const computeChecksum = (content: string) =>
    createHash("sha256").update(content).digest("hex");

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRuntime() {
    const idGen = createTestIdGenerator();
    const workflowRepo = createFridayWorkflowRepository({ db });
    const crudService = createFridayWorkflowCrudService({
      db,
      workflowRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum,
      computeEtag: () => idGen().slice(0, 16),
    });

    return {
      runtime: createFridayWorkflowBuilderRuntime({
        db,
        crudService,
        idGenerator: idGen,
        nowIso: () => NOW,
        computeChecksum,
      }),
      crudService,
    };
  }

  it("exposes all expected services", () => {
    const { runtime } = createRuntime();

    expect(runtime.drafts).toBeDefined();
    expect(runtime.templates).toBeDefined();
    expect(runtime.validation).toBeDefined();
    expect(runtime.testRunner).toBeDefined();
    expect(runtime.collaboration).toBeDefined();
    expect(runtime.importExport).toBeDefined();
    expect(runtime.compositor).toBeDefined();
  });

  it("services are functional and wired correctly", () => {
    const { runtime } = createRuntime();

    // Create a draft via runtime
    const draft = runtime.drafts.createDraft({
      workflowId: "wf-rt",
      title: "Runtime Test",
      spec: createTestSpec({ workflowId: "wf-rt" }),
      visual: createTestVisual("wf-rt"),
    });

    expect(draft.draftId).toBeTruthy();

    // Validate it
    const report = runtime.validation.validateDraft(draft);
    expect(report.valid).toBe(true);

    // List templates
    const templates = runtime.templates.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
  });

  it("full lifecycle: draft → lock → save → validate → compile → publish", () => {
    const { runtime, crudService } = createRuntime();

    // 1. Create workflow
    const workflow = crudService.createWorkflow({
      slug: "lifecycle-wf",
      name: "Lifecycle Workflow",
    });

    // 2. Create draft
    const draft = runtime.drafts.createDraft({
      workflowId: workflow.id,
      title: "Lifecycle Draft",
      spec: createTestSpec({ workflowId: workflow.id }),
      visual: createTestVisual(workflow.id),
      ownerUserId: "test-user",
    });

    // 3. Acquire lock
    const lockResult = runtime.collaboration.acquireLock({
      workflowId: workflow.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });
    expect(lockResult.acquired).toBe(true);

    // 4. Save draft
    const saved = runtime.drafts.saveDraft({
      draftId: draft.draftId,
      expectedRevision: 1,
      lockToken: lockResult.lock!.lockToken,
      title: "Updated Title",
    });
    expect(saved.revision).toBe(2);

    // 5. Validate
    const report = runtime.validation.validateDraft(saved);
    expect(report.valid).toBe(true);

    // 6. Compile
    const compiled = runtime.compositor.compileDraft(draft.draftId);
    expect(compiled.compiled.schemaVersion).toBe("2.0");

    // 7. Publish
    const published = runtime.compositor.publishDraft({
      draftId: draft.draftId,
      workflowId: workflow.id,
      lockToken: lockResult.lock!.lockToken,
      publishNow: true,
    });
    expect(published.published).toBe(true);

    // 8. Release lock
    runtime.collaboration.releaseLock(workflow.id, lockResult.lock!.lockToken);
    const lock = runtime.collaboration.getLock(workflow.id);
    expect(lock).toBeNull();
  });

  it("template instantiation creates a functional draft", () => {
    const { runtime } = createRuntime();

    const draft = runtime.templates.instantiateTemplate(
      "builtin-simple-action",
      "wf-from-template",
      "From Template",
    );

    // Should be a valid draft
    const report = runtime.validation.validateDraft(draft);
    expect(report.valid).toBe(true);

    // Draft should be fetchable
    const fetched = runtime.drafts.getDraft(draft.draftId);
    expect(fetched).not.toBeNull();
  });

  it("import/export roundtrip works", () => {
    const { runtime } = createRuntime();

    // Create and export
    const original = runtime.drafts.createDraft({
      workflowId: "wf-export",
      title: "Export Me",
      spec: createTestSpec({ workflowId: "wf-export" }),
      visual: createTestVisual("wf-export"),
    });
    const bundle = runtime.importExport.exportDraft(original.draftId);

    // Import into new workflow
    const importResult = runtime.importExport.importBundle(bundle, "wf-imported");
    expect(importResult.draft.workflowId).toBe("wf-imported");

    // Validate imported draft
    const report = runtime.validation.validateDraft(importResult.draft);
    expect(report.valid).toBe(true);
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-template-repository.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderTemplateRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-template-repository.js";
import type { FridayWorkflowTemplateEntity } from "../../../../src/workflows/builder/model/friday-workflow-builder-template.types.js";
import { createTestDb } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderTemplateRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function makeTemplate(overrides?: Partial<FridayWorkflowTemplateEntity>): FridayWorkflowTemplateEntity {
    return {
      templateId: "tmpl-1",
      kind: "user",
      scope: "user",
      ownerUserId: "test-user",
      name: "My Template",
      description: "A test template",
      tags: ["test"],
      spec: createTestSpec(),
      visual: createTestVisual(),
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("creates and retrieves a template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const template = makeTemplate();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, template);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("My Template");
    expect(fetched!.kind).toBe("user");
  });

  it("returns null for missing template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "nonexistent"));
    expect(fetched).toBeNull();
  });

  it("lists templates by scope", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeTemplate({ templateId: "tmpl-1", scope: "user", ownerUserId: "test-user" }));
      repo.create(writerDb, makeTemplate({ templateId: "tmpl-2", scope: "global", ownerUserId: undefined }));
    });

    const userTemplates = db.withReadConnection((readerDb) => repo.list(readerDb, "user"));
    expect(userTemplates).toHaveLength(1);

    const globalTemplates = db.withReadConnection((readerDb) => repo.list(readerDb, "global"));
    expect(globalTemplates).toHaveLength(1);

    const allTemplates = db.withReadConnection((readerDb) => repo.list(readerDb));
    expect(allTemplates).toHaveLength(2);
  });

  it("updates a template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const template = makeTemplate();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, template);
    });

    const updated = { ...template, name: "Updated Name", updatedAt: "2025-06-15T11:00:00.000Z" };
    db.withWriteTransaction((writerDb) => {
      repo.update(writerDb, updated);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched!.name).toBe("Updated Name");
  });

  it("deletes a template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeTemplate());
    });

    db.withWriteTransaction((writerDb) => {
      repo.delete(writerDb, "tmpl-1");
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched).toBeNull();
  });

  it("throws on delete of missing template", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    expect(() =>
      db.withWriteTransaction((writerDb) => repo.delete(writerDb, "nonexistent")),
    ).toThrow("TEMPLATE_NOT_FOUND");
  });

  it("stores correct key format", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, makeTemplate());
    });

    const row = db.withReadConnection((readerDb) =>
      readerDb
        .prepare("SELECT namespace, key FROM memory_items WHERE id = ?")
        .get("tmpl-1"),
    ) as { namespace: string; key: string };

    expect(row.namespace).toBe("workflow_builder_templates");
    expect(row.key).toBe("user:test-user:tmpl-1");
  });

  it("round-trips JSON correctly", () => {
    const repo = createFridayWorkflowBuilderTemplateRepository();
    const template = makeTemplate();
    template.tags = ["tag1", "tag2", "tag3"];

    db.withWriteTransaction((writerDb) => {
      repo.create(writerDb, template);
    });

    const fetched = db.withReadConnection((readerDb) => repo.getById(readerDb, "tmpl-1"));
    expect(fetched!.tags).toEqual(["tag1", "tag2", "tag3"]);
    expect(fetched!.spec.schemaVersion).toBe("1.0");
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-template-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderTemplateRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-template-repository.js";
import { createFridayWorkflowBuilderDraftRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-draft-repository.js";
import { createFridayWorkflowBuilderLockRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-lock-repository.js";
import { createFridayWorkflowBuilderTemplateService } from "../../../../src/workflows/builder/services/friday-workflow-builder-template-service.js";
import { createFridayWorkflowBuilderDraftService } from "../../../../src/workflows/builder/services/friday-workflow-builder-draft-service.js";
import { createFridayWorkflowBuilderCollaborationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-collaboration-service.js";
import { getFridayBuiltinWorkflowTemplates } from "../../../../src/workflows/builder/templates/friday-workflow-builder-builtin-templates.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestVisual } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderTemplateService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const collaborationService = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
    const draftService = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService,
      idGenerator: idGen,
      nowIso: () => NOW,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    return createFridayWorkflowBuilderTemplateService({
      db,
      templateRepo: createFridayWorkflowBuilderTemplateRepository(),
      draftService,
      builtinTemplates: getFridayBuiltinWorkflowTemplates(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  }

  it("lists builtin templates", () => {
    const service = createService();
    const templates = service.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(templates.some((t) => t.kind === "builtin")).toBe(true);
  });

  it("gets a builtin template by id", () => {
    const service = createService();
    const template = service.getTemplate("builtin-blank");
    expect(template).not.toBeNull();
    expect(template!.name).toBe("Blank Workflow");
  });

  it("creates a user template", () => {
    const service = createService();
    const template = service.createUserTemplate({
      name: "My Custom Template",
      tags: ["custom"],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    expect(template.kind).toBe("user");
    expect(template.scope).toBe("user");
    expect(template.name).toBe("My Custom Template");
  });

  it("user templates appear in list with builtins", () => {
    const service = createService();
    service.createUserTemplate({
      name: "Custom",
      tags: [],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const all = service.listTemplates();
    expect(all.some((t) => t.name === "Custom")).toBe(true);
    expect(all.some((t) => t.kind === "builtin")).toBe(true);
  });

  it("user template with same name overrides builtin", () => {
    const service = createService();
    service.createUserTemplate({
      name: "Blank Workflow",
      tags: [],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const templates = service.listTemplates();
    const blanks = templates.filter((t) => t.name === "Blank Workflow");
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.kind).toBe("user");
  });

  it("updates a user template", () => {
    const service = createService();
    const created = service.createUserTemplate({
      name: "Original",
      tags: ["v1"],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const updated = service.updateUserTemplate(created.templateId, {
      name: "Updated",
      tags: ["v2"],
    });

    expect(updated.name).toBe("Updated");
    expect(updated.tags).toEqual(["v2"]);
  });

  it("cannot update builtin template", () => {
    const service = createService();
    expect(() =>
      service.updateUserTemplate("builtin-blank", { name: "Hacked" }),
    ).toThrow();
  });

  it("deletes a user template", () => {
    const service = createService();
    const created = service.createUserTemplate({
      name: "Temporary",
      tags: [],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    service.deleteUserTemplate(created.templateId);

    const fetched = service.getTemplate(created.templateId);
    expect(fetched).toBeNull();
  });

  it("instantiates a template into a draft", () => {
    const service = createService();
    const draft = service.instantiateTemplate(
      "builtin-simple-action",
      "wf-new",
      "My New Workflow",
      "test-user",
    );

    expect(draft.workflowId).toBe("wf-new");
    expect(draft.title).toBe("My New Workflow");
    expect(draft.spec.workflowId).toBe("wf-new");
    expect(draft.visual.workflowId).toBe("wf-new");
    expect(draft.status).toBe("active");
  });

  it("throws when instantiating nonexistent template", () => {
    const service = createService();
    expect(() =>
      service.instantiateTemplate("nonexistent", "wf-1", "Title"),
    ).toThrow("TEMPLATE_NOT_FOUND");
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-test-runner-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderTestRunnerService } from "../../../../src/workflows/builder/services/friday-workflow-builder-test-runner-service.js";
import { createFridayWorkflowBuilderTestRunRepository } from "../../../../src/workflows/builder/persistence/friday-workflow-builder-test-run-repository.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";
import { createTestSpec, createTestSpecWithEdge } from "./_helpers/create-test-spec.js";

describe("FridayWorkflowBuilderTestRunnerService", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createService() {
    const idGen = createTestIdGenerator();
    return createFridayWorkflowBuilderTestRunnerService({
      db,
      testRunRepo: createFridayWorkflowBuilderTestRunRepository(),
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  }

  it("runs all tests and returns results", () => {
    const service = createService();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
    expect(result.caseResults).toHaveLength(1);
    expect(result.caseResults[0]!.status).toBe("passed");
  });

  it("reports failed assertion", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "failing test",
          inputs: {},
          mocks: { "step-1": { output: { value: "wrong" } } },
          assertions: [
            { path: "steps.step-1.output.value", operator: "==", expected: "correct" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(false);
    expect(result.caseResults[0]!.status).toBe("failed");
    expect(result.caseResults[0]!.assertionResults[0]!.passed).toBe(false);
    expect(result.caseResults[0]!.assertionResults[0]!.actual).toBe("wrong");
    expect(result.caseResults[0]!.assertionResults[0]!.expected).toBe("correct");
  });

  it("handles != operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "not equal test",
          inputs: {},
          mocks: { "step-1": { output: { value: "a" } } },
          assertions: [
            { path: "steps.step-1.output.value", operator: "!=", expected: "b" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles > operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "greater than test",
          inputs: {},
          mocks: { "step-1": { output: { count: 10 } } },
          assertions: [
            { path: "steps.step-1.output.count", operator: ">", expected: 5 },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles < operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "less than test",
          inputs: {},
          mocks: { "step-1": { output: { count: 3 } } },
          assertions: [
            { path: "steps.step-1.output.count", operator: "<", expected: 5 },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles contains operator for strings", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "contains test",
          inputs: {},
          mocks: { "step-1": { output: { message: "hello world" } } },
          assertions: [
            { path: "steps.step-1.output.message", operator: "contains", expected: "world" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("handles matches operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "matches test",
          inputs: {},
          mocks: { "step-1": { output: { code: "ERR-123" } } },
          assertions: [
            { path: "steps.step-1.output.code", operator: "matches", expected: "^ERR-\\d+$" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("unmocked steps return empty output", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "unmocked test",
          inputs: {},
          assertions: [
            { path: "steps.step-1.status", operator: "==", expected: "completed" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("persists test results when requested", () => {
    const service = createService();
    const testRunRepo = createFridayWorkflowBuilderTestRunRepository();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec, draftId: "draft-1", persist: true });

    const stored = db.withReadConnection((readerDb) =>
      testRunRepo.getById(readerDb, result.runId),
    );
    expect(stored).not.toBeNull();
    expect(stored!.passed).toBe(result.passed);
  });

  it("does not persist when not requested", () => {
    const service = createService();
    const testRunRepo = createFridayWorkflowBuilderTestRunRepository();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec });

    const stored = db.withReadConnection((readerDb) =>
      testRunRepo.getById(readerDb, result.runId),
    );
    expect(stored).toBeNull();
  });

  it("runSingleTest runs only the named test", () => {
    const service = createService();
    const spec = createTestSpecWithEdge({
      tests: [
        {
          name: "test-a",
          inputs: { data: "a" },
          mocks: { "step-1": { output: {} }, "step-2": { output: { output: "a" } } },
          assertions: [{ path: "steps.step-2.output.output", operator: "==", expected: "a" }],
        },
        {
          name: "test-b",
          inputs: { data: "b" },
          mocks: { "step-1": { output: {} }, "step-2": { output: { output: "b" } } },
          assertions: [{ path: "steps.step-2.output.output", operator: "==", expected: "b" }],
        },
      ],
    });

    const result = service.runSingleTest({ spec, testName: "test-b" });
    expect(result.name).toBe("test-b");
    expect(result.status).toBe("passed");
  });

  it("runSingleTest throws for unknown test name", () => {
    const service = createService();
    const spec = createTestSpec();

    expect(() =>
      service.runSingleTest({ spec, testName: "nonexistent" }),
    ).toThrow("TEST_CASE_NOT_FOUND");
  });

  it("records duration for each test case", () => {
    const service = createService();
    const spec = createTestSpecWithEdge();

    const result = service.runTests({ spec });
    expect(result.caseResults[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-validation-service.test.ts`
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { createFridayWorkflowBuilderValidationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-validation-service.js";
import { createFridayWorkflowCompiler } from "../../../../src/workflows/compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../../../src/workflows/compiler/friday-workflow-validator.js";
import type { FridayWorkflowDraftEntity } from "../../../../src/workflows/builder/model/friday-workflow-builder-draft.types.js";
import { createTestSpec, createTestSpecWithEdge, createTestVisual } from "./_helpers/create-test-spec.js";
import { createTestIdGenerator } from "../_helpers/create-test-db.js";

describe("FridayWorkflowBuilderValidationService", () => {
  const NOW = "2025-06-15T10:00:00.000Z";

  function createService() {
    const idGen = createTestIdGenerator();
    const compiler = createFridayWorkflowCompiler({
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();

    return createFridayWorkflowBuilderValidationService({
      compiler,
      validator,
      nowIso: () => NOW,
      idGenerator: idGen,
    });
  }

  function makeDraft(overrides?: Partial<FridayWorkflowDraftEntity>): FridayWorkflowDraftEntity {
    return {
      draftId: "draft-1",
      workflowId: "wf-1",
      title: "Test Draft",
      status: "active",
      revision: 1,
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      createdAt: NOW,
      updatedAt: NOW,
      autosave: { enabled: true, intervalMs: 30000 },
      ...overrides,
    };
  }

  it("validates a valid spec", () => {
    const service = createService();
    const report = service.validateSpec(createTestSpec());

    expect(report.valid).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
    expect(report.compiledGraphPreview).toBeDefined();
  });

  it("reports error for missing name", () => {
    const service = createService();
    const spec = createTestSpec({ name: "" });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    const nameIssue = report.issues.find((i) => i.code === "SPEC_MISSING_NAME");
    expect(nameIssue).toBeDefined();
    expect(nameIssue!.stage).toBe("spec_schema");
    expect(nameIssue!.severity).toBe("error");
  });

  it("reports error for missing startStepId", () => {
    const service = createService();
    const spec = createTestSpec({ startStepId: "" });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEC_MISSING_START_STEP")).toBe(true);
  });

  it("reports error for empty steps", () => {
    const service = createService();
    const spec = createTestSpec({ steps: [] });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEC_NO_STEPS")).toBe(true);
  });

  it("reports error for startStepId not in steps", () => {
    const service = createService();
    const spec = createTestSpec({ startStepId: "nonexistent" });
    const report = service.validateSpec(spec);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "SPEC_START_STEP_NOT_FOUND")).toBe(true);
  });

  it("reports duplicate step IDs", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-1", type: "skill_call", ref: "b" },
      ],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "SPEC_DUPLICATE_STEP_ID")).toBe(true);
  });

  it("reports edge referencing missing source step", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [{ id: "step-1", type: "skill_call", ref: "a" }],
      edges: [{ from: "nonexistent", to: "step-1" }],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "SPEC_EDGE_MISSING_SOURCE")).toBe(true);
  });

  it("reports output referencing missing step", () => {
    const service = createService();
    const spec = createTestSpec({
      outputs: [{ key: "result", fromStep: "nonexistent", path: "data" }],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "SPEC_OUTPUT_MISSING_STEP")).toBe(true);
  });

  it("validates a draft with visual model", () => {
    const service = createService();
    const draft = makeDraft();
    const report = service.validateDraft(draft);

    expect(report.valid).toBe(true);
  });

  it("reports canvas warning for orphan visual node", () => {
    const service = createService();
    const visual = createTestVisual("wf-1");
    visual.nodes.push({ nodeId: "orphan-node", x: 500, y: 500 });

    const draft = makeDraft({ visual });
    const report = service.validateDraft(draft);

    expect(report.issues.some((i) => i.code === "CANVAS_ORPHAN_NODE")).toBe(true);
    // Warnings don't block validity
    expect(report.valid).toBe(true);
  });

  it("reports canvas warning for invalid zoom", () => {
    const service = createService();
    const visual = createTestVisual("wf-1");
    visual.viewport.zoom = 0.01;

    const draft = makeDraft({ visual });
    const report = service.validateDraft(draft);

    expect(report.issues.some((i) => i.code === "CANVAS_INVALID_ZOOM")).toBe(true);
  });

  it("validates tests with invalid operator", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "bad test",
          inputs: {},
          assertions: [
            { path: "x", operator: "invalid" as never, expected: 1 },
          ],
        },
      ],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "TEST_INVALID_OPERATOR")).toBe(true);
  });

  it("validates tests with mock referencing unknown step", () => {
    const service = createService();
    const spec = createTestSpec({
      tests: [
        {
          name: "mock test",
          inputs: {},
          mocks: { "nonexistent-step": { output: {} } },
          assertions: [],
        },
      ],
    });
    const report = service.validateSpec(spec);

    expect(report.issues.some((i) => i.code === "TEST_MOCK_UNKNOWN_STEP")).toBe(true);
  });

  it("validateForPublish blocks on errors", () => {
    const service = createService();
    const draft = makeDraft({
      spec: createTestSpec({ name: "", workflowId: "wf-1" }),
    });
    const report = service.validateForPublish(draft);

    expect(report.valid).toBe(false);
    expect(report.issues.some((i) => i.code === "PUBLISH_BLOCKED_BY_ERRORS")).toBe(true);
  });

  it("validateForPublish passes with valid draft", () => {
    const service = createService();
    const draft = makeDraft();
    const report = service.validateForPublish(draft);

    expect(report.valid).toBe(true);
  });

  it("includes compiled graph preview on valid spec", () => {
    const service = createService();
    const report = service.validateSpec(createTestSpecWithEdge());

    expect(report.compiledGraphPreview).toBeDefined();
    expect(report.compiledGraphPreview!.schemaVersion).toBe("2.0");
    expect(report.compiledGraphPreview!.graph.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("does not include compiled graph preview when schema invalid", () => {
    const service = createService();
    const spec = createTestSpec({ steps: [] });
    const report = service.validateSpec(spec);

    expect(report.compiledGraphPreview).toBeUndefined();
  });
});
```

