import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AutomationsPage } from "../../../ui/src/routes/automations-page";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
  update: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api/automations", () => ({
  automationsApi: {
    list: mocks.list,
    create: mocks.create,
    run: mocks.run,
    update: mocks.update,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushCycles(count = 6): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await flush();
  }
}

async function waitFor<T>(factory: () => T, predicate: (value: T) => boolean, attempts = 12): Promise<T> {
  for (let index = 0; index < attempts; index += 1) {
    const value = factory();
    if (predicate(value)) {
      return value;
    }
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

describe("automations page", () => {
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

  async function renderPage(path = "/automations"): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: [path], key: path },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(AutomationsPage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    mocks.list.mockResolvedValue([]);
    mocks.create.mockResolvedValue(undefined);
    mocks.run.mockResolvedValue(undefined);
    mocks.update.mockResolvedValue(undefined);

    const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
    windowRef = window as unknown as Window & typeof globalThis;
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousSVGElement = globalThis.SVGElement;
    previousNode = globalThis.Node;
    previousMutationObserver = globalThis.MutationObserver;

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

  function getByTestId<T extends HTMLElement = HTMLElement>(testId: string): T {
    const element = container?.querySelector<T>(`[data-testid="${testId}"]`);
    expect(element, `Missing test id ${testId}`).not.toBeNull();
    return element!;
  }

  it("hydrates the create form from assistant schedule prefill params", async () => {
    await renderPage(
      "/automations?name=Weekly%20Ops%20Summary&task=Prepare%20the%20weekly%20operations%20summary&timezone=America%2FLos_Angeles",
    );

    expect(getByTestId<HTMLInputElement>("automations-name-input").value).toBe("Weekly Ops Summary");
    expect(getByTestId<HTMLTextAreaElement>("automations-task-input").value).toBe(
      "Prepare the weekly operations summary",
    );
    expect(getByTestId<HTMLInputElement>("automations-timezone-input").value).toBe("America/Los_Angeles");
  });

  it("sorts automation cards by leverage score before raw run volume", async () => {
    mocks.list.mockResolvedValue([
      {
        id: "steady-runner",
        name: "Steady Runner",
        taskTemplate: "Steady task",
        enabled: true,
        runCount: 12,
        estimatedTimeSavedMinutes: 15,
        reuseCount: 2,
        promotionState: "private",
        lastOutcomeScore: 90,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
      {
        id: "high-leverage",
        name: "High Leverage",
        taskTemplate: "High leverage task",
        enabled: true,
        runCount: 4,
        estimatedTimeSavedMinutes: 30,
        reuseCount: 1,
        promotionState: "team",
        lastOutcomeScore: 90,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
      {
        id: "busy-but-weaker",
        name: "Busy But Weaker",
        taskTemplate: "Busy task",
        enabled: true,
        runCount: 30,
        estimatedTimeSavedMinutes: 10,
        reuseCount: 5,
        promotionState: "public",
        lastOutcomeScore: 45,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
      },
    ]);

    await renderPage();

    const cards = await waitFor(
      () => Array.from(container?.querySelectorAll<HTMLElement>('[data-testid^="automation-card-"]') ?? []),
      (value) => value.length === 3,
    );
    expect(cards.map((card) => card.dataset.testid)).toEqual([
      "automation-card-high-leverage",
      "automation-card-steady-runner",
      "automation-card-busy-but-weaker",
    ]);
  });
});
