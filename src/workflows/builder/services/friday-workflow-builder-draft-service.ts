import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type { UUID } from "../../model/friday-workflow.types.js";
import type { FridayWorkflowSpecV1 } from "../../model/friday-workflow-spec.types.js";
import type { FridayWorkflowVisualGraphV1 } from "../model/friday-workflow-builder-canvas.types.js";
import type {
  FridayWorkflowDraftEntity,
  FridayWorkflowDraftSaveInput,
  FridayWorkflowDraftSourceReview,
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
    sourceReview?: FridayWorkflowDraftSourceReview;
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
        sourceReview: input.sourceReview,
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
        if (!existing) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

        // Assert lock atomically on the SAME writer connection
        deps.collaborationService.assertLockOnConnection(db, existing.workflowId, input.lockToken);

        // Optimistic revision check
        if (existing.revision !== input.expectedRevision) {
          throw new FridayDomainError("DRAFT_VERSION_CONFLICT", "Draft version conflict", { httpStatus: 409 });
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
        if (!draft) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

        // Assert lock atomically on the SAME writer connection
        deps.collaborationService.assertLockOnConnection(db, draft.workflowId, input.lockToken);

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
        if (!draft) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

        // Assert lock atomically on the SAME writer connection
        deps.collaborationService.assertLockOnConnection(db, draft.workflowId, lockToken);

        deps.draftRepo.updateStatus(db, draftId, "archived", deps.nowIso());
      });
    },

    forkDraft(sourceDraftId, newTitle) {
      const source = deps.db.withReadConnection((db) =>
        deps.draftRepo.getById(db, sourceDraftId),
      );
      if (!source) throw new FridayDomainError("DRAFT_NOT_FOUND", "Draft not found", { httpStatus: 404 });

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
        sourceReview: source.sourceReview,
      };

      deps.db.withWriteTransaction((db) => {
        deps.draftRepo.create(db, forked);
      });

      return forked;
    },
  };
}
