import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProviderTruth } from "../../../ui/src/hooks/use-provider-truth";
import { providersApi } from "@/lib/api/providers";

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    list: vi.fn(),
    listHealth: vi.fn(),
    getRouting: vi.fn(),
    explainRouting: vi.fn(),
  },
}));

const provider = {
  id: "provider-1",
  kind: "openai",
  name: "OpenAI",
  enabled: true,
  defaultModel: "gpt-4o-mini",
  config: {
    backendKind: "http",
  },
};

const health = {
  providerId: "provider-1",
  providerKind: "openai",
  lane: "primary",
  enabled: true,
  defaultModel: "gpt-4o-mini",
  backendKind: "http",
  authMode: "api-key",
  backendHealth: "healthy",
  authHealth: "healthy",
  routingEligible: true,
  validationStatus: "ok",
  circuitState: "closed",
  reasons: [],
  suggestedAction: "",
};

describe("loadProviderTruth", () => {
  beforeEach(() => {
    vi.mocked(providersApi.list).mockReset();
    vi.mocked(providersApi.listHealth).mockReset();
    vi.mocked(providersApi.getRouting).mockReset();
    vi.mocked(providersApi.explainRouting).mockReset();
  });

  it("degrades readiness when a primary provider has no fallback lane", async () => {
    vi.mocked(providersApi.list).mockResolvedValue([provider] as never);
    vi.mocked(providersApi.listHealth).mockResolvedValue([health] as never);
    vi.mocked(providersApi.getRouting).mockResolvedValue({
      defaultProviderId: "provider-1",
      defaultModel: "gpt-4o-mini",
      fallbackProviderIds: [],
    });
    vi.mocked(providersApi.explainRouting).mockResolvedValue({
      selected: {
        providerId: "provider-1",
        providerKind: "openai",
        model: "gpt-4o-mini",
        backendKind: "http",
        pinned: false,
      },
      selectedAdjusted: false,
      candidates: [],
      reasonText: "default",
    } as never);

    const truth = await loadProviderTruth();

    expect(truth.currentStatus).toBe("healthy");
    expect(truth.status).toBe("degraded");
    expect(truth.hasFallbackLane).toBe(false);
    expect(truth.alerts.some((alert) => alert.code === "fallback_missing")).toBe(true);
  });

  it("stays healthy when a fallback lane is configured", async () => {
    vi.mocked(providersApi.list).mockResolvedValue([
      provider,
      { ...provider, id: "provider-2", name: "OpenAI fallback" },
    ] as never);
    vi.mocked(providersApi.listHealth).mockResolvedValue([
      health,
      { ...health, providerId: "provider-2", lane: "fallback" },
    ] as never);
    vi.mocked(providersApi.getRouting).mockResolvedValue({
      defaultProviderId: "provider-1",
      defaultModel: "gpt-4o-mini",
      fallbackProviderIds: ["provider-2"],
    });
    vi.mocked(providersApi.explainRouting).mockResolvedValue({
      selected: {
        providerId: "provider-1",
        providerKind: "openai",
        model: "gpt-4o-mini",
        backendKind: "http",
        pinned: false,
      },
      selectedAdjusted: false,
      candidates: [],
      reasonText: "default",
    } as never);

    const truth = await loadProviderTruth();

    expect(truth.status).toBe("healthy");
    expect(truth.hasFallbackLane).toBe(true);
    expect(truth.alerts.some((alert) => alert.code === "fallback_missing")).toBe(false);
  });
});
