import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkflowBuilderPage } from "../../../ui/src/routes/workflow-builder-page";

const mocks = vi.hoisted(() => ({
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
  instantiateTemplate: vi.fn(),
  listDrafts: vi.fn(),
  createDraft: vi.fn(),
  getDraft: vi.fn(),
  saveDraft: vi.fn(),
  autosaveDraft: vi.fn(),
  compileDraft: vi.fn(),
  publishDraft: vi.fn(),
  acquireLock: vi.fn(),
  renewLock: vi.fn(),
  releaseLock: vi.fn(),
  listWorkflows: vi.fn(),
  createWorkflow: vi.fn(),
  listSkills: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  setCenter: vi.fn(),
  screenToFlowPosition: vi.fn((input: { x: number; y: number }) => input),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
  }),
}));

vi.mock("@/lib/api/workflow-builder", () => ({
  workflowBuilderApi: {
    listTemplates: mocks.listTemplates,
    getTemplate: mocks.getTemplate,
    instantiateTemplate: mocks.instantiateTemplate,
    listDrafts: mocks.listDrafts,
    createDraft: mocks.createDraft,
    getDraft: mocks.getDraft,
    saveDraft: mocks.saveDraft,
    autosaveDraft: mocks.autosaveDraft,
    compileDraft: mocks.compileDraft,
    publishDraft: mocks.publishDraft,
    acquireLock: mocks.acquireLock,
    renewLock: mocks.renewLock,
    releaseLock: mocks.releaseLock,
  },
}));

vi.mock("@/lib/api/workflows", () => ({
  workflowsApi: {
    list: mocks.listWorkflows,
    create: mocks.createWorkflow,
  },
}));

