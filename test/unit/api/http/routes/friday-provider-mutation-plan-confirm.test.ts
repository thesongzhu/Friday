import { describe, it, expect, vi } from "vitest";

import type { FridayHttpContext, FridayRouteDefinition } from "#api";
import { createFridayProviderRoutes } from "#api";
import type { FridayProviderProfile, FridayProviderService } from "#providers";
import {
  createFridayMutatingActionGate,
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
  type FridayDeviceApprovalVerifyResult,
} from "../../../../../src/security/friday-mutating-action-gate.js";
import { createFridayProviderApprovalPoPVerifier } from "../../../../../src/api/auth/device-attest/index.js";
import type { ProviderApprovalDeviceProof } from "../../../../../src/api/auth/device-attest/index.js";
import {
  deviceOwnerPrincipalIdFor,
  generateTestDeviceKey,
  makeApprovalProof,
  makeApprovalTranscript,
  type TestDeviceKey,
} from "../../../../helpers/friday-provider-approval-test-kit.js";

/**
 * SEC-APPROVAL-AUTHORITY-001 · CORE-A CR-2 — device-authored provider approval.
 *
 * Integration tests against the REAL provider routes (plan / plan.confirm / the
 * gated mutation routes) with the REAL canonical mutating-action gate + the REAL
 * asymmetric device-approval verifier. Nothing here mocks the gate or the crypto:
 * every negative is the production fail-closed path. The Hub holds NO signing key —
 * the owner DEVICE signs each approval; the Hub only verifies it.
 */
