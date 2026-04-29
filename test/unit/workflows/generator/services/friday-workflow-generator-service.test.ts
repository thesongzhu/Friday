import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { createFridayWorkflowGeneratorService } from "#workflows";
import type {
  CreateFridayWorkflowGeneratorServiceDeps,
  FridayWorkflowGeneratorService,
  FridayWorkflowCrudService,
} from "#workflows";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridaySqliteLayer } from "#state";

const NOW = "2026-02-18T10:00:00.000Z";

// ─── Mock DB ───

function makeMockDb(): FridaySqliteLayer {
  const store = new Map<string, {
    id: string;
    namespace: string;
    key: string;
    value_json: string;
    tags_json: string;
    created_at: string;
    updated_at: string;
  }>();

  function makeDb() {
    return {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("INSERT INTO memory_items")) {
          return {
            run: vi.fn(
              (id: string, namespace: string, key: string, valueJson: string, tagsJson: string, createdAt: string, updatedAt: string) => {
                const storeKey = `${namespace}:${key}`;
                const existing = store.get(storeKey);
                store.set(storeKey, {
                  id: existing ? existing.id : id,
                  namespace, key,
                  value_json: valueJson,
                  tags_json: tagsJson,
                  created_at: existing ? existing.created_at : createdAt,
                  updated_at: updatedAt,
                });
              },
            ),
          };
        }
        if (sql.startsWith("SELECT value_json FROM memory_items")) {
          return {
            get: vi.fn((namespace: string, key: string) => {
              const row = store.get(`${namespace}:${key}`);
              return row ? { value_json: row.value_json } : undefined;
            }),
          };
        }
        if (sql.startsWith("SELECT * FROM memory_items WHERE namespace = ? AND key = ?")) {
          return {
            get: vi.fn((namespace: string, key: string) => {
              return store.get(`${namespace}:${key}`) ?? undefined;
            }),
          };
        }
        if (sql.includes("key LIKE ?") && sql.includes("ORDER BY")) {
          return {
            all: vi.fn((namespace: string, keyPrefix: string) => {
              const prefix = keyPrefix.replace(/%$/, "");
              const results: unknown[] = [];
              for (const [, row] of store.entries()) {
                if (row.namespace === namespace && row.key.startsWith(prefix)) {
                  results.push(row);
                }
              }
              return results;
            }),
          };
        }
        if (sql.startsWith("DELETE FROM memory_items WHERE namespace = ? AND key = ?")) {
          return {
            run: vi.fn((namespace: string, key: string) => {
              store.delete(`${namespace}:${key}`);
            }),
          };
        }
        if (sql.startsWith("DELETE FROM memory_items WHERE namespace = ? AND key LIKE ?")) {
          return {
            run: vi.fn((namespace: string, keyPrefix: string) => {
              const prefix = keyPrefix.replace(/%$/, "");
              for (const storeKey of [...store.keys()]) {
                const row = store.get(storeKey);
                if (row && row.namespace === namespace && row.key.startsWith(prefix)) {
                  store.delete(storeKey);
                }
              }
            }),
          };
        }
        return { run: vi.fn(), get: vi.fn(() => undefined), all: vi.fn(() => []) };
      }),
    };
  }

  const db = makeDb();
  return {
    withReadConnection: vi.fn((fn: (db: unknown) => unknown) => fn(db)),
    withWriteTransaction: vi.fn((fn: (db: unknown) => void) => fn(db)),
  } as unknown as FridaySqliteLayer;
}

// ─── Mock Provider Service ───

function makeMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({ defaultProviderId: "p-1", fallbackProviderIds: [] })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: { id: "p-1", kind: "openai" as const, name: "OpenAI", baseUrl: "https://api.openai.com", enabled: true, config: { api: "openai-completions" as const, authMode: "api-key" as const, keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" }, supportedModels: ["gpt-4o"], validation: { status: "ok" as const, checkedAt: NOW } }, createdAt: NOW, updatedAt: NOW },
      model: "gpt-4o",
    })),
    runWithFallback: vi.fn(async ({ run }: { run: (route: unknown, credential: string | null) => Promise<unknown> }) => {
      const route = {
        provider: { id: "p-1", kind: "openai" as const, name: "OpenAI", baseUrl: "https://api.openai.com", enabled: true, config: { api: "openai-completions" as const, authMode: "api-key" as const, keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" }, supportedModels: ["gpt-4o"], validation: { status: "ok" as const, checkedAt: NOW } }, createdAt: NOW, updatedAt: NOW },
        model: "gpt-4o",
      };
      const result = await run(route, "sk-test-key");
      return { result, route, attempts: [] };
    }),
  } as unknown as FridayProviderService;
}

// ─── Mock Skill Registry ───

function makeMockRegistry(): FridaySkillRegistry {
  return {
    list: vi.fn(() => [
      {
        manifest: {
          id: "send-email",
          name: "Send Email",
          description: "Sends an email",
          inputs: [{ key: "to", type: "string", required: true }],
          outputs: [{ key: "messageId", type: "string", description: "ID" }],
        },
      },
    ]),
    get: vi.fn((id: string) => {
      if (id === "send-email") {
        return { manifest: { id: "send-email", name: "Send Email", description: "Sends", inputs: [], outputs: [] } };
      }
      return null;
    }),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as FridaySkillRegistry;
}

// ─── Mock Workflow CRUD ───

function makeMockWorkflowCrud(): FridayWorkflowCrudService {
  return {
    createWorkflow: vi.fn((input) => ({
      id: "wf-1",
      slug: input.slug,
      name: input.name,
      description: input.description,
      tags: [],
      latestVersionNumber: 0,
      isArchived: false,
      revision: 1,
      etag: "etag-1",
      createdAt: NOW,
      updatedAt: NOW,
    })),
    getWorkflow: vi.fn(() => null),
    getWorkflowBySlug: vi.fn(() => null),
    listWorkflows: vi.fn(() => []),
    updateWorkflow: vi.fn((input) => ({
      id: input.workflowId,
      slug: "existing-workflow",
      name: input.name ?? "Existing Workflow",
      description: input.description,
      tags: ["existing"],
      latestVersionNumber: 1,
      publishedVersionNumber: 1,
      isArchived: false,
      revision: input.expectedRevision + 1,
      etag: "etag-updated",
      createdAt: NOW,
      updatedAt: NOW,
    })),
    updateWorkflowWithGraph: vi.fn(() => ({} as never)),
    archiveWorkflow: vi.fn(),
    createWorkflowWithVersion: vi.fn(() => ({} as never)),
    createVersion: vi.fn(() => ({
      id: "wv-1",
      workflowId: "wf-1",
      versionNumber: 1,
      checksum: "check-1",
      graphJson: {},
      isPublished: false,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    publishVersion: vi.fn(() => ({
      id: "wv-1",
      workflowId: "wf-1",
      versionNumber: 1,
      checksum: "check-1",
      graphJson: {},
      isPublished: true,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    getVersion: vi.fn(() => null),
    listVersions: vi.fn(() => []),
    getPublishedVersion: vi.fn(() => null),
  } as unknown as FridayWorkflowCrudService;
}

// ─── LLM responses ───

function makeRequirementsResponse(state: "needs_clarification" | "ready_for_generation") {
  return {
    state,
    questions: state === "needs_clarification" ? ["What trigger type?"] : [],
    requirements: {
      goal: "Send emails",
      trigger: { type: "manual" },
      inputs: [{ key: "recipient", type: "string", required: true }],
      plannedSteps: [{ id: "send", intent: "Send email", nodeTypeHint: "action", preferredSkillId: "send-email" }],
      outputs: [{ key: "result", fromStep: "send", path: "messageId" }],
      errorPolicy: { onFailure: "fail_fast", notifyUser: false },
      assumptions: [],
      testScenarios: [{ name: "happy path" }],
    },
  };
}

function makeSpecResponse(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    workflowId: "send-emails",
    name: "Send Emails",
    description: "Sends emails",
    startStepId: "send",
    trigger: { type: "manual" },
    inputs: [{ key: "recipient", type: "string", required: true }],
    steps: [{ id: "send", type: "skill_call", ref: "send-email" }],
    edges: [],
    outputs: [{ key: "result", fromStep: "send", path: "messageId" }],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
    ...overrides,
  };
}

function makeVisualResponse() {
  return {
    schemaVersion: "1.0",
    workflowId: "send-emails",
    viewport: { x: 0, y: 0, zoom: 1 },
    panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
    nodes: [
      { nodeId: "__trigger__", x: 100, y: 100 },
      { nodeId: "send", x: 350, y: 100 },
    ],
    edges: [],
  };
}

function makeTestsResponse() {
  return [
    {
      name: "happy path",
      inputs: { recipient: "alice@example.com" },
      assertions: [{ path: "outputs.result", operator: "==", expected: "msg-1" }],
    },
  ];
}

function makeTransformSpecResponseWithTopLevelTransform() {
  return {
    schemaVersion: "1.0",
    workflowId: "send-emails",
    name: "Send Emails",
    description: "Sends emails",
    startStepId: "output_version_two",
    trigger: { type: "manual" },
    inputs: [],
    steps: [{ id: "output_version_two", type: "transform", transform: { message: "version two" } }],
    edges: [],
    outputs: [{ key: "message", fromStep: "output_version_two", path: "message" }],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
  };
}

function makeTransformSpecResponseWithTopLevelExpression() {
  return {
    schemaVersion: "1.0",
    workflowId: "send-emails",
    name: "Send Emails",
    description: "Sends emails",
    startStepId: "output_version_two",
    trigger: { type: "manual" },
    inputs: [],
    steps: [{ id: "output_version_two", type: "transform", expression: '{"message":"version two"}' }],
    edges: [],
    outputs: [{ key: "message", fromStep: "output_version_two", path: "message" }],
    errorPolicy: { onFailure: "fail_fast", notifyUser: false },
    tests: [],
  };
}

// ─── Fetch mock ───

function mockFetchForLlm(responses: unknown[]): void {
  let callIdx = 0;
  globalThis.fetch = vi.fn(async () => {
    const resp = responses[callIdx] ?? responses[responses.length - 1];
    callIdx++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(resp) } }],
      }),
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(resp) } }] }),
    } as Response;
  });
}

