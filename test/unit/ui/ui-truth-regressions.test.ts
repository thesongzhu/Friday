import { describe, expect, it } from "vitest";
import { AVAILABLE_COMMANDS } from "../../../ui/src/components/core/command-palette";
import { getProviderBootstrapRecommendation } from "../../../ui/src/routes/setup-page";

describe("ui truth regressions", () => {
  it("keeps operator console discoverable in the command palette", () => {
    expect(AVAILABLE_COMMANDS.some((item) => item.path === "/command-center")).toBe(true);
  });

  it("keeps hidden marketplace routes out of available command results", () => {
    expect(AVAILABLE_COMMANDS.some((item) => item.path === "/marketplace")).toBe(false);
  });

  it("keeps Google setup copy on the HTTP path instead of promising Gemini CLI", () => {
    const recommendation = getProviderBootstrapRecommendation("google");

    expect(recommendation.backend).toBe("HTTP only");
    expect(recommendation.boundary).not.toContain("Gemini CLI");
    expect(recommendation.operatorNote).not.toContain("Gemini CLI");
  });
});
