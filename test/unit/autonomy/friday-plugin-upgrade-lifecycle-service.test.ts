import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayPluginRepository } from "#plugins";
import { createFridayPluginUpgradeLifecycleService } from "../../../src/autonomy/services/friday-plugin-upgrade-lifecycle-service.js";

import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayPluginUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    db.withWriteTransaction((conn) => {
      createFridayPluginRepository().upsertPlugin(conn, {
        id: "friday.test.plugin",
        name: "Test Plugin",
        description: "Plugin upgrade lifecycle test fixture",
        version: "1.0.0",
        source: "local",
        status: "installed",
        enabled: true,
        trustMode: "trust_on_install",
        installPath: "/tmp/friday-test-plugin",
        kinds: ["skill"],
        manifest: {
          schemaVersion: "1.0",
          id: "friday.test.plugin",
          version: "1.0.0",
          name: "Test Plugin",
          description: "Plugin upgrade lifecycle test fixture",
          kinds: ["skill"],
          entrypoints: { skill: "./dist/index.js" },
          permissions: { grants: [], promptOn: [] },
          compatibility: { minHubVersion: "0.1.0", apiVersion: "1" },
        },
        nowIso: "2026-04-17T20:00:00.000Z",
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  it("tracks shadow, canary, promote, and rollback metadata for plugins", () => {
    const pluginRepo = createFridayPluginRepository();
    const service = createFridayPluginUpgradeLifecycleService({
      db,
      pluginRepo,
      nowIso: () => "2026-04-17T21:15:00.000Z",
    });

    const shadowed = service.registerShadowVersion({
      pluginId: "friday.test.plugin",
      shadowVersionId: "friday.test.plugin@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.shadowVersionId).toBe("friday.test.plugin@shadow");

    const canary = service.recordCanaryResult({
      pluginId: "friday.test.plugin",
      success: true,
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.sampleSize).toBe(1);
    expect(canary.canaryStats?.successCount).toBe(1);

    const promoted = service.promote({
      pluginId: "friday.test.plugin",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.lastVerifiedAt).toBe("2026-04-17T21:15:00.000Z");

    const rolledBack = service.rollback({
      pluginId: "friday.test.plugin",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(rolledBack.promotionChannel).toBe("rolled_back");
    expect(rolledBack.compatibilityStatus).toBe("adaptation_required");
    expect(rolledBack.shadowVersionId).toBeNull();
    expect(rolledBack.canaryStats?.rollbackCount).toBe(1);
  });
});