describe("provider mutation plan → DEVICE confirm → gated mutation", () => {
  const NOW = "2026-02-17T10:00:00.000Z";
  /** The shared HMAC secret the LEGACY plugin-lifecycle path uses — a provider
   * mutation must REFUSE any approval carrying it (the Hub-self-sign negative). */
  const APPROVAL_SIGNATURE_SECRET = "test-hub-token-secret"; // pragma: allowlist secret
  const SECRET_API_KEY = "sk-live-CR2SECRET0000000000000000000000000000"; // pragma: allowlist secret

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

  interface Plan {
    planDigest: string;
    actionDigest: string;
    humanReadableSummary: string[];
  }

  interface Harness {
    service: FridayProviderService;
    route: (operationId: string) => FridayRouteDefinition<unknown, unknown, unknown, unknown>;
    setNow: (iso: string) => void;
  }

  function makeHarness(options: { withVerifier?: boolean } = {}): Harness {
    const service = makeMockService();
    let now = NOW;

    const providerApprovalVerifier = createFridayProviderApprovalPoPVerifier();
    // Wire the gate EXACTLY like the runtime: legacy HMAC secret (plugin path) PLUS
    // the asymmetric device verifier (provider path). Providers reject HMAC issuers.
    const canonicalMutationGate = createFridayMutatingActionGate({
      nowIso: () => now,
      ticketIdGenerator: () => "ticket-1",
      approvalSignatureSecret: APPROVAL_SIGNATURE_SECRET,
      requireApprovalSignature: true,
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
    });

    const routes = createFridayProviderRoutes({
      providerService: service,
      providerMutationGateRequired: true,
      canonicalMutationGate,
      allowTestOnlyProviderProbeExecution: true,
      allowTestOnlyProviderRoutingControlsExecution: true,
      nowIso: () => now,
      ...(options.withVerifier === false ? {} : { providerApprovalVerifier }),
    });

    return {
      service,
      route: (operationId: string) => {
        const found = routes.find((entry) => entry.operationId === operationId);
        if (!found) throw new Error(`route not found: ${operationId}`);
        return found;
      },
      setNow: (iso: string) => {
        now = iso;
      },
    };
  }

  // The single owner device for the harness (device-owner principal binds to it).
  const OWNER = generateTestDeviceKey();
  const OWNER_PRINCIPAL = deviceOwnerPrincipalIdFor(OWNER);

  function makeCtx(input: {
    body?: unknown;
    params?: Record<string, string>;
    principalId?: string;
    requestId?: string;
  }): FridayHttpContext<unknown, unknown, unknown> {
    const principalId = input.principalId ?? OWNER_PRINCIPAL;
    return {
      requestId: input.requestId ?? "req-1",
      receivedAt: NOW,
      params: input.params ?? {},
      query: {},
      body: input.body ?? {},
      headers: {},
      // The owner principal is BOUND to the device (its principalId IS the
      // device-owner id `device-owner:<keyHash>`). We set `principalType: "user"`
      // rather than "device" ON PURPOSE: a "device"-typed principal is release
      // DISABLED today (`isReleaseDisabledDevicePrincipal` — the NATIVE_IPC
      // attestation operator leaf we must NOT touch), so a "device" principal is
      // refused before any device-verification logic runs. This fixture stands in
      // for that principal AFTER it clears the attestation gate, so the tests
      // exercise the device-authored approval LOGIC (which binds on the principalId).
      // The real "device"-typed end-to-end admit remains the attestation operator leaf.
      principal: {
        principalType: "user",
        principalId,
        userId: "owner-user",
        role: "owner",
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
    principalId = OWNER_PRINCIPAL,
  ): Promise<Plan> {
    const result = await harness.route("providers.plan").handler(makeCtx({ body, principalId })) as {
      plan: Plan;
    };
    return result.plan;
  }

  /** Author a device proof for `planned` (defaults: owner key + a fresh expiry). */
  function deviceProofFor(
    planned: Plan,
    opts: { key?: TestDeviceKey; decidedByPrincipalId?: string; expiresAt?: string } = {},
  ): ProviderApprovalDeviceProof {
    const key = opts.key ?? OWNER;
    const transcript = makeApprovalTranscript(key, {
      actionDigest: planned.actionDigest,
      decidedByPrincipalId: opts.decidedByPrincipalId ?? deviceOwnerPrincipalIdFor(key),
      expiresAt: opts.expiresAt ?? "2026-02-17T10:09:00.000Z",
    });
    return makeApprovalProof(key, transcript);
  }

  async function confirm(
    harness: Harness,
    planned: Plan,
    opts: {
      principalId?: string;
      deviceApproval?: ProviderApprovalDeviceProof;
    } = {},
  ): Promise<{ approval: { canonicalApproval: unknown; planDigest: string; expiresAt: string } }> {
    return await harness.route("providers.plan.confirm").handler(
      makeCtx({
        body: {
          planDigest: planned.planDigest,
          confirm: true,
          deviceApproval: opts.deviceApproval ?? deviceProofFor(planned),
        },
        principalId: opts.principalId ?? OWNER_PRINCIPAL,
      }),
    ) as { approval: { canonicalApproval: unknown; planDigest: string; expiresAt: string } };
  }

  // ─── Happy path: the Hub VERIFIES a device approval and admits ───

  it("plan → DEVICE confirm → create passes the canonical gate", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    expect(planned.planDigest).toMatch(/^fpmp_[0-9a-f]{64}$/);

    const confirmed = await confirm(harness, planned);
    // The Hub added NO signature; it returned the device-authored approval verbatim.
    const approval = confirmed.approval.canonicalApproval as FridayCanonicalApprovalResolution;
    expect(approval.issuer).toBe("friday_device_owner");
    expect(approval.signature).toBeUndefined();
    expect(approval.deviceProof).toBeDefined();

    const result = await harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.planDigest, canonicalApproval: approval },
    }));
    expect(harness.service.createProvider).toHaveBeenCalledWith(CREATE_PARAMS);
    expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
  });

  it("plan → DEVICE confirm → routing.set (a second gated surface) passes the gate", async () => {
    const harness = makeHarness();
    const routingParams = { defaultProviderId: "prov-001", fallbackProviderIds: ["prov-001"] };
    const planned = await plan(harness, { action: "providers.routing.set", params: routingParams });
    const confirmed = await confirm(harness, planned);

    const result = await harness.route("providers.routing.set").handler(makeCtx({
      body: { ...routingParams, planDigest: planned.planDigest, canonicalApproval: confirmed.approval.canonicalApproval },
    }));
    expect(result).toHaveProperty("canonicalGate.ticketId", "ticket-1");
  });

  // ─── SEC-APPROVAL-AUTHORITY-001 negative controls ───

  it("HUB SELF-SIGN: a Hub-minted HMAC approval is REFUSED on a provider mutation", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    // The exact forbidden primitive: a symmetric HMAC the Hub both mints AND holds
    // the secret for, bound to the correct action digest. It MUST NOT admit.
    const hubSelfSigned = signFridayCanonicalApproval(
      {
        decision: "approved",
        approvalId: "hub-self-signed-1",
        decidedByPrincipalId: OWNER_PRINCIPAL,
        actionDigest: planned.actionDigest,
        expiresAt: "2026-02-17T10:09:00.000Z",
      },
      APPROVAL_SIGNATURE_SECRET,
    );

    await expect(harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.planDigest, canonicalApproval: hubSelfSigned },
    }))).rejects.toMatchObject({ code: "PROVIDER_MUTATION_APPROVAL_NOT_DEVICE_AUTHORED", httpStatus: 403 });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("WEB-SESSION confirm:true with NO device proof FAILS (no Hub self-mint)", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    await expect(harness.route("providers.plan.confirm").handler(makeCtx({
      body: { planDigest: planned.planDigest, confirm: true },
    }))).rejects.toMatchObject({ code: "PROVIDER_MUTATION_APPROVAL_PROOF_REQUIRED", httpStatus: 400 });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("WRONG DEVICE: an approval whose signing key is not the owner's bound device is refused at confirm", async () => {
    const harness = makeHarness();
    const attacker = generateTestDeviceKey();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });

    // The attacker signs with its OWN key but claims the owner's principal id. The
    // signing key hash no longer maps to the owner principal → refused.
    const proof = deviceProofFor(planned, { key: attacker, decidedByPrincipalId: OWNER_PRINCIPAL });
    await expect(confirm(harness, planned, { deviceApproval: proof })).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_APPROVAL_DEVICE_NOT_BOUND",
      httpStatus: 403,
    });
  });

  it("DIGEST MUTATION between preview and dispatch yields zero sink", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned);

    // Same owner, same planDigest, same device approval — but the body that arrives
    // points at a different endpoint. The gate recomputes the digest from THIS
    // request, so the device signature no longer covers it.
    await expect(harness.route("providers.create").handler(makeCtx({
      body: {
        ...CREATE_PARAMS,
        baseUrl: "https://attacker.example",
        planDigest: planned.planDigest,
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("replaying a valid approval under a DIFFERENT plan digest fails closed", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned);

    await expect(harness.route("providers.create").handler(makeCtx({
      body: {
        ...CREATE_PARAMS,
        planDigest: "fpmp_someone-elses-digest",
        canonicalApproval: confirmed.approval.canonicalApproval,
      },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a tampered device signature fails closed at the gate", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned);
    const approval = confirmed.approval.canonicalApproval as FridayCanonicalApprovalResolution;
    const tampered = {
      ...approval,
      deviceProof: {
        ...approval.deviceProof!,
        signature: { encoding: "ieee-p1363-base64" as const, value: Buffer.alloc(64, 7).toString("base64") },
      },
    };

    await expect(harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.planDigest, canonicalApproval: tampered },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a device approval is single-use at the gate (replay is denied)", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned);
    const body = {
      ...CREATE_PARAMS,
      planDigest: planned.planDigest,
      canonicalApproval: confirmed.approval.canonicalApproval,
    };

    await harness.route("providers.create").handler(makeCtx({ body }));
    await expect(harness.route("providers.create").handler(makeCtx({ body })))
      .rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).toHaveBeenCalledTimes(1);
  });

  it("an EXPIRED device approval is refused by the gate", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned, {
      deviceApproval: deviceProofFor(planned, { expiresAt: "2026-02-17T10:05:00.000Z" }),
    });

    harness.setNow("2026-02-17T10:06:00.000Z"); // past the signed approval expiry
    await expect(harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.planDigest, canonicalApproval: confirmed.approval.canonicalApproval },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_DENIED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a device approval with an over-long lifetime is refused at confirm", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    // 30 minutes > the Hub's 10-minute max device-approval lifetime.
    await expect(confirm(harness, planned, {
      deviceApproval: deviceProofFor(planned, { expiresAt: "2026-02-17T10:30:00.000Z" }),
    })).rejects.toMatchObject({ code: "PROVIDER_MUTATION_APPROVAL_EXPIRY_INVALID", httpStatus: 403 });
  });

  // ─── Plan-layer fail-closed negatives (unchanged semantics) ───

  it("missing planDigest is refused with PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED", async () => {
    const harness = makeHarness();
    await expect(harness.route("providers.create").handler(makeCtx({ body: CREATE_PARAMS })))
      .rejects.toMatchObject({ code: "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED", httpStatus: 403 });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("a plan digest alone (no approval) never authorizes a mutation", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await expect(harness.route("providers.create").handler(makeCtx({
      body: { ...CREATE_PARAMS, planDigest: planned.planDigest },
    }))).rejects.toMatchObject({ code: "CANONICAL_APPROVAL_REQUIRED" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
  });

  it("an unknown / stale plan digest cannot be confirmed", async () => {
    const harness = makeHarness();
    await expect(confirm(harness, { planDigest: "fpmp_deadbeef", actionDigest: "d".repeat(64), humanReadableSummary: [] }))
      .rejects.toMatchObject({ code: "PROVIDER_MUTATION_PLAN_NOT_FOUND", httpStatus: 404 });
  });

  it("a plan can only be confirmed by the principal that created it", async () => {
    const harness = makeHarness();
    const otherOwner = generateTestDeviceKey();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS }, OWNER_PRINCIPAL);

    // A different owner device presents a structurally valid proof for itself.
    await expect(confirm(harness, planned, {
      principalId: deviceOwnerPrincipalIdFor(otherOwner),
      deviceApproval: deviceProofFor(planned, { key: otherOwner }),
    })).rejects.toMatchObject({ code: "PROVIDER_MUTATION_PLAN_OWNER_MISMATCH", httpStatus: 403 });
  });

  it("a plan is single-use at the confirm layer", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await confirm(harness, planned);
    await expect(confirm(harness, planned)).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_PLAN_ALREADY_CONFIRMED",
      httpStatus: 409,
    });
  });

  it("an expired plan cannot be confirmed", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    harness.setNow("2026-02-17T10:11:00.000Z"); // > 10 minute plan TTL
    await expect(confirm(harness, planned)).rejects.toMatchObject({ code: "PROVIDER_MUTATION_PLAN_NOT_FOUND" });
  });

  it("confirm requires an explicit `confirm: true` and never defaults it", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await expect(harness.route("providers.plan.confirm").handler(makeCtx({
      body: { planDigest: planned.planDigest },
    }))).rejects.toMatchObject({ code: "PROVIDER_MUTATION_CONFIRMATION_REQUIRED" });
  });

  it("confirm fails closed (503) when no device-approval verifier is wired", async () => {
    const harness = makeHarness({ withVerifier: false });
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await expect(confirm(harness, planned)).rejects.toMatchObject({
      code: "PROVIDER_MUTATION_APPROVAL_VERIFIER_UNAVAILABLE",
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

  // ─── Secret-freedom of the review + approval artifacts ───

  it("the plan response never echoes an API key (presence only)", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const serialized = JSON.stringify(planned);
    expect(serialized).not.toContain(SECRET_API_KEY);
    expect(serialized).not.toContain("CR2SECRET");
    expect(planned.humanReadableSummary.join("\n")).toContain("never shown or echoed back");
  });

  it("the confirm response never echoes an API key", async () => {
    const harness = makeHarness();
    const planned = await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    const confirmed = await confirm(harness, planned);
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
    expect(planned.humanReadableSummary.join("\n")).toContain("1 header value(s)");
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
      { action: "providers.routing.pin", params: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" } },
      { action: "providers.routing.penalty.clear", params: { providerId: "prov-001", model: "gpt-4o", backendKind: "http" } },
      { action: "providers.auth.profiles.activate", providerId: "prov-001", profileKey: "default" },
      { action: "providers.oauth.openai_codex.device.initiate", params: { providerId: "codex-001" } },
      { action: "providers.oauth.openai_codex.device.complete", params: { providerId: "codex-001", deviceCodeId: "device-1" } },
      { action: "capabilities.doctor", params: { providerIds: ["prov-001"] } },
    ];
    for (const body of cases) {
      const planned = await plan(harness, body);
      expect(planned.planDigest, String(body.action)).toMatch(/^fpmp_/);
      expect(planned.humanReadableSummary.length, String(body.action)).toBeGreaterThan(0);
    }
  });

  it("planning performs no provider mutation", async () => {
    const harness = makeHarness();
    await plan(harness, { action: "providers.create", params: CREATE_PARAMS });
    await plan(harness, { action: "providers.delete", providerId: "prov-001" });
    expect(harness.service.createProvider).not.toHaveBeenCalled();
    expect(harness.service.deleteProvider).not.toHaveBeenCalled();
  });
});
