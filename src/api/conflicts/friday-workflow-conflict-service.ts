import type {
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
  FridayWorkflowConflictEntity,
  FridayWorkflowConflictStatus,
  FridayWorkflowDraftEntity,
} from "../model/friday-api-workflow.types.js";
import type { FridayWorkflowSpecV1, FridayWorkflowVisualGraphV1, UUID } from "#workflows";
import type {
  CreateFridayWorkflowConflictServiceDeps,
  FridayDetectConflictInput,
  FridayWorkflowConflictService,
} from "./friday-workflow-conflict-service.types.js";
import { createFridayWorkflowConflictRepository } from "../persistence/friday-workflow-conflict-repository.js";
import { FridayDomainError } from "#errors";

// ─── Error ───

export class FridayConflictServiceError extends FridayDomainError {
  override readonly name = "FridayConflictServiceError";
  constructor(code: string, message: string) {
    super(code, message, { httpStatus: 409 });
  }
}

// ─── Factory ───

export function createFridayWorkflowConflictService(
  deps: CreateFridayWorkflowConflictServiceDeps,
): FridayWorkflowConflictService {
  const repo = createFridayWorkflowConflictRepository();

  return {
    detectConflict(input) {
      // Check if a base version was expected but the head has moved on
      if (!input.baseWorkflowVersionId) {
        return null; // No base = no conflict to detect
      }

      if (input.baseWorkflowVersionId === input.headWorkflowVersionId) {
        return null; // Base matches head, no conflict
      }

      const now = deps.nowIso();
      const entity: FridayWorkflowConflictEntity = {
        conflictId: deps.idGenerator(),
        workflowId: input.workflowId,
        draftId: input.draftId,
        kind: "revision_conflict",
        status: "open",
        baseWorkflowVersionId: input.baseWorkflowVersionId,
        headWorkflowVersionId: input.headWorkflowVersionId,
        detectedAt: now,
        summary: input.summary,
        patches: [],
      };

      deps.db.withWriteTransaction((db) => {
        repo.create(db, entity, now);
      });

      return entity;
    },

    listConflicts(workflowId, status, limit, cursor) {
      return deps.db.withReadConnection((db) =>
        repo.listByWorkflow(db, workflowId, status, limit, cursor),
      );
    },

    getConflict(conflictId) {
      return deps.db.withReadConnection((db) => repo.findById(db, conflictId));
    },

    resolveConflict(conflictId, request, resolvedByUserId) {
      const conflict = deps.db.withReadConnection((db) => repo.findById(db, conflictId));

      if (!conflict) {
        throw new FridayConflictServiceError("CONFLICT_NOT_FOUND", `Conflict ${conflictId} not found`);
      }

      if (conflict.status !== "open") {
        throw new FridayConflictServiceError(
          "ALREADY_RESOLVED",
          `Conflict ${conflictId} is already ${conflict.status}`,
        );
      }

      // Validate lock token ownership
      const lockRow = deps.db.withReadConnection((db) =>
        (db
          .prepare(
            "SELECT lock_token, owner_user_id, expires_at FROM workflow_locks WHERE workflow_id = ? AND lock_token = ?",
          )
          .get(conflict.workflowId, request.lockToken) as {
          lock_token: string;
          owner_user_id: string;
          expires_at: string;
        } | undefined),
      );

      if (!lockRow) {
        throw new FridayConflictServiceError("LOCK_NOT_FOUND", `Lock token '${request.lockToken}' not found for workflow`);
      }

      if (resolvedByUserId && lockRow.owner_user_id !== resolvedByUserId) {
        throw new FridayConflictServiceError("LOCK_OWNER_MISMATCH", "Lock token does not belong to the resolving user");
      }

      const now = deps.nowIso();

      if (new Date(lockRow.expires_at) < new Date(now)) {
        throw new FridayConflictServiceError("LOCK_EXPIRED", "Lock has expired");
      }

      // Validate expected draft revision
      const draftRow = deps.db.withReadConnection((db) =>
        (db
          .prepare("SELECT revision, spec_json, visual_json, title FROM workflow_builder_drafts WHERE draft_id = ?")
          .get(conflict.draftId) as {
          revision: number;
          spec_json: string;
          visual_json: string;
          title: string;
        } | undefined),
      );

      if (draftRow && draftRow.revision !== request.expectedDraftRevision) {
        throw new FridayConflictServiceError(
          "REVISION_MISMATCH",
          `Expected draft revision ${request.expectedDraftRevision} but found ${draftRow.revision}`,
        );
      }

      // Apply resolution strategy and persist
      const result = deps.db.withWriteTransaction((db) => {
        const resolved = repo.resolve(db, conflictId, resolvedByUserId, now);
        if (!resolved) {
          throw new FridayConflictServiceError("RESOLVE_FAILED", "Failed to resolve conflict");
        }

        const newRevision = (draftRow?.revision ?? request.expectedDraftRevision) + 1;
        const strategy = request.resolution.strategy;

        let specJson: string;
        let visualJson: string;
        let title: string;

        if (strategy === "accept_local") {
          // Keep local draft as-is — use existing draft state
          specJson = draftRow?.spec_json ?? JSON.stringify({
            specVersion: "1.0",
            name: "resolved-local",
            trigger: { type: "manual" },
            steps: [],
          });
          visualJson = draftRow?.visual_json ?? JSON.stringify({
            viewport: { x: 0, y: 0, zoom: 1 },
            panels: { leftOpen: true, rightOpen: true, bottomOpen: false },
            nodes: [],
            edges: [],
            groups: [],
          });
          title = draftRow?.title ?? "Resolved draft (local)";
        } else if (strategy === "accept_remote") {
          // Replace with head version content
          const headVersion = db
            .prepare("SELECT graph_json FROM workflow_versions WHERE id = ?")
            .get(conflict.headWorkflowVersionId) as { graph_json: string } | undefined;
          specJson = headVersion?.graph_json ?? JSON.stringify({
            specVersion: "1.0",
            name: "resolved-remote",
            trigger: { type: "manual" },
            steps: [],
          });
          visualJson = draftRow?.visual_json ?? JSON.stringify({
            viewport: { x: 0, y: 0, zoom: 1 },
            panels: { leftOpen: true, rightOpen: true, bottomOpen: false },
            nodes: [],
            edges: [],
            groups: [],
          });
          title = draftRow?.title ?? "Resolved draft (remote)";
        } else {
          // manual_merge - use provided merged content
          const mergeReq = request.resolution as {
            strategy: "manual_merge";
            mergedSpec: FridayWorkflowSpecV1;
            mergedVisual: FridayWorkflowVisualGraphV1;
          };
          specJson = JSON.stringify(mergeReq.mergedSpec);
          visualJson = JSON.stringify(mergeReq.mergedVisual);
          title = draftRow?.title ?? "Resolved draft (merged)";
        }

        // Persist resolved draft state
        db.prepare(
          `UPDATE workflow_builder_drafts
           SET revision = ?, spec_json = ?, visual_json = ?, updated_at = ?
           WHERE draft_id = ?`,
        ).run(newRevision, specJson, visualJson, now, conflict.draftId);

        const draft: FridayWorkflowDraftEntity = {
          draftId: conflict.draftId,
          workflowId: conflict.workflowId,
          title,
          status: "active",
          revision: newRevision,
          spec: JSON.parse(specJson),
          visual: JSON.parse(visualJson),
          createdAt: conflict.detectedAt,
          updatedAt: now,
          autosave: { enabled: false, intervalMs: 30_000 },
        };

        return { conflict: resolved, draft };
      });

      return result;
    },
  };
}
