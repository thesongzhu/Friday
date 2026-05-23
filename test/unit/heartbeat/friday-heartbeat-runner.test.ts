import { describe, it, expect, vi } from "vitest";

import { createFridayHeartbeatRunner } from "../../../src/heartbeat/friday-heartbeat-runner.js";
import type {
  FridayHeartbeatRunRecord,
  FridayHeartbeatState,
  FridayHeartbeatStateRepository,
} from "../../../src/heartbeat/friday-heartbeat.types.js";

function createMemoryRepo(
  initial: Partial<FridayHeartbeatState> = {},
): {
  repository: FridayHeartbeatStateRepository;
  runs: FridayHeartbeatRunRecord[];
  state: FridayHeartbeatState;
} {
  const runs: FridayHeartbeatRunRecord[] = [];
  const state: FridayHeartbeatState = {
    lastRunAt: null,
    lastActionAt: null,
    cooldownUntil: null,
    updatedAt: "2026-02-23T00:00:00.000Z",
    ...initial,
  };

  return {
    repository: {
      getState: () => ({ ...state }),
      saveState: (next) => {
        state.lastRunAt = next.lastRunAt;
        state.lastActionAt = next.lastActionAt;
        state.cooldownUntil = next.cooldownUntil;
        state.updatedAt = next.updatedAt;
      },
      appendRun: (record) => {
        runs.push(record);
      },
      listRuns: () => [...runs],
    },
    runs,
    state,
  };
}

