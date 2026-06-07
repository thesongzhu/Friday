import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb, createTestIdGenerator } from "../../satellites/_helpers/create-test-db.helper.js";
import {
  createFridayAgentRuntime,
  createFridayAgentEventEmitter,
  createFridayAgentRunRepository,
} from "#agent";
import type { FridayAgentLlmClient, CreateFridayAgentRuntimeDeps } from "#agent";
import { FridayDomainError } from "#errors";

/**
 * Phase 3b guard-placement fix.
 *
 * TS Runtime Retirement for agent runs was ROUTE-only: POST /v1/agent/runs and
 * POST /v1/sessions/:sessionKey/run fail closed at the HTTP route wrappers, but
 * the underlying agent run loop `executeRun` METHOD had no retirement guard.
 * Non-route callers — heartbeat runner, channel entry adapter, cron dynamic-job
 * runner, autonomous engine, planning gate, subagent child runtime, and the
 * agent-sessions tool — reach `executeRun` directly, bypassing the route guards.
 *
 * These tests prove the guard now lives on the METHOD: in default/live config
 * (test-oracle flag unset) `executeRun` fails closed BEFORE any DB read or
 * run-row creation, creating NO friday_agent_runs row. With the explicit
 * test-oracle flag enabled the legacy path still works (so existing harnesses
 * and the mock/test env are preserved). A runtime built WITHOUT the flag — the
 * exact failure mode if the hub child/subagent factory forgot to thread it —
 * also fails closed, documenting why both the parent and child factories must
 * propagate the flag.
 */

const NOW = "2026-02-18T10:00:00.000Z";
const RETIRED_CODE = "TS_RUNTIME_AGENT_RUN_RETIRED";

function makeHappyLlmClient(): FridayAgentLlmClient {
  return {
    async *stream() {
      yield { type: "text_delta" as const, text: "Hello" };
      yield {
        type: "message_end" as const,
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

describe("FridayAgentRuntime TS-retirement method guard (executeRun)", () => {
  let db: FridaySqliteLayer;
  let idGenerator: () => string;

  beforeEach(() => {
    db = createTestDb();
    idGenerator = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function baseDeps(
    overrides?: Partial<CreateFridayAgentRuntimeDeps>,
  ): CreateFridayAgentRuntimeDeps {
    return {
      db,
      llmClient: makeHappyLlmClient(),
      model: "test-model",
      providerId: "test-provider",
      systemPrompt: "You are a test agent.",
      tools: [],
      eventEmitter: createFridayAgentEventEmitter(),
      idGenerator,
      nowIso: () => NOW,
      ...overrides,
    };
  }

  function countAgentRunRows(): number {
    return db.withReadConnection((reader) =>
      (reader
        .prepare("SELECT COUNT(*) AS c FROM friday_agent_runs")
        .get() as { c: number }).c,
    );
  }

  it("fails closed by default (flag unset): throws TS_RUNTIME_AGENT_RUN_RETIRED 503 and creates no run row", async () => {
    const runtime = createFridayAgentRuntime(baseDeps());
    const fixedRunId = "agent-run-retired-0001";

    let caught: unknown;
    try {
      await runtime.executeRun({ runId: fixedRunId, task: "Say hello" });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(FridayDomainError);
    const domainError = caught as FridayDomainError;
    expect(domainError.code).toBe(RETIRED_CODE);
    expect(domainError.httpStatus).toBe(503);
    expect(domainError.details).toMatchObject({
      classification: "fail_closed",
      replacement: "rust_owned_agent_run_entrypoint_required",
    });

    // The guard runs BEFORE any run-row creation: zero friday_agent_runs rows.
    expect(countAgentRunRows()).toBe(0);
    const repo = createFridayAgentRunRepository();
    expect(db.withReadConnection((reader) => repo.getById(reader, fixedRunId))).toBeNull();
  });

  it("fails closed when the flag is explicitly false (only exact `true` opts in)", async () => {
    const runtime = createFridayAgentRuntime(
      baseDeps({ allowTestOnlyAgentRunExecution: false }),
    );

    await expect(
      runtime.executeRun({ task: "Say hello" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
    expect(countAgentRunRows()).toBe(0);
  });

  it("fails closed for a child/subagent-style runtime built WITHOUT the flag (threading contract)", async () => {
    // A child runtime that does not receive `allowTestOnlyAgentRunExecution`
    // (e.g. if the hub child factory forgot to thread it) must fail closed when
    // a flag-on parent spawns it — this is why both factories must propagate it.
    const childRuntime = createFridayAgentRuntime(
      baseDeps({ systemPrompt: "You are a sub-agent." }),
    );

    await expect(
      childRuntime.executeRun({ task: "Do the delegated work" }),
    ).rejects.toMatchObject({ code: RETIRED_CODE, httpStatus: 503 });
    expect(countAgentRunRows()).toBe(0);
  });

  it("runs normally when the test-oracle flag is enabled (legacy path preserved)", async () => {
    const runtime = createFridayAgentRuntime(
      baseDeps({ allowTestOnlyAgentRunExecution: true }),
    );

    const result = await runtime.executeRun({ task: "Say hello" });
    expect(result.status).toBe("completed");
    expect(countAgentRunRows()).toBeGreaterThan(0);
  });
});
