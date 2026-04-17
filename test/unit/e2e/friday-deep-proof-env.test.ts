import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertFridayDeepProofAnthropicLane,
  getFridayDeepProofEnvStatus,
} from "../../e2e/live/_helpers/deep-proof-env.js";

function repoPath(...segments: string[]): string {
  return path.resolve(process.cwd(), ...segments);
}

describe("friday deep proof env", () => {
  it("accepts the Anthropic API-key lane when no legacy or supplemental lanes are enabled", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      FRIDAY_ANTHROPIC_API_KEY: "test-key",
    });

    expect(status.gated).toBe(true);
    expect(status.providerAuthLane).toBe("api_key");
    expect(status.credentialEnvRef).toBe("$FRIDAY_ANTHROPIC_API_KEY");
    expect(status.blockers).toEqual([]);
  });

  it("uses the legacy ANTHROPIC_API_KEY alias when the canonical env var is absent", () => {
    const envRef = assertFridayDeepProofAnthropicLane({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      ANTHROPIC_API_KEY: "legacy-key",
    });

    expect(envRef).toBe("$ANTHROPIC_API_KEY");
  });

  it("blocks deep proof runs when the legacy live lane is enabled", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      FRIDAY_ANTHROPIC_API_KEY: "test-key",
      E2E_LIVE: "1",
    });

    expect(status.gated).toBe(false);
    expect(status.blockers).toContain("legacy_live_lane_enabled");
  });

  it("blocks deep proof runs when OpenAI or Ollama supplemental lanes are enabled", () => {
    const status = getFridayDeepProofEnvStatus({
      FRIDAY_E2E_LIVE_ANTHROPIC: "1",
      FRIDAY_ANTHROPIC_API_KEY: "test-key",
      FRIDAY_E2E_LIVE_OPENAI: "1",
    });

    expect(status.gated).toBe(false);
    expect(status.blockers).toContain("supplemental_provider_lane_enabled");
  });

  it("rejects missing Anthropic-only configuration with an actionable error", () => {
    expect(() => assertFridayDeepProofAnthropicLane({})).toThrowError(
      /Anthropic-only lane required/i,
    );
  });

  it("keeps the canonical real-browser helper free of mock bootstrap shortcuts", () => {
    const source = fs.readFileSync(
      repoPath("test/e2e/ui/_helpers/browser-env.ts"),
      "utf8",
    );

    expect(source).not.toContain("createMockHubEnv");
    expect(source).not.toContain("localStorage.setItem");
    expect(source).not.toContain("/v1/setup/complete");
  });

  it("keeps the deep-proof helper free of legacy provider routing globals", () => {
    const source = fs.readFileSync(
      repoPath("test/e2e/live/_helpers/deep-proof-env.ts"),
      "utf8",
    );

    expect(source).not.toContain("LIVE_PROVIDER_KIND");
    expect(source).not.toContain("FRIDAY_E2E_LIVE_OPENAI ===");
    expect(source).not.toContain("FRIDAY_E2E_LIVE_OLLAMA ===");
  });
});
