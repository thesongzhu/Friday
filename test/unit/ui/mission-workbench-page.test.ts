import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MissionWorkbenchPage } from "../../../ui/src/routes/mission-workbench-page";

const mocks = vi.hoisted(() => ({
  controlRouteDecision: vi.fn(),
  createMissionFromSurface: vi.fn(),
  decideMemoryCandidate: vi.fn(),
  getSnapshot: vi.fn(),
  transitionWorkItemStatus: vi.fn(),
}));

vi.mock("@/providers/locale-provider", () => ({
  useAppLocale: () => ({ locale: "en" }),
}));

vi.mock("@/hooks/use-mission-workbench", () => ({
  useMissionWorkbenchSnapshot: () => ({
    snapshot: SNAPSHOT,
    isLoading: false,
    isLive: true,
    liveUnavailable: false,
  }),
}));

vi.mock("@/lib/api/mission-workbench", () => ({
  missionWorkbenchApi: {
    controlRouteDecision: mocks.controlRouteDecision,
    createMissionFromSurface: mocks.createMissionFromSurface,
    decideMemoryCandidate: mocks.decideMemoryCandidate,
    getSnapshot: mocks.getSnapshot,
    transitionWorkItemStatus: mocks.transitionWorkItemStatus,
  },
}));

const SNAPSHOT = {
  missionId: "mission_ui_spine",
  fridayConversationId: "conversation_ui_spine",
  runtimeFeedStatus: "live_rust_hub_projection",
  statusLabels: [],
  duplicatePreflight: {
    status: "opens_existing_mission",
    duplicateMissionId: "mission_existing",
    duplicateWorkItemId: "work_existing",
  },
  routeDecision: {
    advisorSummary: "Route through Rust Hub.",
    selectedRoute: "codex",
    controlRef: "route-ui-spine",
    workItemId: "work_ui_spine",
    alternatives: ["deepseek"],
    actionItems: [],
    truthLabel: "friday_owned",
  },
  providerReceiptRefs: ["proof://provider/ui"],
  channelReceiptRefs: [],
  workItems: [
    {
      id: "work_ui_spine",
      title: "UI work item",
      state: "ready",
      owner: "friday_owned",
      done: false,
      blockingReason: "waiting for provider proof",
      recoveryKind: "none",
      canRetry: false,
      canCancel: false,
    },
  ],
  timelinePages: [
    {
      page: 1,
      cursor: "cursor-1",
      eventRefs: ["event://ui-spine"],
    },
  ],
  memoryCandidates: [
    {
      id: "memory_ui_candidate",
      preview: "Remember the UI memory candidate.",
      state: "candidate_review_only",
      grantsMemoryAuthority: false,
      evidenceRef: "proof://memory/ui-candidate",
    },
    {
      id: "memory_other_candidate",
      preview: "Keep the unrelated memory candidate clean.",
      state: "candidate_review_only",
      grantsMemoryAuthority: false,
      evidenceRef: "proof://memory/other-candidate",
    },
  ],
  capabilityStates: [],
  transcriptSections: [],
} as const;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushCycles(count = 8): Promise<void> {
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

describe("MissionWorkbenchPage", () => {
  let previousWindow: typeof globalThis.window;
  let previousDocument: typeof globalThis.document;
  let previousNavigator: typeof globalThis.navigator;
  let previousHTMLElement: typeof globalThis.HTMLElement;
  let previousSVGElement: typeof globalThis.SVGElement;
  let previousNode: typeof globalThis.Node;
  let previousEvent: typeof globalThis.Event;
  let previousMouseEvent: typeof globalThis.MouseEvent;
  let container: HTMLElement | null = null;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousSVGElement = globalThis.SVGElement;
    previousNode = globalThis.Node;
    previousEvent = globalThis.Event;
    previousMouseEvent = globalThis.MouseEvent;

    const { window } = parseHTML("<!doctype html><html><body><div id=\"root\"></div></body></html>");
    defineGlobal("window", window as unknown as typeof globalThis.window);
    defineGlobal("document", window.document as unknown as typeof globalThis.document);
    defineGlobal("navigator", window.navigator as unknown as typeof globalThis.navigator);
    defineGlobal("HTMLElement", window.HTMLElement as unknown as typeof globalThis.HTMLElement);
    defineGlobal("SVGElement", window.SVGElement as unknown as typeof globalThis.SVGElement);
    defineGlobal("Node", window.Node as unknown as typeof globalThis.Node);
    defineGlobal("Event", window.Event as unknown as typeof globalThis.Event);
    defineGlobal("MouseEvent", window.MouseEvent as unknown as typeof globalThis.MouseEvent);

    mocks.decideMemoryCandidate.mockReset();
    mocks.decideMemoryCandidate.mockResolvedValue({
      memoryId: "memory_ui_candidate",
      state: "confirmed",
      status: "confirmed",
      recallable: true,
    });
    mocks.controlRouteDecision.mockReset();
    mocks.createMissionFromSurface.mockReset();
    mocks.createMissionFromSurface.mockResolvedValue({
      fridayConversationId: "conversation_ui_spine",
      missionId: "mission_ui_spine",
      workItemId: "work_ui_spine",
      surfaceThreadId: "mission-workbench:mission_ui_spine",
      status: "ready",
      blockers: [],
      createdOrReady: true,
    });
    mocks.transitionWorkItemStatus.mockReset();

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
    defineGlobal("Event", previousEvent as typeof globalThis.Event);
    defineGlobal("MouseEvent", previousMouseEvent as typeof globalThis.MouseEvent);
  });

  async function renderPage(): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/mission-workbench?missionId=mission_ui_spine"] },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(MissionWorkbenchPage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  it("confirms a memory candidate through the Memory Spine decision route", async () => {
    await renderPage();

    const confirm = container?.querySelector<HTMLButtonElement>(
      "[data-testid=\"mission-memory-confirm-memory_ui_candidate\"]",
    );
    expect(confirm).not.toBeNull();

    await act(async () => {
      confirm!.click();
      await flushCycles();
    });

    expect(mocks.decideMemoryCandidate).toHaveBeenCalledWith({
      memoryId: "memory_ui_candidate",
      ownerPrincipal: "operator:mission-workbench",
      decision: "confirm",
    });
  });

  it("renders Memory Spine decision errors as a visible status pill", async () => {
    mocks.decideMemoryCandidate.mockRejectedValueOnce(new Error("memory spine decide refused"));
    await renderPage();

    const confirm = container?.querySelector<HTMLButtonElement>(
      "[data-testid=\"mission-memory-confirm-memory_ui_candidate\"]",
    );
    expect(confirm).not.toBeNull();

    await act(async () => {
      confirm!.click();
      await flushCycles();
    });

    expect(container?.textContent).toContain("memory spine decide refused");
    const occurrences = container?.textContent?.match(/memory spine decide refused/g)?.length ?? 0;
    expect(occurrences).toBe(1);
  });

  it("labels Mission intake as an idempotent ensure action", async () => {
    await renderPage();

    const createMission = container?.querySelector<HTMLButtonElement>(
      "[data-testid=\"mission-spine-create-from-workbench\"]",
    );
    expect(createMission).not.toBeNull();
    expect(createMission?.textContent).toContain("Ensure Mission");
    expect(createMission?.textContent).not.toContain("Create Mission");

    await act(async () => {
      createMission!.click();
      await flushCycles();
    });

    expect(mocks.createMissionFromSurface).toHaveBeenCalledWith({
      fridayConversationId: "conversation_ui_spine",
      ownerPrincipal: "operator:mission-workbench",
      surfaceThreadId: "mission-workbench:mission_ui_spine",
      surfaceKind: "desktop",
      deliveryRoute: "desktop://mission-workbench",
      visibilityPolicy: "compact",
      missionId: "mission_ui_spine",
      workItemId: "work_ui_spine",
      title: "UI work item",
      intent: "Route through Rust Hub.",
      lane: "codex",
      targetProviderOrAgent: "codex",
      proofRequirements: ["outcome:AnswerProduced:>=1"],
    });
  });
});
