import type { FridaySqliteLayer } from "#state";
import type { FridaySkillRegistry, FridaySkillRepository } from "#skills";
import type { FridayWorkflowCrudService } from "../../services/friday-workflow-crud-service.js";

import { createFridayWorkflowCompiler } from "../../compiler/friday-workflow-compiler.js";
import { createFridayWorkflowValidator } from "../../compiler/friday-workflow-validator.js";

import { createFridayWorkflowBuilderDraftRepository } from "../persistence/friday-workflow-builder-draft-repository.js";
import { createFridayWorkflowBuilderTemplateRepository } from "../persistence/friday-workflow-builder-template-repository.js";
import { createFridayWorkflowBuilderSpecVersionRepository } from "../persistence/friday-workflow-builder-spec-version-repository.js";
import { createFridayWorkflowBuilderTestRunRepository } from "../persistence/friday-workflow-builder-test-run-repository.js";
import { createFridayWorkflowBuilderLockRepository } from "../persistence/friday-workflow-builder-lock-repository.js";

import { createFridayWorkflowBuilderCollaborationService } from "../services/friday-workflow-builder-collaboration-service.js";
import type { FridayWorkflowBuilderCollaborationService } from "../services/friday-workflow-builder-collaboration-service.js";
import { createFridayWorkflowBuilderDraftService } from "../services/friday-workflow-builder-draft-service.js";
import type { FridayWorkflowBuilderDraftService } from "../services/friday-workflow-builder-draft-service.js";
import { createFridayWorkflowBuilderTemplateService } from "../services/friday-workflow-builder-template-service.js";
import type { FridayWorkflowBuilderTemplateService } from "../services/friday-workflow-builder-template-service.js";
import { createFridayWorkflowBuilderValidationService } from "../services/friday-workflow-builder-validation-service.js";
import type { FridayWorkflowBuilderValidationService } from "../services/friday-workflow-builder-validation-service.js";
import { createFridayWorkflowBuilderTestRunnerService } from "../services/friday-workflow-builder-test-runner-service.js";
import type { FridayWorkflowBuilderTestRunnerService } from "../services/friday-workflow-builder-test-runner-service.js";
import { createFridayWorkflowBuilderImportExportService } from "../services/friday-workflow-builder-import-export-service.js";
import type { FridayWorkflowBuilderImportExportService } from "../services/friday-workflow-builder-import-export-service.js";
import { createFridayWorkflowBuilderCompositorService } from "../services/friday-workflow-builder-compositor-service.js";
import type { FridayWorkflowBuilderCompositorService } from "../services/friday-workflow-builder-compositor-service.js";
import { getFridayBuiltinWorkflowTemplates } from "../templates/friday-workflow-builder-builtin-templates.js";


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
  skillRegistry?: FridaySkillRegistry;
  skillRepo?: FridaySkillRepository;
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
    skillRepo: deps.skillRepo,
    skillRegistry: deps.skillRegistry,
    idGenerator: deps.idGenerator,
    nowIso: deps.nowIso,
  });

  const validation = createFridayWorkflowBuilderValidationService({
    compiler,
    validator,
    db: deps.db,
    skillRepo: deps.skillRepo,
    skillRegistry: deps.skillRegistry,
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
