import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("setup provider regressions", () => {
  it("does not show the old MBTI communication step during setup", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    expect(setupSource).not.toContain("选择沟通风格");
    expect(setupSource).not.toContain("Choose Communication Style");
    expect(setupSource).not.toContain("COMMUNICATION_MBTI_OPTIONS");
    expect(setupSource).not.toContain("saveCommunicationMutation");
    expect(setupSource).toContain("type SetupStep = 0 | 1 | 2 | 3 | 4 | 5");
    expect(setupSource).toContain("StepDots current={currentStep} total={6}");
  });

  it("saves the detected provider kind instead of overwriting the first existing provider", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    expect(setupSource).toContain("buildProviderSaveDraftFromDetection");
    expect(setupSource).toContain("existingProviders.find((provider) => provider.kind === draft.kind)");
    expect(setupSource).toContain("saveProviderMutation.mutate(\n          buildProviderSaveDraftFromDetection(result)");
    expect(setupSource).not.toContain("const existing = existingProviders[0]");
  });

  it("keeps provider truth copy clear that it is live routing, not setup echo", () => {
    const providerTruthSource = readFileSync("ui/src/components/console/shell/provider-truth.tsx", "utf8");
    const providerTruthHookSource = readFileSync("ui/src/hooks/use-provider-truth.ts", "utf8");

    expect(providerTruthSource).toContain("当前实际路由");
    expect(providerTruthSource).toContain("这不是 setup 输入回显");
    expect(providerTruthSource).toContain("Setup / 默认配置");
    expect(providerTruthHookSource).toContain("OpenAI Provider");
    expect(providerTruthHookSource).toContain("moonshot|kimi|月之暗面");
  });
});
