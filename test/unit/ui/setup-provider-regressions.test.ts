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

    // The setup save now routes through the shared confirmed save+routing helper
    // (SEC-APPROVAL-AUTHORITY-001 / CR-2 finding #3), resolving an existing provider
    // by kind (not overwriting the first). Same axis as before (the helper is called
    // with `providersApi` and the same-KIND lookup, in that order) but tolerant of
    // argument wrapping: create + routing are now ONE owner-reviewed operation.
    expect(setupSource).toMatch(/saveProviderWithRouting\(\s*providersApi,\s*existingSameKind,/);
    expect(setupSource).toContain("existingProviders.find((provider) => provider.kind === draft.kind)");
    expect(setupSource).toContain("saveProviderMutation.mutate(buildCurrentProviderSaveDraft()");
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
    // B0.5: native Lark WS client replaces @larksuiteoapi/node-sdk so the
    // public install no longer pulls the SDK's vulnerable axios chain.
    expect(larkSource).not.toContain("@larksuiteoapi/node-sdk");
    expect(larkSource).toContain("new LarkWsClient");
    expect(larkSource).toContain("./internal/lark-ws-client");
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
    expect(hubSource).toContain("evaluateFridayChannelApprovalExpiry");
    expect(hubSource).toContain("approval_expired");
    expect(hubSource).toContain("toolApprovalCommand: true");
    expect(hubSource).toContain("回复「批准");
  });

  it("refreshes stored sessions without reviving local no-password login", () => {
    const apiClientSource = readFileSync("ui/src/lib/api/client.ts", "utf8");
    const authProviderSource = readFileSync("ui/src/providers/auth-provider.tsx", "utf8");
    const authApiSource = readFileSync("ui/src/lib/api/auth.ts", "utf8");

    expect(authApiSource).toContain("\"/v1/auth/me\"");
    expect(authProviderSource).toContain("authStorage.getAccessToken()");
    expect(authProviderSource).toContain("const me = await fetchMe()");
    expect(apiClientSource).not.toContain("JSON.stringify({ local:");
    expect(apiClientSource).not.toContain("local: true");
    expect(apiClientSource).toContain("res.status === 401 && retry && canRefreshSession(path)");
    expect(apiClientSource).toContain("return apiFetch<T>(path, init, false)");
  });

  it("keeps provider truth copy clear that it is live routing, not setup echo", () => {
    const providerTruthSource = readFileSync("ui/src/components/console/shell/provider-truth.tsx", "utf8");
    const providerTruthHookSource = readFileSync("ui/src/hooks/use-provider-truth.ts", "utf8");

    expect(providerTruthSource).toContain("当前实际路由");
    expect(providerTruthSource).toContain("这不是 setup 输入回显");
    expect(providerTruthSource).toContain("Setup / 默认配置");
    expect(providerTruthSource).toContain("Connect provider route");
    expect(providerTruthSource).toContain("Choose model");
    expect(providerTruthSource).not.toContain("Current route unavailable");
    expect(providerTruthSource).not.toContain("Live provider truth is unavailable");
    expect(providerTruthSource).not.toContain("No live route");
    expect(providerTruthHookSource).toContain("OpenAI Provider");
    expect(providerTruthHookSource).toContain("moonshot|kimi|月之暗面");
  });

  it("does not advertise Anthropic OAuth or setup-token onboarding in the setup recommendation", () => {
    const setupSource = readFileSync("ui/src/routes/setup-page.tsx", "utf8");

    expect(setupSource).toContain('case "anthropic"');
    expect(setupSource).toContain('auth: "API key"');
    expect(setupSource).not.toContain('auth: "API key, token/setup-token, or OAuth"');
    expect(setupSource).not.toContain("Anthropic OAuth");
    expect(setupSource).not.toContain("Anthropic setup-token");
  });

  it("keeps mission workbench empty state user-facing instead of engineering-unavailable copy", () => {
    const missionWorkbenchSource = readFileSync("ui/src/routes/mission-workbench-page.tsx", "utf8");

    expect(missionWorkbenchSource).toContain("Connect the live mission projection");
    expect(missionWorkbenchSource).toContain("placeholder work or fabricated evidence");
    expect(missionWorkbenchSource).not.toContain("Hub projection unavailable");
    expect(missionWorkbenchSource).not.toContain("Live Rust Hub projection is unavailable");
  });
});
