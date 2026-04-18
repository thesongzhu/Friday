import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";

import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import { createFridayMcpServerUpgradeLifecycleService } from "../../../src/autonomy/services/friday-mcp-server-upgrade-lifecycle-service.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayMcpServerUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("tracks shadow, canary, promote, and rollback metadata for MCP servers", () => {
    const repo = createFridayAutonomySubjectUpgradeStateRepository();
    const service = createFridayMcpServerUpgradeLifecycleService({
      db,
      stateRepo: repo,
      mcpAdapter: {
        listServers: () => [{ id: "stdio-echo", transport: "stdio", command: "node", args: ["server.js"] }],
      },
      nowIso: () => "2026-04-17T22:15:00.000Z",
    });

    service.registerShadowVersion({
      serverId: "stdio-echo",
      shadowVersionId: "stdio-echo@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });

    let state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("shadow");
    expect(state?.shadowVersionId).toBe("stdio-echo@shadow");

    service.recordCanaryResult({
      serverId: "stdio-echo",
      success: true,
    });
    state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("canary");
    expect(state?.canaryStats?.sampleSize).toBe(1);
    expect(state?.canaryStats?.successCount).toBe(1);

    service.promote({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("active");
    expect(state?.lastVerifiedAt).toBe("2026-04-17T22:15:00.000Z");

    service.rollback({
      serverId: "stdio-echo",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    state = db.withReadConnection((conn) => repo.get(conn, "mcp_server", "stdio-echo"));
    expect(state?.promotionChannel).toBe("rolled_back");
    expect(state?.compatibilityStatus).toBe("adaptation_required");
    expect(state?.shadowVersionId).toBeUndefined();
    expect(state?.canaryStats?.rollbackCount).toBe(1);
  });
});
