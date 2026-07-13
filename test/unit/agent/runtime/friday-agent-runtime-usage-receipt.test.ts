import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import type { FridaySqliteLayer } from "#state";
import {
  createFridayAgentRuntime,
  createFridayAgentEventEmitter,
} from "#agent";
import type {
  CreateFridayAgentRuntimeDeps,
  FridayAgentLlmClient,
  FridayAgentLlmStreamEvent,
} from "#agent";
import {
  createFridayProviderService,
  resetMasterKeyCache,
} from "#providers";
import type { FridayProviderService, FridayProviderApi } from "#providers";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";

// ─────────────────────────────────────────────────────────────────────────────
// BYOK-PROVIDER-COST-RECEIPT — agent-runtime request-id + receipt coverage.
//
// The generator inference-client path already binds a provider request-id +
// receipt to its usage writes. Agent turns did NOT: both usageRecorder callbacks
// in the hub called recordUsage() with no request-id, so every agent turn was
// persisted with a NULL request_id and no receipt (non-idempotent, unverifiable).
//
// These tests drive the REAL agent-runtime usage-emission path — streamLlmResponse
// consumes a SIMULATED provider response (a fake llmClient whose message_end
// carries a synthetic request-id, exactly as the real HTTP client now surfaces it
// from the response's request-id header) → turnMeta → the runtime's usageRecorder
// → the REAL provider service.recordUsage → REAL sqlite (v102 migration applied).
// The receipt is then read back through the REAL service.getCallReceipt. No mock
// stands in for the recording/receipt mechanism. The only simulated part is the
// upstream provider HTTP response, which must never be a real provider call.
// ─────────────────────────────────────────────────────────────────────────────

