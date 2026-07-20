import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderMutationDeclinedError,
  saveProviderWithValidation,
  type ProviderPlanConfirmer,
  type ProviderValidateSaveClient,
  type ProviderSaveResult,
} from "@/lib/providers";
import type {
  CreateProviderInput,
  FridayProviderMutationApproval,
  FridayProviderMutationPlan,
  PlanProviderMutationInput,
} from "@/lib/api/providers";
import type { FridayProviderProfile } from "@/lib/api/types";

/**
 * Task 1 — the onboarding setup wizard's validate/save action must go through
 * the SAME live create validate-before-persist path the Settings page uses
 * (providersApi.create/update with validateOnSave:true), NOT the retired
 * POST /v1/providers/detect route (fail-closed 503 in the default runtime).
 *
 * CORE-RUNNABLE-001 / CORE-A CR-2 — in a release profile the canonical
 * mutating-action gate REQUIRES a server-derived plan digest plus a signed
 * canonical approval (absent ⇒ 403 PROVIDER_MUTATION_PLAN_DIGEST_REQUIRED).
 * The helper must therefore run the full plan → owner-confirm → mint → replay
 * handshake, and must NOT mutate anything when the owner declines.
 *
 * These tests drive the shared client helper. No real key / call.
 */

function fakeProvider(id: string): FridayProviderProfile {
  // The helper never inspects the provider body, so a minimal stub is fine.
  return { id } as unknown as FridayProviderProfile;
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

/** Owner ALWAYS confirms — used by the pre-existing behavioural assertions. */
const alwaysConfirm: ProviderPlanConfirmer = async () => true;
/** Owner reviews and DECLINES. */
const alwaysDecline: ProviderPlanConfirmer = async () => false;

function makeClient(overrides?: {
  create?: (input: CreateProviderInput) => Promise<ProviderSaveResult>;
  plan?: FridayProviderMutationPlan;
}) {
  const create = vi.fn(
    overrides?.create ??
      (async (_input: CreateProviderInput): Promise<ProviderSaveResult> => ({
        provider: fakeProvider("created-1"),
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
    async (_input: PlanProviderMutationInput): Promise<FridayProviderMutationPlan> =>
      overrides?.plan ?? fakePlan(),
  );
  const confirmMutation = vi.fn(
    async (planDigest: string): Promise<FridayProviderMutationApproval> => ({
      planDigest,
      actionDigest: "action-digest-1",
      action: "providers.create",
      confirmedAt: "2026-07-19T00:01:00.000Z",
      expiresAt: "2026-07-19T00:06:00.000Z",
      canonicalApproval: { signature: "signed-by-server" },
    }),
  );
  const client: ProviderValidateSaveClient = { planMutation, confirmMutation, create, update };
  return { client, create, update, planMutation, confirmMutation };
}

describe("onboarding validate-before-persist (Task 1 re-point)", () => {
  it("hits the live create route with validateOnSave:true when no provider of that kind exists", async () => {
    const { client, create, update } = makeClient();

    await saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm);

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const arg = create.mock.calls[0][0];
    expect(arg.validateOnSave).toBe(true); // validate-before-persist, not blind save
    expect(arg.kind).toBe("openai"); // saves the selected kind
  });

  it("updates the existing same-kind provider instead of creating a duplicate", async () => {
    const { client, create, update } = makeClient();

    await saveProviderWithValidation(client, { id: "existing-openai" }, makeDraft(), alwaysConfirm);

    expect(update).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    const [id, patch] = update.mock.calls[0];
    expect(id).toBe("existing-openai");
    expect(patch.validateOnSave).toBe(true);
  });

  it("replay: a replayed save is idempotent — create once, then update (no double-persist, no validate bypass)", async () => {
    const { client, create, update } = makeClient();
    const draft = makeDraft();

    // First submit: nothing exists yet → create.
    await saveProviderWithValidation(client, undefined, draft, alwaysConfirm);
    // Replay of the same submit: the provider now exists (same kind) → update,
    // NOT a second create. So the credential is not persisted twice, and the
    // re-check still runs (validateOnSave stays true).
    await saveProviderWithValidation(client, { id: "created-1" }, draft, alwaysConfirm);

    expect(create).toHaveBeenCalledTimes(1); // exactly one persist, no duplicate
    expect(update).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].validateOnSave).toBe(true);
    expect(update.mock.calls[0][1].validateOnSave).toBe(true); // no bypass on replay
  });

  it("propagates a validate-before-persist rejection (invalid key is surfaced, not swallowed)", async () => {
    const { client } = makeClient({
      create: async () => {
        throw Object.assign(new Error("Authentication failed"), {
          code: "PROVIDER_AUTH_INVALID",
        });
      },
    });

    await expect(
      saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm),
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_INVALID" });
  });

  it("the setup wizard no longer depends on the retired /v1/providers/detect route", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    // The validate/save action must not call the retired detect endpoint.
    expect(setupSource).not.toContain("setupApi.detectProvider");
    // It must route through the shared validate-before-persist helper…
    expect(setupSource).toContain("saveProviderWithValidation");
    // …with validate-before-persist explicitly requested.
    expect(setupSource).toContain("validateOnSave: true");
  });
});

