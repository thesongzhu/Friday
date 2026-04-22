import { describe, expect, it, vi } from "vitest";

import { createFridaySubagentRoutes } from "../../../../../src/api/http/routes/friday-subagent-routes.js";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    query: {},
    body: {},
    headers: {},
    principal: { userId: "test-user", scopes: ["workflow.run"] },
    requestId: "req-1",
    receivedAt: "2026-04-21T12:00:00.000Z",
    ...overrides,
  } as never;
}

function makeRun(packId?: string) {
  return {
    id: "run-1",
    task: "test task",
    status: "completed",
    sessionKey: "session-1",
    attempt: 1,
    maxAttempts: 1,
    createdAt: "2026-04-21T12:00:00.000Z",
    metadata: packId
      ? {
          packContext: {
            packId,
            updatedAt: "2026-04-21T12:00:00.000Z",
          },
        }
      : undefined,
  } as const;
}

function makeSubagentRecord(responseText: string) {
  return {
    id: "subagent-1",
    parentRunId: "run-1",
    parentSessionKey: "session-1",
    childRunId: "child-run-1",
    childSessionKey: "child-session-1",
    task: "整理候选商品并输出交接摘要",
    mode: "fresh",
    depth: 1,
    status: "completed",
    createdAt: "2026-04-21T12:00:00.000Z",
    startedAt: "2026-04-21T12:00:01.000Z",
    completedAt: "2026-04-21T12:00:02.000Z",
    durationMs: 1000,
    outcome: {
      status: "completed",
      response: responseText,
      toolCallCount: 2,
      durationMs: 1000,
      usageInput: 10,
      usageOutput: 20,
    },
  } as const;
}

function findRoute(operationId: string) {
  const subagent = makeSubagentRecord(
    [
      "已经找到 3 个候选商品，可以进入今天的动作清单。",
      "readOnly=true",
      "childRunId: 123e4567-e89b-12d3-a456-426614174000",
      "sessionKey: subagent:session-123",
    ].join("\n"),
  );
  const deps = {
    subagentRegistry: {
      list: vi.fn(() => [subagent]),
      getById: vi.fn(() => subagent),
      listByParentRunId: vi.fn(() => [subagent]),
    },
    getRun: vi.fn(() => makeRun("custom-pack-demo")),
  } as never;
  const route = createFridaySubagentRoutes(deps).find((entry) => entry.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return { route, deps, subagent };
}

describe("createFridaySubagentRoutes", () => {
  it("sanitizes custom-pack subagent outcomes in the parent-run listing route", async () => {
    const { route } = findRoute("agent.runs.subagents.list");

    const result = await route.handler(makeCtx({
      params: { runId: "run-1" },
    })) as { items: Array<{ outcome?: { response?: string } }> };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.outcome?.response).toContain("已经找到 3 个候选商品");
    expect(result.items[0]?.outcome?.response).not.toContain("readOnly");
    expect(result.items[0]?.outcome?.response).not.toContain("childRunId");
    expect(result.items[0]?.outcome?.response).not.toContain("sessionKey");
    expect(result.items[0]?.outcome?.response).not.toContain("123e4567-e89b-12d3-a456-426614174000");
  });

  it("sanitizes custom-pack subagent outcomes in the direct get route", async () => {
    const { route } = findRoute("agent.subagents.get");

    const result = await route.handler(makeCtx({
      params: { subagentId: "subagent-1" },
    })) as { subagent: { outcome?: { response?: string } } };

    expect(result.subagent.outcome?.response).toContain("已经找到 3 个候选商品");
    expect(result.subagent.outcome?.response).not.toContain("readOnly");
    expect(result.subagent.outcome?.response).not.toContain("childRunId");
    expect(result.subagent.outcome?.response).not.toContain("sessionKey");
  });

  it("leaves non-custom subagent outcomes unchanged", async () => {
    const rawResponse = [
      "已经找到 3 个候选商品，可以进入今天的动作清单。",
      "readOnly=true",
    ].join("\n");
    const subagent = makeSubagentRecord(rawResponse);
    const deps = {
      subagentRegistry: {
        list: vi.fn(() => [subagent]),
        getById: vi.fn(() => subagent),
        listByParentRunId: vi.fn(() => [subagent]),
      },
      getRun: vi.fn(() => makeRun("industry-cross-border-ecommerce")),
    } as never;
    const route = createFridaySubagentRoutes(deps).find((entry) => entry.operationId === "agent.runs.subagents.list");
    if (!route) {
      throw new Error("Route agent.runs.subagents.list not found");
    }

    const result = await route.handler(makeCtx({
      params: { runId: "run-1" },
    })) as { items: Array<{ outcome?: { response?: string } }> };

    expect(result.items[0]?.outcome?.response).toBe(rawResponse);
  });
});
