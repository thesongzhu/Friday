import { randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFridayAgentPlanningGateService,
  type FridayAgentRunEventRepository,
  type FridayAgentRunRecord,
  type FridayAgentRunRepository,
  type FridayAgentRuntime,
} from "#agent";

function createRunRepository(store: Map<string, FridayAgentRunRecord>): FridayAgentRunRepository {
  return {
    create(_db, input) {
      const record: FridayAgentRunRecord = {
        id: input.id,
        task: input.task,
        status: "pending",
        sessionKey: input.sessionKey,
        providerId: input.providerId,
        model: input.model,
        attempt: 0,
        maxAttempts: input.maxAttempts,
        constraints: input.constraints,
        createdAt: input.nowIso,
      };
      store.set(record.id, record);
      return record;
    },
    getById(_db, id) {
      return store.get(id) ?? null;
    },
    update(_db, input) {
      const existing = store.get(input.id);
      if (!existing) return null;
      const next: FridayAgentRunRecord = {
        ...existing,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        ...(input.planReview !== undefined ? { planReview: input.planReview } : {}),
        ...(input.actualExecution !== undefined ? { actualExecution: input.actualExecution } : {}),
        ...(input.responseText !== undefined ? { responseText: input.responseText } : {}),
        ...(input.summary !== undefined ? { summary: input.summary } : {}),
        ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
        ...(input.taskProfile !== undefined ? { taskProfile: input.taskProfile } : {}),
      };
      store.set(next.id, next);
      return next;
    },
    list() {
      return [...store.values()];
    },
    listActive() {
      return [...store.values()].filter((run) => run.status !== "completed" && run.status !== "failed" && run.status !== "cancelled");
    },
  };
}

function createRunEventRepository(
  events: Map<string, Array<ReturnType<FridayAgentRunEventRepository["list"]>[number]>> = new Map(),
): FridayAgentRunEventRepository {
  return {
    append(_db, input) {
      const list = events.get(input.runId) ?? [];
      if (list.some((event) => event.seq === input.seq)) {
        throw new Error(`Duplicate event seq ${String(input.seq)} for run ${input.runId}`);
      }
      list.push({
        eventId: input.eventId,
        runId: input.runId,
        seq: input.seq,
        eventName: input.eventName,
        payload: input.payload,
        emittedAt: input.emittedAt,
        createdAt: input.createdAt,
      });
      events.set(input.runId, list);
    },
    list(_db, runId, afterSeq) {
      const list = events.get(runId) ?? [];
      if (typeof afterSeq === "number") {
        return list.filter((event) => event.seq > afterSeq);
      }
      return [...list];
    },
  };
}

