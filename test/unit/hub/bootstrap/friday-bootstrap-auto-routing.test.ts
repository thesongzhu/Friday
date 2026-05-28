import { describe, expect, it } from "vitest";

import {
  collectFridayBootstrapRouteCandidates,
  resolveFridayBootstrapAutoRouting,
  type FridayBootstrapRouteCandidate,
} from "../../../../src/hub/bootstrap/friday-bootstrap-auto-routing.js";

const modelFor = (c: FridayBootstrapRouteCandidate) =>
  c.kind === "anthropic" ? "claude-sonnet-4-20250514" : c.kind === "deepseek" ? "deepseek-v4-pro" : "gpt-4o-mini";

describe("resolveFridayBootstrapAutoRouting", () => {
  it("auto-selects the sole provider with no injected fallbacks (single-key BYOK)", () => {
    const decision = resolveFridayBootstrapAutoRouting(
      [{ kind: "openai", id: "openai-1" }],
      modelFor,
    );
    expect(decision).toEqual({
      defaultProviderId: "openai-1",
      defaultModel: "gpt-4o-mini",
      fallbackProviderIds: [],
    });
  });

  it("does NOT silently pick a default when multiple providers are available", () => {
    const decision = resolveFridayBootstrapAutoRouting(
      [
        { kind: "anthropic", id: "anthropic-1" },
        { kind: "openai", id: "openai-1" },
        { kind: "deepseek", id: "deepseek-1" },
      ],
      modelFor,
    );
    // null => routing stays unconfigured => resolveRoute surfaces PROVIDER_NO_ROUTING =>
    // the user must choose explicitly. No hidden default, no fallback fan-out.
    expect(decision).toBeNull();
  });

  it("returns null when there are no candidates", () => {
    expect(resolveFridayBootstrapAutoRouting([], modelFor)).toBeNull();
  });

  it("never injects fallback providers even in the single-provider case", () => {
    const decision = resolveFridayBootstrapAutoRouting(
      [{ kind: "deepseek", id: "deepseek-1" }],
      modelFor,
    );
    expect(decision?.fallbackProviderIds).toEqual([]);
  });
});

describe("collectFridayBootstrapRouteCandidates", () => {
  it("unions newly-detected with already-enabled providers (deduped by id)", () => {
    const candidates = collectFridayBootstrapRouteCandidates({
      detected: [{ kind: "deepseek", id: "deepseek-1" }],
      existingEnabled: [
        { kind: "anthropic", id: "anthropic-1" },
        { kind: "openai", id: "openai-1" },
      ],
    });
    expect(candidates.map((c) => c.id).sort()).toEqual(["anthropic-1", "deepseek-1", "openai-1"]);
  });

  it("does not double-count a provider present in both lists", () => {
    const candidates = collectFridayBootstrapRouteCandidates({
      detected: [{ kind: "openai", id: "openai-1" }],
      existingEnabled: [{ kind: "openai", id: "openai-1" }],
    });
    expect(candidates).toHaveLength(1);
  });

  it("second-boot regression: adding one env key to an existing multi-provider setup still requires explicit choice", () => {
    // Two providers already configured, user adds a third via a new env key.
    const candidates = collectFridayBootstrapRouteCandidates({
      detected: [{ kind: "deepseek", id: "deepseek-1" }],
      existingEnabled: [
        { kind: "anthropic", id: "anthropic-1" },
        { kind: "openai", id: "openai-1" },
      ],
    });
    expect(candidates).toHaveLength(3);
    // The union (3) must NOT be silently auto-selected — the newly-detected single key
    // must not become the default among multiple configured providers.
    expect(resolveFridayBootstrapAutoRouting(candidates, modelFor)).toBeNull();
  });

  it("preserves single-provider BYOK from either source", () => {
    expect(
      resolveFridayBootstrapAutoRouting(
        collectFridayBootstrapRouteCandidates({
          detected: [{ kind: "openai", id: "openai-1" }],
          existingEnabled: [],
        }),
        modelFor,
      )?.defaultProviderId,
    ).toBe("openai-1");
    expect(
      resolveFridayBootstrapAutoRouting(
        collectFridayBootstrapRouteCandidates({
          detected: [],
          existingEnabled: [{ kind: "anthropic", id: "anthropic-1" }],
        }),
        modelFor,
      )?.defaultProviderId,
    ).toBe("anthropic-1");
  });
});
