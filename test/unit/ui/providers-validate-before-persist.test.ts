import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  saveProviderWithValidation,
  type ProviderValidateSaveClient,
  type ProviderSaveResult,
} from "@/lib/providers";
import type { CreateProviderInput } from "@/lib/api/providers";
import type { FridayProviderProfile } from "@/lib/api/types";

/**
 * Task 1 — the onboarding setup wizard's validate/save action must go through
 * the SAME live create validate-before-persist path the Settings page uses
 * (providersApi.create/update with validateOnSave:true), NOT the retired
 * POST /v1/providers/detect route (fail-closed 503 in the default runtime).
 *
 * These tests drive the shared client helper (the re-point target) and also
 * assert the wizard no longer depends on the detect route. No real key / call.
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

function makeClient(overrides?: {
  create?: (input: CreateProviderInput) => Promise<ProviderSaveResult>;
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
  const client: ProviderValidateSaveClient = { create, update };
  return { client, create, update };
}

describe("onboarding validate-before-persist (Task 1 re-point)", () => {
  it("hits the live create route with validateOnSave:true when no provider of that kind exists", async () => {
    const { client, create, update } = makeClient();

    await saveProviderWithValidation(client, undefined, makeDraft());

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    const arg = create.mock.calls[0][0];
    expect(arg.validateOnSave).toBe(true); // validate-before-persist, not blind save
    expect(arg.kind).toBe("openai"); // saves the selected kind
  });

  it("updates the existing same-kind provider instead of creating a duplicate", async () => {
    const { client, create, update } = makeClient();

    await saveProviderWithValidation(client, { id: "existing-openai" }, makeDraft());

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
    await saveProviderWithValidation(client, undefined, draft);
    // Replay of the same submit: the provider now exists (same kind) → update,
    // NOT a second create. So the credential is not persisted twice, and the
    // re-check still runs (validateOnSave stays true).
    await saveProviderWithValidation(client, { id: "created-1" }, draft);

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
      saveProviderWithValidation(client, undefined, makeDraft()),
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
