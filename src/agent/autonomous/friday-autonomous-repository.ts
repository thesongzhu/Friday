/**
 * Autonomous Engine SQLite Repository — persists goals, steps, and iterations.
 *
 * Write-through cache pattern: the engine keeps in-memory Maps for hot-path
 * performance; this repository provides durable SQLite persistence.
 *
 * @module agent/autonomous/friday-autonomous-repository
 */

import type Database from "better-sqlite3";
import type {
  FridayAutonomousGoal,
  FridayAutonomousGoalListFilters,
  FridayAutonomousIteration,
  FridayAutonomousStep,
  UUID,
} from "./friday-autonomous.types.js";
import { safeJsonParse } from "#utilities";

// ─── Row types ───

interface GoalRow {
  id: string;
  status: string;
  priority: string;
  source: string;
  description: string;
  success_criteria_json: string | null;
  max_iterations: number;
  timeout_ms: number;
  iteration_count: number;
  step_ids_json: string;
  current_step_index: number;
  parent_goal_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
}

interface StepRow {
  id: string;
  goal_id: string;
  idx: number;
  status: string;
  domain: string;
  instruction: string;
  planned_action_json: string | null;
  verification_json: string | null;
  max_retries: number;
  retry_count: number;
  observations_json: string;
  started_at: string | null;
  completed_at: string | null;
  failure_reason: string | null;
}

interface IterationRow {
  id: string;
  goal_id: string;
  step_id: string;
  idx: number;
  timestamp: string;
  observations_json: string;
  reasoning: string;
  decision_json: string;
  result_json: string | null;
  duration_ms: number;
  usage_input: number | null;
  usage_output: number | null;
}

// ─── Row-to-domain mappers ───

function goalRowToDomain(row: GoalRow): FridayAutonomousGoal {
  return {
    id: row.id,
    status: row.status as FridayAutonomousGoal["status"],
    priority: row.priority as FridayAutonomousGoal["priority"],
    source: row.source as FridayAutonomousGoal["source"],
    description: row.description,
    successCriteria: row.success_criteria_json
      ? safeJsonParse<FridayAutonomousGoal["successCriteria"]>(row.success_criteria_json) ?? undefined
      : undefined,
    maxIterations: row.max_iterations,
    timeoutMs: row.timeout_ms,
    iterationCount: row.iteration_count,
    stepIds: safeJsonParse<readonly string[]>(row.step_ids_json) ?? [],
    currentStepIndex: row.current_step_index,
    parentGoalId: row.parent_goal_id ?? undefined,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  };
}

function stepRowToDomain(row: StepRow): FridayAutonomousStep {
  return {
    id: row.id,
    goalId: row.goal_id,
    index: row.idx,
    status: row.status as FridayAutonomousStep["status"],
    domain: row.domain as FridayAutonomousStep["domain"],
    instruction: row.instruction,
    plannedAction: row.planned_action_json
      ? safeJsonParse<FridayAutonomousStep["plannedAction"]>(row.planned_action_json) ?? undefined
      : undefined,
    verification: row.verification_json
      ? safeJsonParse<FridayAutonomousStep["verification"]>(row.verification_json) ?? undefined
      : undefined,
    maxRetries: row.max_retries,
    retryCount: row.retry_count,
    observations: safeJsonParse<readonly unknown[]>(row.observations_json) ?? [],
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
  } as FridayAutonomousStep;
}

function iterationRowToDomain(row: IterationRow): FridayAutonomousIteration {
  return {
    id: row.id,
    goalId: row.goal_id,
    stepId: row.step_id,
    index: row.idx,
    timestamp: row.timestamp,
    observations: safeJsonParse<readonly unknown[]>(row.observations_json) ?? [],
    reasoning: row.reasoning,
    decision: safeJsonParse<FridayAutonomousIteration["decision"]>(row.decision_json)!,
    result: row.result_json
      ? safeJsonParse<FridayAutonomousIteration["result"]>(row.result_json) ?? undefined
      : undefined,
    durationMs: row.duration_ms,
    usageInput: row.usage_input ?? undefined,
    usageOutput: row.usage_output ?? undefined,
  } as FridayAutonomousIteration;
}

// ─── Repository interface ───

export interface FridayAutonomousRepository {
  createGoal(db: Database.Database, goal: FridayAutonomousGoal): void;
  updateGoal(db: Database.Database, goalId: UUID, patch: Partial<FridayAutonomousGoal>): void;
  getGoal(db: Database.Database, goalId: UUID): FridayAutonomousGoal | null;
  listGoals(db: Database.Database, filters?: FridayAutonomousGoalListFilters): FridayAutonomousGoal[];
  listActiveGoals(db: Database.Database): FridayAutonomousGoal[];

  createStep(db: Database.Database, step: FridayAutonomousStep): void;
  updateStep(db: Database.Database, stepId: UUID, patch: Partial<FridayAutonomousStep>): void;
  getStep(db: Database.Database, stepId: UUID): FridayAutonomousStep | null;
  getStepsByGoalId(db: Database.Database, goalId: UUID): FridayAutonomousStep[];

  appendIteration(db: Database.Database, iteration: FridayAutonomousIteration): void;
  getIterationsByGoalId(db: Database.Database, goalId: UUID): FridayAutonomousIteration[];
}

// ─── Field → column mapping for dynamic updates ───

const GOAL_FIELD_MAP: Record<string, string> = {
  status: "status",
  priority: "priority",
  source: "source",
  description: "description",
  successCriteria: "success_criteria_json",
  maxIterations: "max_iterations",
  timeoutMs: "timeout_ms",
  iterationCount: "iteration_count",
  stepIds: "step_ids_json",
  currentStepIndex: "current_step_index",
  parentGoalId: "parent_goal_id",
  startedAt: "started_at",
  completedAt: "completed_at",
  failureReason: "failure_reason",
};

