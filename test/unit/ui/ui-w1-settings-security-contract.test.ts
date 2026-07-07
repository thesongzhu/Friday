import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "../../../ui/src/routes/settings-page";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  assistantDiagnosticsGet: vi.fn(),
  channelsList: vi.fn(),
  healthGetCapabilityHealth: vi.fn(),
  healthGetMe: vi.fn(),
  learningGetOverview: vi.fn(),
  providerUsageGetBudget: vi.fn(),
  providersExplainRouting: vi.fn(),
  providersGetRouting: vi.fn(),
  providersList: vi.fn(),
  providersListCapabilityHealth: vi.fn(),
  providersListHealth: vi.fn(),
  providersListTemplates: vi.fn(),
  revokeSatellite: vi.fn(),
  revokeToken: vi.fn(),
  systemGetAgentLoopExpertMode: vi.fn(),
  systemGetAgentLoopPolicy: vi.fn(),
  systemGetCommunicationPersona: vi.fn(),
  systemGetCurrentState: vi.fn(),
  systemGetSession: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  uixSetPreference: vi.fn(),
}));

vi.mock("@/providers/locale-provider", () => ({
  useAppLocale: () => ({ locale: "en" }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: mocks.apiGet,
    patch: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock("@/lib/api/assistant-diagnostics", () => ({
  assistantDiagnosticsApi: {
    get: mocks.assistantDiagnosticsGet,
  },
}));

vi.mock("@/lib/api/channels", () => ({
  channelsApi: {
    list: mocks.channelsList,
  },
}));

vi.mock("@/lib/api/health", () => ({
  healthApi: {
    getCapabilityHealth: mocks.healthGetCapabilityHealth,
    getMe: mocks.healthGetMe,
  },
}));

vi.mock("@/lib/api/learning", () => ({
  learningApi: {
    demotePattern: vi.fn(),
    getOverview: mocks.learningGetOverview,
    setLessonEnabled: vi.fn(),
  },
}));

vi.mock("@/lib/api/provider-usage", () => ({
  providerUsageApi: {
    getBudget: mocks.providerUsageGetBudget,
  },
}));

vi.mock("@/lib/api/providers", () => ({
  providersApi: {
    clearRoutePenalty: vi.fn(),
    create: vi.fn(),
    explainRouting: mocks.providersExplainRouting,
    getRouting: mocks.providersGetRouting,
    initiateOpenAICodexDeviceOAuth: vi.fn(),
    completeOpenAICodexDeviceOAuth: vi.fn(),
    list: mocks.providersList,
    listCapabilityHealth: mocks.providersListCapabilityHealth,
    listHealth: mocks.providersListHealth,
    listTemplates: mocks.providersListTemplates,
    pinRoute: vi.fn(),
    runCapabilityDoctor: vi.fn(),
    setRouting: vi.fn(),
    update: vi.fn(),
    validate: vi.fn(),
  },
}));

vi.mock("@/lib/api/security", () => ({
  securityApi: {
    getCenter: vi.fn(async () => ({
      generatedAt: "2026-07-06T20:00:00.000Z",
      tokens: {
        active: 2,
        expired: 0,
        revoked24h: 0,
        highPrivilegeActive: 1,
      },
      satellites: {
        restricted: 1,
        trusted: 0,
        revoked: 0,
        pendingPairings: 0,
      },
      findings: [
        {
          id: "finding-token",
          severity: "high",
          type: "token_scope_risk",
          message: "High privilege token should be revoked.",
          tokenId: "  token-high-1  ",
          detectedAt: "2026-07-06T20:00:00.000Z",
        },
        {
          id: "finding-satellite",
          severity: "medium",
          type: "revocation_gap",
          message: "Satellite should be revoked.",
          satelliteId: "  satellite-risk-1  ",
          detectedAt: "2026-07-06T20:00:00.000Z",
        },
      ],
    })),
    revokeSatellite: mocks.revokeSatellite,
    revokeToken: mocks.revokeToken,
  },
}));

vi.mock("@/lib/api/system", () => ({
  systemApi: {
    executeIntent: vi.fn(),
    getAgentLoopExpertMode: mocks.systemGetAgentLoopExpertMode,
    getAgentLoopPolicy: mocks.systemGetAgentLoopPolicy,
    getCommunicationPersona: mocks.systemGetCommunicationPersona,
    getCurrentState: mocks.systemGetCurrentState,
    getSession: mocks.systemGetSession,
    updateAgentLoopExpertMode: vi.fn(),
    updateAgentLoopPolicy: vi.fn(),
    updateCommunicationPreferences: vi.fn(),
  },
}));

vi.mock("@/hooks/use-uix-preferences", () => ({
  useUixPreferences: () => ({
    values: {},
    setPreference: mocks.uixSetPreference,
    isLoading: false,
  }),
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushCycles(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await flush();
  }
}

async function waitFor<T>(factory: () => T, predicate: (value: T) => boolean, attempts = 20): Promise<T> {
  for (let index = 0; index < attempts; index += 1) {
    const value = factory();
    if (predicate(value)) return value;
    await act(async () => {
      await flushCycles();
    });
  }
  return factory();
}

function defineGlobal<K extends keyof typeof globalThis>(key: K, value: (typeof globalThis)[K]): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

describe("UI-W1 Settings Security screen contract", () => {
  const read = (path: string) => readFileSync(path, "utf8");
  let container: HTMLElement | null = null;
  let root: Root | null = null;
  let queryClient: QueryClient;
  let previousWindow: typeof globalThis.window | undefined;
  let previousDocument: typeof globalThis.document | undefined;
  let previousNavigator: typeof globalThis.navigator | undefined;
  let previousHTMLElement: typeof globalThis.HTMLElement | undefined;
  let previousSVGElement: typeof globalThis.SVGElement | undefined;
  let previousNode: typeof globalThis.Node | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousSVGElement = globalThis.SVGElement;
    previousNode = globalThis.Node;

    const { window } = parseHTML("<html><body><div id=\"root\"></div></body></html>");
    defineGlobal("window", window as unknown as typeof globalThis.window);
    defineGlobal("document", window.document as unknown as typeof globalThis.document);
    defineGlobal("navigator", window.navigator as unknown as typeof globalThis.navigator);
    defineGlobal("HTMLElement", window.HTMLElement as unknown as typeof globalThis.HTMLElement);
    defineGlobal("SVGElement", window.SVGElement as unknown as typeof globalThis.SVGElement);
    defineGlobal("Node", window.Node as unknown as typeof globalThis.Node);

    mocks.apiGet.mockImplementation(async (path: string) => {
      if (path === "/v1/uix/learned-facts") return { items: [] };
      if (path === "/v1/guide-lens/state") return null;
      return null;
    });
    mocks.assistantDiagnosticsGet.mockResolvedValue({ mcpServerStates: [] });
    mocks.channelsList.mockResolvedValue([]);
    mocks.healthGetCapabilityHealth.mockResolvedValue({
      status: "healthy",
      uptime: 12,
      capabilities: {
        system: { enabled: true, remoteMode: "local" },
        plugins: { runtimeMode: "full" },
        channels: { enabledKinds: [] },
        search: { latestness: "provider_backed" },
      },
    });
    mocks.healthGetMe.mockResolvedValue({
      user: { displayName: "Operator", role: "owner" },
      scopes: ["settings:read"],
    });
    mocks.learningGetOverview.mockResolvedValue({
      coverage: {
        lessons: 0,
        patterns: 0,
        routeAdjustments: 0,
        blockedRoutes: 0,
      },
      lessons: [],
      patterns: [],
    });
    mocks.providerUsageGetBudget.mockResolvedValue({
      month: "2026-07",
      config: null,
      spentUsd: 0,
      remainingUsd: null,
      state: "ok",
    });
    mocks.providersExplainRouting.mockResolvedValue(undefined);
    mocks.providersGetRouting.mockResolvedValue(null);
    mocks.providersList.mockResolvedValue([]);
    mocks.providersListCapabilityHealth.mockResolvedValue([]);
    mocks.providersListHealth.mockResolvedValue([]);
    mocks.providersListTemplates.mockResolvedValue([]);
    mocks.revokeSatellite.mockResolvedValue({ revoked: true, satelliteId: "satellite-risk-1" });
    mocks.revokeToken.mockResolvedValue({ revoked: true, tokenId: "token-high-1" });
    mocks.systemGetAgentLoopExpertMode.mockResolvedValue(null);
    mocks.systemGetAgentLoopPolicy.mockResolvedValue({
      maxAttemptsPerFingerprint: 3,
      cooldownMinutes: 10,
      paused: false,
      autoApplyLowRisk: false,
      requireRollbackPlan: true,
      requireAcceptanceCheck: true,
    });
    mocks.systemGetCommunicationPersona.mockResolvedValue(null);
    mocks.systemGetCurrentState.mockResolvedValue({
      capturedAt: "2026-07-06T20:00:00.000Z",
      frontmostAppId: "com.apple.finder",
      frontmostWindowId: "window-1",
      controlLease: null,
      health: {
        status: "healthy",
        updatedAt: "2026-07-06T20:00:00.000Z",
      },
      permissions: [],
    });
    mocks.systemGetSession.mockResolvedValue({
      workspaceRoot: "/tmp/friday",
      cloudPlanningMode: "local",
      startedAt: "2026-07-06T20:00:00.000Z",
      companion: {
        platform: "darwin",
        runtimeKind: "native",
        transport: {
          mode: "local",
          protocol: "http",
        },
      },
      health: {
        status: "healthy",
        reasons: [],
      },
    });

    container = window.document.getElementById("root") as HTMLElement;
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
        await flushCycles();
      });
    }
    defineGlobal("window", previousWindow as typeof globalThis.window);
    defineGlobal("document", previousDocument as typeof globalThis.document);
    defineGlobal("navigator", previousNavigator as typeof globalThis.navigator);
    defineGlobal("HTMLElement", previousHTMLElement as typeof globalThis.HTMLElement);
    defineGlobal("SVGElement", previousSVGElement as typeof globalThis.SVGElement);
    defineGlobal("Node", previousNode as typeof globalThis.Node);
  });

  async function renderSettingsPage(): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/settings"] },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(SettingsPage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  it("keeps Settings Security on the authenticated desktop settings route", () => {
    const routerSource = read("ui/src/router.tsx");
    const settingsSource = read("ui/src/routes/settings-page.tsx");

    expect(routerSource).toContain('path: "settings"');
    expect(routerSource).toContain("<SettingsPage />");
    expect(settingsSource).toContain("Settings Security");
  });

  it("renders the security workbench from existing provider, system, and security APIs", () => {
    const source = read("ui/src/routes/settings-page.tsx");

    expect(source).toContain('data-ui-screen="desktop-settings-security"');
    expect(source).toContain('data-ui-component="settings-security-header"');
    expect(source).toContain('data-ui-component="settings-security-provider-auth"');
    expect(source).toContain('data-ui-component="settings-security-permissions"');
    expect(source).toContain('data-ui-component="settings-security-command-center"');
    expect(source).toContain('data-ui-component="settings-security-runtime-guards"');
    expect(source).toContain("providersApi.list()");
    expect(source).toContain("systemApi.getCurrentState");
    expect(source).toContain("securityApi.getCenter");
  });

  it("keeps security actions wired while labeling operator-gated boundaries as not completed by UI", () => {
    const source = read("ui/src/routes/settings-page.tsx");
    const securityApiSource = read("ui/src/lib/api/security.ts");

    expect(securityApiSource).toContain("revokeToken");
    expect(securityApiSource).toContain("revokeSatellite");
    expect(source).toContain("securityApi.revokeToken");
    expect(source).toContain("securityApi.revokeSatellite");
    expect(source).toContain('data-ui-component="settings-security-token-revoke"');
    expect(source).toContain('data-ui-component="settings-security-satellite-revoke"');
    expect(source).toContain('data-ui-component="settings-security-operator-boundary"');
    expect(source).toContain("settings security != operator SIGN");
    expect(source).toContain("UI status != prod deploy");
    expect(source).toContain("NO-GO");
  });

  it("renders revoke controls as confirmed actions and calls security APIs with trimmed ids", async () => {
    await renderSettingsPage();

    const tokenButton = await waitFor(
      () => container?.querySelector<HTMLButtonElement>("[data-ui-component=\"settings-security-token-revoke\"]") ?? null,
      (button) => button !== null,
    );
    expect(tokenButton).not.toBeNull();

    await act(async () => {
      tokenButton!.click();
      await flushCycles();
    });

    expect(mocks.revokeToken).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Confirm revoke token");

    const confirmToken = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Revoke token"));
    expect(confirmToken).not.toBeUndefined();

    await act(async () => {
      confirmToken!.click();
      await flushCycles();
    });

    expect(mocks.revokeToken).toHaveBeenCalledWith("token-high-1");

    const satelliteButton = await waitFor(
      () => container?.querySelector<HTMLButtonElement>("[data-ui-component=\"settings-security-satellite-revoke\"]") ?? null,
      (button) => button !== null,
    );
    expect(satelliteButton).not.toBeNull();

    await act(async () => {
      satelliteButton!.click();
      await flushCycles();
    });

    expect(mocks.revokeSatellite).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Confirm revoke satellite");

    const confirmSatellite = Array.from(container!.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Revoke satellite"));
    expect(confirmSatellite).not.toBeUndefined();

    await act(async () => {
      confirmSatellite!.click();
      await flushCycles();
    });

    expect(mocks.revokeSatellite).toHaveBeenCalledWith("satellite-risk-1", "Revoked from Settings Security");
  });
});
