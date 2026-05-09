import { describe, expect, it } from "vitest";
import { listFridayProviderTemplates } from "#providers";
import { AVAILABLE_COMMANDS } from "../../../ui/src/components/core/command-palette";
import {
  SETUP_CHANNEL_KINDS_ORDERED,
  buildSetupCompletionStepState,
  getProviderBootstrapRecommendation,
  getSetupProviderKindsForRegion,
} from "../../../ui/src/routes/setup-page";

describe("ui truth regressions", () => {
  it("keeps operator console discoverable in the command palette", () => {
    expect(AVAILABLE_COMMANDS.some((item) => item.path === "/command-center")).toBe(true);
  });

  it("keeps Google setup copy on the HTTP path instead of promising Gemini CLI", () => {
    const recommendation = getProviderBootstrapRecommendation("google");

    expect(recommendation.backend).toBe("HTTP only");
    expect(recommendation.boundary).not.toContain("Gemini CLI");
    expect(recommendation.operatorNote).not.toContain("Gemini CLI");
  });

  it("only shows setup provider choices that have a first-run closed-loop path", () => {
    const templates = listFridayProviderTemplates();

    expect(getSetupProviderKindsForRegion(templates, "international")).toEqual([
      "openai",
      "openai-codex",
      "anthropic",
      "openrouter",
      "xai",
      "mistral",
      "groq",
    ]);
    expect(getSetupProviderKindsForRegion(templates, "china")).toEqual([
      "deepseek",
      "moonshot",
      "qwen",
      "kimi-coding",
    ]);
  });

  it("keeps setup channels limited to verified first-run control routes", () => {
    expect(SETUP_CHANNEL_KINDS_ORDERED).toEqual(["telegram", "discord", "feishu"]);
  });

  it("records only promoted skills as completed setup work", () => {
    expect(buildSetupCompletionStepState({
      providerValidated: true,
      channelsSaved: true,
      skillsPromoted: true,
    })).toEqual({
      completedSteps: ["welcome", "security", "provider", "channels", "skills", "done"],
      skippedSteps: ["communication", "network"],
    });

    expect(buildSetupCompletionStepState({
      providerValidated: false,
      channelsSaved: false,
      skillsPromoted: false,
    })).toEqual({
      completedSteps: ["welcome", "security", "done"],
      skippedSteps: ["communication", "provider", "channels", "network", "skills"],
    });
  });
});
