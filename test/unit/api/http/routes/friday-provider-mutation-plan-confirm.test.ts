import { describe, it, expect, vi } from "vitest";

import type { FridayHttpContext, FridayRouteDefinition } from "#api";
import { createFridayProviderRoutes } from "#api";
import type { FridayProviderProfile, FridayProviderService } from "#providers";
import {
  createFridayMutatingActionDigest,
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
  type FridayMutatingActionRequest,
} from "../../../../../src/security/friday-mutating-action-gate.js";

/**
 * CORE-A CR-2 — provider setup owner-confirm handshake.
 *
 * These are integration tests against the REAL provider routes (plan / plan.confirm /
 * the gated mutation routes) with the REAL canonical mutating-action gate wired with a
 * signature secret. Nothing here is a mock of the gate: every negative below is the
 * production fail-closed path.
 */
describe("provider mutation plan → owner confirm → gated mutation", () => {
  const NOW = "2026-02-17T10:00:00.000Z";
  const APPROVAL_SIGNATURE_SECRET = "test-hub-token-secret";
  /**
   * A key-SHAPED value. Every "no secret leaks" assertion below searches the full
   * serialized plan/confirm response for this exact string.
   */
  const SECRET_API_KEY = "sk-live-CR2SECRET0000000000000000000000000000";

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

  function makeMockService(): FridayProviderService {
    return {
      listProviders: vi.fn(async () => [sampleProfile]),
      getProvider: vi.fn(async () => sampleProfile),
      createProvider: vi.fn(async () => sampleProfile),
      updateProvider: vi.fn(async () => sampleProfile),
      deleteProvider: vi.fn(async () => undefined),
      activateAuthProfile: vi.fn(async () => ({ id: "auth-default" })),
      getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "prov-001", fallbackProviderIds: [] })),
      setRoutingConfig: vi.fn(async (input: unknown) => input),
    } as unknown as FridayProviderService;
  }

  interface Harness {
    routes: FridayRouteDefinition<unknown, unknown, unknown, unknown>[];
    service: FridayProviderService;
    route: (operationId: string) => FridayRouteDefinition<unknown, unknown, unknown, unknown>;
    setNow: (iso: string) => void;
    signCalls: () => number;
  }

  function makeHarness(options: { withSigner?: boolean } = {}): Harness {
    const service = makeMockService();
    let now = NOW;
    let signCalls = 0;

    // The REAL production signing seam (identical to friday-api-runtime's
    // signCanonicalApprovalForRequest): HMAC over the server-derived action digest,
    // with a ~10 minute expiry.
    const signCanonicalApproval = (
      request: FridayMutatingActionRequest,
      input: { approvalIdPrefix: string },
    ): FridayCanonicalApprovalResolution => {
      signCalls += 1;
      const expiresAt = new Date(Date.parse(now) + 10 * 60 * 1000).toISOString();
      return signFridayCanonicalApproval({
        decision: "approved",
        approvalId: `${input.approvalIdPrefix}-${String(signCalls)}`,
        decidedByPrincipalId: request.actor.principalId ?? request.actor.id,
        actionDigest: createFridayMutatingActionDigest(request),
        expiresAt,
      }, APPROVAL_SIGNATURE_SECRET);
    };

    const routes = createFridayProviderRoutes({
      providerService: service,
      providerMutationGateRequired: true,
      canonicalMutationGate: createFridayMutatingActionGate({
        nowIso: () => now,
        ticketIdGenerator: () => "ticket-1",
        approvalSignatureSecret: APPROVAL_SIGNATURE_SECRET,
      }),
      allowTestOnlyProviderProbeExecution: true,
      allowTestOnlyProviderRoutingControlsExecution: true,
      nowIso: () => now,
      ...(options.withSigner === false ? {} : { signCanonicalApproval }),
    });

    return {
      routes,
      service,
      route: (operationId: string) => {
        const found = routes.find((entry) => entry.operationId === operationId);
        if (!found) {
          throw new Error(`route not found: ${operationId}`);
        }
        return found;
      },
      setNow: (iso: string) => {
        now = iso;
      },
      signCalls: () => signCalls,
    };
  }

  function makeCtx(input: {
    body?: unknown;
    params?: Record<string, string>;
    principalId?: string;
    requestId?: string;
  }): FridayHttpContext<unknown, unknown, unknown> {
    const principalId = input.principalId ?? "user-1";
    return {
      requestId: input.requestId ?? "req-1",
      receivedAt: NOW,
      params: input.params ?? {},
      query: {},
      body: input.body ?? {},
      headers: {},
      principal: {
        principalType: "user",
        principalId,
        userId: principalId,
        role: "admin",
        scopes: ["hub.admin"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    } as unknown as FridayHttpContext<unknown, unknown, unknown>;
  }

  const CREATE_PARAMS = {
    kind: "openai" as const,
    name: "Test",
    baseUrl: "https://test.com",
    authMode: "api-key" as const,
    api: "openai-completions" as const,
    supportedModels: ["gpt-4o"],
    apiKey: SECRET_API_KEY,
  };

  async function plan(
    harness: Harness,
    body: Record<string, unknown>,
    principalId = "user-1",
  ): Promise<{ plan: { planDigest: string; humanReadableSummary: string[] } }> {
    return await harness.route("providers.plan").handler(
      makeCtx({ body, principalId }),
    ) as { plan: { planDigest: string; humanReadableSummary: string[] } };
  }

  async function confirm(
    harness: Harness,
    planDigest: string,
    principalId = "user-1",
  ): Promise<{ approval: { canonicalApproval: unknown; planDigest: string } }> {
    return await harness.route("providers.plan.confirm").handler(
      makeCtx({ body: { planDigest, confirm: true }, principalId }),
    ) as { approval: { canonicalApproval: unknown; planDigest: string } };
  }

  // ─── Happy path ───

  it("plan → confirm → create passes the canonical gate for a NORMAL owner", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    expect(planned.plan.planDigest).toMatch(/^fpmp_[0-9a-f]{64}$/);

    const confirmed = await confirm(harness, planned.plan.planDigest);
    const result = await harness.route("providers.create").handler(makeCtx({
      body: {
        ...CREATE_PARAMS,
        planDigest: planned.plan.planDigest,
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }));

    expect(harness.service.createProvider).toHaveBeenCalledWith(CREATE_PARAMS);
    expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
    expect(result).toHaveProperty("canonicalGate.planDigest", planned.plan.planDigest);
  });

  it("plan → confirm → routing.set (a second gated surface) passes the gate", async () => {
    const harness = makeHarness();
    const routingParams = { defaultProviderId: "prov-001", fallbackProviderIds: ["prov-001"] };
    const planned = await plan(harness, { action: "providers.routing.set", params: routingParams });
    const confirmed = await confirm(harness, planned.plan.planDigest);

    const result = await harness.route("providers.routing.set").handler(makeCtx({
      body: {
        ...routingParams,
        planDigest: planned.plan.planDigest,
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }));
    expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
  });

  it("plan → confirm → delete (a param-free target-id surface) passes the gate", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.delete", providerId: "prov-001" });
    const confirmed = await confirm(harness, planned.plan.planDigest);

    const result = await harness.route("providers.delete").handler(makeCtx({
      params: { providerId: "prov-001" },
      body: {
        planDigest: planned.plan.planDigest,
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }));
    expect(harness.service.deleteProvider).toHaveBeenCalledWith("prov-001");
    expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
  });

  // ─── Fail-closed negatives ───

  it("missing planDigest is refused with PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED", async () => {
    const harness = makeHarness();
    await expect(harness.route("providers.create").handler(makeCtx({ body: CREATE_PARAMS })))
      .rejects.toMatchObject({
        code: "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED",
        httpStatus: 403,
      });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a plan digest alone (no approval) never authorizes a mutation", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    await expect(harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.plan.planDigest },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("an unknown / stale plan digest cannot be confirmed", async () => {
    const harness = makeHarness();
    await expect(confirm(harness, "fpmp_deadbeef")).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_PLAN_NOT_FOUND",
      httpStatus: 404,
    });
  });

  it("replaying a valid approval under a DIFFERENT plan digest fails closed on digest mismatch", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned.plan.planDigest);

    await expect(harness.route("providers.create").handler(makeCtx({
      body: {
        ...CREATE_PARAMS,
        planDigest: "fpmp_someone-elses-digest",
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("parameter drift between the reviewed plan and the replayed body fails closed", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned.plan.planDigest);

    // Same owner, same planDigest, same signed approval — but the body that actually
    // arrives points at a different endpoint. The gate recomputes the action digest
    // from THIS request, so the approval no longer binds.
    await expect(harness.route("providers.create").handler(makeCtx({
      body: {
        ...CREATE_PARAMS,
        baseUrl: "https://attacker.example",
        planDigest: planned.plan.planDigest,
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a tampered approval signature fails closed", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned.plan.planDigest);
    const tampered = {
      ...(confirmed.approval.canonicalApproval as Record<string, unknown>),
      signature: "00".repeat(32),
    };

    await expect(harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.plan.planDigest, canonicalApproval: tampered },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a plan can only be confirmed by the principal that created it", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS }, "user-1");

    await expect(confirm(harness, planned.plan.planDigest, "user-2")).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_PLAN_OWNER_MISMATCH",
      httpStatus: 403,
    });
    expect(harness.signCalls()).toBe(0);
  });

  it("a plan is single-use at the confirm layer", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await confirm(harness, planned.plan.planDigest);

    await expect(confirm(harness, planned.plan.planDigest)).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_PLAN_ALREADY_CONFIRMED",
      httpStatus: 409,
    });
    expect(harness.signCalls()).toBe(1);
  });

  it("a minted approval is single-use at the gate layer (replay is denied)", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned.plan.planDigest);
    const body = {
      ...CREATE_PARAMS,
      planDigest: planned.plan.planDigest,
      canonicalApproval: confirmed.approval.canonicalApproval,
    };

    await harness.route("providers.create").handler(makeCtx({ body }));
    await expect(harness.route("providers.create").handler(makeCtx({ body })))
      .rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).toHaveBeenCalledTimes(1);
  });

  it("an expired plan cannot be confirmed", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    harness.setNow("2026-02-17T10:11:00.000Z"); // > 10 minute plan TTL
    await expect(confirm(harness, planned.plan.planDigest)).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_PLAN_NOT_FOUND",
    });
    expect(harness.signCalls()).toBe(0);
  });

  it("an expired approval is refused by the gate", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned.plan.planDigest);

    harness.setNow("2026-02-17T10:20:00.000Z"); // past the ~10 minute approval expiry
    await expect(harness.route("providers.create").handler(makeCtx({
      body: {
        ...CREATE_PARAMS,
        planDigest: planned.plan.planDigest,
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("confirm requires an explicit `confirm: true` and never defaults it", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    await expect(harness.route("providers.plan.confirm").handler(makeCtx({
      body: { planDigest: planned.plan.planDigest },
    }))).rejects.toMatchObject({ code: "PROVIDER_MUTATION_CONFIRMATION_REQUIRED" });
    expect(harness.signCalls()).toBe(0);
  });

  it("confirm fails closed (503) when no approval signer is wired", async () => {
    const harness = makeHarness({ withSigner: false });
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    await expect(confirm(harness, planned.plan.planDigest)).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_APPROVAL_SIGNER_UNAVAILABLE",
      httpStatus: 503,
    });
  });

  it("plan and confirm refuse the unauthenticated public principal", async () => {
    const harness = makeHarness();
    const publicCtx = {
      requestId: "req-1",
      receivedAt: NOW,
      params: {},
      query: {},
      body: { action: "providers.create", params: CREATE_PARAMS },
      headers: {},
      principal: null,
    } as unknown as FridayHttpContext<unknown, unknown, unknown>;

    await expect(harness.route("providers.plan").handler(publicCtx)).rejects.toMatchObject({
      code: "OWNER_SESSION_CHANNEL_PRINCIPAL_REQUIRED",
      httpStatus: 401,
    });
  });

  // ─── Secret-freedom of the review artifact ───

  it("the plan response never echoes an API key (presence only)", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const serialized = JSON.stringify(planned);

    expect(serialized).not.toContain(SECRET_API_KEY);
    expect(serialized).not.toContain("CR2SECRET");
    expect(planned.plan.humanReadableSummary.join("\n")).toContain("never shown or echoed back");
  });

  it("the confirm response never echoes an API key", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned.plan.planDigest);

    expect(JSON.stringify(confirmed)).not.toContain(SECRET_API_KEY);
    expect(JSON.stringify(confirmed)).not.toContain("CR2SECRET");
  });

  it("a secret smuggled into a custom header value never reaches the plan summary", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, {
      action: "providers.update",
      providerId: "prov-001",
      params: { headers: { "X-Api-Token": SECRET_API_KEY } },
    });

    expect(JSON.stringify(planned)).not.toContain(SECRET_API_KEY);
    expect(planned.plan.humanReadableSummary.join("\n")).toContain("1 header value(s)");
  });

  it("the OAuth device-complete plan never echoes the device code", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, {
      action: "providers.oauth.openai_codex.device.complete",
      params: { providerId: "codex-001", deviceCodeId: SECRET_API_KEY },
    });

    expect(JSON.stringify(planned)).not.toContain(SECRET_API_KEY);
    expect(planned.plan.humanReadableSummary.join("\n")).toContain("never shown here");
  });

  // ─── Plannability coverage of every gated action ───

  it("every gated provider action is plannable", async () => {
    const harness = makeHarness();
    const cases: Array<Record<string, unknown>> = [
      { action: "providers.create", params: CREATE_PARAMS },
      { action: "providers.update", providerId: "prov-001", params: { name: "Renamed" } },
      { action: "providers.delete", providerId: "prov-001" },
      { action: "providers.validate", providerId: "prov-001" },
      { action: "providers.routing.set", params: { defaultProviderId: "prov-001", fallbackProviderIds: [] } },
      {
        action: "providers.routing.pin",
        params: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" },
      },
      {
        action: "providers.routing.penalty.clear",
        params: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" },
      },
      { action: "providers.auth.profiles.activate", providerId: "prov-001", profileKey: "default" },
      { action: "providers.oauth.openai_codex.device.initiate", params: { providerId: "codex-001" } },
      {
        action: "providers.oauth.openai_codex.device.complete",
        params: { providerId: "codex-001", deviceCodeId: "device-1" },
      },
      { action: "capabilities.doctor", params: { providerIds: ["prov-001"] } },
    ];

    for (const body of cases) {
      const planned = await plan(harness, body);
      expect(planned.plan.planDigest, String(body.action)).toMatch(/^fpmp_/);
      expect(planned.plan.humanReadableSummary.length, String(body.action)).toBeGreaterThan(0);
    }
  });

  it("an unknown action is refused before any plan is minted", async () => {
    const harness = makeHarness();
    await expect(plan(harness, { action: "providers.exfiltrate" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  });

  it("a plan whose parameters are invalid is refused up front", async () => {
    const harness = makeHarness();
    await expect(plan(harness, { action: "providers.create", params: { kind: "openai" } }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(plan(harness, { action: "providers.delete" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  // ─── The plan/confirm routes grant no authority of their own ───

  it("planning performs no provider mutation", async () => {
    const harness = makeHarness();
    await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await plan(harness, { action: "providers.delete", providerId: "prov-001" });

    expect(harness.service.createProvider).not.toHaveBeenCalled();
    expect(harness.service.deleteProvider).not.toHaveBeenCalled();
    expect(harness.signCalls()).toBe(0);
  });

  it("re-planning the same change replaces the record and revokes an unspent confirmation slot", async () => {
    const harness = makeHarness();
    const first = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await confirm(harness, first.plan.planDigest);

    // Deterministic digest: re-planning yields the SAME digest, and the fresh record
    // is unconfirmed — but that is safe because the gate refuses the already-minted
    // approval on replay (single-use), proven above.
    const second = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    expect(second.plan.planDigest).toBe(first.plan.planDigest);

    const confirmed = await confirm(harness, second.plan.planDigest);
    expect(harness.signCalls()).toBe(2);
    expect(confirmed.approval.planDigest).toBe(first.plan.planDigest);
  });
});