describe("friday-agent-planning-gate", () => {
  let runs: Map<string, FridayAgentRunRecord>;
  let runtime: FridayAgentRuntime;
  let executeRun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runs = new Map<string, FridayAgentRunRecord>();
    executeRun = vi.fn().mockResolvedValue({
      runId: "run-1",
      status: "completed",
      response: "Executed approved plan.",
      toolCallCount: 1,
      durationMs: 1200,
      usageInput: 10,
      usageOutput: 5,
      finalResponse: "Executed approved plan.",
    });
    runtime = {
      executeRun,
      registerTool: vi.fn(),
      resumeStaleRunsOnBoot: vi.fn().mockReturnValue(0),
    };
  });

  function createService() {
    return createFridayAgentPlanningGateService({
      repo: createRunRepository(runs),
      runEventRepository: createRunEventRepository(),
      runtime,
      eventEmitter: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
      db: {
        withReadConnection<T>(fn: (db: Database) => T): T {
          return fn({} as Database);
        },
        withWriteTransaction<T>(fn: (db: Database) => T): T {
          return fn({} as Database);
        },
      },
      idGenerator: () => randomUUID(),
      nowIso: () => "2026-03-16T08:00:00.000Z",
    });
  }

  it("returns awaiting_plan_approval immediately for a detailed workflow request", () => {
    const service = createService();

    const decision = service.handleTurn({
      runId: "run-1",
      task: "Generate a workflow that runs every Friday, collects workspace release status, posts the summary to Slack, keeps the execution read-only, and reports blockers before deployment.",
      sessionKey: "ui:assistant:1",
    });

    expect(decision.action).toBe("return");
    if (decision.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(decision.result.status).toBe("awaiting_plan_approval");
    expect(decision.pendingPlanRunId).toBe("run-1");
    expect(decision.result.response).toContain("# Proposed plan");
    expect(runs.get("run-1")?.status).toBe("awaiting_plan_approval");
    expect(runs.get("run-1")?.planReview?.gate?.planMarkdown).toContain("Reply `approve` to continue");
    expect(runs.get("run-1")?.actualExecution).toMatchObject({
      requestedProviderId: undefined,
      requestedModel: undefined,
      modelSelectionSource: "route_default",
      turns: [],
    });
  });

  it("treats 'create a new workflow' as a planning-gated workflow request", () => {
    const service = createService();

    const decision = service.handleTurn({
      runId: "run-new-workflow",
      task: "Create a new workflow that runs every weekday morning, summarizes git status, and returns the summary in the workflow response.",
      sessionKey: "ui:assistant:1",
    });

    expect(decision.action).toBe("return");
    if (decision.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(decision.result.status).toBe("awaiting_clarification");
    expect(decision.pendingPlanRunId).toBe("run-new-workflow");
    expect(runs.get("run-new-workflow")?.actualExecution?.turns).toEqual([]);
  });

  it("moves from clarification to plan approval when the user answers follow-up questions", () => {
    const service = createService();

    const first = service.handleTurn({
      runId: "run-clarify",
      task: "Generate a skill",
      sessionKey: "ui:assistant:1",
    });

    expect(first.action).toBe("return");
    if (first.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(first.result.status).toBe("awaiting_clarification");

    const second = service.handleTurn({
      runId: "run-ignored",
      task: "It should summarize git diffs for the current repository.",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-clarify" },
      conversationContext: { turnKind: "clarification" },
    });
    expect(second.action).toBe("return");
    if (second.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(second.result.status).toBe("awaiting_clarification");

    const third = service.handleTurn({
      runId: "run-ignored-2",
      task: "Use Friday starter tools only and avoid writing files outside the workspace.",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-clarify" },
      conversationContext: { turnKind: "clarification" },
    });
    expect(third.action).toBe("return");
    if (third.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(third.result.status).toBe("awaiting_plan_approval");
    expect(third.result.response).toContain("# Proposed plan");
  });

  it("requires every downstream clarification question before rebuilding the plan", () => {
    const service = createService();
    runs.set("run-downstream", {
      id: "run-downstream",
      task: "Generate a workflow for weekly release reporting",
      status: "awaiting_clarification",
      sessionKey: "ui:assistant:1",
      attempt: 0,
      maxAttempts: 3,
      createdAt: "2026-03-16T08:00:00.000Z",
      planReview: {
        plan: {
          task: "Generate a workflow for weekly release reporting",
          stepCount: 3,
          description: "Approved workflow generation plan",
        },
        gate: {
          kind: "generate_workflow",
          state: "awaiting_clarification",
          clarificationQuestions: [
            "Which timezone should this workflow run in?",
            "Which Slack destination should receive the summary?",
            "Should blockers stop the workflow or only be reported?",
          ],
          answers: [],
        },
      },
    });

    const first = service.handleTurn({
      runId: "ignored-1",
      task: "Use America/Los_Angeles.",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-downstream" },
      conversationContext: { turnKind: "clarification" },
    });
    expect(first.action).toBe("return");
    if (first.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(first.result.status).toBe("awaiting_clarification");

    const second = service.handleTurn({
      runId: "ignored-2",
      task: "#release-status",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-downstream" },
      conversationContext: { turnKind: "clarification" },
    });
    expect(second.action).toBe("return");
    if (second.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(second.result.status).toBe("awaiting_clarification");

    const third = service.handleTurn({
      runId: "ignored-3",
      task: "Stop the workflow and report blockers immediately.",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-downstream" },
      conversationContext: { turnKind: "clarification" },
    });
    expect(third.action).toBe("return");
    if (third.action !== "return") {
      throw new Error("Expected return decision");
    }
    expect(third.result.status).toBe("awaiting_plan_approval");
    expect(third.result.response).toContain("# Proposed plan");
  });

  it("treats approve as a control command for the pending plan", () => {
    const service = createService();

    service.handleTurn({
      runId: "run-approve",
      task: "Generate a workflow that exports build evidence, validates the bundle, and only deploys after review.",
      sessionKey: "ui:assistant:1",
    });

    const decision = service.handleTurn({
      runId: "run-approve-2",
      task: "approve",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-approve" },
    });

    expect(decision).toEqual({
      action: "approve",
      runId: "run-approve",
      pendingPlanRunId: null,
    });
  });

  it("resumes the approved run with the stored task and approved plan payload", async () => {
    const service = createService();

    service.handleTurn({
      runId: "run-resume",
      task: "Generate a workflow that exports build evidence, validates the bundle, keeps deployment gated until review approval, runs inside the current workspace, and avoids destructive changes outside the repo.",
      sessionKey: "ui:assistant:1",
    });

    await service.approvePlan({
      runId: "run-resume",
      sessionKey: "ui:assistant:1",
    });

    expect(executeRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-resume",
      task: "Generate a workflow that exports build evidence, validates the bundle, keeps deployment gated until review approval, runs inside the current workspace, and avoids destructive changes outside the repo.",
      resumeExistingRun: true,
      skipPlanningReview: true,
    }));
    const approvedPlan = runs.get("run-resume")?.planReview;
    expect(approvedPlan?.decision?.approved).toBe(true);
    expect(approvedPlan?.gate?.state).toBe("approved");
  });

  it("resyncs event sequence after downstream runtime already appended newer events", () => {
    const events = new Map<string, Array<ReturnType<FridayAgentRunEventRepository["list"]>[number]>>();
    const service = createFridayAgentPlanningGateService({
      repo: createRunRepository(runs),
      runEventRepository: createRunEventRepository(events),
      runtime,
      eventEmitter: {
        emit: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      },
      db: {
        withReadConnection<T>(fn: (db: Database) => T): T {
          return fn({} as Database);
        },
        withWriteTransaction<T>(fn: (db: Database) => T): T {
          return fn({} as Database);
        },
      },
      idGenerator: () => randomUUID(),
      nowIso: () => "2026-03-16T08:00:00.000Z",
    });

    const initial = service.handleTurn({
      runId: "run-seq",
      task: "Generate a workflow",
      sessionKey: "ui:assistant:1",
    });
    expect(initial.action).toBe("return");

    runs.set("run-seq", {
      ...(runs.get("run-seq") as FridayAgentRunRecord),
      status: "awaiting_clarification",
      planReview: {
        ...(runs.get("run-seq")?.planReview ?? {
          plan: {
            task: "Generate a workflow",
            stepCount: 3,
            description: "Planning gate for generate workflow",
          },
        }),
        gate: {
          kind: "generate_workflow",
          state: "awaiting_clarification",
          clarificationQuestions: [
            "What time on Friday should this workflow run?",
            "Which Slack channel or webhook should receive the release status summary?",
          ],
          answers: [],
        },
      },
    });

    const list = events.get("run-seq") ?? [];
    list.push({
      eventId: "runtime-event-10",
      runId: "run-seq",
      seq: 10,
      eventName: "agent.run.executing",
      payload: { runId: "run-seq", attempt: 1 },
      emittedAt: "2026-03-16T08:00:01.000Z",
      createdAt: "2026-03-16T08:00:01.000Z",
    });
    events.set("run-seq", list);

    const followUp = service.handleTurn({
      runId: "ignored-seq",
      task: "10:00 AM Pacific.",
      sessionKey: "ui:assistant:1",
      focusState: { pendingPlanRunId: "run-seq" },
      conversationContext: { turnKind: "clarification" },
    });

    expect(followUp.action).toBe("return");
    const latestSeq = (events.get("run-seq") ?? []).at(-1)?.seq;
    expect(latestSeq).toBeGreaterThan(10);
  });
});
