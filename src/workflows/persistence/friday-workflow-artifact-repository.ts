import type Database from "better-sqlite3";
import { safeJsonParse } from "#utilities";
import type {
  FridayWorkflowArtifactEntity,
  FridayWorkflowArtifactRow,
  JsonObject,
  UUID,
} from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowArtifactRepository {
  insertArtifact(
    db: Database.Database,
    entity: FridayWorkflowArtifactEntity,
  ): void;

  getArtifactById(
    db: Database.Database,
    id: UUID,
  ): FridayWorkflowArtifactEntity | null;

  listArtifactsByRun(
    db: Database.Database,
    runId: UUID,
    nodeId?: string,
  ): FridayWorkflowArtifactEntity[];

  deleteArtifactsByRun(db: Database.Database, runId: UUID): number;
}

// ─── Row mapper ───

function mapArtifactRow(
  row: FridayWorkflowArtifactRow,
): FridayWorkflowArtifactEntity {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    artifactType: row.artifact_type as FridayWorkflowArtifactEntity["artifactType"],
    uri: row.uri,
    checksum: row.checksum ?? undefined,
    metadata: safeJsonParse<JsonObject>(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Factory ───

export function createFridayWorkflowArtifactRepository(): FridayWorkflowArtifactRepository {
  return {
    insertArtifact(db, entity) {
      db.prepare(
        `INSERT INTO workflow_artifacts (id, run_id, node_id, artifact_type, uri, checksum,
         metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entity.id,
        entity.runId,
        entity.nodeId,
        entity.artifactType,
        entity.uri,
        entity.checksum ?? null,
        entity.metadata ? JSON.stringify(entity.metadata) : null,
        entity.createdAt,
        entity.updatedAt,
      );
    },

    getArtifactById(db, id) {
      const row = db
        .prepare("SELECT * FROM workflow_artifacts WHERE id = ?")
        .get(id) as FridayWorkflowArtifactRow | undefined;
      return row ? mapArtifactRow(row) : null;
    },

    listArtifactsByRun(db, runId, nodeId) {
      if (nodeId) {
        return (
          db
            .prepare(
              "SELECT * FROM workflow_artifacts WHERE run_id = ? AND node_id = ? ORDER BY created_at ASC",
            )
            .all(runId, nodeId) as FridayWorkflowArtifactRow[]
        ).map(mapArtifactRow);
      }
      return (
        db
          .prepare(
            "SELECT * FROM workflow_artifacts WHERE run_id = ? ORDER BY created_at ASC",
          )
          .all(runId) as FridayWorkflowArtifactRow[]
      ).map(mapArtifactRow);
    },

    deleteArtifactsByRun(db, runId) {
      const result = db
        .prepare("DELETE FROM workflow_artifacts WHERE run_id = ?")
        .run(runId);
      return result.changes;
    },
  };
}
