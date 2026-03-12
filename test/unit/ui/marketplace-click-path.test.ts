import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplacePage } from "../../../ui/src/routes/marketplace-page";

const mocks = vi.hoisted(() => ({
  listAssets: vi.fn(),
  getAsset: vi.fn(),
  listCreators: vi.fn(),
  supportAsset: vi.fn(),
  listRequests: vi.fn(),
  createRequest: vi.fn(),
  getRequest: vi.fn(),
  createRequestResponse: vi.fn(),
  acceptRequestResponse: vi.fn(),
  closeRequest: vi.fn(),
  installSkill: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api/marketplace", () => ({
  marketplaceApi: {
    listAssets: mocks.listAssets,
    getAsset: mocks.getAsset,
    listCreators: mocks.listCreators,
    supportAsset: mocks.supportAsset,
    listRequests: mocks.listRequests,
    createRequest: mocks.createRequest,
    getRequest: mocks.getRequest,
    createRequestResponse: mocks.createRequestResponse,
    acceptRequestResponse: mocks.acceptRequestResponse,
    closeRequest: mocks.closeRequest,
  },
}));

vi.mock("@/lib/api/skills", () => ({
  skillsApi: {
    installSkill: mocks.installSkill,
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    error: mocks.toastError,
  },
}));

const featuredSkill = {
  assetId: "skill:error-triage",
  creatorId: "creator-1",
  assetType: "skill" as const,
  sourceKind: "skills_lifecycle" as const,
  distributionMode: "declarative_public" as const,
  publicEligible: true,
  title: "Error Triage",
  slug: "error-triage",
  summary: "Triages production incidents with bounded permissions.",
  publisherName: "Reliability Guild",
  installable: true,
  installed: false,
  enabled: false,
  verificationStatus: "verified" as const,
  trustScore: 92,
  latestVersion: "2.1.0",
  maturity: "validated_and_keep" as const,
};

const hiddenLegacyAsset = {
  assetId: "skill:legacy-shell",
  creatorId: "creator-legacy",
  assetType: "skill" as const,
  sourceKind: "marketplace_listing" as const,
  distributionMode: "legacy_executable" as const,
  publicEligible: false,
  title: "Legacy Shell Skill",
  slug: "legacy-shell",
  summary: "Legacy executable asset kept out of the public catalog.",
  publisherName: "Legacy Ops",
  installable: false,
  installed: false,
  enabled: false,
  verificationStatus: "verified" as const,
  trustScore: 61,
  latestVersion: "0.8.0",
  maturity: "validated_but_temporary" as const,
};

const creator = {
  id: "creator-1",
  displayName: "Reliability Guild",
  bio: "Builds safe operational assets.",
  avatarUrl: null,
  websiteUrl: null,
  assetIds: [featuredSkill.assetId],
  reputation: {
    overallScore: 90,
    ratingAverage: 4.8,
    ratingCount: 14,
    supportCount: 6,
    supportTotal: { amount: 3000, currency: "USD" },
    installCount: 42,
    verifiedAssetCount: 3,
    verificationSuccessRate: 0.96,
    permissionRestraintScore: 94,
    fulfilledRequestCount: 2,
  },
  verifiedPublisher: true,
};

const openRequest = {
  id: "req-1",
  assetKind: "skill" as const,
  requesterTenantId: "tenant-1",
  requesterPrincipalId: "user-1",
  title: "Personal incident helper",
  goal: "Help me triage incidents in one click.",
  desiredOutcome: "A private skill that drafts a safe triage plan.",
  constraints: ["No outbound network access"],
  budgetSupportIntent: "$50 tip",
  privacy: "private" as const,
  publishability: "allow_publication" as const,
  riskNotes: "No production writes",
  status: "open" as const,
  acceptedResponseId: null,
  createdAt: "2026-03-09T12:00:00.000Z",
  updatedAt: "2026-03-09T12:00:00.000Z",
  closedAt: null,
};

const requestResponse = {
  id: "resp-1",
  requestId: openRequest.id,
  responderTenantId: "tenant-1",
  responderPrincipalId: "creator-user-1",
  responderCreatorId: creator.id,
  message: "I can build a bounded triage skill with no network permissions.",
  proposal: "Draft a safe skill with declarative actions only.",
  deliverableAssetId: null,
  createdAt: "2026-03-09T12:05:00.000Z",
};

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

