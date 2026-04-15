> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

I’m pulling only the five files you specified plus the `find src -type d | sort` output, then I’ll produce a single Phase 5 implementation plan aligned to existing V001 schema and Phase 3 types.

---

I’ve extracted the key anchors; next I’m reading the exact schema/type sections (workflow tables and `WorkflowSpecV1` contract) so the Phase 5 plan can map directly to existing tables and Phase 3 compiler boundaries.

---

I now have the core contracts; I’m quickly checking current `src/workflows` and SQLite layer patterns so the new file layout and service boundaries match existing naming and dependency conventions.

---

I’ve gathered enough implementation context; I’m doing one quick pass over existing test/file naming patterns, then I’ll provide the one-pass Phase 5 plan in the exact section order you requested.

---

**Phase 5: Workflow Builder Implementation Plan**

## 1. File structure (new files)

`src/workflows/model/friday-workflow-spec.types.ts`  
`src/workflows/builder/index.ts`  
`src/workflows/builder/model/friday-workflow-builder-canvas.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-template.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-draft.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-validation.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-test.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-collaboration.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-io.types.ts`  
`src/workflows/builder/model/friday-workflow-builder-runtime.types.ts`  
`src/workflows/builder/persistence/friday-workflow-builder-draft-repository.ts`  
`src/workflows/builder/persistence/friday-workflow-builder-template-repository.ts`  
`src/workflows/builder/persistence/friday-workflow-builder-spec-version-repository.ts`  
`src/workflows/builder/persistence/friday-workflow-builder-test-run-repository.ts`  
`src/workflows/builder/persistence/friday-workflow-builder-lock-repository.ts`  
`src/workflows/builder/services/friday-workflow-builder-draft-service.ts`  
`src/workflows/builder/services/friday-workflow-builder-template-service.ts`  
`src/workflows/builder/services/friday-workflow-builder-validation-service.ts`  
`src/workflows/builder/services/friday-workflow-builder-test-runner-service.ts`  
`src/workflows/builder/services/friday-workflow-builder-collaboration-service.ts`  
`src/workflows/builder/services/friday-workflow-builder-import-export-service.ts`  
`src/workflows/builder/services/friday-workflow-builder-compositor-service.ts`  
`src/workflows/builder/runtime/friday-workflow-builder-runtime.ts`  
`src/workflows/builder/templates/friday-workflow-builder-builtin-templates.ts`  
`src/workflows/builder/templates/friday-workflow-builder-skill-node-template.ts`  

Existing files to update:  
`src/workflows/compiler/friday-workflow-compiler.ts`  
`src/workflows/index.ts`  

---

## 2. Type definitions (full signatures)

