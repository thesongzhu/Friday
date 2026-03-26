import { describe, it, expect, vi, beforeEach } from "vitest";

import { createFridaySkillGeneratorService } from "#skills/generator";
import type { CreateFridaySkillGeneratorServiceDeps } from "#skills/generator";
import type { FridayProviderService } from "#providers";
import type { FridaySkillRegistry } from "#skills";
import type { FridayHubConfigManagerService } from "#hub";
import type { FridayHubMemoryStateService } from "#hub";
import type { FridaySqliteLayer } from "#state";
import type { SkillManifestV2 } from "#skills";
import type { FridaySkillUiSchemaV1 } from "#skills/generator";
import type { FridayGeneratedSkillFile } from "#skills/generator";

const NOW = "2026-02-17T10:00:00.000Z";

// ─── Minimal valid manifest for tests ───

function makeManifest(overrides?: Partial<SkillManifestV2>): SkillManifestV2 {
  return {
    schemaVersion: "2.0",
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    kind: "conversation",
    category: "utility",
    author: { name: "Test" },
    tags: [],
    runtime: {
      kind: "node",
      entrypoint: "index.mjs",
      minHubVersion: "0.1.0",
      apiVersion: "1",
      timeoutMsDefault: 30000,
    },
    triggers: { intents: ["test"], phrases: ["run test"], channels: [] },
    invocation: { userInvocable: true, modelInvocable: true, priority: 50, modes: ["intent"] },
    requirements: { bins: [], env: [], config: [], os: ["darwin", "linux"] },
    inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
    outputs: [{ key: "result", type: "string", description: "Result" }],
    permissions: { grants: [], promptOn: [] },
    executionTargets: { allowedSatelliteTypes: [], requiredCapabilities: [] },
    ...overrides,
  };
}

function makeUiSchema(): FridaySkillUiSchemaV1 {
  return {
    schemaVersion: "1.0",
    title: "Test Skill",
    sections: [{ id: "main", label: "Main", fieldIds: ["query-field"] }],
    fields: [
      { id: "query-field", inputKey: "query", kind: "text", label: "Query", required: true },
    ],
    outputs: [{ id: "result-output", outputKey: "result", label: "Result", widget: "text" }],
    actions: [
      { id: "run", label: "Run", style: "primary" },
      { id: "reset", label: "Reset", style: "secondary" },
    ],
  };
}

function makeCodeFiles(): FridayGeneratedSkillFile[] {
  return [
    {
      path: "index.mjs",
      language: "javascript",
      content: 'export async function execute(input) { return { result: input.query }; }',
    },
  ];
}

// ─── Mock factories ───

function makeMockDb(options?: {
  onUpsert?: (input: {
    namespace: string;
    key: string;
    store: Map<string, {
      id: string;
      namespace: string;
      key: string;
      value_json: string;
      tags_json: string;
      created_at: string;
      updated_at: string;
    }>;
  }) => void;
}): FridaySqliteLayer {
  // In-memory store keyed by "namespace:key"
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
              (
                id: string,
                namespace: string,
                key: string,
                valueJson: string,
                tagsJson: string,
                createdAt: string,
                updatedAt: string,
              ) => {
                const storeKey = `${namespace}:${key}`;
                const existing = store.get(storeKey);
                store.set(storeKey, {
                  id: existing ? existing.id : id,
                  namespace,
                  key,
                  value_json: valueJson,
                  tags_json: tagsJson,
                  created_at: existing ? existing.created_at : createdAt,
                  updated_at: updatedAt,
                });
                options?.onUpsert?.({ namespace, key, store });
              },
            ),
          };
        }
        if (
          sql.startsWith("SELECT * FROM memory_items WHERE namespace = ? AND key = ?")
          || sql.startsWith("SELECT value_json FROM memory_items WHERE namespace = ? AND key = ?")
        ) {
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
              for (const [storeKey, row] of store.entries()) {
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
        // Fallback
        return {
          run: vi.fn(),
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        };
      }),
    };
  }

  const db = makeDb();

  return {
    withReadConnection: vi.fn((fn: (db: unknown) => unknown) => fn(db)),
    withWriteTransaction: vi.fn((fn: (db: unknown) => void) => fn(db)),
  } as unknown as FridaySqliteLayer;
}

let inferCallCount: number;
let inferResponses: unknown[];

function makeMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(async () => []),
    getProvider: vi.fn(async () => null),
    createProvider: vi.fn(async () => ({} as never)),
    updateProvider: vi.fn(async () => ({} as never)),
    deleteProvider: vi.fn(async () => undefined),
    validateProvider: vi.fn(async () => ({ status: "ok" as const, checkedAt: NOW })),
    getRoutingConfig: vi.fn(async () => ({
      defaultProviderId: "p-1",
      fallbackProviderIds: [],
    })),
    setRoutingConfig: vi.fn(async (input) => input),
    resolveRoute: vi.fn(async () => ({
      provider: { id: "p-1", kind: "openai" as const, name: "OpenAI", baseUrl: "https://api.openai.com", enabled: true, config: { api: "openai-completions" as const, authMode: "api-key" as const, keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" }, supportedModels: ["gpt-4o"], validation: { status: "ok" as const, checkedAt: NOW } }, createdAt: NOW, updatedAt: NOW },
      model: "gpt-4o",
    })),
    runWithFallback: vi.fn(async ({ run }) => {
      const route = {
        provider: { id: "p-1", kind: "openai" as const, name: "OpenAI", baseUrl: "https://api.openai.com", enabled: true, config: { api: "openai-completions" as const, authMode: "api-key" as const, keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" }, supportedModels: ["gpt-4o"], validation: { status: "ok" as const, checkedAt: NOW } }, createdAt: NOW, updatedAt: NOW },
        model: "gpt-4o",
      };
      const result = await run(route, "sk-test-key");
      return { result, route, attempts: [] };
    }),
  };
}

function makeMockRegistry(): FridaySkillRegistry {
  return {
    list: vi.fn(() => []),
    get: vi.fn(() => null),
    resolveByIntent: vi.fn(() => null),
    validateAll: vi.fn(() => []),
    reload: vi.fn(async () => undefined),
    refresh: vi.fn(async () => undefined),
    isCompatible: vi.fn(() => ({ compatible: true, reasons: [] })),
    startWatching: vi.fn(async () => undefined),
    stopWatching: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function makeMockConfigManager(): FridayHubConfigManagerService {
  return {
    getCurrentConfig: vi.fn(async () => ({} as never)),
    getConfig: vi.fn(async () => ({ revision: 1, settings: {} })),
    validatePatch: vi.fn(async () => ({ valid: true, errors: [] })),
    applyPatch: vi.fn(async () => ({ revision: 1, changedKeys: [] })),
    listRevisions: vi.fn(async () => ({ items: [] })),
    revertToRevision: vi.fn(async () => ({ revision: 1, changedKeys: [], revertedFrom: 1 })),
    getSkillRegistrySettings: vi.fn(async () => ({
      workspaceDir: "/tmp/test",
      bundledSkillsDir: "/tmp/test/skills",
      managedSkillsDir: "/tmp/test/managed-skills",
      extraSkillDirs: [],
      watchEnabled: false,
      watchDebounceMs: 300,
    })),
    getSkillSecurityProfile: vi.fn(async () => ({})),
  };
}

function makeMockMemoryState(): FridayHubMemoryStateService {
  return {
    listSkillStatuses: vi.fn(async () => ({})),
    upsertDiscoveredSkills: vi.fn(async () => undefined),
    updateSkillStatus: vi.fn(async () => undefined),
    appendAuditLog: vi.fn(async () => undefined),
    getSession: vi.fn(async () => null),
    appendSessionMessage: vi.fn(async (input) => ({
      ...input,
      id: "msg-1",
      sequence: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    getMemoryItems: vi.fn(async () => []),
    putMemoryItem: vi.fn(async () => undefined),
  };
}

// ─── We need to mock the inference client since we can't call real providers ───
// The service creates the client internally via createFridayProviderInferenceClient.
// We mock the providerService.runWithFallback to control LLM outputs.

function setupInferMock(providerService: FridayProviderService, responses: unknown[]): void {
  inferCallCount = 0;
  inferResponses = responses;

  const runWithFallback = providerService.runWithFallback as ReturnType<typeof vi.fn>;
  runWithFallback.mockImplementation(async ({ run }: { run: (route: unknown, credential: string | null) => Promise<unknown> }) => {
    const route = {
      provider: { id: "p-1", kind: "openai", name: "OpenAI", baseUrl: "https://api.openai.com", enabled: true, config: { api: "openai-completions", authMode: "api-key", keySource: { kind: "env-ref", envVar: "OPENAI_API_KEY" }, supportedModels: ["gpt-4o"], validation: { status: "ok", checkedAt: NOW } }, createdAt: NOW, updatedAt: NOW },
      model: "gpt-4o",
    };
    const currentResponse = inferResponses[inferCallCount] ?? inferResponses[inferResponses.length - 1];
    inferCallCount++;

    // The inference client calls run() which calls fetch internally.
    // We need to mock at the fetch level. Instead, let's mock the entire
    // runWithFallback chain to return what the inference client expects.
    // The inference client builds a fetch call. We need to intercept globally.
    throw new Error("Should not reach real provider — use fetch mock");
  });
}

// ─── Tests ───

describe("FridaySkillGeneratorService", () => {
  let service: ReturnType<typeof createFridaySkillGeneratorService>;
  let deps: CreateFridaySkillGeneratorServiceDeps;
  let idCounter: number;

  // We mock global fetch to intercept LLM calls
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    idCounter = 0;
    deps = {
      db: makeMockDb(),
      providerService: makeMockProviderService(),
      registry: makeMockRegistry(),
      configManager: makeMockConfigManager(),
      memoryStateService: makeMockMemoryState(),
      idGenerator: () => `id-${++idCounter}`,
      nowIso: () => NOW,
    };
    service = createFridaySkillGeneratorService(deps);
  });

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

  function restoreFetch(): void {
    globalThis.fetch = originalFetch;
  }

  describe("startSession", () => {
    it("creates a session and returns clarification when needed", async () => {
      const analyzerResponse = {
        state: "needs_clarification",
        questions: ["What format should the output be?", "How long should the timer run?"],
        spec: { goal: "Build a timer" },
      };

      mockFetchForLlm([analyzerResponse]);

      try {
        const result = await service.startSession({
          goal: "Build a timer skill",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.session.sessionId).toBe("id-1");
        expect(result.session.goal).toBe("Build a timer skill");
        expect(result.mode).toBe("clarification_required");
        expect(result.questions).toHaveLength(2);
        expect(result.session.status).toBe("needs_clarification");
      } finally {
        restoreFetch();
      }
    });

    it("creates session and triggers generation when ready", async () => {
      const analyzerResponse = {
        state: "ready_for_generation",
        questions: [],
        spec: {
          goal: "Simple echo",
          inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "node",
        },
      };
      const manifest = makeManifest();
      const files = makeCodeFiles();
      const uiSchema = makeUiSchema();

      // Responses: 1) analyzer, 2) manifest, 3) code, 4) ui
      mockFetchForLlm([analyzerResponse, manifest, files, uiSchema]);

      try {
        const result = await service.startSession({
          goal: "Simple echo skill",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.session.sessionId).toBe("id-1");
        expect(result.mode).toBe("preview_ready");
        expect(result.draft).toBeDefined();
        expect(result.draft?.manifest.id).toBe("test-skill");
        expect(result.draft?.validation.ok).toBe(true);
      } finally {
        restoreFetch();
      }
    });

    it("accepts object-wrapped generated code bundles", async () => {
      const analyzerResponse = {
        state: "ready_for_generation",
        questions: [],
        spec: {
          goal: "Simple echo",
          inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "node",
        },
      };
      const manifest = makeManifest();
      const wrappedFiles = { files: makeCodeFiles() };
      const uiSchema = makeUiSchema();

      // Responses: 1) analyzer, 2) manifest, 3) wrapped code bundle, 4) ui
      mockFetchForLlm([analyzerResponse, manifest, wrappedFiles, uiSchema]);

      try {
        const result = await service.startSession({
          goal: "Simple echo skill",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.mode).toBe("preview_ready");
        expect(result.draft).toBeDefined();
        expect(result.draft?.files).toHaveLength(1);
        expect(result.draft?.files[0]?.path).toBe("index.mjs");
      } finally {
        restoreFetch();
      }
    });

    it("normalizes manifest enum aliases before validation", async () => {
      const analyzerResponse = {
        state: "ready_for_generation",
        questions: [],
        spec: {
          goal: "Get current date",
          inputs: [],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "shell",
        },
      };
      const manifestWithAliases = {
        schemaVersion: "2.0",
        id: "enum-alias-skill",
        name: "Enum Alias Skill",
        description: "Tests manifest alias normalization",
        version: "1.0.0",
        kind: "tool",
        category: "general",
        author: { name: "Test" },
        tags: [],
        runtime: {
          kind: "javascript",
          entrypoint: "main.js",
          minHubVersion: "",
          apiVersion: "1",
          timeoutMsDefault: 30000,
        },
        triggers: { intents: [], phrases: [], channels: [] },
        invocation: {
          userInvocable: true,
          modelInvocable: true,
          priority: 50,
          modes: ["intent"],
        },
        requirements: { bins: [], env: [], config: [], os: ["macos"] },
        inputs: [],
        outputs: [{ key: "result", type: "string", description: "Result" }],
        permissions: { grants: [], promptOn: [] },
        executionTargets: {
          allowedSatelliteTypes: ["macos", "cloud"],
          requiredCapabilities: ["", "web.search"],
        },
      };
      const files = makeCodeFiles();
      const uiSchema = {
        ...makeUiSchema(),
        sections: [],
        fields: [],
      };

      mockFetchForLlm([analyzerResponse, manifestWithAliases, files, uiSchema]);

      try {
        const result = await service.startSession({
          goal: "Normalize enum aliases",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.mode).toBe("preview_ready");
        expect(result.draft).toBeDefined();
        expect(result.draft!.manifest.kind).toBe("conversation");
        expect(result.draft!.manifest.category).toBe("utility");
        expect(result.draft!.manifest.runtime.kind).toBe("node");
        expect(result.draft!.manifest.runtime.entrypoint).toBe("index.mjs");
        expect(result.draft!.manifest.requirements.os).toEqual(["darwin"]);
        expect(result.draft!.manifest.executionTargets.allowedSatelliteTypes).toEqual([
          "desktop",
          "cloud-vm",
        ]);
        expect(result.draft!.manifest.executionTargets.requiredCapabilities).toEqual([
          "web.search",
        ]);
      } finally {
        restoreFetch();
      }
    });

    it("falls back to generated UI schema when model returns malformed UI", async () => {
      const analyzerResponse = {
        state: "ready_for_generation",
        questions: [],
        spec: {
          goal: "Simple echo",
          inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "node",
        },
      };
      const manifest = makeManifest();
      const files = makeCodeFiles();
      const malformedUi = { message: "not a schema" };

      mockFetchForLlm([analyzerResponse, manifest, files, malformedUi]);

      try {
        const result = await service.startSession({
          goal: "Simple echo skill",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.mode).toBe("preview_ready");
        expect(result.draft).toBeDefined();
        expect(result.draft!.uiSchema.schemaVersion).toBe("1.0");
        expect(result.draft!.uiSchema.actions.map((a) => a.id)).toEqual(["run", "reset"]);
      } finally {
        restoreFetch();
      }
    });

    it("returns generation_failed when LLM throws", async () => {
      const analyzerResponse = {
        state: "ready_for_generation",
        questions: [],
        spec: { goal: "A skill" },
      };

      let callIdx = 0;
      globalThis.fetch = vi.fn(async () => {
        callIdx++;
        if (callIdx === 1) {
          // First call: analyzer succeeds
          return {
            ok: true,
            status: 200,
            json: async () => ({
              choices: [{ message: { content: JSON.stringify(analyzerResponse) } }],
            }),
            text: async () => "",
          } as Response;
        }
        // Subsequent calls fail
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Server error" }),
          text: async () => "Server error",
        } as Response;
      });

      try {
        const result = await service.startSession({
          goal: "A failing skill",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.mode).toBe("generation_failed");
        expect(result.errors).toBeDefined();
        expect(result.errors!.length).toBeGreaterThan(0);
        expect(result.session.status).toBe("failed");
      } finally {
        restoreFetch();
      }
    });

    it("self-heals if the persisted session row disappears before the final status update", async () => {
      const analyzerResponse = {
        state: "ready_for_generation",
        questions: [],
        spec: {
          goal: "Simple echo",
          inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "node",
        },
      };
      const manifest = makeManifest();
      const files = makeCodeFiles();
      const uiSchema = makeUiSchema();
      let droppedOnce = false;

      deps = {
        ...deps,
        db: makeMockDb({
          onUpsert: ({ namespace, key, store }) => {
            if (namespace === "skill-generator-draft" && !droppedOnce) {
              store.delete(`skill-generator-session:${key}`);
              droppedOnce = true;
            }
          },
        }),
      };
      service = createFridaySkillGeneratorService(deps);
      mockFetchForLlm([analyzerResponse, manifest, files, uiSchema]);

      try {
        const result = await service.startSession({
          goal: "Simple echo skill",
          userId: "user-1",
          channel: "discord",
        });

        expect(result.mode).toBe("preview_ready");
        const sessionData = await service.getSession(result.session.sessionId);
        expect(sessionData?.session.status).toBe("ready_for_review");
      } finally {
        restoreFetch();
      }
    });
  });

  describe("submitTurn", () => {
    it("adds a user turn and continues clarification", async () => {
      // First start a session
      const startAnalyzer = {
        state: "needs_clarification",
        questions: ["What format?"],
        spec: { goal: "Timer" },
      };
      const continueAnalyzer = {
        state: "needs_clarification",
        questions: ["How long should it run?"],
        spec: { goal: "Timer", format: "json" },
      };

      mockFetchForLlm([startAnalyzer, continueAnalyzer]);

      try {
        const startResult = await service.startSession({
          goal: "Build a timer",
          userId: "user-1",
          channel: "discord",
        });

        expect(startResult.mode).toBe("clarification_required");

        const turnResult = await service.submitTurn(startResult.session.sessionId, {
          message: "JSON format please",
        });

        expect(turnResult.mode).toBe("clarification_required");
        expect(turnResult.questions).toContain("How long should it run?");
      } finally {
        restoreFetch();
      }
    });

    it("throws when session is cancelled", async () => {
      const startAnalyzer = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: {},
      };
      mockFetchForLlm([startAnalyzer]);

      try {
        const startResult = await service.startSession({
          goal: "Build a timer",
          userId: "user-1",
          channel: "discord",
        });

        await service.cancelSession(startResult.session.sessionId);

        await expect(
          service.submitTurn(startResult.session.sessionId, { message: "hello" }),
        ).rejects.toThrow("Cannot submit turn to session in 'cancelled' status");
      } finally {
        restoreFetch();
      }
    });
  });

  describe("getSession", () => {
    it("returns null for non-existent session", async () => {
      const result = await service.getSession("non-existent");
      expect(result).toBeNull();
    });

    it("returns session with turns after startSession", async () => {
      const analyzerResponse = {
        state: "needs_clarification",
        questions: ["What format?"],
        spec: {},
      };
      mockFetchForLlm([analyzerResponse]);

      try {
        const startResult = await service.startSession({
          goal: "Build something",
          userId: "user-1",
          channel: "discord",
        });

        const sessionData = await service.getSession(startResult.session.sessionId);
        expect(sessionData).not.toBeNull();
        expect(sessionData!.session.sessionId).toBe(startResult.session.sessionId);
        expect(sessionData!.turns.length).toBeGreaterThanOrEqual(1);
      } finally {
        restoreFetch();
      }
    });
  });

  describe("generateDraft", () => {
    it("generates a draft from existing spec", async () => {
      // Start session first
      const startAnalyzer = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: {
          goal: "Echo",
          inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "node",
        },
      };
      const manifest = makeManifest();
      const files = makeCodeFiles();
      const uiSchema = makeUiSchema();

      mockFetchForLlm([startAnalyzer, manifest, files, uiSchema]);

      try {
        const startResult = await service.startSession({
          goal: "Echo skill",
          userId: "user-1",
          channel: "discord",
        });

        const draft = await service.generateDraft(startResult.session.sessionId);
        expect(draft).toBeDefined();
        expect(draft.manifest.id).toBe("test-skill");
        expect(draft.validation.ok).toBe(true);
        expect(draft.manifest.tags).toEqual(
          expect.arrayContaining(["generated", "generated.draft"]),
        );
      } finally {
        restoreFetch();
      }
    });

    it("throws when session has no spec", async () => {
      // Create a session with empty specSummary
      const startAnalyzer = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: null,
      };
      mockFetchForLlm([startAnalyzer]);

      try {
        const startResult = await service.startSession({
          goal: "Something vague",
          userId: "user-1",
          channel: "discord",
        });

        await expect(
          service.generateDraft(startResult.session.sessionId),
        ).rejects.toThrow("No valid specification available");
      } finally {
        restoreFetch();
      }
    });
  });

  describe("generateDraft — all attempts fail", () => {
    it("throws FridayDomainError with GENERATION_FAILED and 422, not TypeError/500", async () => {
      // Start session with analyzer that says "ready"
      const analyzerResponse = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: {
          goal: "A skill",
          inputs: [{ key: "q", type: "string", required: true, label: "Q" }],
          outputs: [{ key: "r", type: "string", description: "R" }],
          runtimeKind: "node",
        },
      };

      mockFetchForLlm([analyzerResponse]);

      let sessionId: string;
      try {
        const startResult = await service.startSession({
          goal: "Failing skill",
          userId: "user-1",
          channel: "discord",
        });
        sessionId = startResult.session.sessionId;
      } finally {
        restoreFetch();
      }

      // Now mock fetch to always fail for generateDraft
      globalThis.fetch = vi.fn(async () => {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "LLM unavailable" }),
          text: async () => "LLM unavailable",
        } as Response;
      });

      try {
        await expect(
          service.generateDraft(sessionId),
        ).rejects.toSatisfy((err: unknown) => {
          expect(err).toBeInstanceOf(Error);
          const domainErr = err as Error & { code?: string; httpStatus?: number };
          // Must NOT be a TypeError (the old 500 bug)
          expect(domainErr).not.toBeInstanceOf(TypeError);
          // Must be a FridayDomainError with the right code and status
          expect(domainErr.code).toBe("GENERATION_FAILED");
          expect(domainErr.httpStatus).toBe(422);
          return true;
        });
      } finally {
        restoreFetch();
      }
    });
  });

  describe("cancelSession", () => {
    it("cancels a session", async () => {
      const analyzerResponse = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: {},
      };
      mockFetchForLlm([analyzerResponse]);

      try {
        const startResult = await service.startSession({
          goal: "Build something",
          userId: "user-1",
          channel: "discord",
        });

        await service.cancelSession(startResult.session.sessionId);

        const sessionData = await service.getSession(startResult.session.sessionId);
        expect(sessionData!.session.status).toBe("cancelled");
      } finally {
        restoreFetch();
      }
    });

    it("throws when cancelling a non-existent session", async () => {
      await expect(service.cancelSession("non-existent")).rejects.toThrow(
        "Generation session not found",
      );
    });
  });

  describe("approveAndSave", () => {
    it("throws when session is not in ready_for_review status", async () => {
      const analyzerResponse = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: {},
      };
      mockFetchForLlm([analyzerResponse]);

      try {
        const startResult = await service.startSession({
          goal: "Build something",
          userId: "user-1",
          channel: "discord",
        });

        await expect(
          service.approveAndSave(startResult.session.sessionId),
        ).rejects.toThrow("Cannot approve session in 'needs_clarification' status");
      } finally {
        restoreFetch();
      }
    });

    it("promotes generated drafts to stabilized manifests with evidence", async () => {
      const analyzerResponse = {
        state: "needs_clarification",
        questions: ["What?"],
        spec: {
          goal: "Echo",
          inputs: [{ key: "query", type: "string", required: true, label: "Query" }],
          outputs: [{ key: "result", type: "string", description: "Result" }],
          runtimeKind: "shell",
        },
      };
      const manifest = makeManifest({
        runtime: {
          kind: "shell",
          entrypoint: "run.sh",
          minHubVersion: "0.1.0",
          apiVersion: "1",
          timeoutMsDefault: 30000,
        },
      });
      const files: FridayGeneratedSkillFile[] = [
        {
          path: "run.sh",
          language: "bash",
          executable: true,
          content: "#!/usr/bin/env bash\ncat <<'EOF'\n{\"result\":\"ok\"}\nEOF\n",
        },
      ];
      const uiSchema = makeUiSchema();

      mockFetchForLlm([analyzerResponse, manifest, files, uiSchema]);

      try {
        const startResult = await service.startSession({
          goal: "Echo shell skill",
          userId: "user-1",
          channel: "discord",
        });

        await service.generateDraft(startResult.session.sessionId);
        const result = await service.approveAndSave(startResult.session.sessionId);

        expect(result.promotionStage).toBe("stabilized");
        expect(result.promotedManifestTags).toEqual(
          expect.arrayContaining(["generated", "skill.stabilized", "cli-backed"]),
        );
        expect(result.promotedManifestTags).not.toContain("generated.draft");
        expect(result.evidence).toEqual({
          packageLoaded: true,
          packageValidated: true,
          registryRefreshed: true,
        });
      } finally {
        restoreFetch();
      }
    });
  });
});
