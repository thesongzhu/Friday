import { describe, it, expect, vi, beforeEach } from "vitest";
import { createFridayAutonomousEngine } from "../../../../src/agent/autonomous/friday-autonomous-engine.js";
import type {
  CreateFridayAutonomousEngineDeps,
  FridayAutonomousGoal,
  FridayAutonomousIteration,
  FridayAutonomousStep,
} from "../../../../src/agent/autonomous/friday-autonomous.types.js";

// A3 regression: the autonomous engine must NOT mark a step/goal `completed`
// when the step performed a real *mutating* side effect but the model decided
// "complete" with NO verification criteria (locked decision: missing /
// LLM-self-judgment verification is INVALID completion proof for side effects).
// Mirrors the runtime side-effect gate (#388) for the autonomous surface.

let counter = 0;
const idGen = () => `id-${++counter}`;
const nowIso = () => "2026-05-28T10:00:00Z";
const signal = () => new AbortController().signal;

function inMemoryPersistence(): NonNullable<CreateFridayAutonomousEngineDeps["persistence"]> {
  const goals = new Map<string, FridayAutonomousGoal>();
  const steps = new Map<string, FridayAutonomousStep>();
  const stepsByGoal = new Map<string, FridayAutonomousStep[]>();
  const iters = new Map<string, FridayAutonomousIteration[]>();
  return {
    sqlite: {
      withWriteTransaction: <T>(fn: (db: object) => T): T => fn({}),
      withReadConnection: <T>(fn: (db: object) => T): T => fn({}),
    },
    repository: {
      createGoal: (_d: object, g: FridayAutonomousGoal) => { goals.set(g.id, g); },
      updateGoal: (_d: object, id: string, p: Partial<FridayAutonomousGoal>) => { const c = goals.get(id); if (c) goals.set(id, { ...c, ...p }); },
      getGoal: (_d: object, id: string) => goals.get(id) ?? null,
      listGoals: () => [...goals.values()],
      listActiveGoals: () => [...goals.values()].filter((g) => !["completed", "failed", "cancelled", "interrupted_nonrecoverable"].includes(g.status)),
      createStep: (_d: object, s: FridayAutonomousStep) => { steps.set(s.id, s); stepsByGoal.set(s.goalId, [...(stepsByGoal.get(s.goalId) ?? []), s].sort((a, b) => a.index - b.index)); },
      updateStep: (_d: object, id: string, p: Partial<FridayAutonomousStep>) => { const c = steps.get(id); if (!c) return; const u = { ...c, ...p }; steps.set(id, u); stepsByGoal.set(c.goalId, (stepsByGoal.get(c.goalId) ?? []).map((s) => s.id === id ? u : s)); },
      getStep: (_d: object, id: string) => steps.get(id) ?? null,
      getStepsByGoalId: (_d: object, gid: string) => [...(stepsByGoal.get(gid) ?? [])],
      appendIteration: (_d: object, it: FridayAutonomousIteration) => { iters.set(it.goalId, [...(iters.get(it.goalId) ?? []), it]); },
      getIterationsByGoalId: (_d: object, gid: string) => [...(iters.get(gid) ?? [])],
    } as unknown as NonNullable<CreateFridayAutonomousEngineDeps["persistence"]>["repository"],
  };
}

function makeDeps(executeRunImpl: ReturnType<typeof vi.fn>, toolExecutor: ReturnType<typeof vi.fn>): CreateFridayAutonomousEngineDeps {
  return {
    agentRuntime: { executeRun: executeRunImpl },
    analyzeImages: vi.fn().mockResolvedValue({ text: JSON.stringify({ kind: "complete", summary: "done" }), model: "v", inputTokens: 1, outputTokens: 1 }),
    toolExecutor,
    idGenerator: idGen,
    nowIso,
    eventEmitter: { emit: vi.fn() },
    persistence: inMemoryPersistence(),
  } as unknown as CreateFridayAutonomousEngineDeps;
}

const plan = (step: Record<string, unknown>) => ({ runId: "r-plan", status: "completed", response: JSON.stringify([step]), usageInput: 10, usageOutput: 5 });
const decide = (d: Record<string, unknown>) => ({ runId: "r-dec", status: "completed", response: JSON.stringify(d), usageInput: 5, usageOutput: 5 });

describe("FridayAutonomousEngine side-effect verification (A3)", () => {
  beforeEach(() => { counter = 0; });

  it("FAILS a mutating step the model marks complete with NO verification", async () => {
    const executeRun = vi.fn()
      .mockResolvedValueOnce(plan({ instruction: "Send the confirmation email to bob@example.com", domain: "composite" }))
      .mockResolvedValueOnce(decide({ kind: "act", action: { toolName: "message", args: { channelId: "c1", text: "confirmed" }, rationale: "send the message" } }))
      .mockResolvedValue(decide({ kind: "complete", summary: "Email sent" }));
    const toolExecutor = vi.fn().mockResolvedValue({ isError: false, content: "sent" }); // message = mutating, succeeds
    const engine = createFridayAutonomousEngine(makeDeps(executeRun, toolExecutor));

    const result = await engine.executeGoal({ description: "Email bob the confirmation", signal: signal() });
    // Side effect (message) ran but there is no verification — must NOT be a clean completion.
    expect(result.status).not.toBe("completed");
    expect(result.status).toBe("failed");
  });

  it("COMPLETES a non-mutating (read-only) step marked complete without verification (no over-blocking)", async () => {
    const executeRun = vi.fn()
      .mockResolvedValueOnce(plan({ instruction: "Read the project README", domain: "composite" }))
      .mockResolvedValueOnce(decide({ kind: "act", action: { toolName: "read", args: { path: "README.md" }, rationale: "read it" } }))
      .mockResolvedValue(decide({ kind: "complete", summary: "Read the file" }));
    const toolExecutor = vi.fn().mockResolvedValue({ isError: false, content: "# Readme" }); // read = read-only, not mutating
    const engine = createFridayAutonomousEngine(makeDeps(executeRun, toolExecutor));

    const result = await engine.executeGoal({ description: "Read the README", signal: signal() });
    expect(result.status).toBe("completed");
  });
});
