import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HomePage } from "../../../ui/src/routes/home-page";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  providerRefetch: vi.fn(),
  healthRefetch: vi.fn(),
  getHome: vi.fn(),
  getOverview: vi.fn(),
  runReadyAutoFixActions: vi.fn(),
  listAutomations: vi.fn(),
  getCapabilityHealth: vi.fn(),
}));

vi.mock("@/components/console/shell/provider-truth", () => ({
  ProviderTruthCard: () => null,
  ProviderTruthCompact: () => null,
}));

vi.mock("@/components/packs/pack-card", () => ({
  PackCard: () => null,
}));

vi.mock("@/components/packs/pack-quick-sheet", () => ({
  PackQuickSheet: () => null,
}));

vi.mock("@/components/setup/friday-readiness-summary", () => ({
  FRIDAY_SETUP_READINESS_SESSION_KEY: "friday.setup.readiness",
  FridayReadinessSummaryPanel: () => null,
}));

vi.mock("@/hooks/use-adaptive-polling", () => ({
  useAdaptivePollingInterval: () => false,
}));

vi.mock("@/hooks/use-app-navigate", () => ({
  useAppNavigate: () => mocks.navigate,
}));

vi.mock("@/hooks/use-custom-packs", () => ({
  useCustomPacks: () => ({ customPackInputs: [] }),
}));

vi.mock("@/hooks/use-home-surface-preferences", () => ({
  useHomeSurfacePreferences: () => ({
    pinnedPackIds: [],
    pinPack: vi.fn(),
    unpinPack: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-pack-launch-actions", () => ({
  usePackLaunchActions: () => ({
    startPackNow: vi.fn(),
    adjustPackBeforeStart: vi.fn(),
    continuePack: vi.fn(),
    openCurrentPackRun: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-provider-truth", () => ({
  useProviderTruthQuery: () => ({
    data: undefined,
    isPending: false,
    refetch: mocks.providerRefetch,
  }),
}));

vi.mock("@/hooks/use-system-health", () => ({
  useSystemHealthQuery: () => ({
    data: { status: "degraded" },
    refetch: mocks.healthRefetch,
  }),
}));

vi.mock("@/hooks/use-user-profile", () => ({
  useUserProfile: () => ({ profileType: "solo" }),
}));

vi.mock("@/lib/api/automations", () => ({
  automationsApi: {
    list: mocks.listAutomations,
  },
}));

vi.mock("@/lib/api/health", () => ({
  healthApi: {
    getCapabilityHealth: mocks.getCapabilityHealth,
  },
}));

vi.mock("@/lib/api/learning", () => ({
  learningApi: {
    getOverview: mocks.getOverview,
    runReadyAutoFixActions: mocks.runReadyAutoFixActions,
  },
}));

vi.mock("@/lib/api/uix-snapshots", () => ({
  uixSnapshotsApi: {
    getHome: mocks.getHome,
  },
}));

vi.mock("@/lib/command-palette", () => ({
  requestCommandPaletteOpen: vi.fn(),
}));

vi.mock("@/lib/home/intent-engine", () => ({
  recordPageVisit: vi.fn(),
}));

vi.mock("@/lib/i18n/localized-text", () => ({
  localizedText: (zh: string, en: string) => ({ zh, en }),
  resolveLocalizedText: (text: { zh: string }) => text.zh,
  localize: (_locale: string, zh: string) => zh,
}));

vi.mock("@/providers/locale-provider", () => ({
  useAppLocale: () => ({ locale: "zh" }),
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushCycles(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await flush();
  }
}

function defineGlobal<K extends keyof typeof globalThis>(key: K, value: (typeof globalThis)[K]): void {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

describe("home self-repair", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient;
  let windowRef: Window & typeof globalThis;
  let previousWindow: typeof globalThis.window | undefined;
  let previousDocument: typeof globalThis.document | undefined;
  let previousNavigator: typeof globalThis.navigator | undefined;
  let previousHTMLElement: typeof globalThis.HTMLElement | undefined;
  let previousSVGElement: typeof globalThis.SVGElement | undefined;
  let previousNode: typeof globalThis.Node | undefined;
  let previousMutationObserver: typeof globalThis.MutationObserver | undefined;

  async function renderPage(): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(HomePage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = container?.querySelector<T>(`[data-testid="${testId}"]`);
    expect(element, `Missing test id ${testId}`).not.toBeNull();
    return element!;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    mocks.getHome.mockResolvedValue({
      runs: [],
      pendingApprovals: [],
      scheduledAutomations: [],
    });
    mocks.getOverview.mockResolvedValue({
      lessons: [],
      patterns: [],
      routeAdjustments: [],
      routeBiases: [],
      operatorPins: [],
      penaltyFacts: [],
      recentDecisionDiffs: [],
      blockedRoutes: [],
      rejectedFixes: [],
      recentRejectedFixes: [],
      rollbackHotspots: [],
      coverage: {
        lessons: 0,
        patterns: 0,
        routeAdjustments: 0,
        recentDecisionDiffs: 0,
        blockedRoutes: 0,
        rejectedFixes: 0,
        rollbackHotspots: 0,
        incidents: 0,
        diagnoses: 0,
        autoFixActions: 0,
      },
    });
    mocks.runReadyAutoFixActions.mockResolvedValue({
      summary: {
        inspected: 3,
        executed: 2,
        succeeded: 2,
        failed: 0,
        requiresApproval: 1,
        blockedByPolicy: 0,
        notReady: 0,
        dataProtected: true,
        maxRiskTier: 1,
        limit: 50,
      },
      executed: [],
      skipped: [],
    });
    mocks.listAutomations.mockResolvedValue([]);
    mocks.getCapabilityHealth.mockResolvedValue({});

    const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
    windowRef = window as unknown as Window & typeof globalThis;
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousSVGElement = globalThis.SVGElement;
    previousNode = globalThis.Node;
    previousMutationObserver = globalThis.MutationObserver;

    Object.defineProperty(windowRef, "sessionStorage", {
      configurable: true,
      value: {
        getItem: vi.fn(() => null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    });
    windowRef.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    };
    windowRef.cancelAnimationFrame = vi.fn();

    defineGlobal("window", windowRef);
    defineGlobal("document", windowRef.document);
    defineGlobal("navigator", windowRef.navigator);
    defineGlobal("HTMLElement", windowRef.HTMLElement);
    defineGlobal("SVGElement", windowRef.SVGElement);
    defineGlobal("Node", windowRef.Node);
    defineGlobal("MutationObserver", windowRef.MutationObserver);

    container = windowRef.document.getElementById("root") as HTMLElement;
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
    defineGlobal("MutationObserver", previousMutationObserver as typeof globalThis.MutationObserver);
  });

  it("runs all safe ready self-repair actions from the homepage button", async () => {
    await renderPage();

    await act(async () => {
      getByTestId("home-self-repair").dispatchEvent(new windowRef.Event("click", { bubbles: true }));
      await flushCycles();
    });

    expect(mocks.runReadyAutoFixActions).toHaveBeenCalledWith({ maxRiskTier: 1, limit: 50 });
    expect(getByTestId("home-self-repair-result").textContent).toContain("已完成 2 项自我修复");
    expect(getByTestId("home-self-repair-result").textContent).toContain("用户已有数据不会被清空或重置");
  });
});
