import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFridayDeepProofSingleProviderLane,
  getFridayDeepProofEnvStatus,
} from "../../e2e/live/_helpers/deep-proof-env.js";

function repoPath(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

describe("friday deep proof env", () => {
  // ── Lane selection: exactly one provider lane required ─────────────────

  it("rejects deep proof runs when no provider lane is selected", () => {
    const status = getFridayDeepProofEnvStatus({});
    expect(status.gated).toBe(false);
    expect(status.selectedProvider).toBeNull();
    expect(status.blockers).toContain("no_provider_lane");
  });

  it("rejects deep proof runs when multiple provider lanes are selected", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      FRIDAY_E2E_LIVE_DEEPSEEK: "1",
      FRIDAY_ANTHROPIC_API_KEY: "anthropic-test-key", // pragma: allowlist secret
      FRIDAY_DEEPSEEK_API_KEY: "deepseek-test-key", // pragma: allowlist secret
    });
    expect(status.gated).toBe(false);
    expect(status.selectedProvider).toBeNull();
    expect(status.blockers).toContain("multiple_provider_lanes");
  });

  it("rejects deep proof runs when the legacy E2E_LIVE lane is set", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      FRIDAY_ANTHROPIC_API_KEY: "anthropic-test-key", // pragma: allowlist secret
      E2E_LIVE: "1",
    });
    expect(status.gated).toBe(false);
    expect(status.blockers).toContain("legacy_live_lane_enabled");
  });

  // ── Per-lane acceptance + missing-key rejection ─────────────────────────

  it("accepts the Anthropic lane with FRIDAY_ANTHROPIC_API_KEY", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      FRIDAY_ANTHROPIC_API_KEY: "anthropic-test-key", // pragma: allowlist secret
    });
    expect(status.gated).toBe(true);
    expect(status.selectedProvider).toBe("anthropic");
    expect(status.providerAuthLane).toBe("api_key");
    expect(status.credentialEnvRef).toBe("$FRIDAY_ANTHROPIC_API_KEY");
    expect(status.blockers).toEqual([]);
  });

  it("falls back to ANTHROPIC_API_KEY when FRIDAY_ANTHROPIC_API_KEY is absent", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      ANTHROPIC_API_KEY: "anthropic-legacy-key", // pragma: allowlist secret
    });
    expect(status.gated).toBe(true);
    expect(status.credentialEnvRef).toBe("$ANTHROPIC_API_KEY");
  });

  it("rejects the Anthropic lane when no Anthropic key is present", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
    });
    expect(status.gated).toBe(false);
    expect(status.blockers).toContain("missing_key:anthropic");
  });

  it("accepts the DeepSeek lane with FRIDAY_DEEPSEEK_API_KEY", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_DEEPSEEK: "1",
      FRIDAY_DEEPSEEK_API_KEY: "deepseek-test-key", // pragma: allowlist secret
    });
    expect(status.gated).toBe(true);
    expect(status.selectedProvider).toBe("deepseek");
    expect(status.providerAuthLane).toBe("bearer_token");
    expect(status.credentialEnvRef).toBe("$FRIDAY_DEEPSEEK_API_KEY");
    expect(status.blockers).toEqual([]);
  });

  it("falls back to DEEPSEEK_API_KEY when FRIDAY_DEEPSEEK_API_KEY is absent", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_DEEPSEEK: "1",
      DEEPSEEK_API_KEY: "deepseek-legacy-key", // pragma: allowlist secret
    });
    expect(status.gated).toBe(true);
    expect(status.credentialEnvRef).toBe("$DEEPSEEK_API_KEY");
  });

  it("rejects the DeepSeek lane when no DeepSeek key is present", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_DEEPSEEK: "1",
    });
    expect(status.gated).toBe(false);
    expect(status.blockers).toContain("missing_key:deepseek");
  });

  it("accepts the OpenAI lane with OPENAI_API_KEY", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_OPENAI: "1",
      OPENAI_API_KEY: "openai-test-key", // pragma: allowlist secret
    });
    expect(status.gated).toBe(true);
    expect(status.selectedProvider).toBe("openai");
    expect(status.providerAuthLane).toBe("api_key");
    expect(status.credentialEnvRef).toBe("$OPENAI_API_KEY");
    expect(status.blockers).toEqual([]);
  });

  it("rejects the OpenAI lane when no OpenAI key is present", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_OPENAI: "1",
    });
    expect(status.gated).toBe(false);
    expect(status.blockers).toContain("missing_key:openai");
  });

  it("accepts the Ollama lane without any key (none auth lane)", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_OLLAMA: "1",
    });
    expect(status.gated).toBe(true);
    expect(status.selectedProvider).toBe("ollama");
    expect(status.providerAuthLane).toBe("none");
    expect(status.credentialEnvRef).toBeNull();
    expect(status.blockers).toEqual([]);
  });

  // ── assertFridayDeepProofSingleProviderLane behavior ───────────────────

  it("assertFridayDeepProofSingleProviderLane returns the active lane selection on a valid env", () => {
    const lane = assertFridayDeepProofSingleProviderLane({
      FRIDAY_E2E_LIVE_DEEPSEEK: "1",
      FRIDAY_DEEPSEEK_API_KEY: "deepseek-test-key", // pragma: allowlist secret
    });
    expect(lane.selectedProvider).toBe("deepseek");
    expect(lane.providerAuthLane).toBe("bearer_token");
    expect(lane.credentialEnvRef).toBe("$FRIDAY_DEEPSEEK_API_KEY");
  });

  it("assertFridayDeepProofSingleProviderLane throws an actionable error when no lane is set", () => {
    expect(() => assertFridayDeepProofSingleProviderLane({})).toThrowError(
      /Single-provider lane required/i,
    );
  });

  it("assertFridayDeepProofSingleProviderLane throws when multiple lanes are set", () => {
    expect(() =>
      assertFridayDeepProofSingleProviderLane({
        FRIDAY_E2E_LIVE_ANTHROPIC: "1",
        FRIDAY_E2E_LIVE_OPENAI: "1",
        FRIDAY_ANTHROPIC_API_KEY: "anthropic-test-key", // pragma: allowlist secret
        OPENAI_API_KEY: "openai-test-key", // pragma: allowlist secret
      }),
    ).toThrowError(/exactly one provider lane is required/i);
  });

  it("assertFridayDeepProofSingleProviderLane throws when the selected provider is missing its key", () => {
    expect(() =>
      assertFridayDeepProofSingleProviderLane({
        FRIDAY_E2E_LIVE_DEEPSEEK: "1",
      }),
    ).toThrowError(/DeepSeek/);
  });

  // ── Adjacent invariants preserved from prior contract ──────────────────

  it("keeps the canonical real-browser helper free of mock bootstrap shortcuts", () => {
    const source = fs.readFileSync(
      repoPath("test/e2e/ui/_helpers/browser-env.ts"),
      "utf8",
    );

    expect(source).not.toContain("createMockHubEnv");
    expect(source).not.toContain("localStorage.setItem");
    expect(source).not.toContain("/v1/setup/complete");
  });

  it("keeps the deep-proof helper free of mock-hub bootstrap shortcuts and legacy E2E_LIVE acceptance", () => {
    const source = fs.readFileSync(
      repoPath("test/e2e/live/_helpers/deep-proof-env.ts"),
      "utf8",
    );

    // Mock bootstrap markers must never appear in the deep-proof helper.
    expect(source).not.toContain("createMockHubEnv");
    expect(source).not.toContain("localStorage.setItem");
    // Legacy E2E_LIVE remains a blocker, never an accepted lane.
    expect(source).toContain("legacy_live_lane_enabled");
  });
});
