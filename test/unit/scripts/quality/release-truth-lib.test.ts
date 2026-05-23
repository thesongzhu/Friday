import { describe, expect, it } from "vitest";

import {
  classifyEvidenceTarget,
  classifyReleaseProofEnvironment,
} from "../../../../scripts/quality/release-truth-lib.mjs";

describe("release truth evidence classification", () => {
  it("marks env-gated live tests as not_configured when required env is absent", () => {
    const result = classifyEvidenceTarget({
      filePath: "test/e2e/live/friday-discord-channel-live.e2e.test.ts",
      content: "describe.skipIf(!FRIDAY_LIVE_DISCORD || !DISCORD_GUILD_ID)('live discord', () => {})",
    });

    expect(result.evidenceKind).toBe("cloud-live");
    expect(result.releaseProofEligible).toBe(true);
    expect(result.releaseProofEnvironment).toBe("not_configured");
    expect(result.missingEnv).toEqual(["DISCORD_GUILD_ID", "FRIDAY_LIVE_DISCORD"]);
  });

  it("marks required proof env configured only when all required names are present", () => {
    const configured = classifyReleaseProofEnvironment(
      ["FRIDAY_BASE_URL", "FRIDAY_AUTH_TOKEN"],
      {
        FRIDAY_BASE_URL: "http://127.0.0.1:3141",
        FRIDAY_AUTH_TOKEN: "redacted-token-marker",
      },
    );
    expect(configured).toEqual({ status: "configured", missingEnv: [] });

    const notConfigured = classifyReleaseProofEnvironment(
      ["FRIDAY_BASE_URL", "FRIDAY_AUTH_TOKEN"],
      { FRIDAY_BASE_URL: "http://127.0.0.1:3141" },
    );
    expect(notConfigured).toEqual({
      status: "not_configured",
      missingEnv: ["FRIDAY_AUTH_TOKEN"],
    });
  });
});