describe("marketplace click path", () => {
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
  let previousGetComputedStyle: typeof globalThis.getComputedStyle | undefined;
  let previousRequestAnimationFrame: typeof globalThis.requestAnimationFrame | undefined;
  let previousCancelAnimationFrame: typeof globalThis.cancelAnimationFrame | undefined;

  async function renderPage(path = "/marketplace"): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: [path], key: path },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(MarketplacePage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    mocks.listAssets.mockResolvedValue([featuredSkill, hiddenLegacyAsset]);
    mocks.getAsset.mockResolvedValue({
      ...featuredSkill,
      description: "Triages incidents with bounded declarative actions.",
      permissions: ["system.read", "observability.read", "assistant.recommend"],
      sourceLabel: "public marketplace",
      provenance: { kind: "skill", skillId: "error-triage" },
    });
    mocks.listCreators.mockResolvedValue([creator]);
    mocks.supportAsset.mockResolvedValue({ ok: true });
    mocks.listRequests.mockResolvedValue([openRequest]);
    mocks.createRequest.mockImplementation(async (input) => ({
      request: {
        ...openRequest,
        id: `req-${input.assetKind}`,
        assetKind: input.assetKind,
        title: input.title,
        goal: input.goal,
        desiredOutcome: input.desiredOutcome,
        constraints: input.constraints ?? [],
        budgetSupportIntent: input.budgetSupportIntent ?? null,
        riskNotes: input.riskNotes ?? null,
      },
      responses: [],
    }));
    mocks.getRequest.mockResolvedValue({
      request: openRequest,
      responses: [requestResponse],
    });
    mocks.createRequestResponse.mockResolvedValue({
      request: openRequest,
      responses: [requestResponse],
    });
    mocks.acceptRequestResponse.mockResolvedValue({
      request: { ...openRequest, status: "accepted", acceptedResponseId: requestResponse.id },
      responses: [requestResponse],
    });
    mocks.closeRequest.mockResolvedValue({
      request: { ...openRequest, status: "closed", acceptedResponseId: requestResponse.id },
      responses: [requestResponse],
    });
    mocks.installSkill.mockResolvedValue({
      status: "installed",
      skill: {
        skillId: "error-triage",
        name: "Error Triage",
      },
    });

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
    previousGetComputedStyle = globalThis.getComputedStyle;
    previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    previousCancelAnimationFrame = globalThis.cancelAnimationFrame;

    defineGlobal("window", windowRef);
    defineGlobal("document", windowRef.document);
    defineGlobal("navigator", windowRef.navigator);
    defineGlobal("HTMLElement", windowRef.HTMLElement);
    defineGlobal("SVGElement", windowRef.SVGElement);
    defineGlobal("Node", windowRef.Node);
    defineGlobal("MutationObserver", windowRef.MutationObserver);
    defineGlobal("Event", windowRef.Event);
    defineGlobal("MouseEvent", windowRef.MouseEvent);
    defineGlobal("InputEvent", (windowRef.InputEvent ?? windowRef.Event) as typeof globalThis.InputEvent);
    defineGlobal(
      "getComputedStyle",
      (windowRef.getComputedStyle
        ? windowRef.getComputedStyle.bind(windowRef)
        : (() => ({}) as CSSStyleDeclaration)) as typeof globalThis.getComputedStyle,
    );
    defineGlobal(
      "requestAnimationFrame",
      (((callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0)) as unknown) as typeof globalThis.requestAnimationFrame,
    );
    defineGlobal(
      "cancelAnimationFrame",
      (((handle: number) => clearTimeout(handle)) as unknown) as typeof globalThis.cancelAnimationFrame,
    );

    container = windowRef.document.getElementById("root") as HTMLElement;
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });

    await renderPage();
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
    defineGlobal("getComputedStyle", previousGetComputedStyle as typeof globalThis.getComputedStyle);
    defineGlobal(
      "requestAnimationFrame",
      previousRequestAnimationFrame as typeof globalThis.requestAnimationFrame,
    );
    defineGlobal(
      "cancelAnimationFrame",
      previousCancelAnimationFrame as typeof globalThis.cancelAnimationFrame,
    );
  });

  function getByTestId(testId: string): HTMLElement {
    const element = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect(element, `Missing test id ${testId}`).not.toBeNull();
    return element!;
  }

  async function findByTestId(testId: string): Promise<HTMLElement> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const element = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (element) {
        return element;
      }

      await act(async () => {
        await flushCycles();
      });
    }

    return getByTestId(testId);
  }

  async function click(testId: string): Promise<void> {
    const element = await findByTestId(testId);
    await act(async () => {
      element.dispatchEvent(
        new (windowRef.MouseEvent ?? windowRef.Event)("click", {
          bubbles: true,
          cancelable: true,
        }),
      );
      await flushCycles();
    });
  }

  async function changeInput(testId: string, value: string): Promise<void> {
    const element = (await findByTestId(testId)) as HTMLInputElement | HTMLTextAreaElement;
    const prototypeChain = [Object.getPrototypeOf(element), Object.getPrototypeOf(Object.getPrototypeOf(element))];
    const valueSetter = prototypeChain
      .map((entry) => Object.getOwnPropertyDescriptor(entry, "value")?.set)
      .find((candidate) => typeof candidate === "function");
    const reactPropsKey = Object.keys(element).find((key) => key.startsWith("__reactProps"));
    const reactProps =
      reactPropsKey && reactPropsKey in element
        ? (element as Record<string, { onChange?: (event: { target: { value: string } }) => void }>)[reactPropsKey]
        : null;

    expect(typeof valueSetter === "function" || typeof reactProps?.onChange === "function").toBe(true);

    await act(async () => {
      if (typeof reactProps?.onChange === "function") {
        reactProps.onChange({ target: { value } });
      } else {
        valueSetter!.call(element, value);
        element.dispatchEvent(
          new (windowRef.InputEvent ?? windowRef.Event)("input", {
            bubbles: true,
            cancelable: true,
          }),
        );
        element.dispatchEvent(new windowRef.Event("change", { bubbles: true, cancelable: true }));
        element.dispatchEvent(new windowRef.Event("blur", { bubbles: true, cancelable: true }));
      }
      await flushCycles();
    });
  }

  async function submitRequest(): Promise<void> {
    const submit = await findByTestId("marketplace-request-submit");
    const form = submit.closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new windowRef.Event("submit", { bubbles: true, cancelable: true }));
      await flushCycles();
    });
  }

  it("supports declarative asset install and creator support while hiding legacy assets", async () => {
    expect((await findByTestId("marketplace-asset-card-skill:error-triage")).textContent).toContain("Error Triage");
    expect(
      container?.querySelector('[data-testid="marketplace-asset-card-skill:legacy-shell"]'),
    ).toBeNull();

    await click("marketplace-permissions-toggle-skill:error-triage");
    expect(getByTestId("marketplace-permissions-toggle-skill:error-triage").textContent).toContain(
      "Hide permission preview",
    );

    await click("marketplace-install-skill:error-triage");
    expect(mocks.installSkill).toHaveBeenCalledWith({ skillId: "error-triage" });

    await click("marketplace-support-skill:error-triage");
    expect(mocks.supportAsset).toHaveBeenCalledWith("skill:error-triage", {
      amount: { amount: 500, currency: "USD" },
      message: "Thanks for building this.",
    });
  });

  it("creates skill, workflow, and agent requests through the click-first request board", async () => {
    for (const kind of ["skill", "workflow", "agent"] as const) {
      await click(`marketplace-request-kind-${kind}`);
      await changeInput("marketplace-request-title", `${kind} request`);
      await changeInput("marketplace-request-goal", `Need a ${kind} to help with weekly operations.`);
      await changeInput("marketplace-request-outcome", `The ${kind} should be ready to use.`);
      await changeInput("marketplace-request-constraints", "No outbound network access");
      await changeInput("marketplace-request-budget", "$25 tip");
      await changeInput("marketplace-request-risk-notes", "No destructive actions");
      await submitRequest();
      expect(mocks.createRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          assetKind: kind,
          title: `${kind} request`,
          goal: `Need a ${kind} to help with weekly operations.`,
          desiredOutcome: `The ${kind} should be ready to use.`,
        }),
      );
    }

    expect(mocks.createRequest).toHaveBeenCalledTimes(3);
  });

  it("supports responding to, accepting, and closing requests", async () => {
    await changeInput(
      `marketplace-request-response-input-${openRequest.id}`,
      "I can build this with bounded declarative actions.",
    );
    await click(`marketplace-request-respond-${openRequest.id}`);
    expect(mocks.createRequestResponse).toHaveBeenCalledWith(openRequest.id, {
      message: "I can build this with bounded declarative actions.",
    });

    await click(`marketplace-request-accept-${openRequest.id}-${requestResponse.id}`);
    expect(mocks.acceptRequestResponse).toHaveBeenCalledWith(openRequest.id, requestResponse.id);

    await click(`marketplace-request-close-${openRequest.id}`);
    expect(mocks.closeRequest).toHaveBeenCalledWith(openRequest.id);
  });

  it("hydrates assistant handoff context from the marketplace query string", async () => {
    await renderPage("/marketplace?asset=skill:error-triage&requestKind=workflow&goal=Need%20a%20workflow");

    expect(getByTestId("marketplace-asset-card-skill:error-triage").getAttribute("data-highlighted")).toBe("true");
    expect(getByTestId("marketplace-permissions-toggle-skill:error-triage").textContent).toContain(
      "Hide permission preview",
    );
    expect(getByTestId("marketplace-request-kind-workflow").getAttribute("data-active")).toBe("true");

    const goalInput = getByTestId("marketplace-request-goal") as HTMLInputElement | HTMLTextAreaElement;
    expect(goalInput.value).toBe("Need a workflow");
  });
});
