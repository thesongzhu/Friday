import { createHash } from "node:crypto";
import type { FridaySqliteLayer } from "#state";
import type { FridayWorkflowArtifactRepository } from "../persistence/friday-workflow-artifact-repository.js";
import type { FridayWorkflowArtifactEntity, UUID } from "../model/friday-workflow.types.js";

// ─── Interface ───

export interface FridayWorkflowArtifactWriter {
  writeJsonArtifact(
    runId: UUID,
    nodeId: string,
    output: unknown,
  ): FridayWorkflowArtifactEntity;

  writeArtifact(
    runId: UUID,
    nodeId: string,
    artifactType: string,
    uri: string,
    checksum?: string,
    metadata?: Record<string, unknown>,
  ): FridayWorkflowArtifactEntity;
}

// ─── Dependencies ───

export interface CreateArtifactWriterDeps {
  db: FridaySqliteLayer;
  artifactRepo: FridayWorkflowArtifactRepository;
  idGenerator: () => string;
  nowIso: () => string;
}

// ─── Size threshold for inline vs file storage ───

const INLINE_THRESHOLD = 64 * 1024; // 64KB

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

// ─── Factory ───

export function createFridayWorkflowArtifactWriter(
  deps: CreateArtifactWriterDeps,
): FridayWorkflowArtifactWriter {
  return {
    writeJsonArtifact(runId, nodeId, output) {
      const serialized = JSON.stringify(output);
      const checksum = sha256(serialized);

      let uri: string;
      if (serialized.length < INLINE_THRESHOLD) {
        // Small payload: store inline as data URI
        const encoded = Buffer.from(serialized).toString("base64");
        uri = `data:application/json;base64,${encoded}`;
      } else {
        // Large payload: reference a conceptual file path
        uri = `file://artifacts/${runId}/${nodeId}.json`;
      }

      const nowIso = deps.nowIso();
      const entity: FridayWorkflowArtifactEntity = {
        id: deps.idGenerator(),
        runId,
        nodeId,
        artifactType: "json",
        uri,
        checksum,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      deps.db.withWriteTransaction((db) => {
        deps.artifactRepo.insertArtifact(db, entity);
      });

      return entity;
    },

    writeArtifact(runId, nodeId, artifactType, uri, checksum, metadata) {
      const nowIso = deps.nowIso();
      const entity: FridayWorkflowArtifactEntity = {
        id: deps.idGenerator(),
        runId,
        nodeId,
        artifactType: artifactType as FridayWorkflowArtifactEntity["artifactType"],
        uri,
        checksum,
        metadata: metadata as FridayWorkflowArtifactEntity["metadata"],
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      deps.db.withWriteTransaction((db) => {
        deps.artifactRepo.insertArtifact(db, entity);
      });

      return entity;
    },
  };
}