describe("FridayHeartbeatRunner", () => {
  it("skips when heartbeat is disabled", async () => {
    const repo = createMemoryRepo();
    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: false,
        intervalMs: 60_000,
        cooldownMs: 0,
        fallbackPrompt: "check",
        sessionKey: "system:heartbeat",
      },
      repository: repo.repository,
      agentRuntime: {
        executeRun: vi.fn(async () => ({
          runId: "run-1",
          status: "completed",
          response: "HEARTBEAT_OK",
        })),
      },
      nowIso: () => "2026-02-23T10:00:00.000Z",
      idGenerator: () => "hb-1",
    });

    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("disabled");
    expect(repo.runs).toHaveLength(1);
    expect(repo.runs[0]?.status).toBe("skipped");
  });

  it("skips during cooldown window", async () => {
    const repo = createMemoryRepo({
      cooldownUntil: "2026-02-23T12:00:00.000Z",
    });
    const executeRun = vi.fn(async () => ({
      runId: "run-1",
      status: "completed" as const,
      response: "HEARTBEAT_OK",
    }));

    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        fallbackPrompt: "check",
        sessionKey: "system:heartbeat",
      },
      repository: repo.repository,
      agentRuntime: { executeRun },
      nowIso: () => "2026-02-23T11:00:00.000Z",
      idGenerator: () => "hb-2",
    });

    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("cooldown_active");
    expect(executeRun).not.toHaveBeenCalled();
  });

  it("records no-op heartbeat when response contains HEARTBEAT_OK", async () => {
    const repo = createMemoryRepo();
    const executeRun = vi.fn(async () => ({
      runId: "run-2",
      status: "completed" as const,
      response: "HEARTBEAT_OK",
    }));
    const onActionRequired = vi.fn();

    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 60_000,
        fallbackPrompt: "check",
        sessionKey: "system:heartbeat",
      },
      repository: repo.repository,
      agentRuntime: { executeRun },
      nowIso: () => "2026-02-23T10:00:00.000Z",
      idGenerator: () => "hb-3",
      onActionRequired,
    });

    const result = await runner.runOnce();
    expect(result.status).toBe("ok");
    expect(result.actionRequired).toBe(false);
    expect(onActionRequired).not.toHaveBeenCalled();
    expect(repo.state.lastActionAt).toBeNull();
  });

  it("routes actionable response and sets cooldown", async () => {
    const repo = createMemoryRepo();
    const executeRun = vi.fn(async () => ({
      runId: "run-3",
      status: "completed" as const,
      response: "Urgent: provider quota is near limit.",
    }));
    const onActionRequired = vi.fn();

    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 120_000,
        fallbackPrompt: "check",
        sessionKey: "system:heartbeat",
      },
      repository: repo.repository,
      agentRuntime: { executeRun },
      nowIso: () => "2026-02-23T10:00:00.000Z",
      idGenerator: () => "hb-4",
      onActionRequired,
    });

    const result = await runner.runOnce();
    expect(result.status).toBe("ok");
    expect(result.actionRequired).toBe(true);
    expect(onActionRequired).toHaveBeenCalledOnce();
    expect(repo.state.lastActionAt).toBe("2026-02-23T10:00:00.000Z");
    expect(repo.state.cooldownUntil).toBe("2026-02-23T10:02:00.000Z");
  });

  it("treats unexpected non-empty non-OK output as fail-safe action-required truth", async () => {
    const repo = createMemoryRepo();
    const executeRun = vi.fn(async () => ({
      runId: "run-noisy",
      status: "completed" as const,
      response: "diagnostic: downstream service returned 503",
    }));
    const onActionRequired = vi.fn();

    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 120_000,
        fallbackPrompt: "respond HEARTBEAT_OK only when no action is required",
        sessionKey: "system:heartbeat",
      },
      repository: repo.repository,
      agentRuntime: { executeRun },
      nowIso: () => "2026-02-23T10:00:00.000Z",
      idGenerator: () => "hb-noisy",
      onActionRequired,
    });

    const result = await runner.runOnce();

    expect(result.status).toBe("ok");
    expect(result.actionRequired).toBe(true);
    expect(onActionRequired).toHaveBeenCalledOnce();
    expect(repo.state.cooldownUntil).toBe("2026-02-23T10:02:00.000Z");
  });

  it("loads session history and forwards it into agent execution", async () => {
    const repo = createMemoryRepo();
    const executeRun = vi.fn(async () => ({
      runId: "run-4",
      status: "completed" as const,
      response: "HEARTBEAT_OK",
    }));
    const loadHistoryMessages = vi.fn(async () => [
      { role: "user" as const, content: "previous heartbeat note" },
    ]);

    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        fallbackPrompt: "check",
        sessionKey: "system:heartbeat",
      },
      repository: repo.repository,
      agentRuntime: { executeRun },
      nowIso: () => "2026-02-23T10:00:00.000Z",
      idGenerator: () => "hb-5",
      loadHistoryMessages,
    });

    await runner.runOnce();

    expect(loadHistoryMessages).toHaveBeenCalledWith("system:heartbeat", 24);
    expect(executeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        historyMessages: [{ role: "user", content: "previous heartbeat note" }],
      }),
    );
  });

  it("forwards principal and tenant context into the heartbeat agent run", async () => {
    const repo = createMemoryRepo();
    const executeRun = vi.fn(async () => ({
      runId: "run-5",
      status: "completed" as const,
      response: "HEARTBEAT_OK",
    }));

    const runner = createFridayHeartbeatRunner({
      config: {
        enabled: true,
        intervalMs: 60_000,
        cooldownMs: 0,
        fallbackPrompt: "check",
        sessionKey: "system:heartbeat",
        principalId: "system-heartbeat",
        tenantContext: {
          hubId: "default",
          userId: "system-heartbeat",
          channelKind: "heartbeat",
        },
      },
      repository: repo.repository,
      agentRuntime: { executeRun },
      nowIso: () => "2026-02-23T10:00:00.000Z",
      idGenerator: () => "hb-6",
    });

    await runner.runOnce();

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      principalId: "system-heartbeat",
      tenantContext: {
        hubId: "default",
        userId: "system-heartbeat",
        channelKind: "heartbeat",
      },
    }));
  });
});
