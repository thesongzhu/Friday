import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridaySkillRepository } from "#skills";

import { createTestDb, NOW } from "./marketplace.helper.js";

describe("FridaySkillRepository", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("persists autonomy upgrade metadata for installed skills", () => {
    const repo = createFridaySkillRepository();

    db.withWriteTransaction((conn) => {
      repo.upsertSkillFromMarketplace(conn, {
        id: "skill-1",
        name: "Test Skill",
        source: "marketplace",
        origin: "managed",
        latestVersion: "1.0.0",
        status: "not_installed",
        nowIso: NOW,
      });
    });

    const updated = db.withWriteTransaction((conn) =>
      repo.setUpgradeMetadata(
        conn,
        "skill-1",
        {
          lastVerifiedAt: "2026-04-17T20:00:00.000Z",
          lastVerifiedRuntimeVersion: "f27377c",
          lastVerifiedProviderModel: "claude-sonnet-4-20250514",
          compatibilityStatus: "adaptation_required",
          promotionChannel: "shadow",
          shadowVersionId: "skill-1-shadow-v2",
          canaryStats: {
            sampleSize: 5,
            successCount: 4,
            failureCount: 1,
            rollbackCount: 0,
            lastEvaluatedAt: "2026-04-17T20:05:00.000Z",
          },
        },
        "2026-04-17T20:05:00.000Z",
      ),
    );

    expect(updated).not.toBeNull();
    expect(updated!.lastVerifiedAt).toBe("2026-04-17T20:00:00.000Z");
    expect(updated!.lastVerifiedRuntimeVersion).toBe("f27377c");
    expect(updated!.lastVerifiedProviderModel).toBe("claude-sonnet-4-20250514");
    expect(updated!.compatibilityStatus).toBe("adaptation_required");
    expect(updated!.promotionChannel).toBe("shadow");
    expect(updated!.shadowVersionId).toBe("skill-1-shadow-v2");
    expect(updated!.canaryStats).toEqual({
      sampleSize: 5,
      successCount: 4,
      failureCount: 1,
      rollbackCount: 0,
      lastEvaluatedAt: "2026-04-17T20:05:00.000Z",
    });
  });
});
