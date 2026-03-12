import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type { FridayWorkflowDraftEntity } from "../model/friday-workflow-builder-draft.types.js";
import type {
  FridayWorkflowImportResult,
  FridayWorkflowSpecBundleV1,
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
      if (!draft) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

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
        throw new FridayDomainError("IMPORT_UNSUPPORTED_SCHEMA", `Expected schema version '1.0', got '${bundle.bundleSchemaVersion}'`, { httpStatus: 400 });
      }

      // Verify checksum — reject by default, allow with force flag
      const computedChecksum = computeBundleChecksum(bundle.spec, bundle.visual);
      if (computedChecksum !== bundle.checksum) {
        if (options?.force) {
          warnings.push("Bundle checksum mismatch — content may have been modified (forced import)");
        } else {
          throw new FridayDomainError("IMPORT_CHECKSUM_MISMATCH", "Bundle checksum mismatch — content may have been modified", { httpStatus: 400 });
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