// ─── Tests ───

describe("FridayWorkflowGeneratorService", () => {
  let service: FridayWorkflowGeneratorService;
  let deps: CreateFridayWorkflowGeneratorServiceDeps;
  let idCounter: number;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    idCounter = 0;
    deps = {
      db: makeMockDb(),
      providerService: makeMockProviderService(),
      workflowCrud: makeMockWorkflowCrud(),
      skillRegistry: makeMockRegistry(),
      idGenerator: () => `id-${++idCounter}`,
      nowIso: () => NOW,
      computeChecksum: (content: string) => `checksum-${content.length}`,
    };
    service = createFridayWorkflowGeneratorService(deps);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("startSession", () => {
    it("returns clarification_required when analyzer needs more info", async () => {
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);

      const result = await service.startSession({
        goal: "Build a workflow",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("clarification_required");
      expect(result.questions).toEqual(["What trigger type?"]);
      expect(result.session.status).toBe("needs_clarification");
    });

    it("auto-generates draft when ready", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(result.session.status).toBe("ready_for_review");
    });

    it("normalizes malformed visual output into a valid fallback layout", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        { visual: { nodes: { bad: true }, edges: [] } },
        makeTestsResponse(),
      ]);

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      const visualNodeIds = new Set(result.draft!.visual.nodes.map((n) => n.nodeId));
      expect(visualNodeIds.has("__trigger__")).toBe(true);
      expect(visualNodeIds.has("send")).toBe(true);
    });

    it("normalizes malformed tests output into valid smoke tests", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        { tests: { bad: true } },
      ]);

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(Array.isArray(result.draft!.tests)).toBe(true);
      expect(result.draft!.tests.length).toBeGreaterThanOrEqual(1);
      expect(result.draft!.tests[0]!.assertions.length).toBeGreaterThanOrEqual(1);
      expect(result.draft!.tests[0]!.assertions[0]!.path).toBe("outputs.result");
    });

    it("falls back to a valid step-status smoke test when the workflow has no outputs", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse({ outputs: [] }),
        makeVisualResponse(),
        { tests: { bad: true } },
      ]);

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(result.draft!.tests[0]!.assertions[0]).toEqual({
        path: "steps.send.status",
        operator: "==",
        expected: "completed",
      });
    });

    it("normalizes top-level transform fields into step.args before compilation", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeTransformSpecResponseWithTopLevelTransform(),
        {
          schemaVersion: "1.0",
          workflowId: "send-emails",
          viewport: { x: 0, y: 0, zoom: 1 },
          panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
          nodes: [
            { nodeId: "__trigger__", x: 100, y: 100 },
            { nodeId: "output_version_two", x: 350, y: 100 },
          ],
          edges: [],
        },
        [
          {
            name: "version two path",
            inputs: {},
            assertions: [{ path: "outputs.message", operator: "==", expected: "version two" }],
          },
        ],
      ]);

      const result = await service.startSession({
        goal: "Update the workflow to return version two",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(result.draft!.spec.steps[0]?.args).toEqual({ mapping: { message: "version two" } });
      const compiledNode = result.draft!.compiledGraph.graph.nodes.find((node) => node.id === "output_version_two");
      expect(compiledNode?.type).toBe("data");
      expect(compiledNode?.config).toEqual({ mapping: { message: "version two" } });
    });

    it("normalizes object transforms inside step args into data-node mapping", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse({
          startStepId: "output_version_two",
          inputs: [],
          steps: [
            {
              id: "output_version_two",
              type: "transform",
              args: { transform: { message: "version two" } },
            },
          ],
          outputs: [{ key: "message", fromStep: "output_version_two", path: "message" }],
        }),
        {
          schemaVersion: "1.0",
          workflowId: "send-emails",
          viewport: { x: 0, y: 0, zoom: 1 },
          panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
          nodes: [
            { nodeId: "__trigger__", x: 100, y: 100 },
            { nodeId: "output_version_two", x: 350, y: 100 },
          ],
          edges: [],
        },
        [
          {
            name: "version two path",
            inputs: {},
            assertions: [{ path: "outputs.message", operator: "==", expected: "version two" }],
          },
        ],
      ]);

      const result = await service.startSession({
        goal: "Update the workflow to return version two",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(result.draft!.spec.steps[0]?.args).toEqual({ mapping: { message: "version two" } });
      const compiledNode = result.draft!.compiledGraph.graph.nodes.find((node) => node.id === "output_version_two");
      expect(compiledNode?.config).toEqual({ mapping: { message: "version two" } });
    });

    it("normalizes top-level expression fields into step.args.transform before compilation", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeTransformSpecResponseWithTopLevelExpression(),
        {
          schemaVersion: "1.0",
          workflowId: "send-emails",
          viewport: { x: 0, y: 0, zoom: 1 },
          panelLayout: { leftOpen: true, rightOpen: false, bottomOpen: false },
          nodes: [
            { nodeId: "__trigger__", x: 100, y: 100 },
            { nodeId: "output_version_two", x: 350, y: 100 },
          ],
          edges: [],
        },
        [
          {
            name: "version two path",
            inputs: {},
            assertions: [{ path: "outputs.message", operator: "==", expected: "version two" }],
          },
        ],
      ]);

      const result = await service.startSession({
        goal: "Update the workflow to return version two",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(result.draft!.spec.steps[0]).toEqual({
        id: "output_version_two",
        type: "transform",
        args: { transform: '{"message":"version two"}' },
      });
      const compiledNode = result.draft!.compiledGraph.graph.nodes.find((node) => node.id === "output_version_two");
      expect(compiledNode?.config).toEqual({ transform: '{"message":"version two"}' });
    });

    it("falls back to deterministic visual and tests when auxiliary LLM calls fail", async () => {
      const originalFetch = globalThis.fetch;
      let callIdx = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callIdx++;
        if (callIdx === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(makeRequirementsResponse("ready_for_generation")) } }],
            }),
          } as Response;
        }
        if (callIdx === 2) {
          return {
            ok: true,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(makeSpecResponse()) } }],
            }),
          } as Response;
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "" } }],
          }),
        } as Response;
      });

      try {
        const result = await service.startSession({
          goal: "Send emails",
          userId: "u-1",
          channel: "test",
        });

        expect(result.mode).toBe("preview_ready");
        expect(result.session.status).toBe("ready_for_review");
        expect(result.draft).toBeDefined();
        expect(result.draft!.validation.ok).toBe(true);
        expect(result.draft!.validation.issues).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ code: "VISUAL_FALLBACK", severity: "warning" }),
            expect.objectContaining({ code: "TESTS_FALLBACK", severity: "warning" }),
          ]),
        );
        const visualNodeIds = new Set(result.draft!.visual.nodes.map((n) => n.nodeId));
        expect(visualNodeIds.has("__trigger__")).toBe(true);
        expect(visualNodeIds.has("send")).toBe(true);
        expect(result.draft!.tests.length).toBeGreaterThanOrEqual(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("submitTurn", () => {
    it("progresses conversation with clarification", async () => {
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      const startResult = await service.startSession({
        goal: "Build a workflow",
        userId: "u-1",
        channel: "test",
      });

      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      const turnResult = await service.submitTurn(startResult.session.sessionId, {
        message: "Use manual trigger",
      });

      expect(turnResult.mode).toBe("clarification_required");
    });

    it("rejects submission to cancelled session", async () => {
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      const startResult = await service.startSession({
        goal: "test",
        userId: "u-1",
        channel: "test",
      });

      await service.cancelSession(startResult.session.sessionId);

      await expect(
        service.submitTurn(startResult.session.sessionId, { message: "hello" }),
      ).rejects.toThrow("Cannot submit turn to session");
    });
  });

  describe("generateDraft", () => {
    it("generates from persisted requirements summary", async () => {
      // Start with clarification (requirements still saved)
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      const startResult = await service.startSession({
        goal: "Build an email workflow",
        userId: "u-1",
        channel: "test",
      });

      // Submit turn (requirements still updated with each analyzer call)
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      await service.submitTurn(startResult.session.sessionId, {
        message: "Use manual trigger",
      });

      // Force generate
      mockFetchForLlm([
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const draft = await service.generateDraft(startResult.session.sessionId);
      expect(draft).toBeDefined();
      expect(draft.spec).toBeDefined();
      expect(draft.visual).toBeDefined();
      expect(draft.tests).toBeDefined();
    });

    it("rejects when no requirements summary available", async () => {
      // Mock analyzer returning null requirements  
      mockFetchForLlm([{
        state: "needs_clarification",
        questions: ["Q1"],
        // No requirements field -> requirementsSummary stays empty
      }]);

      const startResult = await service.startSession({
        goal: "test",
        userId: "u-1",
        channel: "test",
      });

      await expect(
        service.generateDraft(startResult.session.sessionId),
      ).rejects.toThrow("No valid requirements available");
    });
  });

  describe("approveAndSave", () => {
    it("creates workflow + version + publishes via CRUD", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(startResult.session.status).toBe("ready_for_review");

      const approveResult = await service.approveAndSave(startResult.session.sessionId);

      expect(approveResult.workflowId).toBe("wf-1");
      expect(approveResult.workflowVersionId).toBe("wv-1");
      expect(approveResult.versionNumber).toBe(1);
      expect(approveResult.published).toBe(true);
      expect(approveResult.slug).toBeTruthy();

      expect(deps.workflowCrud.createWorkflow).toHaveBeenCalled();
      expect(deps.workflowCrud.createVersion).toHaveBeenCalled();
      expect(deps.workflowCrud.publishVersion).toHaveBeenCalled();
    });

    it("persists an executable compiled graph instead of an empty no-op graph", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      await service.approveAndSave(startResult.session.sessionId);

      const compiledGraph = vi.mocked(deps.workflowCrud.createVersion).mock.calls[0]?.[1] as {
        schemaVersion: string;
        graph: {
          nodes: Array<{ id: string; type: string; config?: Record<string, unknown> }>;
          edges: Array<unknown>;
        };
      };

      expect(compiledGraph.schemaVersion).toBe("2.0");
      expect(compiledGraph.graph.nodes).toHaveLength(2);
      expect(compiledGraph.graph.nodes.map((node) => node.type)).toEqual(["trigger", "action"]);
      expect(compiledGraph.graph.edges).toHaveLength(1);
      expect(compiledGraph.graph.nodes.find((node) => node.id === "send")).toMatchObject({
        type: "action",
        config: {
          skillId: "send-email",
        },
      });
    });

    it("persists approved workflow identity on the saved session", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      await service.approveAndSave(startResult.session.sessionId);

      const sessionData = await service.getSession(startResult.session.sessionId);
      expect(sessionData?.session.status).toBe("saved");
      expect(sessionData?.session.workflowId).toBe("wf-1");
      expect(sessionData?.session.workflowVersionId).toBe("wv-1");
      expect(sessionData?.draft).toBeUndefined();
    });

    it("rejects when not in ready_for_review status", async () => {
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      const startResult = await service.startSession({
        goal: "test",
        userId: "u-1",
        channel: "test",
      });

      await expect(
        service.approveAndSave(startResult.session.sessionId),
      ).rejects.toThrow("Cannot approve session");
    });

    it("updates an existing workflow in place when targetWorkflowId is provided", async () => {
      const existingSpec = {
        ...makeSpecResponse(),
        workflowId: "existing-workflow-spec",
        name: "Existing Workflow",
      };
      const existingVersion = {
        id: "wv-existing-1",
        workflowId: "wf-existing",
        versionNumber: 1,
        checksum: "checksum-existing-1",
        graphJson: {},
        isPublished: true,
        createdAt: NOW,
        updatedAt: NOW,
      };

      vi.mocked(deps.workflowCrud.getWorkflow).mockImplementation((workflowId: string) => {
        if (workflowId !== "wf-existing") {
          return null;
        }
        return {
          id: "wf-existing",
          slug: "existing-workflow",
          name: "Existing Workflow",
          description: "Original description",
          tags: ["existing"],
          latestVersionNumber: 1,
          publishedVersionNumber: 1,
          isArchived: false,
          revision: 7,
          etag: "etag-existing",
          createdAt: NOW,
          updatedAt: NOW,
        };
      });
      vi.mocked(deps.workflowCrud.getPublishedVersion).mockReturnValue(existingVersion);
      vi.mocked(deps.workflowCrud.createVersion).mockReturnValue({
        id: "wv-existing-2",
        workflowId: "wf-existing",
        versionNumber: 2,
        checksum: "checksum-existing-2",
        graphJson: {},
        isPublished: false,
        createdAt: NOW,
        updatedAt: NOW,
      });
      vi.mocked(deps.workflowCrud.publishVersion).mockReturnValue({
        id: "wv-existing-2",
        workflowId: "wf-existing",
        versionNumber: 2,
        checksum: "checksum-existing-2",
        graphJson: {},
        isPublished: true,
        createdAt: NOW,
        updatedAt: NOW,
      });

      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        {
          ...existingSpec,
          description: "Updated description",
          tests: [],
        },
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Update the existing workflow to improve the description.",
        userId: "u-1",
        channel: "test",
        targetWorkflowId: "wf-existing",
      });

      expect(startResult.session.workflowId).toBe("wf-existing");
      expect(startResult.session.workflowVersionId).toBe("wv-existing-1");
      expect(startResult.session.maintenanceTarget?.publishedVersionNumber).toBe(1);

      const approveResult = await service.approveAndSave(startResult.session.sessionId);

      expect(approveResult.workflowId).toBe("wf-existing");
      expect(approveResult.workflowVersionId).toBe("wv-existing-2");
      expect(approveResult.versionNumber).toBe(2);

      expect(deps.workflowCrud.createWorkflow).not.toHaveBeenCalled();
      expect(deps.workflowCrud.updateWorkflow).toHaveBeenCalledWith({
        workflowId: "wf-existing",
        expectedRevision: 7,
        etag: "etag-existing",
        name: "Existing Workflow",
        description: "Updated description",
      });
      expect(deps.workflowCrud.createVersion).toHaveBeenCalled();
      expect(deps.workflowCrud.publishVersion).toHaveBeenCalledWith("wf-existing", 2);
    });
  });

  describe("cancelSession", () => {
    it("transitions to cancelled and cleans draft", async () => {
      mockFetchForLlm([makeRequirementsResponse("needs_clarification")]);
      const startResult = await service.startSession({
        goal: "test",
        userId: "u-1",
        channel: "test",
      });

      await service.cancelSession(startResult.session.sessionId);

      const sessionData = await service.getSession(startResult.session.sessionId);
      expect(sessionData!.session.status).toBe("cancelled");
    });

    it("rejects cancellation of saved session", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      await service.approveAndSave(startResult.session.sessionId);

      await expect(
        service.cancelSession(startResult.session.sessionId),
      ).rejects.toThrow("Cannot cancel a session that is already saved");
    });
  });

  describe("getSession", () => {
    it("returns null for unknown session", async () => {
      const result = await service.getSession("nonexistent");
      expect(result).toBeNull();
    });

    it("returns session with turns and draft", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      const sessionData = await service.getSession(startResult.session.sessionId);
      expect(sessionData).not.toBeNull();
      expect(sessionData!.session.sessionId).toBe(startResult.session.sessionId);
      expect(sessionData!.turns.length).toBeGreaterThanOrEqual(1);
      expect(sessionData!.draft).toBeDefined();
    });
  });

  describe("repair loop", () => {
    it("succeeds on second attempt after initial failure with repairAttempts === 1", async () => {
      let fetchIdx = 0;

      globalThis.fetch = vi.fn(async () => {
        fetchIdx++;

        // Call 1: requirements analyzer -> ready_for_generation
        if (fetchIdx === 1) {
          return {
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(makeRequirementsResponse("ready_for_generation")) } }] }),
            text: async () => "",
          } as unknown as Response;
        }

        // Call 2: first spec attempt -> invalid (startStepId references nonexistent step)
        if (fetchIdx === 2) {
          return {
            ok: true, status: 200,
            json: async () => ({
              choices: [{
                message: { content: JSON.stringify({ ...makeSpecResponse(), startStepId: "nonexistent" }) },
              }],
            }),
            text: async () => "",
          } as unknown as Response;
        }

        // Call 3: first visual (for invalid spec)
        if (fetchIdx === 3) {
          return {
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(makeVisualResponse()) } }] }),
            text: async () => "",
          } as unknown as Response;
        }

        // Call 4: first tests (for invalid spec)
        if (fetchIdx === 4) {
          return {
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(makeTestsResponse()) } }] }),
            text: async () => "",
          } as unknown as Response;
        }

        // Call 5+: repair attempts - valid responses
        const repairResponses = [
          makeSpecResponse(), // valid spec
          makeVisualResponse(),
          makeTestsResponse(),
        ];
        const idx = (fetchIdx - 5) % repairResponses.length;
        const resp = repairResponses[idx] ?? makeSpecResponse();

        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(resp) } }] }),
          text: async () => "",
        } as unknown as Response;
      });

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.session).toBeDefined();
      expect(result.mode).toBe("preview_ready");
      expect(result.draft).toBeDefined();
      expect(result.draft!.validation.repairAttempts).toBe(1);
      expect(result.draft!.validation.repaired).toBe(true);
      expect(result.draft!.validation.ok).toBe(true);
    });

    it("fails after all repair attempts exhausted", async () => {
      let fetchIdx = 0;

      globalThis.fetch = vi.fn(async () => {
        fetchIdx++;

        // Call 1: requirements analyzer -> ready_for_generation
        if (fetchIdx === 1) {
          return {
            ok: true, status: 200,
            json: async () => ({ choices: [{ message: { content: JSON.stringify(makeRequirementsResponse("ready_for_generation")) } }] }),
            text: async () => "",
          } as unknown as Response;
        }

        // All spec calls return invalid spec (startStepId references nonexistent step)
        // This generates spec/visual/tests for each attempt (3 attempts × 3 calls = 9 more)
        const invalidSpec = { ...makeSpecResponse(), startStepId: "nonexistent" };
        const responses = [invalidSpec, makeVisualResponse(), makeTestsResponse()];
        const idx = (fetchIdx - 2) % 3;
        const resp = responses[idx];

        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify(resp) } }] }),
          text: async () => "",
        } as unknown as Response;
      });

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.session).toBeDefined();
      expect(result.mode).toBe("draft_needs_repair");
      expect(result.session.status).toBe("draft_ready_needs_repair");
      expect(result.draft).toBeDefined();
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it("returns retryable_provider_failure when the provider rate-limits requirements analysis", async () => {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "rate limit" } }),
        text: async () => JSON.stringify({ error: { message: "rate limit" } }),
      })) as unknown as typeof fetch;

      const result = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(result.mode).toBe("retryable_provider_failure");
      expect(result.session.status).toBe("retryable_provider_failure");
      expect(result.errors?.[0]?.code).toBe("RETRYABLE_PROVIDER_FAILURE");
    });

    it("keeps a valid draft reviewable when regeneration hits a retryable provider error", async () => {
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(startResult.session.status).toBe("ready_for_review");

      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "rate limit" } }),
        text: async () => JSON.stringify({ error: { message: "rate limit" } }),
      })) as unknown as typeof fetch;

      await expect(
        service.generateDraft(startResult.session.sessionId),
      ).rejects.toThrow("returned 429");

      const sessionData = await service.getSession(startResult.session.sessionId);
      expect(sessionData?.session.status).toBe("ready_for_review");
      expect(sessionData?.draft?.validation.ok).toBe(true);

      await expect(
        service.approveAndSave(startResult.session.sessionId),
      ).resolves.toMatchObject({ published: true });
    });
  });

  describe("approveAndSave with invalid draft", () => {
    it("throws when draft has validation.ok === false", async () => {
      // First, generate a session with a valid draft
      mockFetchForLlm([
        makeRequirementsResponse("ready_for_generation"),
        makeSpecResponse(),
        makeVisualResponse(),
        makeTestsResponse(),
      ]);

      const startResult = await service.startSession({
        goal: "Send emails",
        userId: "u-1",
        channel: "test",
      });

      expect(startResult.session.status).toBe("ready_for_review");

      // Tamper with the persisted draft to set validation.ok = false
      // We do this by saving a new draft with ok: false directly via the DB mock
      const sessionId = startResult.session.sessionId;
      const draft = startResult.draft!;
      const invalidDraft = {
        ...draft,
        validation: { ...draft.validation, ok: false, issues: [{ code: "TEST_ERROR", stage: "spec" as const, severity: "error" as const, message: "forced error" }] },
      };

      // Persist the invalid draft by writing directly
      deps.db.withWriteTransaction((writer) => {
        writer
          .prepare(
            `INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(namespace, key) DO UPDATE SET
               value_json = excluded.value_json,
               tags_json = excluded.tags_json,
               updated_at = excluded.updated_at`,
          )
          .run(
            deps.idGenerator(),
            "workflow-generator-draft",
            sessionId,
            JSON.stringify(invalidDraft),
            JSON.stringify(["draft"]),
            NOW,
            NOW,
          );
      });

      await expect(
        service.approveAndSave(sessionId),
      ).rejects.toThrow("Cannot approve a draft with validation errors");
    });
  });
});
