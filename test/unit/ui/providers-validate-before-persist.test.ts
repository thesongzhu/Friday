import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderMutationDeclinedError,
  ProviderRoutingAfterSaveError,
  saveProviderWithRouting,
  saveProviderWithValidation,
  type ProviderPlanConfirmer,
  type ProviderRoutingSaveClient,
  type ProviderValidateSaveClient,
  type ProviderSaveResult,
} from "@/lib/providers";
import type {
  CreateProviderInput,
  FridayProviderMutationApproval,
  FridayProviderMutationPlan,
  PlanProviderMutationInput,
  SetRoutingInput,
} from "@/lib/api/providers";
import type { ProviderApprovalAuthor, ProviderApprovalDeviceProof } from "@/lib/auth/device-key";
import type { FridayModelRoutingConfig, FridayProviderProfile } from "@/lib/api/types";

/**
 * The onboarding setup wizard's validate/save action goes through the SAME live
 * create validate-before-persist path the Settings page uses, and — in a release
 * profile — through the DEVICE-AUTHORED owner-confirm handshake (SEC-APPROVAL-
 * AUTHORITY-001 / CORE-A CR-2): plan → owner-review → DEVICE-sign → confirm →
 * replay. The Hub holds no signing key. These tests drive the shared client
 * helpers with mocks. No real key / call / device.
 */

function fakeProvider(id: string, name = id): FridayProviderProfile {
  return { id, name } as unknown as FridayProviderProfile;
}

function makeDraft(): CreateProviderInput {
  return {
    kind: "openai",
    name: "OpenAI Provider",
    baseUrl: "https://api.openai.com",
    authMode: "api-key",
    api: "openai-completions",
    apiKey: "synthetic-byok-not-a-real-key", // pragma: allowlist secret
    supportedModels: ["gpt-4o"],
    defaultModel: "gpt-4o",
    enabled: true,
  };
}

function fakePlan(overrides?: Partial<FridayProviderMutationPlan>): FridayProviderMutationPlan {
  return {
    planDigest: "plan-digest-1",
    actionDigest: "action-digest-1",
    action: "providers.create",
    surface: "providers",
    humanReadableSummary: ["Add provider openai", "Base URL https://api.openai.com"],
    approvalRequired: true,
    createdAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-19T00:05:00.000Z",
    ...overrides,
  };
}

/** A device proof stub — the client helpers pass it through opaquely. */
function fakeDeviceProof(actionDigest: string): ProviderApprovalDeviceProof {
  return {
    transcript: {
      transcriptVersion: "friday-provider-approval-v1",
      algorithm: "ECDSA_P256_SHA256",
      kind: "provider_mutation_approval",
      approvalId: "approval-stub",
      actionDigest,
      decidedByPrincipalId: "device-owner:hash",
      expiresAt: "2026-07-19T00:09:00.000Z",
      devicePublicKeyHash: "hash",
    },
    devicePublicKey: { encoding: "spki-der-base64", value: "spki" },
    signature: { encoding: "ieee-p1363-base64", value: "sig" },
  };
}

/** Owner ALWAYS confirms. */
const alwaysConfirm: ProviderPlanConfirmer = async () => true;
/** Owner reviews and DECLINES. */
const alwaysDecline: ProviderPlanConfirmer = async () => false;

function makeClient(overrides?: {
  create?: (input: CreateProviderInput) => Promise<ProviderSaveResult>;
  setRouting?: (input: SetRoutingInput) => Promise<FridayModelRoutingConfig>;
  plan?: FridayProviderMutationPlan;
}) {
  const create = vi.fn(
    overrides?.create ??
      (async (_input: CreateProviderInput): Promise<ProviderSaveResult> => ({
        provider: fakeProvider("created-1", "OpenAI Provider"),
        validation: { status: "ok" },
      })),
  );
  const update = vi.fn(
    async (_id: string, _patch): Promise<ProviderSaveResult> => ({
      provider: fakeProvider("updated-1"),
      validation: { status: "ok" },
    }),
  );
  const planMutation = vi.fn(
    async (input: PlanProviderMutationInput): Promise<FridayProviderMutationPlan> =>
      overrides?.plan
        ?? fakePlan(input.action === "providers.routing.set"
          ? { action: "providers.routing.set", planDigest: "routing-digest-1", actionDigest: "routing-action-1" }
          : {}),
  );
  // The device-authored approval is the SECOND argument now — the Hub verifies it.
  const confirmMutation = vi.fn(
    async (planDigest: string, deviceApproval: ProviderApprovalDeviceProof): Promise<FridayProviderMutationApproval> => ({
      planDigest,
      actionDigest: deviceApproval.transcript.actionDigest,
      action: "providers.create",
      confirmedAt: "2026-07-19T00:01:00.000Z",
      expiresAt: "2026-07-19T00:06:00.000Z",
      canonicalApproval: { issuer: "friday_device_owner", deviceProof: deviceApproval },
    }),
  );
  const setRouting = vi.fn(
    overrides?.setRouting ??
      (async (input: SetRoutingInput): Promise<FridayModelRoutingConfig> => ({
        defaultProviderId: input.defaultProviderId,
        fallbackProviderIds: input.fallbackProviderIds,
      } as FridayModelRoutingConfig)),
  );
  const client: ProviderRoutingSaveClient = { planMutation, confirmMutation, create, update, setRouting };
  return { client, create, update, planMutation, confirmMutation, setRouting };
}

