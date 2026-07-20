import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createFridayProviderRoutes } from "#api";
import type { FridayProviderService } from "#providers";
import type { FridayProviderProfile, FridayProviderValidationState, FridayModelRoutingConfig } from "#providers";
import type { FridayHttpContext } from "#api";
import {
  createFridayProviderSetupMutatingActionRequest,
} from "../../../../src/api/http/routes/friday-provider-routes.js";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  type FridayCanonicalApprovalResolution,
  type FridayDeviceApprovalVerifyResult,
} from "../../../../src/security/friday-mutating-action-gate.js";
import { createFridayProviderApprovalPoPVerifier } from "../../../../src/api/auth/device-attest/index.js";
import {
  deviceOwnerPrincipalIdFor,
  generateTestDeviceKey,
  makeApprovalProof,
  makeApprovalTranscript,
} from "../../../helpers/friday-provider-approval-test-kit.js";

describe("FridayProviderRoutes", () => {
  const NOW = "2026-02-17T10:00:00.000Z";
  const PLAN_DIGEST = "provider-setup-plan-1";

  const sampleProfile: FridayProviderProfile = {
    id: "prov-001",
    kind: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com",
    enabled: true,
    defaultModel: "gpt-4o",
    config: {
      api: "openai-completions",
      authMode: "api-key",
      keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
      supportedModels: ["gpt-4o"],
      validation: { status: "ok", checkedAt: NOW },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  const anthropicOauthProfile: FridayProviderProfile = {
    id: "anth-001",
    kind: "anthropic",
    name: "Claude OAuth",
    baseUrl: "https://api.anthropic.com",
    enabled: true,
    defaultModel: "claude-sonnet-4-20250514",
    config: {
      api: "anthropic-messages",
      authMode: "oauth",
      keySource: { kind: "none" },
      oauthProvider: "anthropic",
      supportedModels: ["claude-sonnet-4-20250514"],
      validation: { status: "never" },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  const openAICodexOauthProfile: FridayProviderProfile = {
    id: "codex-001",
    kind: "openai-codex",
    name: "OpenAI Codex OAuth",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    enabled: true,
    defaultModel: "gpt-5.4-mini",
    config: {
      api: "openai-codex-responses",
      authMode: "oauth",
      keySource: { kind: "none" },
      oauthProvider: "openai-codex",
      supportedModels: ["gpt-5.4-mini"],
      validation: { status: "never" },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };

  function makeCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: {},
      headers: {},
      principal: null,
      ...overrides,
    };
  }

  function makeAdminCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}): FridayHttpContext<unknown, unknown, unknown> {
    return makeCtx({
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
      ...overrides,
    });
  }

  // A single owner device; the gate binds the device-authored approval to it.
  const OWNER = generateTestDeviceKey();
  const OWNER_PRINCIPAL = deviceOwnerPrincipalIdFor(OWNER);
  const APPROVAL_EXPIRES_AT = "2026-02-17T10:09:00.000Z";

  function makeProviderMutationApproval(input: {
    action: string;
    surface: string;
    resourceId?: string;
    parameters: Record<string, unknown>;
    idempotencyKey?: string;
  }): FridayCanonicalApprovalResolution {
    const request = createFridayProviderSetupMutatingActionRequest({
      action: input.action,
      actor: {
        kind: "user",
        id: OWNER_PRINCIPAL,
        principalId: OWNER_PRINCIPAL,
      },
      surface: input.surface,
      resourceId: input.resourceId,
      parameters: input.parameters,
      planDigest: PLAN_DIGEST,
      idempotencyKey: input.idempotencyKey,
    });
    const actionDigest = createFridayMutatingActionDigest(request);
    const approvalId = `${input.action}-approval`;
    // A DEVICE-AUTHORED approval (SEC-APPROVAL-AUTHORITY-001): the owner device
    // signs it; the Hub only verifies. A Hub-minted / unsigned approval is refused.
    const transcript = makeApprovalTranscript(OWNER, {
      actionDigest,
      decidedByPrincipalId: OWNER_PRINCIPAL,
      approvalId,
      expiresAt: APPROVAL_EXPIRES_AT,
    });
    return {
      decision: "approved",
      approvalId,
      decidedByPrincipalId: OWNER_PRINCIPAL,
      actionDigest,
      expiresAt: APPROVAL_EXPIRES_AT,
      issuer: "friday_device_owner",
      deviceProof: makeApprovalProof(OWNER, transcript),
    };
  }

  /** A ctx whose bound owner principal IS the device-owner (device-owner:<keyHash>). */
  function makeDeviceOwnerCtx(overrides: Partial<FridayHttpContext<unknown, unknown, unknown>> = {}) {
    return makeAdminCtx({
      principal: {
        principalType: "user",
        principalId: OWNER_PRINCIPAL,
        userId: "user-1",
        role: "owner",
        scopes: ["hub.admin"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      } as FridayHttpContext<unknown, unknown, unknown>["principal"],
      ...overrides,
    });
  }

  function createProviderRoutesWithGate(mockService: FridayProviderService) {
    const providerApprovalVerifier = createFridayProviderApprovalPoPVerifier();
    return createFridayProviderRoutes({
      providerService: mockService,
      providerMutationGateRequired: true,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => NOW,
        ticketIdGenerator: () => "ticket-1",
        deviceApprovalVerifier: (proof, nowMs): FridayDeviceApprovalVerifyResult => {
          const r = providerApprovalVerifier.verifyPossession({
            transcript: proof.transcript,
            devicePublicKey: proof.devicePublicKey,
            signature: proof.signature,
            nowMs,
          });
          return r.ok
            ? {
                ok: true,
                devicePublicKeyHash: r.devicePublicKeyHash,
                approvalId: r.approvalId,
                actionDigest: r.actionDigest,
                decidedByPrincipalId: r.decidedByPrincipalId,
                expiresAt: r.expiresAt,
              }
            : { ok: false, reason: r.reason };
        },
      }),
      providerApprovalVerifier,
      // Probe + routing-controls surfaces fail-close by default; enable the
      // test-oracle flags so these positive-path tests exercise real behavior.
      // The dedicated retirement describe block omits these flags.
      allowTestOnlyProviderProbeExecution: true,
      allowTestOnlyProviderRoutingControlsExecution: true,
    });
  }

  function makeMockService(): FridayProviderService {
    return {
      listProviders: vi.fn(async () => [sampleProfile, anthropicOauthProfile, openAICodexOauthProfile]),
      getProvider: vi.fn(async (id: string) =>
        id === "prov-001"
          ? sampleProfile
          : id === "anth-001"
            ? anthropicOauthProfile
            : id === "codex-001"
              ? openAICodexOauthProfile
              : null,
      ),
      createProvider: vi.fn(async () => sampleProfile),
      updateProvider: vi.fn(async () => sampleProfile),
      deleteProvider: vi.fn(async () => undefined),
      validateProvider: vi.fn(
        async (): Promise<FridayProviderValidationState> => ({
          status: "ok",
          checkedAt: NOW,
        }),
      ),
      getRoutingConfig: vi.fn(
        async (): Promise<FridayModelRoutingConfig> => ({
          defaultProviderId: "anth-001",
          fallbackProviderIds: [],
        }),
      ),
      setRoutingConfig: vi.fn(
        async (input: FridayModelRoutingConfig) => input,
      ),
      resolveRoute: vi.fn(async () => ({
        provider: sampleProfile,
        model: "gpt-4o",
      })),
      runWithFallback: vi.fn(async () => ({
        result: null,
        route: { provider: sampleProfile, model: "gpt-4o" },
        attempts: [],
      })),
      recordUsage: vi.fn(async () => undefined),
      getUsageSummary: vi.fn(async () => ({ groups: [] })),
      getBudgetStatus: vi.fn(async () => ({ monthlyLimitUsd: 0, monthlySpentUsd: 0, remainingUsd: 0, usagePercent: 0, budgetExceeded: false })),
      setBudgetConfig: vi.fn(async () => ({ monthlyLimitUsd: 0 })),
      listAuthProfiles: vi.fn(async () => [
        {
          id: "auth-default",
          providerProfileId: "prov-001",
          providerKind: "openai" as const,
          profileKey: "default",
          label: "OpenAI Default",
          authMode: "api-key" as const,
          keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
          isActive: true,
          metadata: {},
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
      activateAuthProfile: vi.fn(async () => ({
        id: "auth-default",
        providerProfileId: "prov-001",
        providerKind: "openai" as const,
        profileKey: "default",
        label: "OpenAI Default",
        authMode: "api-key" as const,
        keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
        isActive: true,
        metadata: {},
        createdAt: NOW,
        updatedAt: NOW,
      })),
      doctorProvider: vi.fn(async () => ({
        providerId: "prov-001",
        providerKind: "openai" as const,
        backendKind: "http" as const,
        authMode: "api-key" as const,
        checkedAt: NOW,
        backendHealth: "healthy" as const,
        authHealth: "healthy" as const,
        routingEligible: true,
        reasons: [],
        activeProfileKey: "default",
      })),
      runCapabilityDoctor: vi.fn(async () => ({
        checkedAt: NOW,
        providerValidations: [
          {
            providerId: "prov-001",
            providerKind: "openai" as const,
            validation: { status: "ok" as const, checkedAt: NOW },
          },
          {
            providerId: "anth-001",
            providerKind: "anthropic" as const,
            validation: { status: "ok" as const, checkedAt: NOW },
          },
        ],
        capabilityResults: [
          {
            providerId: "prov-001",
            providerKind: "openai" as const,
            capability: "text" as const,
            model: "gpt-4o",
            status: "verified" as const,
            checkedAt: NOW,
            message: "Capability passed a live standardized probe.",
          },
        ],
      })),
      explainRouting: vi.fn(async () => ({
        requestedProviderId: "prov-001",
        requestedModel: "gpt-4o",
        costMode: "standard" as const,
        requiresNativeTools: true,
        selectedBeforeLearning: {
          providerId: "prov-001",
          providerKind: "openai" as const,
          model: "gpt-4o",
          backendKind: "http" as const,
        },
        selectedAfterLearning: {
          providerId: "prov-001",
          providerKind: "openai" as const,
          model: "gpt-4o",
          backendKind: "http" as const,
        },
        selected: {
          providerId: "prov-001",
          providerKind: "openai" as const,
          model: "gpt-4o",
          backendKind: "http" as const,
          originalRank: 1,
          finalRank: 1,
          selected: true,
          eligible: true,
          ineligibilityReasons: [],
          pinned: false,
          baseRankScore: 1,
          historyScore: 0,
          patternScore: 0,
          lessonScore: 0,
          routePenaltyScore: 0,
          pinBonus: 0,
          finalScore: 1,
          matchedLessonIds: [],
          matchedPatternIds: [],
        },
        candidates: [
          {
            providerId: "prov-001",
            providerKind: "openai" as const,
            model: "gpt-4o",
            backendKind: "http" as const,
            originalRank: 1,
            finalRank: 1,
            selected: true,
            eligible: true,
            ineligibilityReasons: [],
            pinned: false,
            baseRankScore: 1,
            historyScore: 0,
            patternScore: 0,
            lessonScore: 0,
            routePenaltyScore: 0,
            pinBonus: 0,
            finalScore: 1,
            matchedLessonIds: [],
            matchedPatternIds: [],
          },
        ],
        candidateScores: [
          {
            providerId: "prov-001",
            providerKind: "openai" as const,
            model: "gpt-4o",
            backendKind: "http" as const,
            originalRank: 1,
            finalRank: 1,
            selected: true,
            eligible: true,
            ineligibilityReasons: [],
            pinned: false,
            baseRankScore: 1,
            historyScore: 0,
            patternScore: 0,
            lessonScore: 0,
            routePenaltyScore: 0,
            pinBonus: 0,
            finalScore: 1,
            matchedLessonIds: [],
            matchedPatternIds: [],
          },
        ],
        learningAdjusted: false,
        learningSignalsPresent: false,
        orderingAdjusted: false,
        selectedAdjusted: false,
        reasonCode: "configured" as const,
        reason: "default route",
        reasonText: "default route",
        historyWindow: { sampleLimit: 250 },
      })),
      pinRoute: vi.fn(async () => undefined),
      clearRoutePenalty: vi.fn(async () => 1),
      initiateOAuthLogin: vi.fn(async () => ({
        providerId: "anth-001",
        oauthProvider: "anthropic" as const,
        authorizationUrl: "https://claude.ai/oauth/authorize?...",
        state: "test-state",
        codeVerifier: "test-verifier",
        scopes: ["org:create_api_key", "user:profile", "user:inference"],
      })),
      completeOAuthLogin: vi.fn(async () => ({
        providerId: "anth-001",
        oauthProvider: "anthropic" as const,
        connected: true,
        runtimeReady: true,
        validation: { status: "ok" as const, checkedAt: NOW },
        expiresAt: NOW,
        tokenType: "Bearer",
        scope: "org:create_api_key user:profile user:inference",
      })),
      initiateOAuthDeviceAuthorization: vi.fn(async () => ({
        providerId: "codex-001",
        oauthProvider: "openai-codex" as const,
        deviceCodeId: "device-code-1",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
        expiresAt: NOW,
        intervalMs: 1000,
        scopes: ["openid", "profile", "email"],
      })),
      completeOAuthDeviceAuthorization: vi.fn(async () => ({
        providerId: "codex-001",
        oauthProvider: "openai-codex" as const,
        connected: true,
        runtimeReady: true,
        validation: { status: "ok" as const, checkedAt: NOW },
        expiresAt: NOW,
        tokenType: "Bearer",
        scope: "openid profile email",
        metadata: { email: "codex@example.test" },
      })),
    };
  }

  it("creates 25 route definitions", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    // 23 → 25: CORE-A CR-2 added the two owner-confirm handshake routes below. The count is
    // asserted TOGETHER with their exact identity so a future accidental route cannot slip in
    // behind a silently bumped number.
    expect(routes).toHaveLength(25);
    const planRoutes = routes
      .filter((r) => r.path === "/v1/providers/plan" || r.path === "/v1/providers/plan/confirm")
      .map((r) => ({ path: r.path, operationId: r.operationId }));
    expect(planRoutes).toEqual([
      { path: "/v1/providers/plan", operationId: "providers.plan" },
      { path: "/v1/providers/plan/confirm", operationId: "providers.plan.confirm" },
    ]);
  });

  it("has correct operation ids", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    const operationIds = routes.map((r) => r.operationId);
    expect(operationIds).toContain("providers.list");
    expect(operationIds).toContain("providers.get");
    expect(operationIds).toContain("providers.create");
    expect(operationIds).toContain("providers.update");
    expect(operationIds).toContain("providers.delete");
    expect(operationIds).toContain("providers.validate");
    expect(operationIds).toContain("providers.doctor");
    expect(operationIds).toContain("capabilities.doctor");
    expect(operationIds).toContain("providers.routing.explain");
    expect(operationIds).toContain("providers.routing.pin");
    expect(operationIds).toContain("providers.routing.penalty.clear");
    expect(operationIds).toContain("providers.auth.profiles.list");
    expect(operationIds).toContain("providers.auth.profiles.activate");
    expect(operationIds).toContain("providers.routing.get");
    expect(operationIds).toContain("providers.routing.set");
    expect(operationIds).toContain("providers.templates.list");
    expect(operationIds).toContain("providers.templates.get");
    expect(operationIds).toContain("providers.health.list");
    expect(operationIds).toContain("auth.oauth.openai.codex.device.initiate");
    expect(operationIds).toContain("auth.oauth.openai.codex.device.complete");
  });

  it("every route declares public auth (auth-boundary product invariant)", () => {
    const routes = createFridayProviderRoutes({
      providerService: makeMockService(),
    });
    for (const route of routes) {
      expect(route.auth).toEqual({ public: true });
    }
  });

  describe("handler behavior", () => {
    it("providers.list returns items", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const listRoute = routes.find((r) => r.operationId === "providers.list")!;

      const result = await listRoute.handler(makeCtx());
      expect(result).toEqual({ items: [sampleProfile, anthropicOauthProfile, openAICodexOauthProfile] });
    });

    it("providers.get returns provider", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const getRoute = routes.find((r) => r.operationId === "providers.get")!;

      const result = await getRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toEqual({ provider: sampleProfile });
    });

    it("providers.get throws on not found", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const getRoute = routes.find((r) => r.operationId === "providers.get")!;

      await expect(
        getRoute.handler(makeCtx({ params: { providerId: "non-existent" } })),
      ).rejects.toThrow("Provider not found");
    });

    it("providers.create calls service with body", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const createRoute = routes.find(
        (r) => r.operationId === "providers.create",
      )!;

      const body = {
        kind: "openai" as const,
        name: "Test",
        baseUrl: "https://test.com",
        authMode: "api-key" as const,
        api: "openai-completions" as const,
        supportedModels: ["gpt-4o"],
      };

      const result = await createRoute.handler(makeCtx({ body }));
      expect(mockService.createProvider).toHaveBeenCalledWith(body);
      expect(result).toHaveProperty("provider");
    });

    it("providers.create requires canonical approval in gate-required profile before service mutation", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const createRoute = routes.find(
        (r) => r.operationId === "providers.create",
      )!;

      const body = {
        kind: "openai" as const,
        name: "Test",
        baseUrl: "https://test.com",
        authMode: "api-key" as const,
        api: "openai-completions" as const,
        supportedModels: ["gpt-4o"],
        planDigest: PLAN_DIGEST,
      };

      await expect(createRoute.handler(makeAdminCtx({ body }))).rejects.toMatchObject({
        code: "CANONICAL_APPROVAL_REQUIRED",
      });
      expect(mockService.createProvider).not.toHaveBeenCalled();
    });

    it("providers.create accepts canonical approval in gate-required profile and strips control fields", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const createRoute = routes.find(
        (r) => r.operationId === "providers.create",
      )!;

      const providerBody = {
        kind: "openai" as const,
        name: "Test",
        baseUrl: "https://test.com",
        authMode: "api-key" as const,
        api: "openai-completions" as const,
        supportedModels: ["gpt-4o"],
      };
      const body = {
        ...providerBody,
        planDigest: PLAN_DIGEST,
        idempotencyKey: "provider-create-key",
        canonicalApproval: makeProviderMutationApproval({
          action: "providers.create",
          surface: "api:/v1/providers/create",
          parameters: providerBody,
          idempotencyKey: "provider-create-key",
        }),
      };

      const result = await createRoute.handler(makeDeviceOwnerCtx({ body }));

      expect(mockService.createProvider).toHaveBeenCalledWith(providerBody);
      expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
    });

    it("providers.create returns schema details and alias hints for invalid field names", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const createRoute = routes.find(
        (r) => r.operationId === "providers.create",
      )!;

      await expect(
        createRoute.handler(makeCtx({
          body: {
            providerKind: "openai",
            displayName: "Test",
            baseUrl: "https://api.openai.com",
            authMode: "api-key",
            api: "openai-completions",
            supportedModels: ["gpt-4o"],
          },
        })),
      ).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        httpStatus: 422,
        message: expect.stringContaining("providerKind is not accepted; use kind"),
        details: {
          errors: expect.arrayContaining([
            "providerKind is not accepted; use kind",
            "displayName is not accepted; use name",
          ]),
          schema: expect.objectContaining({
            acceptedFields: expect.arrayContaining(["kind", "name", "baseUrl", "api", "supportedModels"]),
            requiredFields: expect.arrayContaining(["kind", "name", "baseUrl", "authMode", "api", "supportedModels"]),
            enums: expect.objectContaining({
              kind: expect.arrayContaining(["openai"]),
              authMode: expect.arrayContaining(["api-key"]),
              api: expect.arrayContaining(["openai-completions"]),
            }),
            aliases: expect.objectContaining({
              providerKind: "kind",
              displayName: "name",
            }),
          }),
        },
      });
      expect(mockService.createProvider).not.toHaveBeenCalled();
    });

    it("providers.delete returns deleted true", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const deleteRoute = routes.find(
        (r) => r.operationId === "providers.delete",
      )!;

      const result = await deleteRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toEqual({ deleted: true });
    });

    it("providers.validate returns validation state", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
        allowTestOnlyProviderProbeExecution: true,
      });
      const validateRoute = routes.find(
        (r) => r.operationId === "providers.validate",
      )!;

      const result = await validateRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toEqual({
        validation: { status: "ok", checkedAt: NOW },
      });
    });

    it("providers.validate requires canonical approval in gate-required profile before service mutation", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const validateRoute = routes.find(
        (r) => r.operationId === "providers.validate",
      )!;

      await expect(validateRoute.handler(makeAdminCtx({
        params: { providerId: "prov-001" },
        body: { planDigest: PLAN_DIGEST },
      }))).rejects.toMatchObject({
        code: "CANONICAL_APPROVAL_REQUIRED",
      });
      expect(mockService.validateProvider).not.toHaveBeenCalled();
    });

    it("providers.validate accepts canonical approval in gate-required profile", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const validateRoute = routes.find(
        (r) => r.operationId === "providers.validate",
      )!;

      const result = await validateRoute.handler(makeDeviceOwnerCtx({
        params: { providerId: "prov-001" },
        body: {
          planDigest: PLAN_DIGEST,
          canonicalApproval: makeProviderMutationApproval({
            action: "providers.validate",
            surface: "api:/v1/providers/validate",
            resourceId: "prov-001",
            parameters: { providerId: "prov-001" },
          }),
        },
      }));

      expect(mockService.validateProvider).toHaveBeenCalledWith("prov-001", {
        ownerUserId: "user-1",
      });
      expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
    });

    it("providers.doctor returns doctor report", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
        allowTestOnlyProviderProbeExecution: true,
      });
      const doctorRoute = routes.find(
        (r) => r.operationId === "providers.doctor",
      )!;

      const result = await doctorRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toMatchObject({
        doctor: {
          providerId: "prov-001",
          backendKind: "http",
          activeProfileKey: "default",
        },
      });
    });

    it("capabilities.doctor runs the service capability doctor", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
        allowTestOnlyProviderProbeExecution: true,
      });
      const doctorRoute = routes.find(
        (r) => r.operationId === "capabilities.doctor",
      )!;

      const result = await doctorRoute.handler(makeCtx());

      expect(mockService.runCapabilityDoctor).toHaveBeenCalledTimes(1);
      expect(mockService.validateProvider).not.toHaveBeenCalled();
      expect(result).toEqual({
        checkedAt: NOW,
        providerValidations: [
          {
            providerId: "prov-001",
            providerKind: "openai",
            validation: { status: "ok", checkedAt: NOW },
          },
          {
            providerId: "anth-001",
            providerKind: "anthropic",
            validation: { status: "ok", checkedAt: NOW },
          },
        ],
        capabilityResults: [
          {
            providerId: "prov-001",
            providerKind: "openai",
            capability: "text",
            model: "gpt-4o",
            status: "verified",
            checkedAt: NOW,
            message: "Capability passed a live standardized probe.",
          },
        ],
      });
    });

    it("capabilities.doctor requires canonical approval in gate-required profile before service mutation", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const doctorRoute = routes.find(
        (r) => r.operationId === "capabilities.doctor",
      )!;

      await expect(doctorRoute.handler(makeAdminCtx({
        body: {
          providerIds: ["prov-001"],
          planDigest: PLAN_DIGEST,
        },
      }))).rejects.toMatchObject({
        code: "CANONICAL_APPROVAL_REQUIRED",
      });
      expect(mockService.runCapabilityDoctor).not.toHaveBeenCalled();
    });

    it("capabilities.doctor accepts canonical approval in gate-required profile", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const doctorRoute = routes.find(
        (r) => r.operationId === "capabilities.doctor",
      )!;

      const result = await doctorRoute.handler(makeDeviceOwnerCtx({
        body: {
          providerIds: ["prov-001"],
          planDigest: PLAN_DIGEST,
          canonicalApproval: makeProviderMutationApproval({
            action: "capabilities.doctor",
            surface: "api:/v1/capabilities/doctor",
            resourceId: "prov-001",
            parameters: { providerIds: ["prov-001"] },
          }),
        },
      }));

      expect(mockService.runCapabilityDoctor).toHaveBeenCalledWith({
        ownerUserId: "user-1",
        providerIds: ["prov-001"],
      });
      expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
    });

    it("capabilities.doctor rejects an explicit empty providerIds list", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const doctorRoute = routes.find(
        (r) => r.operationId === "capabilities.doctor",
      )!;

      await expect(doctorRoute.handler(makeCtx({ body: { providerIds: [] } }))).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
        message: "providerIds must contain at least one provider id when provided",
      });
      expect(mockService.runCapabilityDoctor).not.toHaveBeenCalled();
    });

    it("providers.routing.explain delegates query and principal context", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const explainRoute = routes.find(
        (r) => r.operationId === "providers.routing.explain",
      )!;

      const result = await explainRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          query: {
            requestedProviderId: "prov-001",
            requestedModel: "gpt-4o",
            taskProfileId: "review",
            estimatedInputTokens: "2048",
            complexity: "complex",
            requiresNativeTools: "true",
          },
        }),
      );

      expect(mockService.explainRouting).toHaveBeenCalledWith({
        requestedProviderId: "prov-001",
        requestedModel: "gpt-4o",
        tenantContext: {
          hubId: "default",
          userId: "user-1",
        },
        routingContext: {
          estimatedInputTokens: 2048,
          complexity: "complex",
          requiresNativeTools: true,
          taskProfileId: "review",
        },
      });
      expect(result).toHaveProperty("explain.selected.providerId", "prov-001");
    });

    it("providers.routing.pin validates and delegates", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
        allowTestOnlyProviderRoutingControlsExecution: true,
      });
      const pinRoute = routes.find(
        (r) => r.operationId === "providers.routing.pin",
      )!;

      const result = await pinRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          body: {
            taskProfileId: "plan",
            providerId: "prov-001",
            model: "gpt-4o",
            backendKind: "http",
            reason: "operator pin",
          },
        }),
      );

      expect(mockService.pinRoute).toHaveBeenCalledWith({
        userId: "user-1",
        taskProfileId: "plan",
        providerId: "prov-001",
        model: "gpt-4o",
        backendKind: "http",
        reason: "operator pin",
      });
      expect(result).toEqual({ pinned: true });
    });

    it("providers.routing.penalty.clear validates and delegates", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
        allowTestOnlyProviderRoutingControlsExecution: true,
      });
      const clearRoute = routes.find(
        (r) => r.operationId === "providers.routing.penalty.clear",
      )!;

      const result = await clearRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          body: {
            taskProfileId: "review",
            providerId: "prov-001",
            model: "gpt-4o",
            backendKind: "http",
          },
        }),
      );

      expect(mockService.clearRoutePenalty).toHaveBeenCalledWith({
        userId: "user-1",
        taskProfileId: "review",
        providerId: "prov-001",
        model: "gpt-4o",
        backendKind: "http",
      });
      expect(result).toEqual({ cleared: 1 });
    });

    it("providers.auth.profiles.list returns auth profiles", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const listRoute = routes.find(
        (r) => r.operationId === "providers.auth.profiles.list",
      )!;

      const result = await listRoute.handler(
        makeCtx({ params: { providerId: "prov-001" } }),
      );
      expect(result).toMatchObject({
        items: [expect.objectContaining({ profileKey: "default" })],
      });
    });

    it("providers.auth.profiles.activate switches the active profile", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const activateRoute = routes.find(
        (r) => r.operationId === "providers.auth.profiles.activate",
      )!;

      const result = await activateRoute.handler(
        makeCtx({ params: { providerId: "prov-001", profileKey: "default" } }),
      );
      expect(result).toMatchObject({
        profile: expect.objectContaining({ profileKey: "default", isActive: true }),
      });
    });

    it("providers.routing.get returns config", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const getRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.get",
      )!;

      const result = await getRoutingRoute.handler(makeCtx());
      expect(result).toEqual({
        routing: {
          defaultProviderId: "anth-001",
          fallbackProviderIds: [],
        },
      });
    });

    it("providers.routing.set updates config", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      const body = {
        defaultProviderId: "prov-001",
        defaultModel: "gpt-4o",
        fallbackProviderIds: ["prov-002"],
        costMode: "frugal" as const,
        enforceRequestedModel: true,
      };

      const result = await setRoutingRoute.handler(makeCtx({ body }));
      expect(result).toEqual({ routing: body });
    });

    it("providers.routing.set rejects invalid costMode", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      await expect(
        setRoutingRoute.handler(makeCtx({
          body: {
            defaultProviderId: "prov-001",
            fallbackProviderIds: [],
            costMode: "turbo-cheap",
          },
        })),
      ).rejects.toThrow("costMode must be one of: frugal, standard, strict");
      expect(mockService.setRoutingConfig).not.toHaveBeenCalled();
    });

    it("providers.routing.set rejects empty provider ids before service mutation", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      await expect(
        setRoutingRoute.handler(makeCtx({
          body: {
            defaultProviderId: " ",
            fallbackProviderIds: [],
          },
        })),
      ).rejects.toThrow("defaultProviderId is required and must be a non-empty string");

      await expect(
        setRoutingRoute.handler(makeCtx({
          body: {
            defaultProviderId: "prov-001",
            fallbackProviderIds: ["prov-002", ""],
          },
        })),
      ).rejects.toThrow("fallbackProviderIds must be an array of non-empty strings when provided");

      expect(mockService.setRoutingConfig).not.toHaveBeenCalled();
    });

    it("providers.routing.set requires canonical approval in gate-required profile before service mutation", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      const body = {
        defaultProviderId: "prov-001",
        fallbackProviderIds: [],
        planDigest: PLAN_DIGEST,
      };

      await expect(setRoutingRoute.handler(makeAdminCtx({ body }))).rejects.toMatchObject({
        code: "CANONICAL_APPROVAL_REQUIRED",
      });
      expect(mockService.setRoutingConfig).not.toHaveBeenCalled();
    });

    it("providers.routing.set accepts canonical approval in gate-required profile", async () => {
      const mockService = makeMockService();
      const routes = createProviderRoutesWithGate(mockService);
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      const routingBody = {
        defaultProviderId: "prov-001",
        fallbackProviderIds: [],
      };
      const body = {
        ...routingBody,
        planDigest: PLAN_DIGEST,
        canonicalApproval: makeProviderMutationApproval({
          action: "providers.routing.set",
          surface: "api:/v1/model-routing/set",
          resourceId: "model-routing",
          parameters: routingBody,
        }),
      };

      const result = await setRoutingRoute.handler(makeDeviceOwnerCtx({ body }));

      expect(mockService.setRoutingConfig).toHaveBeenCalledWith(routingBody);
      expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
    });

    it("providers.routing.set rejects non-boolean enforceRequestedModel", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const setRoutingRoute = routes.find(
        (r) => r.operationId === "providers.routing.set",
      )!;

      await expect(
        setRoutingRoute.handler(makeCtx({
          body: {
            defaultProviderId: "prov-001",
            fallbackProviderIds: [],
            enforceRequestedModel: "yes",
          },
        })),
      ).rejects.toThrow("enforceRequestedModel must be a boolean when provided");
      expect(mockService.setRoutingConfig).not.toHaveBeenCalled();
    });

    it("auth.oauth.anthropic.initiate fails closed before calling service", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.initiate",
      )!;

      await expect(initiateRoute.handler(
        makeCtx({ principal: { userId: "user-1" } as never, body: { providerId: "anth-001" } }),
      )).rejects.toThrow("Anthropic OAuth/bearer authentication is disabled");

      expect(mockService.initiateOAuthLogin).not.toHaveBeenCalled();
      expect(mockService.createProvider).not.toHaveBeenCalled();
    });

    it("auth.oauth.anthropic.initiate fails closed when providerId is omitted", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.initiate",
      )!;

      await expect(
        initiateRoute.handler(makeCtx({ principal: { userId: "user-1" } as never, body: {} })),
      ).rejects.toThrow("Anthropic OAuth/bearer authentication is disabled");

      expect(mockService.initiateOAuthLogin).not.toHaveBeenCalled();
      expect(mockService.createProvider).not.toHaveBeenCalled();
    });

    it("auth.oauth.anthropic.callback fails closed before calling service", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const callbackRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.callback",
      )!;

      await expect(callbackRoute.handler(
        makeCtx({
          body: {
            providerId: "anth-001",
            authorizationCode: "code#state",
          },
          principal: { userId: "user-1" } as never,
        }),
      )).rejects.toThrow("Anthropic OAuth/bearer authentication is disabled");

      expect(mockService.completeOAuthLogin).not.toHaveBeenCalled();
    });

    it("auth.oauth.anthropic.callback fails closed when providerId is omitted", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const callbackRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.callback",
      )!;

      await expect(callbackRoute.handler(
        makeCtx({
          body: {
            authorizationCode: "code#state",
          },
          principal: { userId: "user-1" } as never,
        }),
      )).rejects.toThrow("Anthropic OAuth/bearer authentication is disabled");

      expect(mockService.completeOAuthLogin).not.toHaveBeenCalled();
    });

    it("auth.oauth.anthropic.initiate does not leak provider-selection ambiguity", async () => {
      const mockService = makeMockService();
      mockService.listProviders = vi.fn(async () => [
        anthropicOauthProfile,
        { ...anthropicOauthProfile, id: "anth-002", name: "Claude OAuth 2" },
      ]);
      mockService.getRoutingConfig = vi.fn(async () => ({
        defaultProviderId: "prov-001",
        fallbackProviderIds: [],
      }));
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.anthropic.initiate",
      )!;

      await expect(
        initiateRoute.handler(makeCtx({ principal: { userId: "user-1" } as never, body: {} })),
      ).rejects.toThrow("Anthropic OAuth/bearer authentication is disabled");
      expect(mockService.listProviders).not.toHaveBeenCalled();
    });

    it("auth.oauth.openai.codex.device.initiate delegates to device-code service with owner user", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const initiateRoute = routes.find(
        (r) => r.operationId === "auth.oauth.openai.codex.device.initiate",
      )!;

      const result = await initiateRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          body: { providerId: "codex-001" },
        }),
      );

      expect(mockService.initiateOAuthDeviceAuthorization).toHaveBeenCalledWith({
        providerId: "codex-001",
        ownerUserId: "user-1",
      });
      expect(result).toHaveProperty("oauth.deviceCodeId", "device-code-1");
    });

    it("auth.oauth.openai.codex.device.complete delegates to device-code service with owner user", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({
        providerService: mockService,
      });
      const completeRoute = routes.find(
        (r) => r.operationId === "auth.oauth.openai.codex.device.complete",
      )!;

      const result = await completeRoute.handler(
        makeCtx({
          principal: { userId: "user-1" } as never,
          body: {
            providerId: "codex-001",
            deviceCodeId: "device-code-1",
          },
        }),
      );

      expect(mockService.completeOAuthDeviceAuthorization).toHaveBeenCalledWith({
        providerId: "codex-001",
        ownerUserId: "user-1",
        deviceCodeId: "device-code-1",
      });
      expect(result).toHaveProperty("oauth.connected", true);
    });
  });

  describe("OAuth route operation ids", () => {
    it("lists provider templates", async () => {
      const routes = createFridayProviderRoutes({
        providerService: makeMockService(),
      });
      const route = routes.find((entry) => entry.operationId === "providers.templates.list")!;

      const result = await route.handler(makeCtx());

      expect(result).toHaveProperty("items");
      expect((result as { items: Array<{ id: string }> }).items.length).toBeGreaterThan(5);
      expect((result as { items: Array<{ id: string }> }).items.some((item) => item.id === "openai")).toBe(true);
    });

    it("lists provider health snapshots", async () => {
      const mockService = makeMockService();
      mockService.getRoutingConfig = vi.fn(async () => ({
        defaultProviderId: "anth-001",
        fallbackProviderIds: ["prov-001"],
      }));
      const routes = createFridayProviderRoutes({
        providerService: Object.assign(mockService, {
          getProviderFallbackState: vi.fn((providerId: string) =>
            providerId === "prov-001"
              ? { circuitState: "cooldown" as const, cooldownRemainingMs: 42_000, lastFailureAt: NOW }
              : { circuitState: "closed" as const },
          ),
        }),
      });
      const route = routes.find((entry) => entry.operationId === "providers.health.list")!;

      const result = await route.handler(makeCtx());
      const items = (result as { items: Array<{ providerId: string; lane: string; circuitState: string }> }).items;

      expect(items).toHaveLength(3);
      expect(items.find((item) => item.providerId === "prov-001")).toMatchObject({
        lane: "fallback",
        circuitState: "cooldown",
      });
      expect(items.find((item) => item.providerId === "anth-001")).toMatchObject({
        lane: "primary",
      });
    });

    it("lists capability health from persisted snapshots without running live probes", async () => {
      const mockService = makeMockService();
      const verifiedProfile: FridayProviderProfile = {
        ...sampleProfile,
        config: {
          ...sampleProfile.config,
          runtimeCapabilities: [
            {
              capability: "text",
              model: "gpt-4o",
              status: "verified",
              verified: true,
              verifiedAt: NOW,
              notes: "Capability passed a live standardized probe.",
            },
          ],
        },
      };
      const pendingProfile: FridayProviderProfile = {
        ...anthropicOauthProfile,
        config: {
          ...anthropicOauthProfile.config,
          validation: { status: "ok", checkedAt: NOW },
          runtimeCapabilities: [
            {
              capability: "vision",
              model: "claude-sonnet-4-20250514",
              status: "declared",
            },
          ],
        },
      };
      const disabledProfile: FridayProviderProfile = {
        ...openAICodexOauthProfile,
        enabled: false,
        config: {
          ...openAICodexOauthProfile.config,
          validation: { status: "never" },
          runtimeCapabilities: [
            {
              capability: "text",
              model: "gpt-5.4-mini",
              status: "declared",
            },
          ],
        },
      };
      mockService.listProviders = vi.fn(async () => [verifiedProfile, pendingProfile, disabledProfile]);
      mockService.doctorProvider = vi.fn(async (providerId: string) => ({
        providerId,
        providerKind: providerId === "anth-001" ? "anthropic" as const : providerId === "codex-001" ? "openai-codex" as const : "openai" as const,
        backendKind: providerId === "codex-001" ? "cli" as const : "http" as const,
        authMode: providerId === "prov-001" ? "api-key" as const : "oauth" as const,
        checkedAt: NOW,
        backendHealth: "healthy" as const,
        authHealth: providerId === "codex-001" ? "missing" as const : "healthy" as const,
        routingEligible: providerId !== "codex-001",
        reasons: providerId === "codex-001" ? ["validation_unverified"] : [],
      }));
      const routes = createFridayProviderRoutes({ providerService: mockService });
      const route = routes.find((entry) => entry.operationId === "providers.capability.health.list")!;

      const result = await route.handler(makeCtx());
      const items = (result as { items: Array<{ providerId: string; capabilities: Array<{ state: string; source: string }> }>; summary: Record<string, number> }).items;

      expect(mockService.runCapabilityDoctor).not.toHaveBeenCalled();
      expect(items.find((item) => item.providerId === "prov-001")?.capabilities[0]).toMatchObject({
        state: "available",
        source: "runtime_capability_snapshot",
      });
      expect(items.find((item) => item.providerId === "anth-001")?.capabilities[0]).toMatchObject({
        state: "proof_pending",
        source: "declared_configuration",
      });
      expect(items.find((item) => item.providerId === "codex-001")?.capabilities[0]).toMatchObject({
        state: "disabled",
      });
      expect((result as { summary: { available: number; proofPending: number; disabled: number } }).summary).toMatchObject({
        available: 1,
        proofPending: 1,
        disabled: 1,
      });
    });

    it("includes OAuth route operation ids", () => {
      const routes = createFridayProviderRoutes({
        providerService: makeMockService(),
      });
      const operationIds = routes.map((r) => r.operationId);
      expect(operationIds).toContain("providers.templates.list");
      expect(operationIds).toContain("providers.health.list");
      expect(operationIds).toContain("providers.capability.health.list");
      expect(operationIds).toContain("auth.oauth.anthropic.initiate");
      expect(operationIds).toContain("auth.oauth.anthropic.callback");
      expect(operationIds).toContain("auth.oauth.openai.codex.device.initiate");
      expect(operationIds).toContain("auth.oauth.openai.codex.device.complete");
    });
  });

  describe("TS runtime retirement (test-oracle flags unset)", () => {
    function retiredRoute(operationId: string, mockService: FridayProviderService) {
      const route = createFridayProviderRoutes({ providerService: mockService }).find(
        (entry) => entry.operationId === operationId,
      );
      if (!route) throw new Error(`route not found: ${operationId}`);
      return route;
    }

    // ── Probe surfaces (allowTestOnlyProviderProbeExecution unset) ──

    it("fail-closes providers.validate with 503 TS_RUNTIME_PROVIDER_PROBE_RETIRED (never calls the service)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("providers.validate", mockService).handler(
          makeCtx({ params: { providerId: "prov-001" } }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_PROVIDER_PROBE_RETIRED", httpStatus: 503 });
      expect(mockService.validateProvider).not.toHaveBeenCalled();
    });

    it("fail-closes providers.doctor with 503 TS_RUNTIME_PROVIDER_PROBE_RETIRED (never calls the service)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("providers.doctor", mockService).handler(
          makeCtx({ params: { providerId: "prov-001" } }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_PROVIDER_PROBE_RETIRED", httpStatus: 503 });
      expect(mockService.doctorProvider).not.toHaveBeenCalled();
    });

    it("fail-closes capabilities.doctor with 503 TS_RUNTIME_PROVIDER_PROBE_RETIRED (never calls the service)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("capabilities.doctor", mockService).handler(makeCtx({ body: {} })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_PROVIDER_PROBE_RETIRED", httpStatus: 503 });
      expect(mockService.runCapabilityDoctor).not.toHaveBeenCalled();
    });

    it("validates the body (400) before the probe retirement guard (capabilities.doctor empty providerIds)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("capabilities.doctor", mockService).handler(makeCtx({ body: { providerIds: [] } })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
      expect(mockService.runCapabilityDoctor).not.toHaveBeenCalled();
    });

    // ── Routing-controls surfaces (allowTestOnlyProviderRoutingControlsExecution unset) ──

    it("fail-closes providers.routing.pin with 503 TS_RUNTIME_PROVIDER_ROUTING_CONTROLS_RETIRED (never calls the service)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("providers.routing.pin", mockService).handler(
          makeCtx({
            principal: { userId: "user-1" } as never,
            body: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" },
          }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_PROVIDER_ROUTING_CONTROLS_RETIRED", httpStatus: 503 });
      expect(mockService.pinRoute).not.toHaveBeenCalled();
    });

    it("fail-closes providers.routing.penalty.clear with 503 TS_RUNTIME_PROVIDER_ROUTING_CONTROLS_RETIRED (never calls the service)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("providers.routing.penalty.clear", mockService).handler(
          makeCtx({
            principal: { userId: "user-1" } as never,
            body: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" },
          }),
        ),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_PROVIDER_ROUTING_CONTROLS_RETIRED", httpStatus: 503 });
      expect(mockService.clearRoutePenalty).not.toHaveBeenCalled();
    });

    it("requires a user-scoped principal (401) before the routing-controls retirement guard (pin)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("providers.routing.pin", mockService).handler(
          makeCtx({
            principal: null,
            body: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" },
          }),
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED", httpStatus: 401 });
      expect(mockService.pinRoute).not.toHaveBeenCalled();
    });

    it("validates the body (400) before the routing-controls retirement guard (pin missing model)", async () => {
      const mockService = makeMockService();
      await expect(
        retiredRoute("providers.routing.pin", mockService).handler(
          makeCtx({
            principal: { userId: "user-1" } as never,
            body: { providerId: "prov-001", backendKind: "http" },
          }),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
      expect(mockService.pinRoute).not.toHaveBeenCalled();
    });

    // ── Deferred + re-labeled surfaces stay reachable (no guard) ──

    it("does NOT fail-close model-routing GET/PUT or the compat_shim reads (no guard)", async () => {
      const mockService = makeMockService();
      const routes = createFridayProviderRoutes({ providerService: mockService });
      // model-routing config is DEFERRED (operator_external_adapter); reachable without the probe/controls flags.
      const routingGet = routes.find((r) => r.operationId === "providers.routing.get")!;
      await expect(routingGet.handler(makeCtx())).resolves.toBeDefined();
      // GET reads re-labeled compat_shim stay reachable (no behavior change).
      const healthList = routes.find((r) => r.operationId === "providers.health.list")!;
      await expect(healthList.handler(makeCtx())).resolves.toBeDefined();
      const getProvider = routes.find((r) => r.operationId === "providers.get")!;
      await expect(
        getProvider.handler(makeCtx({ params: { providerId: "prov-001" } })),
      ).resolves.toBeDefined();
    });
  });

  describe("DARK Rust cut-over for the probe surfaces (FRIDAY_ROUTE_PROVIDERS_VIA_RUST)", () => {
    // A scripted capability-doctor bridge stub (no spawn, no cargo, no CLI, no live
    // Anthropic round-trip, no quota). It records whether --validate-keys was requested.
    function makeDoctorBridge() {
      const calls: Array<{ validateKeys?: boolean }> = [];
      const doctor = vi.fn(async (input?: { validateKeys?: boolean }) => {
        calls.push({ validateKeys: input?.validateKeys });
        return {
          truthLabel: "rust_capability_doctor" as const,
          proofOnly: true as const,
          cliDetected: [{ provider: "codex", installed: true, authenticated: true, detail: "logged_in" }],
          cliLoggedIn: ["codex"],
          keyValidationProbed: input?.validateKeys === true,
          keyValidation: input?.validateKeys === true ? [] : null,
          confirmedValidKeys: input?.validateKeys === true ? [] : null,
        };
      });
      return { rustCapabilityDoctor: { doctor }, calls, doctor };
    }

    function findRoute(operationId: string, extraDeps: Record<string, unknown>) {
      const mockService = makeMockService();
      const route = createFridayProviderRoutes({
        providerService: mockService,
        ...extraDeps,
      } as never).find((entry) => entry.operationId === operationId);
      if (!route) throw new Error(`route not found: ${operationId}`);
      return { route, mockService };
    }

    it("flag OFF (default) stays byte-identical: providers.validate 503 even with the bridge wired", async () => {
      const bridge = makeDoctorBridge();
      const { route, mockService } = findRoute("providers.validate", {
        rustCapabilityDoctor: bridge.rustCapabilityDoctor,
      });
      await expect(
        route.handler(makeCtx({ params: { providerId: "prov-001" } })),
      ).rejects.toMatchObject({ code: "TS_RUNTIME_PROVIDER_PROBE_RETIRED", httpStatus: 503 });
      expect(bridge.doctor).not.toHaveBeenCalled();
      expect(mockService.validateProvider).not.toHaveBeenCalled();
    });

    it("flag ON bridges providers.validate to the Rust capability-doctor and NEVER passes validateKeys", async () => {
      const bridge = makeDoctorBridge();
      const { route, mockService } = findRoute("providers.validate", {
        routeProvidersViaRust: true,
        rustCapabilityDoctor: bridge.rustCapabilityDoctor,
      });
      const result = await route.handler(makeCtx({ params: { providerId: "prov-001" } }));
      expect(result).toMatchObject({ truthLabel: "rust_capability_doctor", proofOnly: true });
      // validate is zero-quota: it must request validateKeys=false.
      expect(bridge.calls).toEqual([{ validateKeys: false }]);
      expect(mockService.validateProvider).not.toHaveBeenCalled();
    });

    it("flag ON bridges providers.doctor to the Rust capability-doctor and NEVER passes validateKeys", async () => {
      const bridge = makeDoctorBridge();
      const { route, mockService } = findRoute("providers.doctor", {
        routeProvidersViaRust: true,
        rustCapabilityDoctor: bridge.rustCapabilityDoctor,
      });
      const result = await route.handler(makeCtx({ params: { providerId: "prov-001" } }));
      expect(result).toMatchObject({ truthLabel: "rust_capability_doctor", proofOnly: true });
      expect(bridge.calls).toEqual([{ validateKeys: false }]);
      expect(mockService.doctorProvider).not.toHaveBeenCalled();
    });

    it("flag ON bridges capabilities.doctor; validateKeys is OFF by default (quota gate)", async () => {
      const bridge = makeDoctorBridge();
      const { route } = findRoute("capabilities.doctor", {
        routeProvidersViaRust: true,
        rustCapabilityDoctor: bridge.rustCapabilityDoctor,
      });
      const result = await route.handler(makeCtx({ body: {} }));
      expect(result).toMatchObject({ truthLabel: "rust_capability_doctor", keyValidationProbed: false });
      // No explicit opt-in ⇒ zero quota.
      expect(bridge.calls).toEqual([{ validateKeys: false }]);
    });

    it("flag ON capabilities.doctor opts into the LIVE key-validation arm ONLY on explicit validateKeys:true", async () => {
      const bridge = makeDoctorBridge();
      const { route } = findRoute("capabilities.doctor", {
        routeProvidersViaRust: true,
        rustCapabilityDoctor: bridge.rustCapabilityDoctor,
      });
      const result = await route.handler(makeCtx({ body: { validateKeys: true } }));
      expect(result).toMatchObject({ truthLabel: "rust_capability_doctor", keyValidationProbed: true });
      expect(bridge.calls).toEqual([{ validateKeys: true }]);
    });

    it("flag ON but bridge missing fails closed (503), never silently passing", async () => {
      const { route } = findRoute("capabilities.doctor", { routeProvidersViaRust: true });
      await expect(route.handler(makeCtx({ body: {} }))).rejects.toMatchObject({
        code: "TS_RUNTIME_PROVIDER_PROBE_RETIRED",
        httpStatus: 503,
      });
    });

    it("flag ON still validates the capabilities.doctor body (400) before bridging", async () => {
      const bridge = makeDoctorBridge();
      const { route } = findRoute("capabilities.doctor", {
        routeProvidersViaRust: true,
        rustCapabilityDoctor: bridge.rustCapabilityDoctor,
      });
      await expect(
        route.handler(makeCtx({ body: { providerIds: [] } })),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR", httpStatus: 400 });
      expect(bridge.doctor).not.toHaveBeenCalled();
    });
  });
});
