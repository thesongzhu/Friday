import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillGeneratorPage } from "../../../ui/src/routes/skill-generator-page";

const mocks = vi.hoisted(() => ({
  getGeneratorSession: vi.fn(),
  getGenerationEvidence: vi.fn(),
  approveSession: vi.fn(),
  testSession: vi.fn(),
  generateDraft: vi.fn(),
  submitGeneratorMessage: vi.fn(),
  startGeneratorSession: vi.fn(),
  cancelSession: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
  }),
}));

vi.mock("@/lib/api/skills", () => ({
  skillsApi: {
    getGeneratorSession: mocks.getGeneratorSession,
    getGenerationEvidence: mocks.getGenerationEvidence,
    approveSession: mocks.approveSession,
    testSession: mocks.testSession,
    generateDraft: mocks.generateDraft,
    submitGeneratorMessage: mocks.submitGeneratorMessage,
    startGeneratorSession: mocks.startGeneratorSession,
    cancelSession: mocks.cancelSession,
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

async function flushCycles(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await flush();
  }
}

async function waitFor<T>(factory: () => T, predicate: (value: T) => boolean, attempts = 16): Promise<T> {
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

describe("skill generator page", () => {
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

  async function renderPage(path = "/skills/generator?sessionId=session-1"): Promise<void> {
    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: [path], key: path },
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(SkillGeneratorPage),
          ),
        ),
      );
      await flushCycles();
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    mocks.getGeneratorSession.mockResolvedValue({
      session: {
        sessionId: "session-1",
        userId: "user-1",
        channel: "assistant",
        status: "ready_for_review",
        goal: "Create a reusable incident triage skill",
        specSummary: "Summarize incidents",
        openQuestions: ["What inputs should the skill accept?"],
        decisions: [],
        createdAt: "2026-03-25T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
      },
      turns: [
        {
          turnId: "turn-1",
          sessionId: "session-1",
          role: "assistant",
          content: "Draft is ready for review.",
          createdAt: "2026-03-25T00:00:00.000Z",
        },
      ],
      draft: {
        manifest: {
          id: "incident-triage",
          name: "Incident Triage",
          description: "Summarize incidents.",
          version: "0.1.0",
          runtime: { kind: "node" },
          tags: ["generated", "ops"],
        },
        files: [
          {
            path: "skill.manifest.json",
            language: "json",
            content: "{\"id\":\"incident-triage\"}",
          },
        ],
        uiSchema: {
          schemaVersion: "1.0",
          title: "Incident Triage",
          sections: [],
          fields: [],
          outputs: [],
          actions: [],
        },
        runtimeKind: "node",
        validation: {
          ok: true,
          issues: [],
          repaired: false,
          repairAttempts: 0,
        },
      },
    });

    mocks.getGenerationEvidence.mockResolvedValue({
      sessionId: "session-1",
      validationSummary: {
        ok: true,
        repaired: false,
        repairAttempts: 0,
        issueCount: 0,
      },
      repairSummary: {
        attempted: false,
        attempts: 0,
      },
      executableTestSummary: null,
      approvalReadiness: {
        ready: true,
        reason: "ready",
      },
    });

    mocks.approveSession.mockResolvedValue({
      sessionId: "session-1",
      skillId: "incident-triage",
      skillDir: "/tmp/skill-candidates/incident-triage/files",
      candidateId: "incident-triage-1-0-0-candidate",
      candidateDir: "/tmp/skill-candidates/incident-triage",
      savedFiles: ["skill.manifest.json", "index.ts"],
      registryRefreshed: false,
      promotionStage: "candidate_staged",
      candidateManifestTags: ["generated", "generated.candidate"],
      promotedManifestTags: [],
      evidence: {
        sessionId: "session-1",
        validationSummary: {
          ok: true,
          repaired: false,
          repairAttempts: 0,
          issueCount: 0,
        },
        repairSummary: {
          attempted: false,
          attempts: 0,
        },
        executableTestSummary: {
          ok: true,
          executable: true,
          issues: [],
          durationMs: 123,
        },
        approvalReadiness: {
          ready: true,
          reason: "ready",
        },
        stagedCandidateIdentity: {
          skillId: "incident-triage",
          candidateId: "incident-triage-1-0-0-candidate",
          candidateDir: "/tmp/skill-candidates/incident-triage",
          filesDir: "/tmp/skill-candidates/incident-triage/files",
        },
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

  it("shows the approve success receipt directly on the generator surface", async () => {
    await renderPage();

    const initialText = await waitFor(
      () => container?.textContent ?? "",
      (value) => value.includes("Incident Triage"),
    );
    expect(initialText).toContain("Incident Triage");

    await act(async () => {
      getByTestId("skill-generator-approve").dispatchEvent(new windowRef.Event("click", { bubbles: true }));
      await flushCycles();
    });

    const receipt = getByTestId("skill-generator-approve-receipt");
    expect(receipt.textContent).toContain("Candidate staged receipt");
    expect(receipt.textContent).toContain("incident-triage");
    expect(receipt.textContent).toContain("incident-triage-1-0-0-candidate");
    expect(receipt.textContent).toContain("/tmp/skill-candidates/incident-triage");
    expect(receipt.textContent).toContain("/tmp/skill-candidates/incident-triage/files");
    expect(receipt.textContent).toContain("candidate_staged");
    expect(receipt.textContent).toContain("generated.candidate");
    expect(receipt.textContent).not.toContain("stabilized");
    expect(receipt.textContent).toContain("not installed, promoted, or runnable");
  });
});
