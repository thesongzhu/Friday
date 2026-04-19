import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type { FridayWorkflowRepository } from "../persistence/friday-workflow-repository.js";
import type {
  FridayWorkflowCreateInput,
  FridayWorkflowEntity,
  FridayWorkflowListInput,
  FridayWorkflowUpdateInput,
  JsonValue,
  FridayWorkflowVersionEntity,
  UUID,
} from "../model/friday-workflow.types.js";
import {
  type FridayCompiledWorkflowGraphV2,
  validateGraphStructure,
} from "../model/friday-workflow-graph.types.js";
import { createFridayWorkflowValidator } from "../compiler/friday-workflow-validator.js";

// ─── Interface ───

export interface FridayWorkflowCrudService {
  createWorkflow(input: FridayWorkflowCreateInput): FridayWorkflowEntity;
  getWorkflow(id: UUID): FridayWorkflowEntity | null;
  getWorkflowBySlug(slug: string): FridayWorkflowEntity | null;
  listWorkflows(input?: FridayWorkflowListInput): FridayWorkflowEntity[];
  updateWorkflow(input: FridayWorkflowUpdateInput): FridayWorkflowEntity;
  /**
   * Update workflow metadata and create a new graph version in a single transaction.
   * Prevents partial updates where metadata changes but version creation fails.
   */
  updateWorkflowWithGraph(
    input: FridayWorkflowUpdateInput,
    graph: FridayCompiledWorkflowGraphV2 | Record<string, unknown>,
    createdByUserId?: UUID,
    changeNote?: string,
  ): { workflow: FridayWorkflowEntity; version: FridayWorkflowVersionEntity };
  archiveWorkflow(id: UUID, deletedBy: string): void;
  /**
   * Create a workflow and its initial version in a single transaction.
   * Prevents orphan workflow rows when version creation fails.
   */
  createWorkflowWithVersion(
    input: FridayWorkflowCreateInput,
    graph: FridayCompiledWorkflowGraphV2 | Record<string, unknown>,
    createdByUserId?: UUID,
    changeNote?: string,
  ): { workflow: FridayWorkflowEntity; version: FridayWorkflowVersionEntity };
  /**
   * Create a new version with a compiled or raw graph.
   * If the graph has `schemaVersion === "2.0"` it is validated as a compiled graph;
   * otherwise it is stored as-is (raw authoring graph).
   */
  createVersion(
    workflowId: UUID,
    compiledGraph: FridayCompiledWorkflowGraphV2 | Record<string, unknown>,
    createdByUserId?: UUID,
    changeNote?: string,
  ): FridayWorkflowVersionEntity;
  publishVersion(
    workflowId: UUID,
    versionNumber?: number,
  ): FridayWorkflowVersionEntity;
  getVersion(versionId: UUID): FridayWorkflowVersionEntity | null;
  listVersions(
    workflowId: UUID,
    limit?: number,
  ): FridayWorkflowVersionEntity[];
  getPublishedVersion(
    workflowId: UUID,
  ): FridayWorkflowVersionEntity | null;
}

// ─── Dependencies ───

export interface CreateWorkflowCrudServiceDeps {
  db: FridaySqliteLayer;
  workflowRepo: FridayWorkflowRepository;
  idGenerator: () => string;
  nowIso: () => string;
  computeChecksum: (content: string) => string;
  computeEtag: () => string;
  onPublish?: (workflowId: string) => Promise<void>;
}

// ─── Factory ───

