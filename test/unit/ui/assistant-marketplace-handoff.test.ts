import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarketplaceActionCard } from "../../../ui/src/routes/assistant-page";
import { buildMarketplaceAssistantCards } from "../../../ui/src/lib/marketplace/view-models";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushCycles(count = 4): Promise<void> {
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

describe("assistant marketplace handoff", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let windowRef: Window & typeof globalThis;
  let previousWindow: typeof globalThis.window | undefined;
  let previousDocument: typeof globalThis.document | undefined;
  let previousNavigator: typeof globalThis.navigator | undefined;
  let previousHTMLElement: typeof globalThis.HTMLElement | undefined;
  let previousSVGElement: typeof globalThis.SVGElement | undefined;
  let previousNode: typeof globalThis.Node | undefined;
  let previousMutationObserver: typeof globalThis.MutationObserver | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

    const marketplaceCards = buildMarketplaceAssistantCards([
      {
        assetId: "skill:error-triage",
        assetType: "skill",
        title: "Error Triage",
        summary: "Triages incidents.",
        publisherName: "Reliability Guild",
        latestVersion: "2.1.0",
        maturity: "validated_and_keep",
        verificationStatus: "verified",
        publicEligible: true,
        installable: true,
        trustScore: 92,
      },
    ]);

    await act(async () => {
      const goalSeed = "Need a weekly reporting workflow. Constraints: read-only, no outbound network access. Risk: avoid touching production writes. Budget: $50 tip.";
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(MarketplaceActionCard, {
            marketplaceCards,
            creators: [
              {
                id: "creator-1",
                handle: "reliability-guild",
                displayName: "Reliability Guild",
                bio: "Builds safe assets.",
                verifiedPublisher: true,
                reputation: {
                  overallScore: 91,
                  supportCount: 8,
                  supportTotal: { amount: 12000, currency: "USD" },
                  installCount: 42,
                  retentionScore: 93,
                  verificationPassRate: 0.97,
                  fulfilledRequestCount: 3,
                },
              },
            ],
            requests: [
              {
                id: "req-1",
                assetKind: "skill",
                title: "Need a personal helper",
                goal: "Triage incidents",
                desiredOutcome: "A one-click triage helper",
                constraints: [],
                budgetSupportIntent: null,
                privacy: "private",
                publishability: "allow_publication",
                status: "open",
                createdAt: "2026-03-09T12:00:00.000Z",
                updatedAt: "2026-03-09T12:00:00.000Z",
              },
            ],
            goalSeed,
            onInstallSkill: vi.fn(),
            onSupportAsset: vi.fn(),
            installPending: false,
            supportPending: false,
          }),
        ),
      );
      await flushCycles();
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

  function getByTestId(testId: string): HTMLElement {
    const element = container?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
    expect(element, `Missing test id ${testId}`).not.toBeNull();
    return element!;
  }

  it("offers explicit marketplace handoff links and request CTAs", () => {
    const structuredGoal = "Need a weekly reporting workflow.";
    expect(getByTestId("assistant-marketplace-open-all").getAttribute("href")).toBe("/marketplace");
    expect(getByTestId("assistant-marketplace-open-skill:error-triage").getAttribute("href")).toBe(
      "/marketplace?asset=skill%3Aerror-triage",
    );
    const skillHref = new URL(getByTestId("assistant-marketplace-request-skill").getAttribute("href")!, "https://example.test");
    expect(skillHref.searchParams.get("requestKind")).toBe("skill");
    expect(skillHref.searchParams.get("goal")).toBe(
      "Need a weekly reporting workflow. Constraints: read-only, no outbound network access. Risk: avoid touching production writes. Budget: $50 tip.",
    );
    expect(skillHref.searchParams.get("title")).toBe(`Need a skill for: ${structuredGoal}`);
    expect(skillHref.searchParams.get("desiredOutcome")).toBe(
      `A usable skill that solves: ${structuredGoal}`,
    );
    expect(skillHref.searchParams.getAll("constraint")).toEqual(["read-only", "no outbound network access"]);
    expect(skillHref.searchParams.get("riskNotes")).toBe("avoid touching production writes");
    expect(skillHref.searchParams.get("budgetSupportIntent")).toBe("$50 tip");

    const workflowHref = new URL(getByTestId("assistant-marketplace-request-workflow").getAttribute("href")!, "https://example.test");
    expect(workflowHref.searchParams.get("requestKind")).toBe("workflow");
    expect(workflowHref.searchParams.get("goal")).toBe(
      "Need a weekly reporting workflow. Constraints: read-only, no outbound network access. Risk: avoid touching production writes. Budget: $50 tip.",
    );
    expect(workflowHref.searchParams.get("title")).toBe(`Need a workflow for: ${structuredGoal}`);
    expect(workflowHref.searchParams.get("desiredOutcome")).toBe(
      `A usable workflow that solves: ${structuredGoal}`,
    );
    expect(workflowHref.searchParams.getAll("constraint")).toEqual(["read-only", "no outbound network access"]);
    expect(workflowHref.searchParams.get("riskNotes")).toBe("avoid touching production writes");
    expect(workflowHref.searchParams.get("budgetSupportIntent")).toBe("$50 tip");

    const agentHref = new URL(getByTestId("assistant-marketplace-request-agent").getAttribute("href")!, "https://example.test");
    expect(agentHref.searchParams.get("requestKind")).toBe("agent");
    expect(agentHref.searchParams.get("goal")).toBe(
      "Need a weekly reporting workflow. Constraints: read-only, no outbound network access. Risk: avoid touching production writes. Budget: $50 tip.",
    );
    expect(agentHref.searchParams.get("title")).toBe(`Need a agent for: ${structuredGoal}`);
    expect(agentHref.searchParams.get("desiredOutcome")).toBe(
      `A usable agent that solves: ${structuredGoal}`,
    );
    expect(agentHref.searchParams.getAll("constraint")).toEqual(["read-only", "no outbound network access"]);
    expect(agentHref.searchParams.get("riskNotes")).toBe("avoid touching production writes");
    expect(agentHref.searchParams.get("budgetSupportIntent")).toBe("$50 tip");
  });
});
