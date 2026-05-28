import { describe, expect, it } from "vitest";

import { runRealWorldValidation } from "../../../validation/real-world/lib/runner.mjs";

const BASE_SCENARIO = {
  layer: "L3",
  productArea: "assistant behavior",
  entrySurface: "/v1/agent/runs",
  routeFamily: "cost control",
  riskTier: "low",
  suites: ["smoke"],
  expectedEvidence: ["selected by catalog-only validation"],
  realWorldPrompt: "Reply OK.",
  execution: {
    kind: "agent_run",
  },
};

describe("real-world runner filtering", () => {
  it("can exclude live-provider scenarios for RGG economy mode without dropping non-provider coverage", async () => {
    const result = await runRealWorldValidation({
      suite: "smoke",
      catalogOnly: true,
      excludeProviderScenarios: true,
      catalog: [
        {
          ...BASE_SCENARIO,
          id: "provider-backed",
          providerLane: "default_only",
        },
        {
          ...BASE_SCENARIO,
          id: "non-provider",
          providerLane: "none",
        },
      ],
    });

    expect(result.scenarioCount).toBe(1);
  });
});