const JSON_GOAL_FIELDS = new Set(["successCriteria", "stepIds"]);

const STEP_FIELD_MAP: Record<string, string> = {
  status: "status",
  domain: "domain",
  instruction: "instruction",
  plannedAction: "planned_action_json",
  verification: "verification_json",
  maxRetries: "max_retries",
  retryCount: "retry_count",
  observations: "observations_json",
  startedAt: "started_at",
  completedAt: "completed_at",
  failureReason: "failure_reason",
};

const JSON_STEP_FIELDS = new Set(["plannedAction", "verification", "observations"]);

// ─── Factory ───

export function createFridayAutonomousRepository(): FridayAutonomousRepository {
  return {
    createGoal(db, goal) {
      db.prepare(
        `INSERT INTO friday_autonomous_goals (
          id, status, priority, source, description, success_criteria_json,
          max_iterations, timeout_ms, iteration_count, step_ids_json,
          current_step_index, parent_goal_id, created_at, started_at,
          completed_at, failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        goal.id,
        goal.status,
        goal.priority,
        goal.source,
        goal.description,
        goal.successCriteria ? JSON.stringify(goal.successCriteria) : null,
        goal.maxIterations,
        goal.timeoutMs,
        goal.iterationCount,
        JSON.stringify(goal.stepIds),
        goal.currentStepIndex,
        goal.parentGoalId ?? null,
        goal.createdAt,
        goal.startedAt ?? null,
        goal.completedAt ?? null,
        goal.failureReason ?? null,
      );
    },

    updateGoal(db, goalId, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [field, value] of Object.entries(patch)) {
        const col = GOAL_FIELD_MAP[field];
        if (!col) continue;
        sets.push(`${col} = ?`);
        values.push(JSON_GOAL_FIELDS.has(field) ? JSON.stringify(value) : (value ?? null));
      }
      if (sets.length === 0) return;
      values.push(goalId);
      db.prepare(`UPDATE friday_autonomous_goals SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    },

    getGoal(db, goalId) {
      const row = db.prepare("SELECT * FROM friday_autonomous_goals WHERE id = ?").get(goalId) as GoalRow | undefined;
      return row ? goalRowToDomain(row) : null;
    },

    listGoals(db, filters) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filters?.status) { where.push("status = ?"); params.push(filters.status); }
      if (filters?.source) { where.push("source = ?"); params.push(filters.source); }
      if (filters?.parentGoalId) { where.push("parent_goal_id = ?"); params.push(filters.parentGoalId); }
      const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
      const limit = filters?.limit ?? 100;
      const rows = db.prepare(`SELECT * FROM friday_autonomous_goals ${whereClause} ORDER BY created_at DESC LIMIT ?`).all(...params, limit) as GoalRow[];
      return rows.map(goalRowToDomain);
    },

    listActiveGoals(db) {
      const rows = db.prepare(
        "SELECT * FROM friday_autonomous_goals WHERE status NOT IN ('completed', 'failed', 'cancelled') ORDER BY created_at ASC",
      ).all() as GoalRow[];
      return rows.map(goalRowToDomain);
    },

    createStep(db, step) {
      db.prepare(
        `INSERT INTO friday_autonomous_steps (
          id, goal_id, idx, status, domain, instruction, planned_action_json,
          verification_json, max_retries, retry_count, observations_json,
          started_at, completed_at, failure_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        step.id,
        step.goalId,
        step.index,
        step.status,
        step.domain,
        step.instruction,
        step.plannedAction ? JSON.stringify(step.plannedAction) : null,
        step.verification ? JSON.stringify(step.verification) : null,
        step.maxRetries,
        step.retryCount,
        JSON.stringify(step.observations),
        step.startedAt ?? null,
        step.completedAt ?? null,
        step.failureReason ?? null,
      );
    },

    updateStep(db, stepId, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [field, value] of Object.entries(patch)) {
        const col = STEP_FIELD_MAP[field];
        if (!col) continue;
        sets.push(`${col} = ?`);
        values.push(JSON_STEP_FIELDS.has(field) ? JSON.stringify(value) : (value ?? null));
      }
      if (sets.length === 0) return;
      values.push(stepId);
      db.prepare(`UPDATE friday_autonomous_steps SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    },

    getStep(db, stepId) {
      const row = db.prepare("SELECT * FROM friday_autonomous_steps WHERE id = ?").get(stepId) as StepRow | undefined;
      return row ? stepRowToDomain(row) : null;
    },

    getStepsByGoalId(db, goalId) {
      const rows = db.prepare("SELECT * FROM friday_autonomous_steps WHERE goal_id = ? ORDER BY idx ASC").all(goalId) as StepRow[];
      return rows.map(stepRowToDomain);
    },

    appendIteration(db, iteration) {
      db.prepare(
        `INSERT INTO friday_autonomous_iterations (
          id, goal_id, step_id, idx, timestamp, observations_json,
          reasoning, decision_json, result_json, duration_ms,
          usage_input, usage_output
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        iteration.id,
        iteration.goalId,
        iteration.stepId,
        iteration.index,
        iteration.timestamp,
        JSON.stringify(iteration.observations),
        iteration.reasoning,
        JSON.stringify(iteration.decision),
        iteration.result ? JSON.stringify(iteration.result) : null,
        iteration.durationMs,
        iteration.usageInput ?? null,
        iteration.usageOutput ?? null,
      );
    },

    getIterationsByGoalId(db, goalId) {
      const rows = db.prepare("SELECT * FROM friday_autonomous_iterations WHERE goal_id = ? ORDER BY idx ASC").all(goalId) as IterationRow[];
      return rows.map(iterationRowToDomain);
    },
  };
}
