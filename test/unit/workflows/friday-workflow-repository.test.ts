import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createFridayWorkflowRepository } from "#workflows";
import { createTestDb } from "./_helpers/create-test-db.helper.js";

describe("FridayWorkflowRepository", () => {
  let db: FridaySqliteLayer;
  const NOW = "2025-01-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function createRepo() {
    return createFridayWorkflowRepository({ db });
  }

  it("inserts and gets a workflow", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      const entity = repo.insertWorkflow(
        conn,
        "wf-1",
        { slug: "my-wf", name: "My Workflow", description: "Test" },
        "etag-1",
        NOW,
      );
      expect(entity.id).toBe("wf-1");
      expect(entity.slug).toBe("my-wf");
      expect(entity.name).toBe("My Workflow");
      expect(entity.revision).toBe(1);
      expect(entity.isArchived).toBe(false);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getWorkflowById(conn, "wf-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe("my-wf");
  });

  it("enforces slug uniqueness", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "unique", name: "A" }, "e1", NOW);
    });
    expect(() =>
      db.withWriteTransaction((conn) => {
        repo.insertWorkflow(conn, "wf-2", { slug: "unique", name: "B" }, "e2", NOW);
      }),
    ).toThrow();
  });

  it("updates with correct revision", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });

    const updated = db.withWriteTransaction((conn) =>
      repo.updateWorkflow(
        conn,
        {
          workflowId: "wf-1",
          expectedRevision: 1,
          etag: "e1",
          name: "Updated",
        },
        "e2",
        NOW,
      ),
    );

    expect(updated.name).toBe("Updated");
    expect(updated.revision).toBe(2);
    expect(updated.etag).toBe("e2");
  });

  it("throws on wrong revision", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });

    expect(() =>
      db.withWriteTransaction((conn) =>
        repo.updateWorkflow(
          conn,
          {
            workflowId: "wf-1",
            expectedRevision: 99,
            etag: "e1",
            name: "Updated",
          },
          "e2",
          NOW,
        ),
      ),
    ).toThrow("WORKFLOW_VERSION_CONFLICT");
  });

  it("archives and hides workflow from get", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });
    db.withWriteTransaction((conn) => {
      repo.archiveWorkflow(conn, "wf-1", "user-1", NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getWorkflowById(conn, "wf-1"),
    );
    expect(fetched).toBeNull();
  });

  it("stores autonomy upgrade metadata", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "upgradeable", name: "Upgradeable Workflow" }, "e1", NOW);
    });

    const updated = db.withWriteTransaction((conn) =>
      repo.setUpgradeMetadata(
        conn,
        "wf-1",
        {
          lastVerifiedAt: "2026-04-17T20:00:00.000Z",
          lastVerifiedRuntimeVersion: "f27377c",
          lastVerifiedProviderModel: "claude-sonnet-4-20250514",
          compatibilityStatus: "adaptation_required",
          promotionChannel: "shadow",
          shadowVersionId: "wf-1-vshadow",
          canaryStats: {
            sampleSize: 6,
            successCount: 5,
            failureCount: 1,
            rollbackCount: 0,
            lastEvaluatedAt: "2026-04-17T20:03:00.000Z",
          },
        },
        "2026-04-17T20:03:00.000Z",
      ),
    );

    expect(updated.lastVerifiedRuntimeVersion).toBe("f27377c");
    expect(updated.compatibilityStatus).toBe("adaptation_required");
    expect(updated.promotionChannel).toBe("shadow");
    expect(updated.shadowVersionId).toBe("wf-1-vshadow");
    expect(updated.canaryStats?.sampleSize).toBe(6);
  });

  it("frees archived slug for reuse", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "reusable", name: "A" }, "e1", NOW);
      repo.archiveWorkflow(conn, "wf-1", "user-1", NOW);
      repo.insertWorkflow(conn, "wf-2", { slug: "reusable", name: "B" }, "e2", NOW);
    });

    const fetched = db.withReadConnection((conn) =>
      repo.getWorkflowBySlug(conn, "reusable"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("wf-2");
  });

  it("inserts and gets a version", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
    });

    const version = db.withWriteTransaction((conn) =>
      repo.insertVersion(
        conn,
        "wv-1",
        "wf-1",
        1,
        "checksum-1",
        '{"schemaVersion":"2.0"}',
        undefined,
        undefined,
        NOW,
      ),
    );

    expect(version.id).toBe("wv-1");
    expect(version.versionNumber).toBe(1);

    const fetched = db.withReadConnection((conn) =>
      repo.getVersionById(conn, "wv-1"),
    );
    expect(fetched).not.toBeNull();
    expect(fetched!.versionNumber).toBe(1);
  });

  it("enforces version number uniqueness per workflow", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs", "{}", undefined, undefined, NOW);
    });

    expect(() =>
      db.withWriteTransaction((conn) => {
        repo.insertVersion(conn, "wv-2", "wf-1", 1, "cs2", "{}", undefined, undefined, NOW);
      }),
    ).toThrow();
  });

  it("gets latest version", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);
    });

    const latest = db.withReadConnection((conn) =>
      repo.getLatestVersion(conn, "wf-1"),
    );
    expect(latest!.versionNumber).toBe(2);
  });

  it("publishes version and clears previous", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);

      repo.publishVersion(conn, "wf-1", "wv-1", NOW);
      repo.setPublishedVersion(conn, "wf-1", 1, NOW);
    });

    let published = db.withReadConnection((conn) =>
      repo.getPublishedVersion(conn, "wf-1"),
    );
    expect(published!.versionNumber).toBe(1);

    // Publish version 2, v1 should be unpublished
    db.withWriteTransaction((conn) => {
      repo.publishVersion(conn, "wf-1", "wv-2", NOW);
      repo.setPublishedVersion(conn, "wf-1", 2, NOW);
    });

    published = db.withReadConnection((conn) =>
      repo.getPublishedVersion(conn, "wf-1"),
    );
    expect(published!.versionNumber).toBe(2);

    // v1 should no longer be published
    const v1 = db.withReadConnection((conn) =>
      repo.getVersionById(conn, "wv-1"),
    );
    expect(v1!.isPublished).toBe(false);
  });

  it("lists versions ordered by version_number DESC", () => {
    const repo = createRepo();
    db.withWriteTransaction((conn) => {
      repo.insertWorkflow(conn, "wf-1", { slug: "s", name: "A" }, "e1", NOW);
      repo.insertVersion(conn, "wv-1", "wf-1", 1, "cs1", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-2", "wf-1", 2, "cs2", "{}", undefined, undefined, NOW);
      repo.insertVersion(conn, "wv-3", "wf-1", 3, "cs3", "{}", undefined, undefined, NOW);
    });

    const versions = db.withReadConnection((conn) =>
      repo.listVersions(conn, "wf-1"),
    );
    expect(versions).toHaveLength(3);
    expect(versions[0]!.versionNumber).toBe(3);
    expect(versions[1]!.versionNumber).toBe(2);
    expect(versions[2]!.versionNumber).toBe(1);
  });
});
