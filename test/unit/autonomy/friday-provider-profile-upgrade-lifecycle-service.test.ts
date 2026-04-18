import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayProviderProfileRepository } from "#providers";
import { createFridayProviderProfileUpgradeLifecycleService } from "../../../src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";

import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayProviderProfileUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    db.withWriteTransaction((conn) => {
      createFridayProviderProfileRepository().insert(conn, {
        id: "provider-1",
        kind: "anthropic",
        name: "Anthropic Deep Proof",
        baseUrl: "https://api.anthropic.com",
        enabled: true,
        defaultModel: "claude-sonnet-4-20250514",
        config: {
          api: "anthropic-messages",
          authMode: "api-key",
          keySource: { kind: "env-ref", envVar: "FRIDAY_ANTHROPIC_API_KEY" },
          supportedModels: ["claude-sonnet-4-20250514"],
          validation: { status: "ok" },
        },
        createdAt: "2026-04-17T20:00:00.000Z",
        updatedAt: "2026-04-17T20:00:00.000Z",
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  it("tracks shadow, canary, promote, and rollback metadata for provider profiles", () => {
    const providerProfileRepo = createFridayProviderProfileRepository();
    const service = createFridayProviderProfileUpgradeLifecycleService({
      db,
      providerProfileRepo,
      nowIso: () => "2026-04-17T21:00:00.000Z",
    });

    const shadowed = service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.shadowVersionId).toBe("provider-1@shadow");

    const canary = service.recordCanaryResult({
      providerId: "provider-1",
      success: true,
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.sampleSize).toBe(1);
    expect(canary.canaryStats?.successCount).toBe(1);

    const promoted = service.promote({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.lastVerifiedAt).toBe("2026-04-17T21:00:00.000Z");

    const rolledBack = service.rollback({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(rolledBack.promotionChannel).toBe("rolled_back");
    expect(rolledBack.compatibilityStatus).toBe("adaptation_required");
    expect(rolledBack.shadowVersionId).toBeUndefined();
    expect(rolledBack.canaryStats?.rollbackCount).toBe(1);
  });
});
