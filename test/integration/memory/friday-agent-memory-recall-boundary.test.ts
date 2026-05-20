import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFridayAgentMemoryTools } from "#agent";
import {
  createFridayMemoryGuardServiceFactory,
  createFridayMemoryService,
} from "#memory";
import type { FridaySqliteLayer } from "#state";
import type { FridayProviderService } from "#providers";
import { attachFridayAgentToolExecutionContext } from "../../../src/agent/runtime/friday-agent-tool-execution-context.js";
import { createTestDb, createTestIdGenerator } from "../../helpers/friday-test-db.helper.js";

function createMockProviderService(): FridayProviderService {
  return {
    listProviders: vi.fn(),
    getProvider: vi.fn(),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    validateProvider: vi.fn(),
    getRoutingConfig: vi.fn(),
    setRoutingConfig: vi.fn(),
    resolveRoute: vi.fn(),
    runWithFallback: vi.fn().mockImplementation(async (params) => {
      const route = {
        provider: {
          id: "prov-1",
          kind: "openai" as const,
          name: "OpenAI",
          baseUrl: "https://api.openai.com",
          enabled: true,
          config: {
            api: "openai-completions" as const,
            authMode: "api-key" as const,
            keySource: { kind: "none" as const },
            supportedModels: ["text-embedding-3-small"],
          },
          createdAt: "2026-05-20T18:00:00.000Z",
          updatedAt: "2026-05-20T18:00:00.000Z",
        },
        model: "text-embedding-3-small",
      };
      const result = await params.run(route, "sk-test-key");
      return {
        result,
        route,
        attempts: [],
        routingDecision: {
          strategy: "direct" as const,
          reason: "test",
          budget: { withinBudget: true, remainingUsd: 100, monthlyLimitUsd: 100, spentUsd: 0 },
        },
      };
    }),
    recordUsage: vi.fn(),
    getUsageSummary: vi.fn(),
    getBudgetStatus: vi.fn(),
    setBudgetConfig: vi.fn(),
  } as unknown as FridayProviderService;
}

function signalWithAdminTenant(): AbortSignal {
  return attachFridayAgentToolExecutionContext(new AbortController().signal, {
    runId: "run-1",
    sessionKey: "agent:run:run-1",
    readOnly: true,
    principalId: "admin-001",
    tenantContext: {
      hubId: "admin-001",
      userId: "admin-001",
    },
  });
}

describe("Friday agent memory recall boundary", () => {
  let db: FridaySqliteLayer;
  const originalFetch = globalThis.fetch;
  const nowIso = () => "2026-05-20T18:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
            model: "text-embedding-3-small",
          }),
          { status: 200 },
        ),
      ),
    ) as typeof fetch;
  });

  afterEach(() => {
    db.close();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("recalls current-principal API memory through the agent memory_search tool", async () => {
    const memoryService = createFridayMemoryService({
      db,
      providerService: createMockProviderService(),
      idGenerator: createTestIdGenerator(),
      nowIso,
    });
    const memoryGuardFactory = createFridayMemoryGuardServiceFactory({
      core: memoryService,
      db,
      nowIso,
      nowMs: () => Date.parse(nowIso()),
    });

    await memoryGuardFactory.forContext({
      principalId: "admin-001",
      subject: {
        hubId: "admin-001",
        userId: "admin-001",
        accessLevel: "tenant",
      },
    }).store(
      "five-scenario-proof",
      "For this proof run, the user's preferred project codename is BARB-phase-22d-real.",
      {
        source: "five-scenario-real-proof",
        tags: ["five-scenario", "preference"],
      },
    );

    const [searchTool] = createFridayAgentMemoryTools({
      memoryService,
      memoryGuardFactory,
    });
    const result = await searchTool!.execute(
      { query: "proof run project codename", limit: 3 },
      signalWithAdminTenant(),
    );

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject([
      {
        content: "For this proof run, the user's preferred project codename is BARB-phase-22d-real.",
        metadata: {
          namespace: "tenant.admin-001.user.admin-001.five-scenario-proof",
          source: "five-scenario-real-proof",
        },
      },
    ]);
  });
});
