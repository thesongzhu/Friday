import { afterEach, describe, expect, it, vi } from "vitest";

import { createFridayApiRuntime } from "#api";
import {
  createFridayAgentEventEmitter,
  type FridayAgentRuntime,
} from "#agent";
import type { FridayProviderService } from "#providers";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";

const NOW = "2026-03-24T12:00:00.000Z";

function makeIdGenerator(): () => string {
  let counter = 0;
  return () => `id-${String(++counter)}`;
}

function makeProviderService(): FridayProviderService {
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
      provider: {
        id: "p-1",
        kind: "openai" as const,
        name: "OpenAI",
        baseUrl: "https://api.openai.com",
        enabled: true,
        config: {
          api: "openai-responses" as const,
          authMode: "api-key" as const,
          keySource: { kind: "env-ref" as const, envVar: "OPENAI_API_KEY" },
          supportedModels: ["gpt-5.1"],
          validation: { status: "ok" as const, checkedAt: NOW },
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      model: "gpt-5.1",
    })),
    runWithFallback: vi.fn(async () => ({} as never)),
  } as unknown as FridayProviderService;
}

describe("FridayApiRuntime deterministic dispatch", () => {
  let db: FridaySqliteLayer;

  afterEach(() => {
    db?.close();
  });

  it("handles capability queries without a session key and does not invoke the agent", async () => {
    db = createTestDb();
    const executeRun = vi.fn(async () => {
      throw new Error("agent should not run");
    });
    const agentRuntime: FridayAgentRuntime = {
      executeRun,
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator: makeIdGenerator(),
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      capabilitySnapshotGetter: () => ({
        readOnly: false,
        messaging: { enabled: false, kinds: [] },
        mcp: { enabled: false, serverCount: 0, servers: [] },
        provider: { available: true, configuredCount: 0, mutationBlockedByReadOnly: false },
        browser: {},
        system: { enabled: false },
        desktop: { connected: false },
        companion: { connected: false },
      }),
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    expect(startRoute).toBeDefined();

    const result = await startRoute!.handler({
      body: {
        task: "What can you do right now?",
      },
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        scopes: ["agent.run"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    } as never);

    expect(result.status).toBe("completed");
    expect(result.response).toContain("Current capabilities:");
    expect(result.eventStreamAvailable).toBe(true);
    expect(executeRun).not.toHaveBeenCalled();

    const getRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.get");
    expect(getRoute).toBeDefined();

    const getResult = await getRoute!.handler({
      params: { runId: result.runId },
      query: {},
      body: null,
      headers: {},
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        scopes: ["agent.read"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    } as never);

    expect(getResult.run.id).toBe(result.runId);
    expect(getResult.run.status).toBe("completed");
    expect(getResult.run.responseText).toContain("Current capabilities:");

    const eventsRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.events");
    expect(eventsRoute).toBeDefined();
    const raw = {
      writeHead: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      on: vi.fn(),
    };
    await eventsRoute!.handler({
      params: { runId: result.runId },
      query: {},
      body: null,
      headers: {},
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        scopes: ["agent.read"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
      _raw: raw,
    } as never);

    expect(raw.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"agent.run.text_delta"'),
    );
    expect(raw.write).toHaveBeenCalledWith(
      expect.stringContaining('"type":"agent.run.completed"'),
    );
    expect(raw.end).toHaveBeenCalled();
  });

  it("routes Feishu-context work consultations to the agent instead of setup guidance", async () => {
    db = createTestDb();
    const executeRun = vi.fn(async (input) => ({
      runId: input.runId ?? "agent-run-1",
      status: "completed" as const,
      response: "可以。我会先确认项目入口、技术栈、期望产物和审计深度。",
      toolCallCount: 3,
      durationMs: 42,
      usageInput: 100,
      usageOutput: 60,
    }));
    const agentRuntime: FridayAgentRuntime = {
      executeRun,
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator: makeIdGenerator(),
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      capabilitySnapshotGetter: () => ({
        readOnly: false,
        messaging: { enabled: true, kinds: ["feishu"] },
        mcp: { enabled: false, serverCount: 0, servers: [] },
        provider: { available: true, configuredCount: 1, mutationBlockedByReadOnly: false },
        browser: {},
        system: { enabled: true },
        desktop: { connected: false },
        companion: { connected: true },
      }),
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    const startRoute = runtime.routes.getRoutes().find((route) => route.operationId === "agent.runs.start");
    expect(startRoute).toBeDefined();

    const task = "在飞书里回复用户：Friday 能不能帮我把公司内部一个混乱项目审计清楚、列出问题、排优先级、必要时生成报告和自动化？我不知道从哪里开始。";
    const result = await startRoute!.handler({
      body: {
        task,
        executionContext: {
          surface: "channel",
          interactive: true,
        },
      },
      principal: {
        principalType: "user",
        principalId: "feishu-user-1",
        userId: "feishu-user-1",
        scopes: ["agent.run"],
        tokenId: "tok-feishu",
        tokenKind: "access",
        issuedAt: NOW,
      },
    } as never);

    expect(result.status).toBe("completed");
    expect(result.response).toContain("可以");
    expect(result.response).not.toContain("不是“已注册渠道”");
    expect(result.response).not.toContain("/setup?step=channels&channel=feishu");
    expect(executeRun).toHaveBeenCalledOnce();
    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      task,
      principalId: "feishu-user-1",
      scopes: ["agent.run"],
      executionContext: expect.objectContaining({
        surface: "channel",
        interactive: true,
      }),
      tenantContext: expect.objectContaining({
        userId: "feishu-user-1",
      }),
    }));
  });

  it("routes session explicit high-impact preferences through requestPreferenceUpdate before agent execution", async () => {
    db = createTestDb();
    const executeRun = vi.fn(async (input) => ({
      runId: input.runId ?? "agent-run-1",
      status: "completed" as const,
      response: "ok",
      toolCallCount: 0,
      durationMs: 10,
      usageInput: 1,
      usageOutput: 1,
    }));
    const requestPreferenceUpdate = vi.fn(() => ({
      requiresConfirmation: true,
      candidate: { id: "candidate-1", status: "ready_for_review" },
    }));
    const updatePreference = vi.fn();
    const agentRuntime: FridayAgentRuntime = {
      executeRun,
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn(() => 0),
    };

    const runtime = createFridayApiRuntime({
      db,
      // TEST-ONLY: no durable master key here → allow the inactive (identity) realtime
      // pseudonymizer so runtime-published realtime events do not fail-closed
      // (SEC-REALTIME-EVENT-PII-BY-VALUE / round-6 P0-1).
      allowTestOnlyInactiveRealtimePseudonym: true,
      idGenerator: makeIdGenerator(),
      nowIso: () => NOW,
      providerService: makeProviderService(),
      agentRuntime,
      agentEventEmitter: createFridayAgentEventEmitter(),
      reflexService: {
        requestPreferenceUpdate,
        updatePreference,
      } as never,
      tokenSecret: "test-secret-key-that-is-at-least-32-chars-long!!", // pragma: allowlist secret
      computeChecksum: (content: string) => `checksum-${content.length}`,
      resolveSkill: () => null,
      invokeSkill: async () => ({}),
      allowTestOnlyAgentRunStartExecution: true,
      allowTestOnlySessionRunExecution: true,
      allowTestOnlySessionExecution: true,
    });

    const runRoute = runtime.routes.getRoutes().find((route) => route.operationId === "sessions.run");
    expect(runRoute).toBeDefined();

    await runRoute!.handler({
      params: { sessionKey: "chat:default:user-1" },
      body: {
        task: "以后允许 live llm 测试",
      },
      principal: {
        principalType: "user",
        principalId: "user-1",
        userId: "user-1",
        scopes: ["agent.run"],
        tokenId: "tok-1",
        tokenKind: "access",
        issuedAt: NOW,
      },
    } as never);

    expect(requestPreferenceUpdate).toHaveBeenCalledWith({
      userId: "user-1",
      category: "reflex",
      key: "testing.live_llm_policy",
      value: "allowed_with_cost_notice",
      sourceSurface: "operate",
    });
    expect(updatePreference).not.toHaveBeenCalled();
    expect(executeRun).toHaveBeenCalledOnce();
  });
});