```ts
// src/workflows/model/friday-workflow-spec.types.ts

import type { WorkflowFailurePolicyV2, UUID, ISODateTime } from "./friday-workflow.types.js";
import type { FridayCompiledWorkflowGraphV2 } from "./friday-workflow-graph.types.js";

export type FridayWorkflowSpecTrigger =
  | { type: "manual" }
  | { type: "schedule"; cron: string; timezone: string }
  | { type: "event"; source: string; event: string };

export type FridayWorkflowSpecInputType = "string" | "number" | "boolean" | "object" | "array";

export interface FridayWorkflowSpecInput {
  key: string;
  type: FridayWorkflowSpecInputType;
  required: boolean;
  defaultValue?: unknown;
}

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

export interface FridayWorkflowSpecEdge {
  from: string;
  to: string;
  when?: "success" | "failure" | "true" | "false";
}

export interface FridayWorkflowSpecOutput {
  key: string;
  fromStep: string;
  path: string;
}

export interface FridayWorkflowSpecMockStepResult {
  output: Record<string, unknown>;
  status?: "completed" | "failed";
}

export interface FridayWorkflowSpecTestAssertion {
  path: string;
  operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
  expected: unknown;
}

export interface FridayWorkflowSpecTestCase {
  name: string;
  description?: string;
  inputs: Record<string, unknown>;
  mocks?: Record<string, FridayWorkflowSpecMockStepResult>;
  assertions: FridayWorkflowSpecTestAssertion[];
}

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

// src/workflows/builder/model/friday-workflow-builder-canvas.types.ts

export interface FridayWorkflowCanvasViewportV1 {
  x: number;
  y: number;
  zoom: number;
}

export interface FridayWorkflowCanvasPanelLayoutV1 {
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
}

export interface FridayWorkflowBuilderNodeLayoutV1 {
  nodeId: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  zIndex?: number;
}

export interface FridayWorkflowBuilderEdgeLayoutV1 {
  edgeKey: string; // `${from}:${to}:${when ?? "any"}`
  sourceHandle?: string;
  targetHandle?: string;
  bendPoints?: Array<{ x: number; y: number }>;
}

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

// src/workflows/builder/model/friday-workflow-builder-template.types.ts

export type FridayWorkflowTemplateKind = "builtin" | "skill" | "user";
export type FridayWorkflowTemplateScope = "global" | "user";

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

// src/workflows/builder/model/friday-workflow-builder-draft.types.ts

export type FridayWorkflowDraftStatus = "active" | "archived" | "published" | "conflicted";

export interface FridayWorkflowDraftAutosaveState {
  enabled: boolean;
  intervalMs: number;
  lastSavedAt?: ISODateTime;
}

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

export interface FridayWorkflowDraftSaveInput {
  draftId: UUID;
  expectedRevision: number;
  lockToken: string;
  spec?: FridayWorkflowSpecV1;
  visual?: FridayWorkflowVisualGraphV1;
  title?: string;
  autosave?: Partial<FridayWorkflowDraftAutosaveState>;
}

// src/workflows/builder/model/friday-workflow-builder-validation.types.ts

export type FridayWorkflowValidationSeverity = "error" | "warning" | "info";
export type FridayWorkflowValidationStage =
  | "spec_schema"
  | "graph_compile"
  | "compiled_graph"
  | "skill_refs"
  | "expressions"
  | "tests"
  | "canvas";

export interface FridayWorkflowBuilderValidationIssue {
  code: string;
  stage: FridayWorkflowValidationStage;
  severity: FridayWorkflowValidationSeverity;
  message: string;
  jsonPath?: string;
  stepId?: string;
  edgeRef?: { from: string; to: string; when?: "success" | "failure" | "true" | "false" };
}

export interface FridayWorkflowBuilderValidationReport {
  valid: boolean;
  issues: FridayWorkflowBuilderValidationIssue[];
  compiledGraphPreview?: FridayCompiledWorkflowGraphV2;
  generatedAt: ISODateTime;
}

// src/workflows/builder/model/friday-workflow-builder-test.types.ts

export type FridayWorkflowTestCaseStatus = "passed" | "failed" | "skipped";

export interface FridayWorkflowTestAssertionResult {
  path: string;
  operator: "==" | "!=" | ">" | "<" | "contains" | "matches";
  expected: unknown;
  actual: unknown;
  passed: boolean;
  message?: string;
}

export interface FridayWorkflowTestCaseResult {
  name: string;
  status: FridayWorkflowTestCaseStatus;
  durationMs: number;
  assertionResults: FridayWorkflowTestAssertionResult[];
  error?: { code: string; message: string };
}

export interface FridayWorkflowTestRunResult {
  runId: UUID;
  workflowId: UUID;
  draftId?: UUID;
  startedAt: ISODateTime;
  finishedAt: ISODateTime;
  passed: boolean;
  caseResults: FridayWorkflowTestCaseResult[];
}

// src/workflows/builder/model/friday-workflow-builder-collaboration.types.ts

export interface FridayWorkflowEditLock {
  workflowId: UUID;
  lockToken: string;
  ownerUserId: UUID;
  ownerSessionId?: string;
  acquiredAt: ISODateTime;
  heartbeatAt: ISODateTime;
  expiresAt: ISODateTime;
}

export interface FridayWorkflowLockAcquireInput {
  workflowId: UUID;
  ownerUserId: UUID;
  ownerSessionId?: string;
  ttlSec: number;
}

export interface FridayWorkflowLockAcquireResult {
  acquired: boolean;
  lock?: FridayWorkflowEditLock;
  conflict?: FridayWorkflowEditLock;
}

// src/workflows/builder/model/friday-workflow-builder-io.types.ts

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

export interface FridayWorkflowImportResult {
  draft: FridayWorkflowDraftEntity;
  validation: FridayWorkflowBuilderValidationReport;
  warnings: string[];
}

// src/workflows/builder/model/friday-workflow-builder-runtime.types.ts

export interface FridayWorkflowBuilderPublishInput {
  draftId: UUID;
  workflowId: UUID;
  lockToken: string;
  createdByUserId?: UUID;
  changeNote?: string;
  publishNow: boolean;
}

export interface FridayWorkflowBuilderPublishResult {
  workflowId: UUID;
  workflowVersionId: UUID;
  versionNumber: number;
  published: boolean;
  checksum: string;
  validation: FridayWorkflowBuilderValidationReport;
}
```

