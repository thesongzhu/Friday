import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridaySkillRepository } from "#skills";
import { createFridaySkillUpgradeLifecycleService } from "../../../src/autonomy/services/friday-skill-upgrade-lifecycle-service.js";

import { createTestDb, NOW } from "../skills/marketplace/marketplace.helper.js";

describe("createFridaySkillUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
    db.withWriteTransaction((conn) => {
      createFridaySkillRepository().upsertSkillFromMarketplace(conn, {
        id: "skill-1",
        name: "Skill 1",
        source: "marketplace",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "installed",
        nowIso: NOW,
      });
    });
  });

  afterEach(() => {
    db.close();
  });

  it("tracks shadow, canary, promote, and rollback metadata for skills", () => {
    const skillRepo = createFridaySkillRepository();
    const service = createFridaySkillUpgradeLifecycleService({
      db,
      skillRepo,
      nowIso: () => "2026-04-17T20:30:00.000Z",
    });

    const shadowed = service.registerShadowVersion({
      skillId: "skill-1",
      shadowVersionId: "2.0.0",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.shadowVersionId).toBe("2.0.0");

    const canary = service.recordCanaryResult({
      skillId: "skill-1",
      success: true,
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.sampleSize).toBe(1);
    expect(canary.canaryStats?.successCount).toBe(1);

    const promoted = service.promote({
      skillId: "skill-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.lastVerifiedAt).toBe("2026-04-17T20:30:00.000Z");

    const rolledBack = service.rollback({
      skillId: "skill-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    expect(rolledBack.promotionChannel).toBe("rolled_back");
    expect(rolledBack.compatibilityStatus).toBe("adaptation_required");
    expect(rolledBack.shadowVersionId).toBeUndefined();
    expect(rolledBack.canaryStats?.rollbackCount).toBe(1);
  });

  it("reports missing skills as a structured not-found error", () => {
    const service = createFridaySkillUpgradeLifecycleService({
      db,
      skillRepo: createFridaySkillRepository(),
      nowIso: () => "2026-04-17T20:30:00.000Z",
    });

    expect(() =>
      service.registerShadowVersion({
        skillId: "missing-skill",
        shadowVersionId: "2.0.0",
        runtimeVersion: "f27377c",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "SKILL_NOT_FOUND",
        httpStatus: 404,
      }),
    );
  });
});
