import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { V068_AUTONOMOUS_ENGINE_PERSISTENCE_SQL } from "../../../../src/state/sqlite/migrations/v068-autonomous-engine-persistence.js";
import { V071_AUTONOMOUS_STEP_VERIFICATION_PROVENANCE_SQL } from "../../../../src/state/sqlite/migrations/v071-autonomous-step-verification-provenance.js";

/**
 * Unit tests for the autonomous engine SQLite repository.
 * Uses an in-memory SQLite database with the v068 migration applied.
 */

// Dynamically import after build — the repository is a new file
let createFridayAutonomousRepository: () => ReturnType<typeof import("../../../../src/agent/autonomous/friday-autonomous-repository.js")["createFridayAutonomousRepository"]>;

beforeEach(async () => {
  const mod = await import("../../../../src/agent/autonomous/friday-autonomous-repository.js");
  createFridayAutonomousRepository = mod.createFridayAutonomousRepository;
});

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(V068_AUTONOMOUS_ENGINE_PERSISTENCE_SQL);
  db.exec(V071_AUTONOMOUS_STEP_VERIFICATION_PROVENANCE_SQL);
  return db;
}

function makeGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-001",
    status: "pending" as const,
    priority: "normal" as const,
    source: "user" as const,
    description: "Test autonomous goal",
    maxIterations: 50,
    timeoutMs: 300000,
    iterationCount: 0,
    stepIds: [] as readonly string[],
    currentStepIndex: 0,
    createdAt: "2026-04-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeStep(overrides: Record<string, unknown> = {}) {
  return {
    id: "step-001",
    goalId: "goal-001",
    index: 0,
    status: "pending" as const,
    domain: "exec" as const,
    instruction: "Run the test command",
    maxRetries: 3,
    retryCount: 0,
    observations: [] as readonly unknown[],
    ...overrides,
  };
}

function makeIteration(overrides: Record<string, unknown> = {}) {
  return {
    id: "iter-001",
    goalId: "goal-001",
    stepId: "step-001",
    index: 0,
    timestamp: "2026-04-15T00:01:00.000Z",
    observations: [] as readonly unknown[],
    reasoning: "The current state suggests running the command",
    decision: { kind: "act" as const, action: { toolName: "exec", args: { command: "echo hello" } } },
    durationMs: 1500,
    ...overrides,
  };
}

describe("FridayAutonomousRepository", () => {
  let db: Database.Database;
  let repo: ReturnType<typeof createFridayAutonomousRepository>;

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayAutonomousRepository();
  });

  // ─── Goals ───

  describe("goals", () => {
    it("creates and retrieves a goal", () => {
      const goal = makeGoal();
      repo.createGoal(db, goal as never);
      const retrieved = repo.getGoal(db, "goal-001");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("goal-001");
      expect(retrieved!.status).toBe("pending");
      expect(retrieved!.description).toBe("Test autonomous goal");
      expect(retrieved!.maxIterations).toBe(50);
    });

    it("updates goal status", () => {
      repo.createGoal(db, makeGoal() as never);
      repo.updateGoal(db, "goal-001", { status: "executing", startedAt: "2026-04-15T00:00:01.000Z" });
      const updated = repo.getGoal(db, "goal-001");
      expect(updated!.status).toBe("executing");
      expect(updated!.startedAt).toBe("2026-04-15T00:00:01.000Z");
    });

    it("updates stepIds as JSON", () => {
      repo.createGoal(db, makeGoal() as never);
      repo.updateGoal(db, "goal-001", { stepIds: ["s1", "s2", "s3"] as unknown as readonly string[] });
      const updated = repo.getGoal(db, "goal-001");
      expect(updated!.stepIds).toEqual(["s1", "s2", "s3"]);
    });

    it("lists active goals", () => {
      repo.createGoal(db, makeGoal({ id: "g1", status: "executing" }) as never);
      repo.createGoal(db, makeGoal({ id: "g2", status: "completed" }) as never);
      repo.createGoal(db, makeGoal({ id: "g3", status: "pending" }) as never);
      repo.createGoal(db, makeGoal({ id: "g4", status: "failed" }) as never);
      const active = repo.listActiveGoals(db);
      expect(active.map((g) => g.id).sort()).toEqual(["g1", "g3"]);
    });

    it("lists goals with filters", () => {
      repo.createGoal(db, makeGoal({ id: "g1", status: "completed", source: "user" }) as never);
      repo.createGoal(db, makeGoal({ id: "g2", status: "failed", source: "schedule" }) as never);
      const userGoals = repo.listGoals(db, { source: "user" });
      expect(userGoals).toHaveLength(1);
      expect(userGoals[0]!.id).toBe("g1");
    });

    it("returns null for missing goal", () => {
      expect(repo.getGoal(db, "nonexistent")).toBeNull();
    });
  });

  // ─── Steps ───

  describe("steps", () => {
    it("creates and retrieves a step", () => {
      const step = makeStep({
        verificationMethod: "deterministic_file",
        verificationActual: "hello world",
        verificationPatternFamily: "exact_content_with",
      });
      repo.createStep(db, step as never);
      const retrieved = repo.getStep(db, "step-001");
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe("step-001");
      expect(retrieved!.goalId).toBe("goal-001");
      expect(retrieved!.domain).toBe("exec");
      expect(retrieved!.verificationMethod).toBe("deterministic_file");
      expect(retrieved!.verificationActual).toBe("hello world");
      expect(retrieved!.verificationPatternFamily).toBe("exact_content_with");
    });

    it("updates step status and retryCount", () => {
      repo.createStep(db, makeStep() as never);
      repo.updateStep(db, "step-001", { status: "executing", retryCount: 1 });
      const updated = repo.getStep(db, "step-001");
      expect(updated!.status).toBe("executing");
      expect(updated!.retryCount).toBe(1);
    });

    it("gets steps by goal ID ordered by index", () => {
      repo.createStep(db, makeStep({ id: "s1", index: 0 }) as never);
      repo.createStep(db, makeStep({ id: "s2", index: 2 }) as never);
      repo.createStep(db, makeStep({ id: "s3", index: 1 }) as never);
      const steps = repo.getStepsByGoalId(db, "goal-001");
      expect(steps.map((s) => s.id)).toEqual(["s1", "s3", "s2"]);
    });
  });

  // ─── Iterations ───

  describe("iterations", () => {
    it("appends and retrieves iterations", () => {
      repo.appendIteration(db, makeIteration() as never);
      const iters = repo.getIterationsByGoalId(db, "goal-001");
      expect(iters).toHaveLength(1);
      expect(iters[0]!.reasoning).toBe("The current state suggests running the command");
    });

    it("preserves decision discriminated union through JSON round-trip", () => {
      const decision = { kind: "act" as const, action: { toolName: "browser", args: { url: "https://example.com" } } };
      repo.appendIteration(db, makeIteration({ decision }) as never);
      const iters = repo.getIterationsByGoalId(db, "goal-001");
      expect(iters[0]!.decision).toEqual(decision);
    });

    it("returns iterations ordered by index", () => {
      repo.appendIteration(db, makeIteration({ id: "i1", index: 0 }) as never);
      repo.appendIteration(db, makeIteration({ id: "i2", index: 2 }) as never);
      repo.appendIteration(db, makeIteration({ id: "i3", index: 1 }) as never);
      const iters = repo.getIterationsByGoalId(db, "goal-001");
      expect(iters.map((i) => i.id)).toEqual(["i1", "i3", "i2"]);
    });
  });
});