---

## 3. Persistence layer

No new migrations. Use only V001 tables with `FridaySqliteLayer`.

- `workflows` + `workflow_versions` remain canonical published runtime state.
- `memory_items` stores authoring-side state:
  - namespace `workflow_builder_drafts`, key `${workflowId}:${draftId}`, value `FridayWorkflowDraftEntity`
  - namespace `workflow_builder_templates`, key `${scope}:${ownerUserId ?? "global"}:${templateId}`, value `FridayWorkflowTemplateEntity`
  - namespace `workflow_builder_spec_versions`, key `${workflowId}:${workflowVersionId}`, value `{ workflowId, workflowVersionId, spec, checksum, createdAt }`
  - namespace `workflow_builder_test_runs`, key `${draftId}:${runId}`, value `FridayWorkflowTestRunResult`
- `hub_settings` stores lock state:
  - key `workflow_builder_lock:${workflowId}`, value `FridayWorkflowEditLock`
- `audit_logs` records lock/import/export/publish actions.

Repository responsibilities:

- `friday-workflow-builder-draft-repository.ts`:
  - create/get/list/update/archive drafts
  - optimistic revision check inside single write transaction
- `friday-workflow-builder-template-repository.ts`:
  - user template CRUD on `memory_items`
- `friday-workflow-builder-spec-version-repository.ts`:
  - persist exact `WorkflowSpecV1` snapshot when version is created
  - fetch source spec for export/version diff
- `friday-workflow-builder-test-run-repository.ts`:
  - persist and list test run summaries
- `friday-workflow-builder-lock-repository.ts`:
  - acquire/renew/release/read lock via `hub_settings`
  - lock conflict if unexpired lock held by different owner

---

## 4. Services

- `FridayWorkflowBuilderDraftService`
  - `createDraft`, `getDraft`, `listDrafts`, `saveDraft`, `autosaveDraft`, `archiveDraft`, `forkDraft`
  - enforces `lockToken` and `expectedRevision`
- `FridayWorkflowBuilderTemplateService`
  - `listTemplates`, `getTemplate`, `createUserTemplate`, `updateUserTemplate`, `deleteUserTemplate`, `instantiateTemplate`
- `FridayWorkflowBuilderValidationService`
  - `validateSpec`, `validateDraft`, `validateForPublish`
  - runs staged validation and returns unified issue list
- `FridayWorkflowBuilderTestRunnerService`
  - `runTests(draftId|spec)`, `runSingleTest`
  - simulation-only, no side effects, optional persistence of results
- `FridayWorkflowBuilderCollaborationService`
  - `acquireLock`, `renewLock`, `releaseLock`, `getLock`, `assertLock`
- `FridayWorkflowBuilderImportExportService`
  - `exportDraft`, `exportWorkflowVersion`, `importBundle`
- `FridayWorkflowBuilderCompositorService`
  - `compileDraft`, `createVersionFromDraft`, `publishDraft`
  - integrates with Phase 3 CRUD/trigger services

---

## 5. Template system

Template sources:

- Built-in templates from `friday-workflow-builder-builtin-templates.ts`
- Skill-derived templates from installed skill manifests (`skills.current_manifest_json`) using §6.5 mapping
- User templates from `memory_items` namespace `workflow_builder_templates`

Instantiation flow:

1. Load template by priority: user > skill-derived > builtin.
2. Clone spec and visual model.
3. Rebind `workflowId`, generate `draftId`, normalize step IDs if collisions exist.
4. Persist as draft and return validation report.

---

## 6. Validation pipeline

Stage order (real-time + pre-publish):

1. `spec_schema`: enforce `WorkflowSpecV1` contract from skill-system-design §3.3.
2. `graph_compile`: compile via `createFridayWorkflowCompiler().compile(...)`.
3. `compiled_graph`: validate compiled IR via `createFridayWorkflowValidator().validate(...)`.
4. `skill_refs`: verify referenced skills/tools exist and are workflow-invocable.
5. `expressions`: parse all `condition` and expression fields with existing evaluator parser.
6. `tests`: validate tests/mocks/assertions structure and operator compatibility.
7. `canvas`: ensure visual model references existing nodes/edges and viewport sanity.

Rules:

