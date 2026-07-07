import { describe, expect, it } from "vitest";
import { deriveProviderCapabilityMatrix } from "../../../ui/src/routes/providers-page";
import type { FridayProviderCapabilityHealthSnapshotItem, FridayProviderProfile } from "../../../ui/src/lib/api/types";

const provider = {
  id: "provider-openai",
  kind: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com",
  enabled: true,
  defaultModel: "gpt-5.5",
  config: {
    api: "openai-responses",
    authMode: "api-key",
    keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" },
    supportedModels: ["gpt-5.5"],
  },
  createdAt: "2026-07-06T00:00:00.000Z",
  updatedAt: "2026-07-06T00:00:00.000Z",
} satisfies FridayProviderProfile;

const capabilityHealth = {
  providerId: "provider-openai",
  providerKind: "openai",
  providerName: "OpenAI",
  lane: "primary",
  enabled: true,
  validationStatus: "ok",
  capabilities: [
    {
      capability: "text",
      state: "available",
      source: "runtime_capability_snapshot",
      message: "verified by runtime",
      blockerCodes: [],
      lastVerifiedAt: "2026-07-06T00:00:00.000Z",
    },
    {
      capability: "vision",
      state: "setup_needed",
      source: "provider_health_snapshot",
      message: "missing vision lane",
      blockerCodes: ["provider_lane_missing"],
    },
  ],
} satisfies FridayProviderCapabilityHealthSnapshotItem;

describe("UI-W1 providers capability truth derivation", () => {
  it("derives matrix cells from provider capability-health state instead of hard-coding NO-GO", () => {
    const rows = deriveProviderCapabilityMatrix([provider], new Map([[provider.id, capabilityHealth]]));

    expect(rows).toEqual([
      {
        capability: "text",
        cells: [
          {
            providerId: provider.id,
            providerName: "OpenAI",
            state: "available",
            label: "available",
          },
        ],
      },
      {
        capability: "vision",
        cells: [
          {
            providerId: provider.id,
            providerName: "OpenAI",
            state: "setup_needed",
            label: "setup needed",
          },
        ],
      },
    ]);
  });
});
