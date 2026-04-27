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
    expect(setupSource).toContain("saveProviderMutation.mutate(");
    expect(setupSource).toContain("buildProviderSaveDraftFromDetection(result)");
    expect(setupSource).not.toContain("const existing = existingProviders[0]");
  });

  it("validates the selected setup provider instead of switching OpenAI-compatible key prefixes", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    expect(setupSource).toContain("kind: providerKind");
    expect(setupSource).toContain("will not switch to another provider automatically");
    expect(setupSource).toContain("验证并保存");
    expect(setupSource).not.toContain("kind: hasKey ? undefined : providerKind");
    expect(setupSource).not.toContain("自动识别并保存");
    expect(setupSource).not.toContain("Detect & Continue");
  });

  it("does not surface disabled program discovery as a setup error", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    expect(setupSource).toContain("discoveryApi.getStatus()");
    expect(setupSource).toContain("!status.enabled");
    expect(setupSource).toContain("isDiscoveryDisabledError");
    expect(setupSource).not.toContain("Program discovery is disabled. Enable FRIDAY_DISCOVERY_ENABLED=true");
  });

  it("makes setup channel saves activate the live channel runtime", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");
    const setupRoutesSource = readFileSync("src/api/http/routes/friday-setup-routes.ts", "utf8");
    const hubSource = readFileSync("src/hub/friday-hub-bootstrap.ts", "utf8");
    const larkSource = readFileSync("src/channels/lark/friday-lark-channel.ts", "utf8");

    expect(setupSource).toContain("保存并启动");
    expect(setupSource).toContain("activation?.failed.length");
    expect(setupRoutesSource).toContain("activateSavedChannels");
    expect(hubSource).toContain("activateSavedChannelsFromSetupState");
    expect(hubSource).toContain("liveChannelMessageHandler");
    expect(hubSource).toContain("channelRegistry.startAllBestEffort(liveChannelMessageHandler)");
    expect(larkSource).toContain("@larksuiteoapi/node-sdk");
    expect(larkSource).toContain("new Lark.WSClient");
    expect(larkSource).toContain("im.message.receive_v1");
    expect(larkSource).not.toContain("/open-apis/callback/ws/endpoint");
  });

  it("routes channel tool approvals back through the same chat session", () => {
    const hubSource = readFileSync("src/hub/friday-hub-bootstrap.ts", "utf8");
    const channelEntrySource = readFileSync("src/engine/adapters/friday-channel-entry-adapter.ts", "utf8");
    const hubHelpersSource = readFileSync("src/hub/bootstrap/hub-helpers.ts", "utf8");

    expect(channelEntrySource).toContain("FRIDAY_CHANNEL_CONTROL_ROUTE = \"full_agent\"");
    expect(channelEntrySource).toContain("channelControlRoute: FRIDAY_CHANNEL_CONTROL_ROUTE");
    expect(channelEntrySource).toContain("engine.executeRun(input)");
    expect(hubHelpersSource).toContain("resolveFridayChannelDisabledToolNames");
    expect(hubHelpersSource).toContain("return [];");
    expect(hubSource).toContain("channelApprovalRoutesBySession");
    expect(hubSource).toContain("channelToolApprovalSessions");
    expect(hubSource).toContain("parseChannelToolApprovalCommand");
    expect(hubSource).toContain("notifyChannelToolApprovalRequest(prompt)");
    expect(hubSource).toContain("resolveToolApproval(");
    expect(hubSource).toContain("toolApprovalCommand: true");
    expect(hubSource).toContain("回复「批准");
  });

  it("recovers setup API calls with the local session instead of surfacing login errors", () => {
    const apiClientSource = readFileSync("ui/src/lib/api/client.ts", "utf8");

    expect(apiClientSource).toContain("establishLocalSession");
    expect(apiClientSource).toContain("establishLocalIdentity");
    expect(apiClientSource).toContain("\"/v1/auth/me\"");
    expect(apiClientSource).toContain("JSON.stringify({ local: true })");
    expect(apiClientSource).toContain("res.status === 401 && retry && canRecoverWithLocalSession(path)");
    expect(apiClientSource).toContain("return apiFetch<T>(path, init, false)");
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