- `error` blocks publish.
- `warning` allows publish but is returned to UI.
- report includes `jsonPath`, `stepId`, `edgeRef` where possible.

---

## 7. Test runner

Execution model:

- Compile spec once to `FridayCompiledWorkflowGraphV2` (temporary version ID).
- Simulate DAG with Phase 3 scheduler + expression evaluator semantics.
- For each test:
  - inject `inputs`
  - apply `mocks` by step ID
  - unmocked side-effecting steps return deterministic no-op output (`{}`)
  - evaluate assertions (`==`, `!=`, `>`, `<`, `contains`, `matches`)
- Persist result to `workflow_builder_test_runs` (optional flag).

Outputs:

- per-test status
- assertion-level pass/fail with actual vs expected
- overall pass/fail summary
- deterministic run checksum for reproducibility

---

## 8. Draft management

Draft lifecycle:

1. `createDraft` from blank/template/import.
2. `acquireLock` required before write operations.
3. `saveDraft` with optimistic `expectedRevision`.
4. `autosaveDraft` skips write when content checksum unchanged.
5. `archiveDraft` soft-archives in payload status.
6. `publishDraft` marks draft with `publishedVersionId` and status.

Conflict handling:

- revision mismatch returns `DRAFT_VERSION_CONFLICT` with latest server draft.
- lock mismatch returns `WORKFLOW_EDIT_LOCK_REQUIRED` or `WORKFLOW_EDIT_LOCK_CONFLICT`.

---

## 9. Runtime compositor

`createFridayWorkflowBuilderRuntime` composes builder services and Phase 3 runtime contracts.

Dependencies:

- `db: FridaySqliteLayer`
- `idGenerator`, `nowIso`, `computeChecksum`
- Phase 3 services: `workflowCrudService`, `workflowTriggerService`, compiler/validator components

Publish flow:

1. Load draft and assert lock.
2. Run full validation pipeline.
3. Compile `WorkflowSpecV1` -> `CompiledWorkflowGraphV2`.
4. Persist runtime version via Phase 3 `createVersion`.
5. Persist source spec snapshot in `workflow_builder_spec_versions`.
6. If `publishNow`, call Phase 3 `publishVersion` and refresh trigger registrations.
7. Emit audit log + optional event.
8. Return `FridayWorkflowBuilderPublishResult`.

---

## 10. Unit test plan (files + cases)

`test/unit/workflows/builder/friday-workflow-builder-draft-repository.test.ts`  
Cases: create/get/list drafts, revision conflict, archive behavior, namespace/key correctness.

`test/unit/workflows/builder/friday-workflow-builder-lock-repository.test.ts`  
Cases: acquire free lock, reject active lock, renew by owner, release with token check, TTL expiry takeover.

`test/unit/workflows/builder/friday-workflow-builder-template-repository.test.ts`  
Cases: CRUD user templates, scope filtering, key format, JSON roundtrip.

`test/unit/workflows/builder/friday-workflow-builder-template-service.test.ts`  
Cases: merge builtin/skill/user templates, precedence rules, instantiate template into draft.

`test/unit/workflows/builder/friday-workflow-builder-validation-service.test.ts`  
Cases: each validation stage failure, warning vs error behavior, compiled preview generation, phase3 validator integration.

`test/unit/workflows/builder/friday-workflow-builder-test-runner-service.test.ts`  
Cases: all-pass tests, mock override semantics, unmocked no-op behavior, assertion operator coverage, deterministic outputs.

`test/unit/workflows/builder/friday-workflow-builder-import-export-service.test.ts`  
Cases: export checksum, import valid bundle, reject bad schema/checksum, import collision as clone.

`test/unit/workflows/builder/friday-workflow-builder-draft-service.test.ts`  
Cases: lock-required writes, autosave no-op on unchanged checksum, save conflict returns latest draft.

`test/unit/workflows/builder/friday-workflow-builder-compositor-service.test.ts`  
Cases: validation blocks publish, version creation stores compiled graph + source spec snapshot, publish-now updates published version and triggers reload.

`test/unit/workflows/builder/friday-workflow-builder-runtime.test.ts`  
Cases: runtime wiring, dependency injection correctness, exposed services contract.

`test/unit/workflows/friday-workflow-compiler.test.ts` (update)  
Cases: spec type import path compatibility and no regression in compile behavior.

`test/unit/workflows/friday-workflow-crud-service.test.ts` (update)  
Cases: compositor-created versions remain compatible with existing CRUD publish flows.

