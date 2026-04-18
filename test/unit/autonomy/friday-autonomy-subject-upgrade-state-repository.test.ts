import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";

import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayAutonomySubjectUpgradeStateRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("persists and merges runtime-only subject upgrade metadata", () => {
    const repo = createFridayAutonomySubjectUpgradeStateRepository();

    db.withWriteTransaction((conn) => {
      repo.setUpgradeMetadata(conn, "mcp_server", "stdio-echo", {
        compatibilityStatus: "adaptation_required",
        promotionChannel: "shadow",
        shadowVersionId: "stdio-echo@shadow",
      }, "2026-04-17T22:00:00.000Z");
      repo.setUpgradeMetadata(conn, "mcp_server", "stdio-echo", {
        promotionChannel: "active",
        compatibilityStatus: "compatible",
        canaryStats: {
          sampleSize: 2,
          successCount: 2,
          failureCount: 0,
          rollbackCount: 0,
        },
      }, "2026-04-17T22:05:00.000Z");
    });

    const row = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(row).toMatchObject({
      subjectKind: "mcp_server",
      subjectId: "stdio-echo",
      compatibilityStatus: "compatible",
      promotionChannel: "active",
      shadowVersionId: "stdio-echo@shadow",
      canaryStats: {
        sampleSize: 2,
        successCount: 2,
        failureCount: 0,
        rollbackCount: 0,
      },
    });

    const rows = db.withReadConnection((conn) => repo.list(conn, { subjectKind: "mcp_server" }));
    expect(rows).toHaveLength(1);
  });
});