/** A device-approval author stub that records the digests it was asked to sign. */
function makeAuthor(): ProviderApprovalAuthor & { calls: string[] } {
  const calls: string[] = [];
  const author = (async ({ actionDigest }: { actionDigest: string }) => {
    calls.push(actionDigest);
    return fakeDeviceProof(actionDigest);
  }) as ProviderApprovalAuthor & { calls: string[] };
  author.calls = calls;
  return author;
}

describe("onboarding validate-before-persist", () => {
  it("hits the live create route with validateOnSave:true when no provider of that kind exists", async () => {
    const { client, create, update } = makeClient();
    await saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm, makeAuthor());
    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const arg = create.mock.calls[0][0];
    expect(arg.validateOnSave).toBe(true);
    expect(arg.kind).toBe("openai");
  });

  it("updates the existing same-kind provider instead of creating a duplicate", async () => {
    const { client, create, update } = makeClient();
    await saveProviderWithValidation(client, { id: "existing-openai" }, makeDraft(), alwaysConfirm, makeAuthor());
    expect(update).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe("existing-openai");
    expect(patch.validateOnSave).toBe(true);
  });

  it("propagates a validate-before-persist rejection (invalid key is surfaced, not swallowed)", async () => {
    const { client } = makeClient({
      create: async () => {
        throw Object.assign(new Error("Authentication failed"), { code: "PROVIDER_AUTH_INVALID" });
      },
    });
    await expect(
      saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm, makeAuthor()),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" });
  });

  it("the setup wizard no longer depends on the retired /v1/providers/detect route", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");
    expect(setupSource).not.toContain("setupApi.detectProvider");
    // It routes through the shared confirmed-save + confirmed-routing helper.
    expect(setupSource).toContain("saveProviderWithRouting");
  });
});

