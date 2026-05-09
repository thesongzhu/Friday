import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import { createFridayProviderProfileRepository } from "#providers";
import {
  createFridayProviderProfileLifecycleMutatingActionRequest,
  createFridayProviderProfileUpgradeLifecycleService,
} from "../../../src/autonomy/services/friday-provider-profile-upgrade-lifecycle-service.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";

import { createTestDb } from "../satellites/_helpers/create-test-db.helper.js";

describe("createFridayProviderProfileUpgradeLifecycleService", () => {
  let db: FridaySqliteLayer;
  let stateDir: string;
  const PLAN_DIGEST = "plan-provider-1";

  beforeEach(() => {
    db = createTestDb();
    stateDir = mkdtempSync(join(tmpdir(), "friday-provider-lifecycle-"));
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
    rmSync(stateDir, { recursive: true, force: true });
  });

  const actor = {
    kind: "user" as const,
    id: "user-1",
    principalId: "user-1",
  };

  function makeApproval(input: {
    action: "shadow" | "canary" | "promote" | "rollback";
    shadowVersionId?: string;
    runtimeVersion?: string;
    planDigest?: string;
  }): FridayCanonicalApprovalResolution {
    const planDigest = input.planDigest ?? PLAN_DIGEST;
    const request = createFridayProviderProfileLifecycleMutatingActionRequest({
      action: input.action,
      providerId: "provider-1",
      shadowVersionId: input.shadowVersionId ?? "provider-1@shadow",
      runtimeVersion: input.runtimeVersion ?? "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: `api:/v1/autonomy/providers/${input.action}`,
      planDigest,
      rollback: input.action === "rollback"
        ? { planned: true, planDigest, actions: ["providers.lifecycle.promote"] }
        : undefined,
    });
    return {
      decision: "approved",
      approvalId: `${input.action}-approval`,
      decidedByPrincipalId: "user-1",
      actionDigest: createFridayMutatingActionDigest(request),
      expiresAt: "2026-04-17T22:00:00.000Z",
    };
  }

  function createService(options: {
    validateProvider?: ReturnType<typeof vi.fn>;
  } = {}) {
    const providerProfileRepo = createFridayProviderProfileRepository();
    return createFridayProviderProfileUpgradeLifecycleService({
      db,
      providerProfileRepo,
      nowIso: () => "2026-04-17T21:00:00.000Z",
      stateDir,
      validateProvider: options.validateProvider ?? vi.fn(async () => ({
        status: "ok" as const,
        checkedAt: "2026-04-17T21:00:00.000Z",
      })),
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => "2026-04-17T21:00:00.000Z",
        ticketIdGenerator: () => `ticket-${Math.random().toString(36).slice(2)}`,
      }),
    });
  }

  it("requires canonical approval before shadow can mutate provider profiles", () => {
    const service = createService();

    expect(() => service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      planDigest: PLAN_DIGEST,
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/shadow",
    })).toThrow(expect.objectContaining({ code: "CANONICAL_APPROVAL_REQUIRED" }));

    const provider = createFridayProviderProfileRepository().getById(db.writer, "provider-1");
    expect(provider?.promotionChannel).toBe("none");
  });

  it("requires plan digest before provider lifecycle mutations", () => {
    const service = createService();

    expect(() => service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/shadow",
      canonicalApproval: makeApproval({ action: "shadow" }),
      planDigest: "",
    })).toThrow(expect.objectContaining({ code: "PROVIDER_LIFECYCLE_PLAN_DIGEST_REQUIRED" }));
  });

  it("tracks shadow, real validation canary, promote, evidence, and rollback for provider profiles", async () => {
    const validateProvider = vi.fn(async () => ({
      status: "ok" as const,
      checkedAt: "2026-04-17T21:00:00.000Z",
    }));
    const service = createService({ validateProvider });

    const shadowed = service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
    });
    expect(shadowed.promotionChannel).toBe("shadow");
    expect(shadowed.shadowVersionId).toBe("provider-1@shadow");

    const canary = await service.recordCanaryResult({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
    });
    expect(canary.promotionChannel).toBe("canary");
    expect(canary.canaryStats?.sampleSize).toBe(1);
    expect(canary.canaryStats?.successCount).toBe(1);
    expect(validateProvider).toHaveBeenCalledWith("provider-1", { tenantContext: undefined });

    const promoted = service.promote({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      planDigest: PLAN_DIGEST,
      actor,
      surface: "api:/v1/autonomy/providers/promote",
      canonicalApproval: makeApproval({ action: "promote", planDigest: PLAN_DIGEST }),
    });
    expect(promoted.promotionChannel).toBe("active");
    expect(promoted.lastVerifiedAt).toBe("2026-04-17T21:00:00.000Z");

    const rolledBack = service.rollback({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      planDigest: PLAN_DIGEST,
      actor,
      surface: "api:/v1/autonomy/providers/rollback",
      canonicalApproval: makeApproval({ action: "rollback", planDigest: PLAN_DIGEST }),
    });
    expect(rolledBack.promotionChannel).toBe("none");
    expect(rolledBack.compatibilityStatus).toBe("unknown");
    expect(rolledBack.shadowVersionId).toBeUndefined();
    expect(rolledBack.canaryStats?.rollbackCount).toBe(1);
    expect(service.getLifecycleEvidence({ providerId: "provider-1" })).toMatchObject({
      providerId: "provider-1",
      stage: "rolled_back",
      canarySuccessCount: 1,
      rollbackPointerAvailable: true,
    });
  });

  it("blocks promote when provider canary failed", async () => {
    const service = createService({
      validateProvider: vi.fn(async () => ({
        status: "failed" as const,
        checkedAt: "2026-04-17T21:00:00.000Z",
        errorCode: "PROVIDER_AUTH_INVALID",
        errorMessage: "bad key",
      })),
    });

    service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
    });
    await service.recordCanaryResult({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
    });

    expect(() => service.promote({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      planDigest: PLAN_DIGEST,
      actor,
      surface: "api:/v1/autonomy/providers/promote",
      canonicalApproval: makeApproval({ action: "promote", planDigest: PLAN_DIGEST }),
    })).toThrow(expect.objectContaining({ code: "PROVIDER_LIFECYCLE_CANARY_NOT_GREEN" }));
  });

  it("blocks promote when lifecycle evidence lacks a rollback pointer", async () => {
    const service = createService();
    service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
    });
    await service.recordCanaryResult({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/canary",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "canary" }),
    });

    const evidencePath = join(stateDir, "autonomy", "provider-lifecycle", "provider-1.json");
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as { shadow?: Record<string, unknown> };
    if (evidence.shadow) {
      delete evidence.shadow.previous;
    }
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");

    expect(() => service.promote({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      planDigest: PLAN_DIGEST,
      actor,
      surface: "api:/v1/autonomy/providers/promote",
      canonicalApproval: makeApproval({ action: "promote", planDigest: PLAN_DIGEST }),
    })).toThrow(expect.objectContaining({ code: "PROVIDER_LIFECYCLE_ROLLBACK_POINTER_REQUIRED" }));
  });

  it("blocks rollback before a provider lifecycle version is promoted", () => {
    const service = createService();
    service.registerShadowVersion({
      providerId: "provider-1",
      shadowVersionId: "provider-1@shadow",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      actor,
      surface: "api:/v1/autonomy/providers/shadow",
      planDigest: PLAN_DIGEST,
      canonicalApproval: makeApproval({ action: "shadow" }),
    });

    expect(() => service.rollback({
      providerId: "provider-1",
      runtimeVersion: "f27377c",
      providerModel: "claude-sonnet-4-20250514",
      planDigest: PLAN_DIGEST,
      actor,
      surface: "api:/v1/autonomy/providers/rollback",
      canonicalApproval: makeApproval({ action: "rollback", planDigest: PLAN_DIGEST }),
    })).toThrow(expect.objectContaining({ code: "PROVIDER_LIFECYCLE_PROMOTION_REQUIRED" }));
  });
});
