import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
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
      if (!draft) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

      const validation = deps.validationService.validateDraft(draft);

      if (!validation.compiledGraphPreview) {
        throw new FridayDomainError("DRAFT_COMPILATION_FAILED", "Draft compilation failed", { httpStatus: 400 });
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
      if (!draft) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

      // 2b. Assert draft belongs to the target workflow
      if (draft.workflowId !== input.workflowId) {
        throw new FridayDomainError("DRAFT_WORKFLOW_MISMATCH", "Draft does not belong to the specified workflow", { httpStatus: 400 });
      }
      if (draft.sourceReview?.requiresReviewBeforePublish && input.externalReviewConfirmed !== true) {
        throw new FridayDomainError(
          "WORKFLOW_EXTERNAL_DRAFT_REVIEW_REQUIRED",
          "Externally imported workflow drafts require explicit review confirmation before publish or deploy.",
          {
            httpStatus: 403,
            details: {
              draftId: draft.draftId,
              workflowId: draft.workflowId,
              source: draft.sourceReview.source,
              sourceUrl: draft.sourceReview.sourceUrl,
            },
          },
        );
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