export function createFridayWorkflowCrudService(
  deps: CreateWorkflowCrudServiceDeps,
): FridayWorkflowCrudService {
  const validator = createFridayWorkflowValidator();

  function assertGraphIsWritable(
    graph: FridayCompiledWorkflowGraphV2 | Record<string, unknown>,
  ): void {
    if (graph == null || typeof graph !== "object" || Array.isArray(graph)) {
      throw new FridayDomainError("INVALID_GRAPH", "Graph must be a non-null object", { httpStatus: 400 });
    }
    const structuralErrors = validateGraphStructure(graph as Record<string, unknown>);
    if (structuralErrors.length > 0) {
      throw new FridayDomainError("INVALID_GRAPH", structuralErrors[0]!, { httpStatus: 400 });
    }

    const isCompiled =
      "schemaVersion" in graph
      && graph.schemaVersion === "2.0"
      && "graph" in graph;
    if (!isCompiled) {
      return;
    }
    const validation = validator.validate(graph as FridayCompiledWorkflowGraphV2);
    if (!validation.valid) {
      const firstError = validation.errors[0]!;
      throw new FridayDomainError(firstError.code, firstError.message, { httpStatus: 400 });
    }
  }

  return {
    createWorkflow(input) {
      const id = deps.idGenerator();
      const etag = deps.computeEtag();
      const nowIso = deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        return deps.workflowRepo.insertWorkflow(db, id, input, etag, nowIso);
      });
    },

    getWorkflow(id) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getWorkflowById(db, id);
      });
    },

    getWorkflowBySlug(slug) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getWorkflowBySlug(db, slug);
      });
    },

    listWorkflows(input) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.listWorkflows(db, input ?? {});
      });
    },

    updateWorkflow(input) {
      const newEtag = deps.computeEtag();
      const nowIso = deps.nowIso();

      return deps.db.withWriteTransaction((db) => {
        return deps.workflowRepo.updateWorkflow(db, input, newEtag, nowIso);
      });
    },

    updateWorkflowWithGraph(input, graph, createdByUserId, changeNote) {
      assertGraphIsWritable(graph);

      const graphJson = JSON.stringify(graph);
      const checksum = deps.computeChecksum(graphJson);
      const newEtag = deps.computeEtag();

      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();
        const workflow = deps.workflowRepo.updateWorkflow(db, input, newEtag, nowIso);
        const versionNumber = deps.workflowRepo.incrementVersionNumber(db, input.workflowId, nowIso);
        const versionId = deps.idGenerator();
        const version = deps.workflowRepo.insertVersion(
          db, versionId, input.workflowId, versionNumber, checksum, graphJson,
          createdByUserId, changeNote, nowIso,
        );
        return { workflow, version };
      });
    },

    archiveWorkflow(id, deletedBy) {
      const nowIso = deps.nowIso();
      deps.db.withWriteTransaction((db) => {
        deps.workflowRepo.archiveWorkflow(db, id, deletedBy, nowIso);
      });
    },

    createWorkflowWithVersion(input, graph, createdByUserId, changeNote) {
      assertGraphIsWritable(graph);

      const graphJson = JSON.stringify(graph);
      const checksum = deps.computeChecksum(graphJson);
      const workflowId = deps.idGenerator();
      const etag = deps.computeEtag();

      return deps.db.withWriteTransaction((db) => {
        const nowIso = deps.nowIso();

        const workflow = deps.workflowRepo.insertWorkflow(db, workflowId, input, etag, nowIso);

        // First version is always #1 — no need to increment since
        // insertWorkflow already sets latest_version_number to 1.
        const versionNumber = 1;
        const versionId = deps.idGenerator();
        const version = deps.workflowRepo.insertVersion(
          db,
          versionId,
          workflowId,
          versionNumber,
          checksum,
          graphJson,
          createdByUserId,
          changeNote,
          nowIso,
        );

        return { workflow, version };
      });
    },

    createVersion(workflowId, compiledGraph, createdByUserId, changeNote) {
      assertGraphIsWritable(compiledGraph);

      const graphJson = JSON.stringify(compiledGraph);
      const checksum = deps.computeChecksum(graphJson);

      return deps.db.withWriteTransaction((db) => {
        const versionNumber = deps.workflowRepo.incrementVersionNumber(
          db,
          workflowId,
          deps.nowIso(),
        );

        const versionId = deps.idGenerator();
        return deps.workflowRepo.insertVersion(
          db,
          versionId,
          workflowId,
          versionNumber,
          checksum,
          graphJson,
          createdByUserId,
          changeNote,
          deps.nowIso(),
        );
      });
    },

    publishVersion(workflowId, versionNumber) {
      const result = deps.db.withWriteTransaction((db) => {
        let version: FridayWorkflowVersionEntity | null;

        if (versionNumber !== undefined) {
          // Find version by number
          const versions = deps.workflowRepo.listVersions(db, workflowId);
          version =
            versions.find((v) => v.versionNumber === versionNumber) ?? null;
        } else {
          // Publish latest version
          version = deps.workflowRepo.getLatestVersion(db, workflowId);
        }

        if (!version) {
          throw new FridayDomainError("WORKFLOW_VERSION_NOT_FOUND", "Workflow version not found", { httpStatus: 404 });
        }

        deps.workflowRepo.publishVersion(
          db,
          workflowId,
          version.id,
          deps.nowIso(),
        );
        deps.workflowRepo.setPublishedVersion(
          db,
          workflowId,
          version.versionNumber,
          deps.nowIso(),
        );

        // Re-fetch to return updated entity
        return deps.workflowRepo.getVersionById(db, version.id)!;
      });

      if (deps.onPublish) {
        // Fire async, don't block the publish response
        deps.onPublish(workflowId).catch((err) => {
          // Trigger sync failure is non-fatal but should be observable
          console.error(`[friday] trigger sync failed for workflow ${workflowId}:`, err);
        });
      }

      return result;
    },

    getVersion(versionId) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getVersionById(db, versionId);
      });
    },

    listVersions(workflowId, limit) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.listVersions(db, workflowId, limit);
      });
    },

    getPublishedVersion(workflowId) {
      return deps.db.withReadConnection((db) => {
        return deps.workflowRepo.getPublishedVersion(db, workflowId);
      });
    },
  };
}
