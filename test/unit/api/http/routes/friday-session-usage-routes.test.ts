import { describe, expect, it, afterEach } from "vitest";

import { createFridaySessionUsageRoutes } from "../../../../../src/api/http/routes/friday-session-usage-routes.js";
import { createFridayAgentRunRepository } from "#agent";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";

describe("FridaySessionUsageRoutes", () => {
  const db = createTestDb();

  afterEach(() => {
    db.withWriteTransaction((writer) => {
      writer.prepare("DELETE FROM friday_agent_runs").run();
    });
  });

  it("aggregates usage by the actual provider route recorded after execution", async () => {
    const repo = createFridayAgentRunRepository();
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "run-1",
        task: "Route aggregation test",
        sessionKey: "webchat:test:usage-route",
        maxAttempts: 1,
        nowIso: "2026-04-23T08:10:00.000Z",
      });
      repo.update(writer, {
        id: "run-1",
        status: "completed",
        completedAt: "2026-04-23T08:10:05.000Z",
        usageInput: 12,
        usageOutput: 6,
        costUsd: 0.0012,
        actualExecution: {
          actualProviderId: "openai-live",
          actualModel: "gpt-4o-mini",
          turns: [
            {
              providerId: "openai-live",
              model: "gpt-4o-mini",
              inputTokens: 12,
              outputTokens: 6,
              costUsd: 0.0012,
            },
          ],
        },
      });
    });

    const route = createFridaySessionUsageRoutes({ db })
      .find((entry) => entry.operationId === "sessions.usage.get");

    if (!route) {
      throw new Error("sessions.usage.get route not found");
    }

    const result = await route.handler({
      requestId: "req-session-usage",
      receivedAt: "2026-04-23T08:10:06.000Z",
      params: { sessionKey: "webchat:test:usage-route" },
      query: {},
      body: undefined,
      headers: {},
      principal: null,
    });

    expect(result).toMatchObject({
      sessionKey: "webchat:test:usage-route",
      totalInputTokens: 12,
      totalOutputTokens: 6,
      totalCostUsd: 0.0012,
      totalRuns: 1,
      byModel: [
        {
          providerId: "openai-live",
          model: "gpt-4o-mini",
          inputTokens: 12,
          outputTokens: 6,
          costUsd: 0.0012,
          runs: 1,
        },
      ],
    });
  });
});