describe("CORE-A CR-2 — DEVICE-authored owner-confirm handshake", () => {
  it("runs plan → DEVICE-sign → confirm → mutate and replays the SERVER digest + device approval", async () => {
    const { client, create, planMutation, confirmMutation } = makeClient();
    const author = makeAuthor();

    await saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm, author);

    // 1) plan derived from the EXACT mutation body
    const planReq = planMutation.mock.calls[0][0];
    expect(planReq.action).toBe("providers.create");
    expect(planReq.params).toMatchObject({ kind: "openai", validateOnSave: true });

    // 2) the DEVICE signed over the SERVER-computed action digest…
    expect(author.calls).toEqual(["action-digest-1"]);
    // 3) …and confirm carried that device proof (2-arg confirm; Hub verifies it)
    expect(confirmMutation).toHaveBeenCalledTimes(1);
    const [confirmDigest, confirmProof] = confirmMutation.mock.calls[0];
    expect(confirmDigest).toBe("plan-digest-1");
    expect((confirmProof as ProviderApprovalDeviceProof).transcript.actionDigest).toBe("action-digest-1");

    // 4) the mutation replays the device-authored controls
    const body = create.mock.calls[0][0];
    expect(body.planDigest).toBe("plan-digest-1");
    expect((body.canonicalApproval as { issuer?: string }).issuer).toBe("friday_device_owner");
  });

  it("NEGATIVE: owner declines → no device approval authored, nothing mutated", async () => {
    const { client, create, update, planMutation, confirmMutation } = makeClient();
    const author = makeAuthor();

    await expect(
      saveProviderWithValidation(client, undefined, makeDraft(), alwaysDecline, author),
    ).rejects.toBeInstanceOf(ProviderMutationDeclinedError);

    expect(planMutation).toHaveBeenCalledTimes(1);
    expect(author.calls).toEqual([]); // no device signature authored
    expect(confirmMutation).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("NEGATIVE: a non-true confirmation is never treated as consent", async () => {
    const { client, create, confirmMutation } = makeClient();
    const ambiguous = (async () => undefined) as unknown as ProviderPlanConfirmer;

    await expect(
      saveProviderWithValidation(client, undefined, makeDraft(), ambiguous, makeAuthor()),
    ).rejects.toBeInstanceOf(ProviderMutationDeclinedError);

    expect(confirmMutation).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("the client never derives the digest itself — the DEVICE signs the SERVER digest", async () => {
    const { client, create } = makeClient({ plan: fakePlan({ planDigest: "server-only-digest" }) });
    const author = makeAuthor();
    await saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm, author);
    expect(create.mock.calls[0][0].planDigest).toBe("server-only-digest");
    expect(author.calls).toEqual(["action-digest-1"]); // whatever the server derived
  });
});

// ─── Advisor #1628 finding #3 — partial Setup state (SAFE-ROLLBACK-PRECONDITION-001) ───

describe("CORE-A CR-2 — provider save + routing cannot leave a partial provider", () => {
  it("RED-FIRST (the defect): a BARE setRouting with no approval 403s in a release profile", async () => {
    // This reproduces the OLD setup path: create succeeds, then `providersApi.setRouting`
    // is called WITHOUT a planDigest/approval → the release gate 403s AFTER the provider
    // is already persisted, stranding a created-but-unrouted provider.
    const { client } = makeClient({
      setRouting: async (input) => {
        if (!input.planDigest || !input.canonicalApproval) {
          throw Object.assign(new Error("plan digest required"), {
            code: "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED",
            httpStatus: 403,
          });
        }
        return { defaultProviderId: input.defaultProviderId, fallbackProviderIds: [] } as FridayModelRoutingConfig;
      },
    });

    await expect(
      client.setRouting({ defaultProviderId: "created-1", fallbackProviderIds: [] }),
    ).rejects.toMatchObject({ code: "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED", httpStatus: 403 });
  });

  it("FIXED: saveProviderWithRouting routes setRouting THROUGH plan/confirm (carries a device approval)", async () => {
    // Same release gate as the red-first, but now routing flows through the confirmed,
    // device-authored handshake, so it carries the controls and never 403s-after-persist.
    const { client, create, setRouting, planMutation, confirmMutation } = makeClient({
      setRouting: async (input) => {
        if (!input.planDigest || !input.canonicalApproval) {
          throw Object.assign(new Error("plan digest required"), { code: "PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED" });
        }
        return { defaultProviderId: input.defaultProviderId, fallbackProviderIds: [] } as FridayModelRoutingConfig;
      },
    });
    const author = makeAuthor();

    const result = await saveProviderWithRouting(
      client,
      undefined,
      makeDraft(),
      (provider) => ({ defaultProviderId: provider.id, fallbackProviderIds: [] }),
      alwaysConfirm,
      author,
    );

    expect(create).toHaveBeenCalledTimes(1);
    // TWO gated mutations, TWO confirmed device approvals (create + routing).
    expect(planMutation).toHaveBeenCalledTimes(2);
    expect(confirmMutation).toHaveBeenCalledTimes(2);
    // routing carried the confirmed controls → no 403-after-persist.
    const routingArg = setRouting.mock.calls[0][0];
    expect(routingArg.defaultProviderId).toBe("created-1");
    expect(routingArg.planDigest).toBe("routing-digest-1");
    expect(routingArg.canonicalApproval).toBeDefined();
    expect(result.routing.defaultProviderId).toBe("created-1");
  });

  it("routing failure AFTER a save is reported TRUTHFULLY (provider named), never hidden", async () => {
    const { client } = makeClient({
      setRouting: async () => {
        throw Object.assign(new Error("routing service unavailable"), { code: "ROUTING_UNAVAILABLE" });
      },
    });

    const err = await saveProviderWithRouting(
      client,
      undefined,
      makeDraft(),
      (provider) => ({ defaultProviderId: provider.id, fallbackProviderIds: [] }),
      alwaysConfirm,
      makeAuthor(),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ProviderRoutingAfterSaveError);
    expect((err as ProviderRoutingAfterSaveError).provider.id).toBe("created-1");
    // the provider was saved (reported), not swallowed behind a generic save failure
    expect((err as ProviderRoutingAfterSaveError).provider.name).toBe("OpenAI Provider");
  });

  it("declining the routing plan propagates the decline (the save's first step stands)", async () => {
    const { client } = makeClient();
    let call = 0;
    const confirmThenDecline: ProviderPlanConfirmer = async () => {
      call += 1;
      return call === 1; // confirm the create, decline the routing
    };

    await expect(
      saveProviderWithRouting(
        client,
        undefined,
        makeDraft(),
        (provider) => ({ defaultProviderId: provider.id, fallbackProviderIds: [] }),
        confirmThenDecline,
        makeAuthor(),
      ),
    ).rejects.toBeInstanceOf(ProviderMutationDeclinedError);
  });
});
