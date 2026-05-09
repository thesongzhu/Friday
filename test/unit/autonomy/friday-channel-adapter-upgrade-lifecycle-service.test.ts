import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FridaySqliteLayer } from "#state";

import { createFridayAutonomySubjectUpgradeStateRepository } from "../../../src/autonomy/persistence/friday-autonomy-subject-upgrade-state-repository.js";
import {
  createFridayChannelAdapterLifecycleMutatingActionRequest,
  createFridayChannelAdapterUpgradeLifecycleService,
} from "../../../src/autonomy/services/friday-channel-adapter-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";
import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayChannelAdapterUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;
  let stateDir: string;
  let ticketCounter = 0;
  const PLAN_DIGEST = "channel-plan-1";
  const runtimeVersion = "f27377c";
  const providerModel = "claude-sonnet-4-20250514";
  const actor = {
    kind: "user",
    id: "user-1",
    principalId: "user-1",
  };

  beforeEach(() => {
    db = createTestDb();
    stateDir = mkdtempSync(join(tmpdir(), "friday-channel-lifecycle-"));
    ticketCounter = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function makeApproval(input: {
    action: "shadow" | "canary" | "promote" | "rollback";
    shadowVersionId?: string;
    runtimeVersion?: string;
    providerModel?: string;
    surface: string;
  }): FridayCanonicalApprovalResolution {
    const request = createFridayChannelAdapterLifecycleMutatingActionRequest({
      action: input.action,
      channelKind: "webchat",
      shadowVersionId: input.shadowVersionId ?? "webchat@shadow",
      runtimeVersion: input.runtimeVersion ?? runtimeVersion,
      providerModel: input.providerModel ?? providerModel,
      actor,
      surface: input.surface,
      planDigest: PLAN_DIGEST,
      rollback: input.action === "rollback"
        ? { planned: true, planDigest: PLAN_DIGEST, actions: ["channel_adapters.lifecycle.promote"] }
        : undefined,
    });
    return {
      decision: "approved",
      approvalId: `channel-${input.action}-approval`,
      decidedByPrincipalId: "user-1",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-04-17T23:20:00.000Z",
    };
  }

  function createService(options: { connected?: boolean; stateDir?: string | null } = {}) {
    const repo = createFridayAutonomySubjectUpgradeStateRepository();
    const connected = options.connected ?? true;
    const service = createFridayChannelAdapterUpgradeLifecycleService({
      db,
      stateRepo: repo,
      channelRegistry: {
        describe: (kind: string) => kind === "webchat"
          ? {
              kind: "webchat",
              running: connected,
              status: connected ? "connected" : "disconnected",
              health: {
                state: connected ? "connected" : "disconnected",
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
      ...(options.stateDir === null ? {} : { stateDir: options.stateDir ?? stateDir }),
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => "2026-04-17T22:20:00.000Z",
        ticketIdGenerator: () => `ticket-${String(++ticketCounter)}`,
      }),
    });
    return { repo, service };
  }

  it("requires canonical approval before channel shadow can mutate", () => {
    const { repo, service } = createService();

    expect(() => service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:shadow",
      planDigest: PLAN_DIGEST,
    })).toThrow("requires canonical approval");

    const state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state).toBeNull();
  });

  it("requires durable evidence storage before channel lifecycle mutation", () => {
    const { repo, service } = createService({ stateDir: null });

    expect(() => service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow", surface: "test:shadow" }),
    })).toThrow("require durable evidence storage");

    const state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state).toBeNull();
  });

  it("tracks shadow, runtime canary, promote, rollback metadata, and evidence for channel adapters", () => {
    const { repo, service } = createService();

    service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow", surface: "test:shadow" }),
    });

    let state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("shadow");
    expect(state?.shadowVersionId).toBe("webchat@shadow");

    service.recordCanaryResult({
      channelKind: "webchat",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary", surface: "test:canary" }),
    });
    state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("canary");
    expect(state?.canaryStats?.sampleSize).toBe(1);

    service.promote({
      channelKind: "webchat",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:promote",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "promote", surface: "test:promote" }),
    });
    state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("active");
    expect(state?.lastVerifiedAt).toBe("2026-04-17T22:20:00.000Z");

    service.rollback({
      channelKind: "webchat",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:rollback",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "rollback", surface: "test:rollback" }),
    });
    state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state?.promotionChannel).toBe("rolled_back");
    expect(state?.compatibilityStatus).toBe("adaptation_required");
    expect(state?.canaryStats?.rollbackCount).toBe(1);
    expect(service.getLifecycleEvidence({ channelKind: "webchat" })).toMatchObject({
      channelKind: "webchat",
      canarySuccessCount: 0,
      canaryFailureCount: 0,
      rollbackPointerAvailable: true,
    });
  });

  it("restores previous verification metadata during channel rollback", () => {
    const { repo, service } = createService();
    db.withWriteTransaction((conn) => {
      repo.setUpgradeMetadata(conn, "channel_adapter", "webchat", {
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: "webchat@active",
        canaryStats: {
          sampleSize: 3,
          successCount: 3,
          failureCount: 0,
          rollbackCount: 1,
          lastEvaluatedAt: "2026-04-17T21:00:00.000Z",
        },
        lastVerifiedAt: "2026-04-17T21:00:00.000Z",
        lastVerifiedRuntimeVersion: "runtime-old",
        lastVerifiedProviderModel: "model-old",
      }, "2026-04-17T21:00:00.000Z");
    });

    service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow-2",
      runtimeVersion: "runtime-new",
      providerModel: "model-new",
      actor,
      surface: "test:shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({
        action: "shadow",
        shadowVersionId: "webchat@shadow-2",
        runtimeVersion: "runtime-new",
        providerModel: "model-new",
        surface: "test:shadow",
      }),
    });
    service.recordCanaryResult({
      channelKind: "webchat",
      runtimeVersion: "runtime-new",
      providerModel: "model-new",
      actor,
      surface: "test:canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({
        action: "canary",
        shadowVersionId: "webchat@shadow-2",
        runtimeVersion: "runtime-new",
        providerModel: "model-new",
        surface: "test:canary",
      }),
    });
    service.promote({
      channelKind: "webchat",
      runtimeVersion: "runtime-new",
      providerModel: "model-new",
      actor,
      surface: "test:promote",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({
        action: "promote",
        shadowVersionId: "webchat@shadow-2",
        runtimeVersion: "runtime-new",
        providerModel: "model-new",
        surface: "test:promote",
      }),
    });
    service.rollback({
      channelKind: "webchat",
      runtimeVersion: "runtime-new",
      providerModel: "model-new",
      actor,
      surface: "test:rollback",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({
        action: "rollback",
        shadowVersionId: "webchat@shadow-2",
        runtimeVersion: "runtime-new",
        providerModel: "model-new",
        surface: "test:rollback",
      }),
    });

    const state = db.withReadConnection((conn) => repo.get(conn, "channel_adapter", "webchat"));
    expect(state).toMatchObject({
      compatibilityStatus: "compatible",
      promotionChannel: "active",
      shadowVersionId: "webchat@active",
      lastVerifiedAt: "2026-04-17T21:00:00.000Z",
      lastVerifiedRuntimeVersion: "runtime-old",
      lastVerifiedProviderModel: "model-old",
    });
    expect(state?.canaryStats).toMatchObject({
      sampleSize: 3,
      successCount: 3,
      failureCount: 0,
      rollbackCount: 2,
      lastEvaluatedAt: "2026-04-17T22:20:00.000Z",
    });
  });

  it("records failed runtime canary evidence and blocks promote", () => {
    const { service } = createService({ connected: false });

    service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow", surface: "test:shadow" }),
    });

    expect(() => service.recordCanaryResult({
      channelKind: "webchat",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary", surface: "test:canary" }),
    })).toThrow("failed lifecycle canary smoke");

    expect(() => service.promote({
      channelKind: "webchat",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:promote",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "promote", surface: "test:promote" }),
    })).toThrow("requires at least one successful canary");
    expect(service.getLifecycleEvidence({ channelKind: "webchat" })).toMatchObject({
      canarySuccessCount: 0,
      canaryFailureCount: 1,
      runtimeStatus: "disconnected",
    });
  });

  it("does not let a canary for one runtime promote a different runtime", () => {
    const { service } = createService();

    service.registerShadowVersion({
      channelKind: "webchat",
      shadowVersionId: "webchat@shadow",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow", surface: "test:shadow" }),
    });
    service.recordCanaryResult({
      channelKind: "webchat",
      runtimeVersion,
      providerModel,
      actor,
      surface: "test:canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary", surface: "test:canary" }),
    });

    expect(() => service.promote({
      channelKind: "webchat",
      runtimeVersion: "different-runtime",
      providerModel,
      actor,
      surface: "test:promote",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({
        action: "promote",
        runtimeVersion: "different-runtime",
        surface: "test:promote",
      }),
    })).toThrow("same shadow/runtime/provider tuple");
  });
});
