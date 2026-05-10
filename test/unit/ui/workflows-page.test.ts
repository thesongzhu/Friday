import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowsPage } from "../../../ui/src/routes/workflows-page";

const mocks = vi.hoisted(() => ({
  listWorkflows: vi.fn(),
  getWorkflowOverview: vi.fn(),
  getWorkflowVisualization: vi.fn(),
  deployWorkflowDraft: vi.fn(),
  cancelRun: vi.fn(),
  retryRun: vi.fn(),
  resumeRun: vi.fn(),
  startRun: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/providers/locale-provider", () => ({
  useAppLocale: () => ({ locale: "en" }),
}));

vi.mock("@/hooks/use-system-events", () => ({
  useSystemEvents: () => ({ events: [] }),
}));

vi.mock("@/lib/api/workflows", () => ({
  workflowsApi: {
    list: mocks.listWorkflows,
  },
}));

vi.mock("@/lib/api/system", () => ({
  systemApi: {
    getWorkflowOverview: mocks.getWorkflowOverview,
    getWorkflowVisualization: mocks.getWorkflowVisualization,
    deployWorkflowDraft: mocks.deployWorkflowDraft,
  },
}));

vi.mock("@/lib/api/workflow-runs", () => ({
  workflowRunsApi: {
    cancel: mocks.cancelRun,
    retry: mocks.retryRun,
    resume: mocks.resumeRun,
    start: mocks.startRun,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

vi.mock("@xyflow/react", async () => {
  const react = await import("react");
  return {
    Background: () => react.createElement("div"),
    Controls: () => react.createElement("div"),
    MarkerType: { ArrowClosed: "arrowclosed" },
    ReactFlow: ({ children }: { children?: react.ReactNode }) => react.createElement("div", null, children),
  };
});

const NOW = "2026-05-09T00:00:00.000Z";

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

function triggerCheckboxChange(input: HTMLInputElement, checked: boolean): void {
  input.checked = checked;
  const propsKey = Object.keys(input).find((key) => key.startsWith("__reactProps$"));
  const props = propsKey ? (input as unknown as Record<string, { onChange?: (event: { target: HTMLInputElement }) => void }>)[propsKey] : undefined;
  if (!props?.onChange) {
    throw new Error("React checkbox change handler was not attached");
  }
  props.onChange({ target: input });
}

function makeExternalDraft() {
  return {
    draftId: "draft-1",
    workflowId: "wf-1",
    title: "External Draft",
    status: "active",
    revision: 1,
    spec: {
      schemaVersion: "1.0",
      workflowId: "wf-1",
      name: "External Workflow",
      trigger: { type: "manual" },
      inputs: [],
      startStepId: "step-1",
      steps: [{ id: "step-1", type: "data", value: { ok: true } }],
      edges: [],
      outputs: [],
      tests: [],
    },
    visual: {
      schemaVersion: "1.0",
      workflowId: "wf-1",
      viewport: { x: 0, y: 0, zoom: 1 },
      panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
      nodes: [{ nodeId: "step-1", x: 0, y: 0 }],
      edges: [],
    },
    createdAt: NOW,
    updatedAt: NOW,
    autosave: { enabled: true, intervalMs: 30000 },
    sourceReview: {
      source: "deeplink.workflow_template",
      sourceUrl: "https://example.com/template.json",
      importedAt: NOW,
      requiresReviewBeforePublish: true,
    },
  };
}

describe("workflows page", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient;
  let previousWindow: typeof globalThis.window | undefined;
  let previousDocument: typeof globalThis.document | undefined;
  let previousNavigator: typeof globalThis.navigator | undefined;
  let previousHTMLElement: typeof globalThis.HTMLElement | undefined;
  let previousSVGElement: typeof globalThis.SVGElement | undefined;
  let previousNode: typeof globalThis.Node | undefined;
  let previousEvent: typeof globalThis.Event | undefined;
  let previousMouseEvent: typeof globalThis.MouseEvent | undefined;
  let previousInputEvent: typeof globalThis.InputEvent | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const draft = makeExternalDraft();
    mocks.listWorkflows.mockResolvedValue({
      items: [{
        id: "wf-1",
        slug: "external-workflow",
        name: "External Workflow",
        tags: [],
        latestVersionNumber: 0,
        isArchived: false,
        revision: 1,
        etag: "wf-etag",
        createdAt: NOW,
        updatedAt: NOW,
      }],
    });
    mocks.getWorkflowOverview.mockResolvedValue({
      workflow: {
        id: "wf-1",
        slug: "external-workflow",
        name: "External Workflow",
        tags: [],
        latestVersionNumber: 0,
        isArchived: false,
        revision: 1,
        etag: "wf-etag",
        createdAt: NOW,
        updatedAt: NOW,
      },
      drafts: [draft],
      latestDraft: draft,
      recentRuns: [],
      latestRunNodeTimeline: [],
      latestEvidenceExports: [],
      versionHistory: [],
    });
    mocks.getWorkflowVisualization.mockResolvedValue({
      workflow: {
        id: "wf-1",
        slug: "external-workflow",
        name: "External Workflow",
        tags: [],
        latestVersionNumber: 0,
        isArchived: false,
        revision: 1,
        etag: "wf-etag",
        createdAt: NOW,
        updatedAt: NOW,
      },
      targetKind: "draft",
      draft,
      spec: draft.spec,
      visual: draft.visual,
      recentRuns: [],
      nodeTimeline: [],
      latestEvidenceExports: [],
    });
    mocks.deployWorkflowDraft.mockResolvedValue({ workflowId: "wf-1" });

    const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousSVGElement = globalThis.SVGElement;
    previousNode = globalThis.Node;
    previousEvent = globalThis.Event;
    previousMouseEvent = globalThis.MouseEvent;
    previousInputEvent = globalThis.InputEvent;

    defineGlobal("window", window as unknown as typeof globalThis.window);
    defineGlobal("document", window.document as unknown as typeof globalThis.document);
    defineGlobal("navigator", window.navigator as unknown as typeof globalThis.navigator);
    defineGlobal("HTMLElement", window.HTMLElement as unknown as typeof globalThis.HTMLElement);
    defineGlobal("SVGElement", window.SVGElement as unknown as typeof globalThis.SVGElement);
    defineGlobal("Node", window.Node as unknown as typeof globalThis.Node);
    defineGlobal("Event", window.Event as unknown as typeof globalThis.Event);
    defineGlobal("MouseEvent", window.MouseEvent as unknown as typeof globalThis.MouseEvent);
    defineGlobal("InputEvent", window.InputEvent as unknown as typeof globalThis.InputEvent);

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
    defineGlobal("InputEvent", previousInputEvent as typeof globalThis.InputEvent);
  });

  async function renderPage(): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ["/workflows?workflowId=wf-1&focus=deploy"] },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(WorkflowsPage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  it("requires external draft review before deploying from the operator page", async () => {
    await renderPage();
    await waitFor(
      () => container?.textContent ?? "",
      (value) => value.includes("I reviewed this externally imported workflow draft"),
    );

    const deployButton = Array.from(container?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Deploy now"),
    ) as HTMLButtonElement | undefined;
    expect(deployButton).toBeDefined();

    await act(async () => {
      deployButton!.click();
      await flushCycles();
    });
    expect(mocks.deployWorkflowDraft).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith("Review and confirm this external workflow draft before deploy.");

    const checkbox = container?.querySelector<HTMLInputElement>('[data-testid="workflow-operator-external-draft-review-confirm"]');
    expect(checkbox).not.toBeNull();
    await act(async () => {
      triggerCheckboxChange(checkbox!, true);
      await flushCycles();
    });
    await act(async () => {
      deployButton!.click();
      await flushCycles();
    });

    await waitFor(
      () => mocks.deployWorkflowDraft.mock.calls.length,
      (value) => value > 0,
    );
    expect(mocks.deployWorkflowDraft).toHaveBeenCalledWith("wf-1", "draft-1", expect.objectContaining({
      externalReviewConfirmed: true,
    }));
  });
});
