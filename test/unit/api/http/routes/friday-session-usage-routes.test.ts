import { describe, expect, it, afterEach } from "vitest";

import { FridayDomainError } from "#errors";
import { createFridaySessionUsageRoutes } from "../../../../../src/api/http/routes/friday-session-usage-routes.js";
import { createFridayAgentRunRepository } from "#agent";
import { createFridaySessionService } from "#sessions";
import { createTestDb } from "../../../satellites/_helpers/create-test-db.helper.js";
import type { FridaySessionService } from "#sessions";

const db = createTestDb();

function makeBoundPrincipal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    principalType: "user",
    principalId: "user:usage-attacker",
    tenantId: "tenant-attacker",
    userId: "user-attacker",
    role: "viewer",
    scopes: ["session.read"],
    tokenId: "token-usage-attacker",
    tokenKind: "access",
    issuedAt: "2026-04-23T08:10:00.000Z",
    ...overrides,
  };
}

async function expectRouteError(fn: Promise<unknown>, code: string): Promise<void> {
  try {
    await fn;
    expect.fail("Expected FridayDomainError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(FridayDomainError);
    expect((err as FridayDomainError).code).toBe(code);
  }
}

function createSessionService(): FridaySessionService {
  let counter = 0;
  return createFridaySessionService({
    db,
    idGenerator: () => `usage-session-${++counter}`,
    nowIso: () => "2026-04-23T08:10:00.000Z",
    allowTestOnlySessionExecution: true,
  });
}

describe("FridaySessionUsageRoutes", () => {
  afterEach(() => {
    db.withWriteTransaction((writer) => {
      writer.prepare("DELETE FROM friday_agent_runs").run();
      writer.prepare("DELETE FROM session_messages").run();
      writer.prepare("DELETE FROM sessions").run();
    });
  });

  it("aggregates usage by the actual provider route recorded after execution", async () => {
    const repo = createFridayAgentRunRepository();
    const sessionService = createSessionService();
    const session = await sessionService.createSession({
      channel: "webchat",
      accountId: "tenant-usage",
      chatId: "usage-route",
      userId: "user-usage",
    });
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "run-1",
        task: "Route aggregation test",
        sessionKey: session.key,
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

    const route = createFridaySessionUsageRoutes({ db, sessionService } as never)
      .find((entry) => entry.operationId === "sessions.usage.get");

    if (!route) {
      throw new Error("sessions.usage.get route not found");
    }

    const result = await route.handler({
      requestId: "req-session-usage",
      receivedAt: "2026-04-23T08:10:06.000Z",
      params: { sessionKey: session.key },
      query: {},
      body: undefined,
      headers: {},
      principal: makeBoundPrincipal({
        tenantId: "tenant-usage",
        userId: "user-usage",
      }),
    });

    expect(result).toMatchObject({
      sessionKey: session.key,
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

  it("NEW-30 red: rejects per-session usage reads for a session owned by a different principal", async () => {
    const repo = createFridayAgentRunRepository();
    const sessionService = createSessionService();
    const victimSession = await sessionService.createSession({
      channel: "discord",
      accountId: "tenant-victim",
      chatId: "user-victim",
      userId: "user-victim",
    });
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "run-victim-usage",
        task: "Victim usage",
        sessionKey: victimSession.key,
        maxAttempts: 1,
        nowIso: "2026-04-23T08:10:00.000Z",
      });
      repo.update(writer, {
        id: "run-victim-usage",
        status: "completed",
        completedAt: "2026-04-23T08:10:05.000Z",
        usageInput: 100,
        usageOutput: 50,
        costUsd: 9.99,
      });
    });

    const route = createFridaySessionUsageRoutes({ db, sessionService } as never)
      .find((entry) => entry.operationId === "sessions.usage.get");
    if (!route) {
      throw new Error("sessions.usage.get route not found");
    }

    await expectRouteError(
      route.handler({
        requestId: "req-session-usage-cross-owner",
        receivedAt: "2026-04-23T08:10:06.000Z",
        params: { sessionKey: victimSession.key },
        query: {},
        body: undefined,
        headers: {},
        principal: makeBoundPrincipal(),
      }),
      "SESSION_OWNER_MISMATCH",
    );
  });

  it("NEW-30 red: filters bulk usage summaries to the authenticated principal scope", async () => {
    const repo = createFridayAgentRunRepository();
    const sessionService = createSessionService();
    const attackerSession = await sessionService.createSession({
      channel: "discord",
      accountId: "tenant-attacker",
      chatId: "user-attacker",
      userId: "user-attacker",
    });
    const victimSession = await sessionService.createSession({
      channel: "discord",
      accountId: "tenant-victim",
      chatId: "user-victim",
      userId: "user-victim",
    });
    db.withWriteTransaction((writer) => {
      repo.create(writer, {
        id: "run-attacker-usage",
        task: "Attacker usage",
        sessionKey: attackerSession.key,
        maxAttempts: 1,
        nowIso: "2026-04-23T08:10:00.000Z",
      });
      repo.update(writer, {
        id: "run-attacker-usage",
        status: "completed",
        completedAt: "2026-04-23T08:10:05.000Z",
        usageInput: 12,
        usageOutput: 6,
        costUsd: 0.12,
      });
      repo.create(writer, {
        id: "run-victim-usage",
        task: "Victim usage",
        sessionKey: victimSession.key,
        maxAttempts: 1,
        nowIso: "2026-04-23T08:10:00.000Z",
      });
      repo.update(writer, {
        id: "run-victim-usage",
        status: "completed",
        completedAt: "2026-04-23T08:10:05.000Z",
        usageInput: 1000,
        usageOutput: 500,
        costUsd: 99.99,
      });
    });

    const route = createFridaySessionUsageRoutes({ db, sessionService } as never)
      .find((entry) => entry.operationId === "sessions.usage.list");
    if (!route) {
      throw new Error("sessions.usage.list route not found");
    }

    const result = await route.handler({
      requestId: "req-session-usage-list-scope",
      receivedAt: "2026-04-23T08:10:06.000Z",
      params: {},
      query: {},
      body: undefined,
      headers: {},
      principal: makeBoundPrincipal(),
    }) as { items: Array<{ sessionKey: string; totalCostUsd: number }> };

    expect(result.items).toEqual([
      expect.objectContaining({
        sessionKey: attackerSession.key,
        totalCostUsd: 0.12,
      }),
    ]);
  });
});