vi.mock("@/lib/api/skills", () => ({
  skillsApi: {
    listSkills: mocks.listSkills,
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
    Background: () => react.createElement("div", { "data-testid": "mock-flow-background" }),
    BaseEdge: (props: { id?: string }) => react.createElement("div", { "data-testid": `mock-edge-base-${props.id ?? "edge"}` }),
    Controls: () => react.createElement("div", { "data-testid": "mock-flow-controls" }),
    EdgeLabelRenderer: ({ children }: { children?: react.ReactNode }) => react.createElement(react.Fragment, null, children),
    Handle: () => react.createElement("span", { "data-testid": "mock-flow-handle" }),
    MarkerType: {
      ArrowClosed: "arrowclosed",
    },
    MiniMap: () => react.createElement("div", { "data-testid": "mock-flow-minimap" }),
    Position: {
      Left: "left",
      Right: "right",
    },
    ReactFlow: ({
      nodes,
      edges,
      nodeTypes,
      edgeTypes,
      children,
    }: {
      nodes: Array<Record<string, unknown>>;
      edges: Array<Record<string, unknown>>;
      nodeTypes?: Record<string, (props: Record<string, unknown>) => react.ReactNode>;
      edgeTypes?: Record<string, (props: Record<string, unknown>) => react.ReactNode>;
      children?: react.ReactNode;
    }) => react.createElement(
      "div",
      { "data-testid": "mock-react-flow" },
      [
        ...(nodes ?? []).map((node) => {
          const NodeRenderer = nodeTypes?.[String(node.type)] ?? ((props: { data?: { name?: string } }) => react.createElement("div", null, props.data?.name ?? "node"));
          return react.createElement(
            "div",
            { key: `node-${String(node.id)}`, "data-node-id": String(node.id) },
            react.createElement(NodeRenderer, {
              id: node.id,
              data: node.data,
              selected: node.selected ?? false,
              type: node.type,
              dragging: false,
              zIndex: 1,
              isConnectable: true,
              targetPosition: "left",
              sourcePosition: "right",
              positionAbsoluteX: (node.position as { x: number; y: number } | undefined)?.x ?? 0,
              positionAbsoluteY: (node.position as { x: number; y: number } | undefined)?.y ?? 0,
            }),
          );
        }),
        ...(edges ?? []).map((edge) => {
          const EdgeRenderer = edgeTypes?.[String(edge.type)] ?? (() => null);
          return react.createElement(
            "div",
            { key: `edge-${String(edge.id)}`, "data-edge-id": String(edge.id) },
            react.createElement(EdgeRenderer, {
              id: edge.id,
              source: edge.source,
              target: edge.target,
              selected: edge.selected ?? false,
              data: edge.data,
              markerEnd: edge.markerEnd,
              sourceX: 0,
              sourceY: 0,
              targetX: 100,
              targetY: 32,
              sourcePosition: "right",
              targetPosition: "left",
            }),
          );
        }),
        children,
      ],
    ),
    ReactFlowProvider: ({ children }: { children?: react.ReactNode }) => react.createElement(react.Fragment, null, children),
    applyEdgeChanges: (_changes: unknown, edges: unknown) => edges,
    applyNodeChanges: (_changes: unknown, nodes: unknown) => nodes,
    getBezierPath: () => ["M0,0", 48, 20],
    useReactFlow: () => ({
      screenToFlowPosition: mocks.screenToFlowPosition,
      setCenter: mocks.setCenter,
    }),
  };
});

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

function buildDraft() {
  return {
    draftId: "draft-1",
    workflowId: "workflow-1",
    ownerUserId: "user-1",
    title: "Workflow Draft",
    status: "active" as const,
    revision: 3,
    spec: {
      schemaVersion: "1.0",
      workflowId: "workflow-1",
      name: "Workflow Draft",
      description: "Workflow builder page coverage",
      startStepId: "step-a",
      trigger: { type: "manual" as const },
      inputs: [],
      steps: [
        {
          id: "step-a",
          type: "skill_call" as const,
          ref: "browser-qa-report",
          args: {
            taskProfile: "review",
            integrationMode: "stable_skill",
          },
        },
      ],
      edges: [],
      outputs: [],
      errorPolicy: { onFailure: "fail_fast" as const, notifyUser: true },
      tests: [],
    },
    visual: {
      schemaVersion: "1.0",
      workflowId: "workflow-1",
      viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null,
      selectedEdgeKey: null,
      panelLayout: { leftOpen: true, rightOpen: true, bottomOpen: false },
      nodes: [
        { nodeId: "__trigger__", x: 24, y: 120, width: 220, height: 120 },
        { nodeId: "step-a", x: 320, y: 120, width: 240, height: 120 },
      ],
      edges: [
        { edgeKey: "__trigger__:step-a:any", sourceHandle: "any", targetHandle: "in" },
      ],
    },
    createdAt: "2026-03-25T00:00:00.000Z",
    updatedAt: "2026-03-25T00:00:00.000Z",
    autosave: {
      enabled: true,
      intervalMs: 15000,
      lastSavedAt: "2026-03-25T00:00:00.000Z",
    },
  };
}

describe("workflow builder page", () => {
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
  let previousEvent: typeof globalThis.Event | undefined;
  let previousMouseEvent: typeof globalThis.MouseEvent | undefined;
  let previousInputEvent: typeof globalThis.InputEvent | undefined;

  async function renderPage(path = "/workflows/builder?workflowId=workflow-1&draftId=draft-1&focus=draft"): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: [path], key: path },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(WorkflowBuilderPage),
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

  function getButtonByText(label: string): HTMLButtonElement {
    const button = Array.from(container?.querySelectorAll("button") ?? []).find((candidate) =>
      candidate.textContent?.includes(label),
    ) as HTMLButtonElement | undefined;
    expect(button, `Missing button ${label}`).toBeDefined();
    return button!;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    const draft = buildDraft();

    mocks.listTemplates.mockResolvedValue({
      items: [],
      stableItems: [],
    });
    mocks.getTemplate.mockResolvedValue({ template: null });
    mocks.instantiateTemplate.mockResolvedValue({ draft });
    mocks.listDrafts.mockResolvedValue({ items: [draft] });
    mocks.createDraft.mockResolvedValue({ draft });
    mocks.getDraft.mockResolvedValue({ draft });
    mocks.saveDraft.mockResolvedValue({
      draft: {
        ...draft,
        revision: 4,
        updatedAt: "2026-03-25T00:10:00.000Z",
      },
    });
    mocks.autosaveDraft.mockResolvedValue({ draft: null });
    mocks.compileDraft.mockResolvedValue({
      compiled: {
        schemaVersion: "2.0",
        workflowId: "workflow-1",
        graph: {
          nodes: [{ id: "step-a", type: "skill_call", ref: "browser-qa-report" }],
          edges: [],
        },
      },
      validation: {
        valid: false,
        generatedAt: "2026-03-25T00:05:00.000Z",
        issues: [
          {
            code: "missing-ref",
            stage: "graph_compile",
            severity: "error",
            message: "Action step needs a ref",
            stepId: "step-a",
          },
        ],
      },
    });
    mocks.publishDraft.mockResolvedValue({
      workflowId: "workflow-1",
      workflowVersionId: "version-1",
      versionNumber: 1,
      published: true,
      checksum: "checksum-1",
      validation: {
        valid: true,
        generatedAt: "2026-03-25T00:06:00.000Z",
        issues: [],
      },
    });
    mocks.acquireLock.mockResolvedValue({
      acquired: true,
      lock: {
        workflowId: "workflow-1",
        lockToken: "lock-1",
        ownerUserId: "user-1",
        ownerSessionId: "session-1",
        expiresAt: "2026-03-25T00:10:00.000Z",
      },
    });
    mocks.renewLock.mockResolvedValue({
      lock: {
        workflowId: "workflow-1",
        lockToken: "lock-1",
        ownerUserId: "user-1",
        ownerSessionId: "session-1",
        expiresAt: "2026-03-25T00:10:00.000Z",
      },
    });
    mocks.releaseLock.mockResolvedValue({ released: true });
    mocks.listWorkflows.mockResolvedValue({
      items: [{ id: "workflow-1", name: "Workflow Draft" }],
    });
    mocks.createWorkflow.mockResolvedValue({
      workflow: { id: "workflow-2" },
    });
    mocks.listSkills.mockResolvedValue([
      { skillId: "browser-qa-report", name: "Browser QA Report" },
    ]);

    const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
    windowRef = window as unknown as Window & typeof globalThis;
    previousWindow = globalThis.window;
    previousDocument = globalThis.document;
    previousNavigator = globalThis.navigator;
    previousHTMLElement = globalThis.HTMLElement;
    previousSVGElement = globalThis.SVGElement;
    previousNode = globalThis.Node;
    previousMutationObserver = globalThis.MutationObserver;
    previousEvent = globalThis.Event;
    previousMouseEvent = globalThis.MouseEvent;
    previousInputEvent = globalThis.InputEvent;

    defineGlobal("window", windowRef);
    defineGlobal("document", windowRef.document);
    defineGlobal("navigator", windowRef.navigator);
    defineGlobal("HTMLElement", windowRef.HTMLElement);
    defineGlobal("SVGElement", windowRef.SVGElement);
    defineGlobal("Node", windowRef.Node);
    defineGlobal("MutationObserver", windowRef.MutationObserver);
    defineGlobal("Event", windowRef.Event);
    defineGlobal("MouseEvent", windowRef.MouseEvent);
    defineGlobal("InputEvent", windowRef.InputEvent);

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
    defineGlobal("Event", previousEvent as typeof globalThis.Event);
    defineGlobal("MouseEvent", previousMouseEvent as typeof globalThis.MouseEvent);
    defineGlobal("InputEvent", previousInputEvent as typeof globalThis.InputEvent);
  });

  it("shows grouped node palette sections and filters them by the local search query", async () => {
    await renderPage();

    const initialText = await waitFor(
      () => getByTestId("workflow-builder-node-library").textContent ?? "",
      (value) => value.includes("Node Library"),
    );

    expect(initialText).toContain("Execution");
    expect(initialText).toContain("Logic");
    expect(initialText).toContain("Data");
    expect(initialText).toContain("Action");
    expect(initialText).toContain("AI / Tool");
    expect(initialText).toContain("Condition");
    expect(initialText).toContain("Approval");
    expect(initialText).toContain("Transform");

    const searchInput = getByTestId<HTMLInputElement>("workflow-builder-node-search");
    await act(async () => {
      searchInput.value = "logic";
      searchInput.dispatchEvent(new windowRef.InputEvent("input", { bubbles: true, data: "logic", inputType: "insertText" }));
      searchInput.dispatchEvent(new windowRef.Event("change", { bubbles: true }));
      await flushCycles();
    });

    const filteredText = getByTestId("workflow-builder-node-library").textContent ?? "";
    expect(filteredText).toContain("Logic");
    expect(filteredText).toContain("Condition");
    expect(filteredText).toContain("Approval");
    expect(filteredText).not.toContain("AI / Tool");
    expect(filteredText).not.toContain("Transform");
  });

  it("projects compile diagnostics into the canvas summary and focuses the affected node", async () => {
    await renderPage();

    await waitFor(
      () => container?.textContent ?? "",
      (value) => value.includes("Compile") && value.includes("lock"),
    );

    await act(async () => {
      getButtonByText("Compile").click();
      await flushCycles();
    });

    await waitFor(
      () => mocks.compileDraft.mock.calls.length,
      (value) => value > 0,
    );

    const summary = await waitFor(
      () => container?.querySelector<HTMLElement>('[data-testid="workflow-builder-compile-summary"]')?.textContent ?? "",
      (value) => value.includes("1 errors"),
    );
    expect(summary).toContain("1 errors");

    const text = container?.textContent ?? "";
    expect(text).toContain("Compile report");
    expect(text).toContain("Node issues");
    expect(text).toContain("Action step needs a ref");

    await act(async () => {
      getButtonByText("Jump to next issue").dispatchEvent(new windowRef.Event("click", { bubbles: true }));
      await flushCycles();
    });

    expect(mocks.setCenter).toHaveBeenCalledTimes(1);
  });
});
