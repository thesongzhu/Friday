import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowArtifactRepository } from "#workflows";
import { createFridayWorkflowArtifactWriter } from "#workflows";
import { createTestDb, createTestIdGenerator } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowArtifactWriter", () => {
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

  function createWriter() {
    const artifactRepo = createFridayWorkflowArtifactRepository();
    return createFridayWorkflowArtifactWriter({
      db,
      artifactRepo,
      idGenerator: createTestIdGenerator(),
      nowIso: () => NOW,
    });
  }

  it("writes small JSON artifact as data URI", () => {
    const writer = createWriter();
    const entity = writer.writeJsonArtifact("run-1", "node-A", { x: 1 });

    expect(entity.artifactType).toBe("json");
    expect(entity.uri).toMatch(/^data:application\/json;base64,/);
    expect(entity.checksum).toBeTruthy();
    expect(entity.runId).toBe("run-1");
    expect(entity.nodeId).toBe("node-A");
  });

  it("writes large JSON artifact with file URI", () => {
    const writer = createWriter();
    // Create a payload > 64KB
    const largeObj = { data: "x".repeat(70 * 1024) };
    const entity = writer.writeJsonArtifact("run-1", "node-B", largeObj);

    expect(entity.artifactType).toBe("json");
    expect(entity.uri).toMatch(/^file:\/\/artifacts\//);
    expect(entity.checksum).toBeTruthy();
  });

  it("computes correct SHA-256 checksum", () => {
    const writer = createWriter();
    const entity = writer.writeJsonArtifact("run-1", "node-A", { test: true });

    // Checksum should be a 64-char hex string
    expect(entity.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it("writes non-JSON artifact", () => {
    const writer = createWriter();
    const entity = writer.writeArtifact(
      "run-1",
      "node-A",
      "image",
      "file:///tmp/screenshot.png",
      "abc123",
      { width: 1920, height: 1080 },
    );

    expect(entity.artifactType).toBe("image");
    expect(entity.uri).toBe("file:///tmp/screenshot.png");
    expect(entity.checksum).toBe("abc123");
    expect(entity.metadata).toEqual({ width: 1920, height: 1080 });
  });
});
