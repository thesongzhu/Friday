import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";

import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import { createFridayChannelAdapterUpgradeLifecycleService } from "../../../src/autonomy/services/friday-channel-adapter-upgrade-lifecycle-service.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayChannelAdapterUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("tracks shadow, canary, promote, and rollback metadata for channel adapters", () => {
    const repo = createFridayAutonomySubjectUpgradeStateRepository();
    const service = createFridayChannelAdapterUpgradeLifecycleService({
      db,
      stateRepo: repo,
      channelRegistry: {
        describe: (kind: string) => kind === "webchat"
          ? {
              kind: "webchat",
              running: true,
              status: "connected",
              health: {
                state: "connected",
                restartCount: 0,
                credentialStatus: "unknown",
              },
              diagnostics: { authMode: "none" },
              allowlist: {
                hasAllowedUsers: false,
                allowedUsersCount: 0,
                hasAllowedChats: false,
                allowedChatsCount: 0,
              },
            }
          : undefined,
      },
      nowIso: () => "2026-04-17T22:20:00.000Z",
    });

    service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });

    let state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("shadow");
    expect(state?.shadowVersionId).toBe("webchat@shadow");

    service.recordCanaryResult({
      channelKind: "webchat",
      success: true,
    });
    state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("canary");
    expect(state?.canaryStats?.sampleSize).toBe(1);

    service.promote({
      channelKind: "webchat",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("active");
    expect(state?.lastVerifiedAt).toBe("2026-04-17T22:20:00.000Z");

    service.rollback({
      channelKind: "webchat",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
    });
    state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("rolled_back");
    expect(state?.compatibilityStatus).toBe("adaptation_required");
    expect(state?.canaryStats?.rollbackCount).toBe(1);
  });
});
