> Archived: historical audit/plan/report material. Use `docs/current-source-of-truth.md` for the active architecture baseline and `docs/archive/README.md` for archive guidance.

# Phase 5 Code Review Package (Round 2)

## Build & Test Results
- TypeScript: CLEAN
- 721 tests passed (80 files), 0 failures

## Round 1 Issues Fixed (all 6)
1. [HIGH] Publish rejects mismatched workflowId
2. [HIGH] Lock assertion moved inside withWriteTransaction (atomic)
3. [HIGH] Skill-derived templates + precedence user > skill > builtin
4. [MEDIUM] skill_refs validation implemented
5. [MEDIUM] Test runner evaluates edge conditions
6. [MEDIUM] Import rejects checksum mismatch (force flag for override)

## Changed Files
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

      // 2b. Assert draft belongs to the target workflow
      if (draft.workflowId !== input.workflowId) {
        throw new Error("DRAFT_WORKFLOW_MISMATCH");
      }

      // Use draft-derived workflowId for all subsequent operations
      const workflowId = draft.workflowId;

      // 3. Validate for publish
      const validation = deps.validationService.validateForPublish(draft);
      if (!validation.valid) {
        return {
          workflowId,
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
        workflowId,
        compiled,
        input.createdByUserId,
        input.changeNote,
      );

      // 6. Store source spec snapshot
      deps.db.withWriteTransaction((db) => {
        deps.specVersionRepo.create(db, {
          workflowId,
          workflowVersionId: version.id,
          spec: draft.spec,
          checksum: compiled.checksum,
          createdAt: deps.nowIso(),
        });
      });

      // 7. Publish if requested
      if (input.publishNow) {
        deps.crudService.publishVersion(workflowId, version.versionNumber);
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
        workflowId,
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
      return deps.db.withWriteTransaction((db) => {
        const existing = deps.draftRepo.getById(db, input.draftId);
        if (!existing) throw new Error("DRAFT_NOT_FOUND");

        // Assert lock atomically inside the transaction
        deps.collaborationService.assertLock(existing.workflowId, input.lockToken);

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
      return deps.db.withWriteTransaction((db) => {
        const draft = deps.draftRepo.getById(db, input.draftId);
        if (!draft) throw new Error("DRAFT_NOT_FOUND");

        // Assert lock atomically inside the transaction
        deps.collaborationService.assertLock(draft.workflowId, input.lockToken);

        // Skip write if content unchanged
        const newChecksum = deps.computeChecksum(
          JSON.stringify({ spec: input.spec, visual: input.visual }),
        );
        const oldChecksum = deps.computeChecksum(
          JSON.stringify({ spec: draft.spec, visual: draft.visual }),
        );
        if (newChecksum === oldChecksum) return null;

        const now = deps.nowIso();
        const updated: FridayWorkflowDraftEntity = {
          ...draft,
          spec: input.spec,
          visual: input.visual,
          revision: draft.revision + 1,
          updatedAt: now,
          autosave: { ...draft.autosave, lastSavedAt: now },
        };

        deps.draftRepo.update(db, updated);
        return updated;
      });
    },

    archiveDraft(draftId, lockToken) {
      deps.db.withWriteTransaction((db) => {
        const draft = deps.draftRepo.getById(db, draftId);
        if (!draft) throw new Error("DRAFT_NOT_FOUND");

        // Assert lock atomically inside the transaction
        deps.collaborationService.assertLock(draft.workflowId, lockToken);

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
import type { FridaySkillRepository } from "../../../skills/persistence/friday-skill-repository.js";

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
  skillRepo?: FridaySkillRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Factory ───

export function createFridayWorkflowBuilderTemplateService(
  deps: CreateTemplateServiceDeps,
): FridayWorkflowBuilderTemplateService {
  /** Derive templates from installed skills that support workflow mode. */
  function getSkillDerivedTemplates(): FridayWorkflowTemplateEntity[] {
    if (!deps.skillRepo) return [];
    const installed = deps.db.withReadConnection((db) =>
      deps.skillRepo!.listInstalled(db),
    );
    return installed
      .filter(
        (s) =>
          s.currentManifest &&
          s.currentManifest.invocation.modes.includes("workflow"),
      )
      .map((s) => {
        const manifest = s.currentManifest!;
        const now = deps.nowIso();
        return {
          templateId: `skill-${s.id}`,
          kind: "skill" as const,
          scope: "global" as const,
          sourceSkillId: s.id,
          name: manifest.name,
          description: manifest.description,
          tags: manifest.tags,
          spec: {
            schemaVersion: "1.0" as const,
            workflowId: "",
            name: manifest.name,
            description: manifest.description,
            startStepId: "step-1",
            trigger: { type: "manual" as const },
            inputs: manifest.inputs.map((inp) => ({
              key: inp.key,
              type: (
                inp.type === "file" || inp.type === "secret"
                  ? "string"
                  : inp.type
              ) as "string" | "number" | "boolean" | "object" | "array",
              required: inp.required,
              defaultValue: inp.defaultValue,
            })),
            steps: [
              {
                id: "step-1",
                type: "skill_call" as const,
                ref: s.id,
              },
            ],
            edges: [],
            outputs: manifest.outputs.map((o) => ({
              key: o.key,
              fromStep: "step-1",
              path: o.key,
            })),
            errorPolicy: { onFailure: "fail_fast" as const, notifyUser: false },
            tests: [],
          },
          visual: {
            schemaVersion: "1.0" as const,
            workflowId: "",
            viewport: { x: 0, y: 0, zoom: 1 },
            panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
            nodes: [
              { nodeId: "__trigger__", x: 0, y: 0 },
              { nodeId: "step-1", x: 250, y: 0 },
            ],
            edges: [],
          },
          createdAt: now,
          updatedAt: now,
        } satisfies FridayWorkflowTemplateEntity;
      });
  }

  return {
    listTemplates(scope, ownerUserId) {
      const userTemplates = deps.db.withReadConnection((db) =>
        deps.templateRepo.list(db, scope, ownerUserId),
      );

      // Merge with skill-derived and builtins if no scope filter or scope is "global"
      if (!scope || scope === "global") {
        const skillTemplates = getSkillDerivedTemplates();

        // Precedence: user > skill > builtin
        const userNames = new Set(userTemplates.map((t) => t.name));
        const skillFiltered = skillTemplates.filter(
          (st) => !userNames.has(st.name),
        );
        const mergedNames = new Set([
          ...userNames,
          ...skillFiltered.map((t) => t.name),
        ]);
        const builtinFiltered = deps.builtinTemplates.filter(
          (bt) => !mergedNames.has(bt.name),
        );
        return [...builtinFiltered, ...skillFiltered, ...userTemplates];
      }

      return userTemplates;
    },

    getTemplate(templateId) {
      // Check user templates first (highest precedence)
      const userTemplate = deps.db.withReadConnection((db) =>
        deps.templateRepo.getById(db, templateId),
      );
      if (userTemplate) return userTemplate;

      // Check skill-derived templates
      const skillTemplates = getSkillDerivedTemplates();
      const skillMatch = skillTemplates.find((t) => t.templateId === templateId);
      if (skillMatch) return skillMatch;

      // Check builtins last
      const builtin = deps.builtinTemplates.find((t) => t.templateId === templateId);
      if (builtin) return builtin;

      return null;
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

### `src/workflows/builder/services/friday-workflow-builder-validation-service.ts`
```ts
import type { FridaySqliteLayer } from "../../../state/sqlite/friday-sqlite.types.js";
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
import type { FridaySkillRepository } from "../../../skills/persistence/friday-skill-repository.js";

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
  db?: FridaySqliteLayer;
  skillRepo?: FridaySkillRepository;
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

// ─── Skill Refs Validation ───

function validateSkillRefs(
  spec: FridayWorkflowSpecV1,
  db: FridaySqliteLayer,
  skillRepo: FridaySkillRepository,
): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  for (const step of spec.steps) {
    if ((step.type === "skill_call" || step.type === "tool_call") && step.ref) {
      const skill = db.withReadConnection((readerDb) =>
        skillRepo.getSkillById(readerDb, step.ref!),
      );
      if (!skill) {
        issues.push({
          code: "SKILL_REF_NOT_FOUND",
          stage: "skill_refs",
          severity: "error",
          message: `Step '${step.id}' references unknown skill '${step.ref}'`,
          stepId: step.id,
        });
      }
    }
  }

  return issues;
}

// ─── Expression Condition Validation ───

function validateEdgeConditions(
  spec: FridayWorkflowSpecV1,
  compiler: FridayWorkflowCompiler,
): FridayWorkflowBuilderValidationIssue[] {
  const issues: FridayWorkflowBuilderValidationIssue[] = [];

  for (const step of spec.steps) {
    if (step.condition) {
      // Attempt to parse the condition with a mini-spec
      try {
        compiler.validateSpec({
          ...spec,
          steps: [{ ...step, id: "__validate_cond__" }],
          edges: [],
          startStepId: "__validate_cond__",
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

      // Stage 4: skill_refs — verify referenced skills exist
      if (deps.db && deps.skillRepo) {
        issues.push(...validateSkillRefs(spec, deps.db, deps.skillRepo));
      }

      // Stage 5: expressions — validate step conditions and edge conditions
      issues.push(...validateEdgeConditions(spec, deps.compiler));
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

// ─── Edge Condition Evaluator ───

function evaluateEdgeCondition(
  edge: { from: string; to: string; when?: string },
  stepOutputs: Record<string, Record<string, unknown>>,
  mocks?: Record<string, { output: Record<string, unknown>; status?: string }>,
): boolean {
  if (!edge.when) return true; // unconditional

  const mock = mocks?.[edge.from];
  const status = mock?.status ?? "completed";
  const output = stepOutputs[edge.from] ?? {};

  switch (edge.when) {
    case "success":
      return status !== "failed";
    case "failure":
      return status === "failed";
    case "true":
      return output.result === true;
    case "false":
      return output.result === false;
    default:
      return true;
  }
}

function simulateWorkflow(
  spec: FridayWorkflowSpecV1,
  testCase: FridayWorkflowSpecTestCase,
): Record<string, unknown> {
  const stepOutputs: Record<string, Record<string, unknown>> = {};

  // Build edge list per source step (preserving edge metadata)
  const edgesFrom = new Map<string, Array<{ to: string; when?: string }>>();
  for (const step of spec.steps) {
    edgesFrom.set(step.id, []);
  }
  for (const edge of spec.edges) {
    const list = edgesFrom.get(edge.from) ?? [];
    list.push({ to: edge.to, when: edge.when });
    edgesFrom.set(edge.from, list);
  }

  // BFS from startStepId with edge-condition evaluation
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

    // Add successors whose edge conditions are satisfied
    for (const edge of edgesFrom.get(stepId) ?? []) {
      if (
        !visited.has(edge.to) &&
        evaluateEdgeCondition(
          { from: stepId, to: edge.to, when: edge.when },
          stepOutputs,
          testCase.mocks,
        )
      ) {
        queue.push(edge.to);
      }
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
  importBundle(bundle: FridayWorkflowSpecBundleV1, workflowId: UUID, ownerUserId?: UUID, options?: { force?: boolean }): FridayWorkflowImportResult;
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

    importBundle(bundle, workflowId, ownerUserId, options) {
      const warnings: string[] = [];

      // Validate bundle schema
      if (bundle.bundleSchemaVersion !== "1.0") {
        throw new Error(`IMPORT_UNSUPPORTED_SCHEMA: expected '1.0', got '${bundle.bundleSchemaVersion}'`);
      }

      // Verify checksum — reject by default, allow with force flag
      const computedChecksum = computeBundleChecksum(bundle.spec, bundle.visual);
      if (computedChecksum !== bundle.checksum) {
        if (options?.force) {
          warnings.push("Bundle checksum mismatch — content may have been modified (forced import)");
        } else {
          throw new Error("IMPORT_CHECKSUM_MISMATCH");
        }
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

## Test Files (with new tests)
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

  it("publish rejects mismatched workflowId", () => {
    const {
      draftService,
      collaborationService,
      compositorService,
      crudService,
    } = createAllServices();

    // Create two workflows
    const wfA = crudService.createWorkflow({ slug: "wf-a", name: "Workflow A" });
    const wfB = crudService.createWorkflow({ slug: "wf-b", name: "Workflow B" });

    // Draft belongs to workflow A
    const draft = draftService.createDraft({
      workflowId: wfA.id,
      title: "Draft for A",
      spec: createTestSpec({ workflowId: wfA.id }),
      visual: createTestVisual(wfA.id),
      ownerUserId: "test-user",
    });

    // Lock workflow B (different from draft's workflow)
    const lockResult = collaborationService.acquireLock({
      workflowId: wfB.id,
      ownerUserId: "test-user",
      ttlSec: 300,
    });

    // Attempt to publish draft against workflow B → should throw mismatch
    expect(() =>
      compositorService.publishDraft({
        draftId: draft.draftId,
        workflowId: wfB.id,
        lockToken: lockResult.lock!.lockToken,
        publishNow: true,
      }),
    ).toThrow("DRAFT_WORKFLOW_MISMATCH");
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

  it("save with expired lock fails atomically", () => {
    const { draftService, collaborationService } = createServices();
    const draft = draftService.createDraft({
      workflowId: "wf-1",
      title: "My Draft",
      spec: createTestSpec({ workflowId: "wf-1" }),
      visual: createTestVisual("wf-1"),
      ownerUserId: "test-user",
    });

    // Acquire a lock with a very short TTL — but since our test uses a fixed NOW,
    // we need a lock whose expiresAt is already in the past. We can simulate this by
    // acquiring a lock, then using a collaboration service whose nowIso is after expiry.
    const lockResult = collaborationService.acquireLock({
      workflowId: "wf-1",
      ownerUserId: "test-user",
      ttlSec: 1, // 1 second TTL
    });

    // Create a new draft service with a nowIso well past the lock expiry
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const expiredNow = "2099-01-01T00:00:00.000Z";
    const collaborationService2 = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => expiredNow,
    });
    const draftService2 = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService: collaborationService2,
      idGenerator: idGen,
      nowIso: () => expiredNow,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    expect(() =>
      draftService2.saveDraft({
        draftId: draft.draftId,
        expectedRevision: 1,
        lockToken: lockResult.lock!.lockToken,
        title: "Should fail",
      }),
    ).toThrow("WORKFLOW_EDIT_LOCK_EXPIRED");
  });

  it("autosave with expired lock fails atomically", () => {
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
      ttlSec: 1,
    });

    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const expiredNow = "2099-01-01T00:00:00.000Z";
    const collaborationService2 = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => expiredNow,
    });
    const draftService2 = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService: collaborationService2,
      idGenerator: idGen,
      nowIso: () => expiredNow,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    expect(() =>
      draftService2.autosaveDraft({
        draftId: draft.draftId,
        lockToken: lockResult.lock!.lockToken,
        spec: { ...draft.spec, name: "Changed" },
        visual: draft.visual,
      }),
    ).toThrow("WORKFLOW_EDIT_LOCK_EXPIRED");
  });

  it("archive with expired lock fails atomically", () => {
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
      ttlSec: 1,
    });

    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const expiredNow = "2099-01-01T00:00:00.000Z";
    const collaborationService2 = createFridayWorkflowBuilderCollaborationService({
      db,
      lockRepo,
      idGenerator: idGen,
      nowIso: () => expiredNow,
    });
    const draftService2 = createFridayWorkflowBuilderDraftService({
      db,
      draftRepo: createFridayWorkflowBuilderDraftRepository(),
      collaborationService: collaborationService2,
      idGenerator: idGen,
      nowIso: () => expiredNow,
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
    });

    expect(() =>
      draftService2.archiveDraft(draft.draftId, lockResult.lock!.lockToken),
    ).toThrow("WORKFLOW_EDIT_LOCK_EXPIRED");
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

  it("rejects checksum mismatch by default", () => {
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

    expect(() =>
      importExportService.importBundle(bundle, "wf-new"),
    ).toThrow("IMPORT_CHECKSUM_MISMATCH");
  });

  it("allows checksum mismatch with force flag", () => {
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

    const result = importExportService.importBundle(bundle, "wf-new", undefined, { force: true });
    expect(result.warnings.some((w) => w.includes("checksum mismatch"))).toBe(true);
    expect(result.draft).toBeDefined();
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
import { createFridaySkillRepository } from "../../../../src/skills/persistence/friday-skill-repository.js";
import type { FridaySkillRepository } from "../../../../src/skills/persistence/friday-skill-repository.js";
import type { SkillManifestV2 } from "../../../../src/skills/model/friday-skill-manifest-v2.types.js";
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

  // ─── Skill-derived template tests ───

  function createMinimalManifest(overrides?: Partial<SkillManifestV2>): SkillManifestV2 {
    return {
      schemaVersion: "2.0",
      id: "test-wf-skill",
      name: "Workflow Skill",
      description: "A skill that supports workflow mode",
      version: "1.0.0",
      kind: "workflow",
      category: "automation",
      author: { name: "test" },
      tags: ["workflow"],
      runtime: {
        kind: "builtin",
        entrypoint: "skill.ts",
        minHubVersion: "1.0.0",
        apiVersion: "1",
        timeoutMsDefault: 30000,
      },
      triggers: { intents: [], phrases: [], channels: [] },
      invocation: {
        userInvocable: true,
        modelInvocable: false,
        priority: 1,
        modes: ["workflow"],
      },
      requirements: { bins: [], env: [], config: [], os: ["darwin"] },
      inputs: [
        { key: "data", type: "string", required: true, label: "Data" },
      ],
      outputs: [
        { key: "result", type: "string", description: "Result" },
      ],
      permissions: { allowed: [], denied: [] },
      executionTargets: { allowedSatelliteTypes: [], requiredCapabilities: [] },
      ...overrides,
    } as SkillManifestV2;
  }

  function createServiceWithSkills() {
    const idGen = createTestIdGenerator();
    const lockRepo = createFridayWorkflowBuilderLockRepository();
    const skillRepo = createFridaySkillRepository();
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

    return {
      service: createFridayWorkflowBuilderTemplateService({
        db,
        templateRepo: createFridayWorkflowBuilderTemplateRepository(),
        draftService,
        builtinTemplates: getFridayBuiltinWorkflowTemplates(),
        skillRepo,
        idGenerator: idGen,
        nowIso: () => NOW,
      }),
      skillRepo,
    };
  }

  it("lists skill-derived templates from installed skills", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install a workflow-capable skill
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "test-wf-skill",
        name: "Workflow Skill",
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        currentManifest: createMinimalManifest(),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(
        writerDb,
        "test-wf-skill",
        "1.0.0",
        createMinimalManifest(),
        NOW,
      );
    });

    const templates = service.listTemplates();
    const skillTemplate = templates.find((t) => t.kind === "skill");
    expect(skillTemplate).toBeDefined();
    expect(skillTemplate!.sourceSkillId).toBe("test-wf-skill");
    expect(skillTemplate!.name).toBe("Workflow Skill");
  });

  it("skill templates have lower precedence than user templates", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install skill
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "test-wf-skill",
        name: "Workflow Skill",
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        currentManifest: createMinimalManifest(),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(
        writerDb,
        "test-wf-skill",
        "1.0.0",
        createMinimalManifest(),
        NOW,
      );
    });

    // Create user template with same name
    service.createUserTemplate({
      name: "Workflow Skill",
      tags: ["override"],
      ownerUserId: "test-user",
      spec: createTestSpec(),
      visual: createTestVisual(),
    });

    const templates = service.listTemplates();
    const matches = templates.filter((t) => t.name === "Workflow Skill");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.kind).toBe("user");
  });

  it("skill templates have higher precedence than builtin templates", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install skill with same name as a builtin
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "test-wf-skill",
        name: "Blank Workflow", // same as builtin
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        currentManifest: createMinimalManifest({ name: "Blank Workflow" }),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(
        writerDb,
        "test-wf-skill",
        "1.0.0",
        createMinimalManifest({ name: "Blank Workflow" }),
        NOW,
      );
    });

    const templates = service.listTemplates();
    const blanks = templates.filter((t) => t.name === "Blank Workflow");
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.kind).toBe("skill");
  });

  it("skill templates with non-workflow mode are excluded", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install skill that only supports 'intent' mode (not 'workflow')
    const intentManifest = createMinimalManifest({
      invocation: {
        userInvocable: true,
        modelInvocable: false,
        priority: 1,
        modes: ["intent"],
      },
    });
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "intent-only-skill",
        name: "Intent Only",
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        currentManifest: intentManifest,
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writerDb, "intent-only-skill", "1.0.0", intentManifest, NOW);
    });

    const templates = service.listTemplates();
    expect(templates.find((t) => t.name === "Intent Only")).toBeUndefined();
  });

  it("getTemplate finds skill-derived template by id", () => {
    const { service, skillRepo } = createServiceWithSkills();

    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "test-wf-skill",
        name: "Workflow Skill",
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        currentManifest: createMinimalManifest(),
        nowIso: NOW,
      });
      skillRepo.setInstalledVersion(writerDb, "test-wf-skill", "1.0.0", createMinimalManifest(), NOW);
    });

    const template = service.getTemplate("skill-test-wf-skill");
    expect(template).not.toBeNull();
    expect(template!.kind).toBe("skill");
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

  // ─── Edge condition evaluation tests ───

  it("follows success edge when step succeeds", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-success", type: "skill_call", ref: "b" },
        { id: "step-failure", type: "skill_call", ref: "c" },
      ],
      edges: [
        { from: "step-1", to: "step-success", when: "success" },
        { from: "step-1", to: "step-failure", when: "failure" },
      ],
      tests: [
        {
          name: "success path",
          inputs: {},
          mocks: {
            "step-1": { output: { value: "ok" }, status: "completed" },
            "step-success": { output: { reached: true } },
            "step-failure": { output: { reached: true } },
          },
          assertions: [
            { path: "steps.step-success.output.reached", operator: "==", expected: true },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
    // step-failure should NOT have been visited
    expect(result.caseResults[0]!.assertionResults[0]!.passed).toBe(true);
  });

  it("follows failure edge when step fails", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-success", type: "skill_call", ref: "b" },
        { id: "step-failure", type: "skill_call", ref: "c" },
      ],
      edges: [
        { from: "step-1", to: "step-success", when: "success" },
        { from: "step-1", to: "step-failure", when: "failure" },
      ],
      tests: [
        {
          name: "failure path",
          inputs: {},
          mocks: {
            "step-1": { output: { value: "bad" }, status: "failed" },
            "step-success": { output: { reached: true } },
            "step-failure": { output: { error: "oops" } },
          },
          assertions: [
            { path: "steps.step-failure.output.error", operator: "==", expected: "oops" },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("skips success edge when step fails", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "a" },
        { id: "step-success", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step-1", to: "step-success", when: "success" },
      ],
      tests: [
        {
          name: "skip success when failed",
          inputs: {},
          mocks: {
            "step-1": { output: {}, status: "failed" },
            "step-success": { output: { val: "should not see" } },
          },
          assertions: [
            // step-success should NOT be visited, so its output should be undefined
            { path: "steps.step-success.output.val", operator: "==", expected: undefined },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("follows true edge when condition evaluates to true", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "condition", ref: "cond" },
        { id: "step-true", type: "skill_call", ref: "a" },
        { id: "step-false", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step-1", to: "step-true", when: "true" },
        { from: "step-1", to: "step-false", when: "false" },
      ],
      tests: [
        {
          name: "true branch",
          inputs: {},
          mocks: {
            "step-1": { output: { result: true } },
            "step-true": { output: { taken: "yes" } },
            "step-false": { output: { taken: "no" } },
          },
          assertions: [
            { path: "steps.step-true.output.taken", operator: "==", expected: "yes" },
            // step-false should not be visited
            { path: "steps.step-false.output.taken", operator: "==", expected: undefined },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });

  it("follows false edge when condition evaluates to false", () => {
    const service = createService();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "condition", ref: "cond" },
        { id: "step-true", type: "skill_call", ref: "a" },
        { id: "step-false", type: "skill_call", ref: "b" },
      ],
      edges: [
        { from: "step-1", to: "step-true", when: "true" },
        { from: "step-1", to: "step-false", when: "false" },
      ],
      tests: [
        {
          name: "false branch",
          inputs: {},
          mocks: {
            "step-1": { output: { result: false } },
            "step-true": { output: { taken: "yes" } },
            "step-false": { output: { taken: "no" } },
          },
          assertions: [
            { path: "steps.step-false.output.taken", operator: "==", expected: "no" },
            // step-true should not be visited
            { path: "steps.step-true.output.taken", operator: "==", expected: undefined },
          ],
        },
      ],
    });

    const result = service.runTests({ spec });
    expect(result.passed).toBe(true);
  });
});
```

### `test/unit/workflows/builder/friday-workflow-builder-validation-service.test.ts`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "../../../../src/state/sqlite/friday-sqlite.types.js";
import { createFridayWorkflowBuilderValidationService } from "../../../../src/workflows/builder/services/friday-workflow-builder-validation-service.js";
import { createFridayWorkflowCompiler } from "../../../../src/workflows/compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../../../src/workflows/compiler/friday-workflow-validator.js";
import { createFridaySkillRepository } from "../../../../src/skills/persistence/friday-skill-repository.js";
import type { FridayWorkflowDraftEntity } from "../../../../src/workflows/builder/model/friday-workflow-builder-draft.types.js";
import { createTestSpec, createTestSpecWithEdge, createTestVisual } from "./_helpers/create-test-spec.js";
import { createTestDb, createTestIdGenerator } from "../_helpers/create-test-db.js";

describe("FridayWorkflowBuilderValidationService", () => {
  const NOW = "2025-06-15T10:00:00.000Z";
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

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

  // ─── skill_refs validation tests ───

  function createServiceWithSkills() {
    const idGen = createTestIdGenerator();
    const skillRepo = createFridaySkillRepository();
    const compiler = createFridayWorkflowCompiler({
      computeChecksum: (content) => createHash("sha256").update(content).digest("hex"),
      idGenerator: idGen,
    });
    const validator = createFridayWorkflowValidator();

    return {
      service: createFridayWorkflowBuilderValidationService({
        compiler,
        validator,
        db,
        skillRepo,
        nowIso: () => NOW,
        idGenerator: idGen,
      }),
      skillRepo,
    };
  }

  it("skill_refs reports unknown skillId", () => {
    const { service } = createServiceWithSkills();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "nonexistent-skill" },
      ],
    });

    const report = service.validateSpec(spec);
    const skillIssue = report.issues.find((i) => i.code === "SKILL_REF_NOT_FOUND");
    expect(skillIssue).toBeDefined();
    expect(skillIssue!.stage).toBe("skill_refs");
    expect(skillIssue!.severity).toBe("error");
    expect(skillIssue!.stepId).toBe("step-1");
  });

  it("skill_refs passes for installed skill", () => {
    const { service, skillRepo } = createServiceWithSkills();

    // Install the referenced skill
    db.withWriteTransaction((writerDb) => {
      skillRepo.upsertSkillFromMarketplace(writerDb, {
        id: "test-skill",
        name: "Test Skill",
        source: "marketplace",
        origin: "marketplace",
        status: "installed",
        nowIso: NOW,
      });
    });

    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "skill_call", ref: "test-skill" },
      ],
    });

    const report = service.validateSpec(spec);
    const skillIssues = report.issues.filter((i) => i.stage === "skill_refs");
    expect(skillIssues).toHaveLength(0);
  });

  it("skill_refs checks tool_call refs too", () => {
    const { service } = createServiceWithSkills();
    const spec = createTestSpec({
      steps: [
        { id: "step-1", type: "tool_call", ref: "missing-tool" },
      ],
    });

    const report = service.validateSpec(spec);
    expect(report.issues.some((i) => i.code === "SKILL_REF_NOT_FOUND" && i.stepId === "step-1")).toBe(true);
  });
});
```

