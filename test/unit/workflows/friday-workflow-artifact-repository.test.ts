import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowArtifactRepository } from "#workflows";
import type { FridayWorkflowArtifactEntity } from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowArtifactRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    // Insert workflow, version, and run for FK constraints
    db.writer
      .prepare(
        `INSERT INTO workflows (id, slug, name, latest_version_number, is_archived, revision, etag, created_at, updated_at)
         VALUES ('wf-1', 'test-wf', 'Test', 1, 0, 1, 'etag', ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_versions (id, workflow_id, version_number, checksum, graph_json, is_published, created_at, updated_at)
         VALUES ('wv-1', 'wf-1', 1, 'cs', '{}', 1, ?, ?)`,
      )
      .run(NOW, NOW);
    db.writer
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, workflow_version_id, status, trigger_type, started_at, created_at, updated_at)
         VALUES ('run-1', 'wf-1', 'wv-1', 'running', 'manual', ?, ?, ?)`,
      )
      .run(NOW, NOW, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowArtifactRepository();
  }

  function makeArtifact(
    overrides: Partial<FridayWorkflowArtifactEntity> = {},
  ): FridayWorkflowArtifactEntity {
    return {
      id: "art-1",
      runId: "run-1",
      nodeId: "node-A",
      artifactType: "json",
      uri: "data:application/json;base64,eyJ4IjoxfQ==",
      checksum: "abc123",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("inserts and gets an artifact", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact());
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getArtifactById(conn, "art-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.artifactType).toBe("json");
    expect(fetched!.uri).toContain("data:application/json");
  });

  it("lists artifacts by run", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact({ id: "art-1", nodeId: "node-A" }));
      repo.insertArtifact(conn, makeArtifact({ id: "art-2", nodeId: "node-B" }));
    });

    const artifacts = db.withReadConnection((conn) =>
      repo.listArtifactsByRun(conn, "run-1"),
    );
    expect(artifacts).toHaveLength(2);
  });

  it("lists artifacts by run + nodeId", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact({ id: "art-1", nodeId: "node-A" }));
      repo.insertArtifact(conn, makeArtifact({ id: "art-2", nodeId: "node-B" }));
    });

    const artifacts = db.withReadConnection((conn) =>
      repo.listArtifactsByRun(conn, "run-1", "node-A"),
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.nodeId).toBe("node-A");
  });

  it("deletes artifacts by run and returns count", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertArtifact(conn, makeArtifact({ id: "art-1" }));
      repo.insertArtifact(conn, makeArtifact({ id: "art-2", nodeId: "node-B" }));
    });

    const count = db.withWriteTransaction((conn) =>
      repo.deleteArtifactsByRun(conn, "run-1"),
    );
    expect(count).toBe(2);

    const remaining = db.withReadConnection((conn) =>
      repo.listArtifactsByRun(conn, "run-1"),
    );
    expect(remaining).toHaveLength(0);
  });
});
