import type { FridaySqliteLayer } from "#state";
import type { UUID } from "#workflows";
import type {
  FridayResolveWorkflowConflictRequest,
  FridayResolveWorkflowConflictResponse,
  FridayWorkflowConflictEntity,
  FridayWorkflowConflictStatus,
} from "../model/friday-api-workflow.types.js";

export interface FridayWorkflowConflictService {
  detectConflict(input: FridayDetectConflictInput): FridayWorkflowConflictEntity | null;
  listConflicts(
    workflowId: UUID,
    status?: FridayWorkflowConflictStatus,
    limit?: number,
    cursor?: string,
  ): FridayWorkflowConflictEntity[];
  getConflict(conflictId: UUID): FridayWorkflowConflictEntity | null;
  resolveConflict(
    conflictId: UUID,
    request: FridayResolveWorkflowConflictRequest,
    resolvedByUserId?: UUID,
  ): FridayResolveWorkflowConflictResponse;
}

export interface FridayDetectConflictInput {
  workflowId: UUID;
  draftId: UUID;
  baseWorkflowVersionId?: UUID;
  headWorkflowVersionId: UUID;
  summary: string;
}

export interface CreateFridayWorkflowConflictServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
}