describe("Agent-runtime usage: provider request-id + receipt coverage", () => {
  const NOW = "2026-02-20T10:00:00.000Z";
  const TEST_MASTER_KEY = Buffer.alloc(32, 17).toString("hex");

  let db: FridaySqliteLayer;
  let service: FridayProviderService;
  let idGenerator: () => string;
  let originalMasterKey: string | undefined;

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
    originalMasterKey = process.env.FRIDAY_MASTER_KEY;
    process.env.FRIDAY_MASTER_KEY = TEST_MASTER_KEY;
    resetMasterKeyCache();
    service = createFridayProviderService({ db, idGenerator, nowIso: () => NOW });
  });

  afterEach(() => {
    db.close();
    if (originalMasterKey === undefined) delete process.env.FRIDAY_MASTER_KEY;
    else process.env.FRIDAY_MASTER_KEY = originalMasterKey;
    resetMasterKeyCache();
    vi.restoreAllMocks();
  });

  async function createProvider(): Promise<string> {
    const profile = await service.createProvider({
      kind: "openai",
      name: "OpenAI",
      baseUrl: "https://api.openai.com",
      authMode: "api-key",
      api: "openai-completions",
      apiKey: "test-agent-receipt-key", // pragma: allowlist secret
      supportedModels: ["gpt-4o"],
      defaultModel: "gpt-4o",
      validateOnSave: false,
    });
    return profile.id;
  }

  // A usageRecorder that mirrors the hub bootstrap callbacks 1:1 (source
  // "agent-runtime", request-id threaded through). This is the exact seam the
  // production hub wires between the agent runtime and the provider service.
  function makeUsageRecorder(
    providerApi: FridayProviderApi,
  ): NonNullable<CreateFridayAgentRuntimeDeps["usageRecorder"]> {
    return async (usage) => {
      await service.recordUsage({
        providerId: usage.providerId,
        providerApi: (usage.providerApi as FridayProviderApi) ?? providerApi,
        model: usage.model,
        routeStrategy: "configured",
        taskComplexity: "medium",
        usage: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadInputTokens ?? 0,
          cacheWrite: usage.cacheCreationInputTokens ?? 0,
          total: usage.inputTokens + usage.outputTokens,
        },
        costUsd: usage.costUsd ?? 0,
        requestId: usage.requestId,
        metadata: { source: "agent-runtime" },
      });
    };
  }

  function mockLlmClient(events: FridayAgentLlmStreamEvent[]): FridayAgentLlmClient {
    return {
      async *stream() {
        for (const event of events) yield event;
      },
    };
  }

  function runtimeFor(
    providerId: string,
    events: FridayAgentLlmStreamEvent[],
  ) {
    return createFridayAgentRuntime({
      allowTestOnlyAgentRunExecution: true,
      db,
      llmClient: mockLlmClient(events),
      model: "gpt-4o",
      providerId,
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      usageRecorder: makeUsageRecorder("openai-completions"),
    });
  }

  function countRows(requestId: string): number {
    return db.withReadConnection((conn) =>
      (conn.prepare(
        "SELECT COUNT(*) AS n FROM llm_usage_records WHERE request_id = ?",
      ).get(requestId) as { n: number }).n,
    );
  }

  it("binds the provider request-id + a valid receipt to an agent turn", async () => {
    const providerId = await createProvider();
    const requestId = "chatcmpl-AGENT-RECEIPT-001";

    const runtime = runtimeFor(providerId, [
      { type: "text_delta", text: "done" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 1000,
        outputTokens: 500,
        actualProviderId: providerId,
        actualModel: "gpt-4o",
        actualProviderApi: "openai-completions",
        costUsd: 0.05,
        requestId,
      },
    ]);

    const result = await runtime.executeRun({ task: "agent receipt turn" });
    expect(result.status).toBe("completed");

    // Row persisted keyed by the provider's own request-id (was NULL pre-lane).
    expect(countRows(requestId)).toBe(1);

    // Receipt reads back through the REAL service and verifies (tamper-free).
    const lookup = await service.getCallReceipt(requestId);
    expect(lookup).not.toBeNull();
    expect(lookup?.receiptValid).toBe(true);
    expect(lookup?.receipt.requestId).toBe(requestId);
    expect(lookup?.receipt.providerKind).toBe("openai");
    expect(lookup?.receipt.model).toBe("gpt-4o");
    expect(lookup?.receipt.inputTokens).toBe(1000);
    expect(lookup?.receipt.outputTokens).toBe(500);
    expect(lookup?.receipt.costUsd).toBeCloseTo(0.05, 6);
  });

  it("is idempotent on the request-id — the same agent turn twice is ONE row / ONE charge", async () => {
    const providerId = await createProvider();
    const requestId = "chatcmpl-AGENT-RECEIPT-DUP";

    const events: FridayAgentLlmStreamEvent[] = [
      { type: "text_delta", text: "done" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 200,
        outputTokens: 80,
        actualProviderId: providerId,
        actualModel: "gpt-4o",
        actualProviderApi: "openai-completions",
        costUsd: 0.01,
        requestId,
      },
    ];

    // Two independent runs surface the SAME provider request-id (retry / replay).
    await runtimeFor(providerId, events).executeRun({ task: "turn A" });
    await runtimeFor(providerId, events).executeRun({ task: "turn B" });

    expect(countRows(requestId)).toBe(1);
    const totalCost = db.withReadConnection((conn) =>
      (conn.prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_usage_records WHERE request_id = ?",
      ).get(requestId) as { s: number }).s,
    );
    expect(totalCost).toBeCloseTo(0.01, 6);
  });

  it("no-degrade: a turn with no request-id still records (NULL, no receipt) without crashing", async () => {
    const providerId = await createProvider();

    const runtime = runtimeFor(providerId, [
      { type: "text_delta", text: "done" },
      {
        type: "message_end",
        stopReason: "end_turn",
        inputTokens: 10,
        outputTokens: 4,
        actualProviderId: providerId,
        actualModel: "gpt-4o",
        actualProviderApi: "openai-completions",
        costUsd: 0.0001,
        // no requestId — the pre-lane / no-request-id-provider shape.
      },
    ]);

    const result = await runtime.executeRun({ task: "turn without request-id" });
    expect(result.status).toBe("completed");

    // The row is still written, with a NULL request_id and no receipt.
    const nullRows = db.withReadConnection((conn) =>
      (conn.prepare(
        "SELECT COUNT(*) AS n FROM llm_usage_records WHERE provider_id = ? AND request_id IS NULL AND receipt IS NULL",
      ).get(providerId) as { n: number }).n,
    );
    expect(nullRows).toBe(1);
  });
});