describe("CORE-A CR-2 — provider owner-confirm handshake (release canonical gate)", () => {
  it("runs plan → confirm → mutate and replays the SERVER digest + approval on the mutation", async () => {
    const { client, create, planMutation, confirmMutation } = makeClient();

    await saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm);

    // 1) the server derived the plan from the EXACT body the mutation will send
    expect(planMutation).toHaveBeenCalledTimes(1);
    const planReq = planMutation.mock.calls[0][0];
    expect(planReq.action).toBe("providers.create");
    expect(planReq.providerId).toBeUndefined();
    expect(planReq.params).toMatchObject({ kind: "openai", validateOnSave: true });

    // 2) the owner's confirmation was bound to THAT plan digest
    expect(confirmMutation).toHaveBeenCalledWith("plan-digest-1");

    // 3) the mutation replays the server-minted controls so the gate can
    //    recompute the action digest server-side (absent ⇒ 403 fail-closed)
    const body = create.mock.calls[0][0];
    expect(body.planDigest).toBe("plan-digest-1");
    expect(body.canonicalApproval).toEqual({ signature: "signed-by-server" });
  });

  it("update path plans against the existing provider id and replays the approval", async () => {
    const { client, update, planMutation } = makeClient({
      plan: fakePlan({ action: "providers.update" }),
    });

    await saveProviderWithValidation(client, { id: "existing-openai" }, makeDraft(), alwaysConfirm);

    const planReq = planMutation.mock.calls[0][0];
    expect(planReq.action).toBe("providers.update");
    expect(planReq.providerId).toBe("existing-openai");
    // an update patch carries no immutable `kind`
    expect(planReq.params).not.toHaveProperty("kind");

    const [, patch] = update.mock.calls[0];
    expect(patch.planDigest).toBe("plan-digest-1");
    expect(patch.canonicalApproval).toEqual({ signature: "signed-by-server" });
  });

  it("NEGATIVE: owner declines → nothing is minted and nothing is mutated", async () => {
    const { client, create, update, planMutation, confirmMutation } = makeClient();

    await expect(
      saveProviderWithValidation(client, undefined, makeDraft(), alwaysDecline),
    ).rejects.toBeInstanceOf(ProviderMutationDeclinedError);

    expect(planMutation).toHaveBeenCalledTimes(1); // the owner did see a plan
    expect(confirmMutation).not.toHaveBeenCalled(); // …but no approval was minted
    expect(create).not.toHaveBeenCalled(); // …and nothing was persisted
    expect(update).not.toHaveBeenCalled();
  });

  it("NEGATIVE: confirmation is never defaulted — a non-true resolution aborts", async () => {
    const { client, create, confirmMutation } = makeClient();
    // A confirmer that resolves a falsy non-boolean must NOT be treated as consent.
    const ambiguous = (async () => undefined) as unknown as ProviderPlanConfirmer;

    await expect(
      saveProviderWithValidation(client, undefined, makeDraft(), ambiguous),
    ).rejects.toBeInstanceOf(ProviderMutationDeclinedError);

    expect(confirmMutation).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("the client never derives the digest itself — it only replays what the server returned", async () => {
    const { client, create } = makeClient({
      plan: fakePlan({ planDigest: "server-only-digest" }),
    });

    await saveProviderWithValidation(client, undefined, makeDraft(), alwaysConfirm);

    // the replayed digest is exactly the server's, never recomputed client-side
    expect(create.mock.calls[0][0].planDigest).toBe("server-only-digest");
  });

  it("the setup wizard wires the owner-confirm handshake (not a blind save)", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    // the owner must be shown the server-derived summary and confirm explicitly
    expect(setupSource).toContain("humanReadableSummary");
    expect(setupSource).toContain("pendingProviderPlan");
    // a decline is handled as a deliberate cancel, not a validation failure
    expect(setupSource).toContain("ProviderMutationDeclinedError");
  });
});
