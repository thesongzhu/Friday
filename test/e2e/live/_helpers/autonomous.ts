import Database from "better-sqlite3";
import * as path from "node:path";

import { pollUntil } from "./poll.js";

export interface AutonomousGoalSnapshot {
  id: string;
  status: string;
  description: string;
  failureReason?: string;
  stepIds: string[];
  currentStepIndex: number;
}

export interface AutonomousStepSnapshot {
  id: string;
  goalId: string;
  index: number;
  status: string;
  domain: string;
  instruction: string;
  plannedAction?: { toolName?: string; args?: Record<string, unknown> };
  verification?: { type?: string; description?: string; expected?: string; passed?: boolean; actual?: string };
  verificationMethod?: string;
  verificationActual?: string;
  verificationPatternFamily?: string;
  failureReason?: string;
}

function withReadonlyDb<T>(stateDir: string, fn: (db: Database.Database) => T): T {
  const db = new Database(path.join(stateDir, "friday.db"), { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function readAutonomousGoal(
  stateDir: string,
  goalId: string,
): AutonomousGoalSnapshot | null {
  return withReadonlyDb(stateDir, (db) => {
    const row = db.prepare(
      `SELECT id, status, description, failure_reason, step_ids_json, current_step_index
         FROM friday_autonomous_goals
        WHERE id = ?`,
    ).get(goalId) as {
      id: string;
      status: string;
      description: string;
      failure_reason: string | null;
      step_ids_json: string;
      current_step_index: number;
    } | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      status: row.status,
      description: row.description,
      failureReason: row.failure_reason ?? undefined,
      stepIds: JSON.parse(row.step_ids_json) as string[],
      currentStepIndex: row.current_step_index,
    };
  });
}

export function getLatestAutonomousGoalByDescriptionMarker(
  stateDir: string,
  marker: string,
): AutonomousGoalSnapshot | null {
  return withReadonlyDb(stateDir, (db) => {
    const row = db.prepare(
      `SELECT id, status, description, failure_reason, step_ids_json, current_step_index
         FROM friday_autonomous_goals
        WHERE description LIKE ?
        ORDER BY created_at DESC
        LIMIT 1`,
    ).get(`%${marker}%`) as {
      id: string;
      status: string;
      description: string;
      failure_reason: string | null;
      step_ids_json: string;
      current_step_index: number;
    } | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      status: row.status,
      description: row.description,
      failureReason: row.failure_reason ?? undefined,
      stepIds: JSON.parse(row.step_ids_json) as string[],
      currentStepIndex: row.current_step_index,
    };
  });
}

export async function waitForAutonomousGoalByDescriptionMarker(
  stateDir: string,
  marker: string,
  opts: { maxMs?: number; intervalMs?: number } = {},
): Promise<AutonomousGoalSnapshot> {
  return pollUntil(
    async () => getLatestAutonomousGoalByDescriptionMarker(stateDir, marker),
    (goal): goal is AutonomousGoalSnapshot => goal !== null,
    opts,
  );
}

export function listAutonomousSteps(
  stateDir: string,
  goalId: string,
): AutonomousStepSnapshot[] {
  return withReadonlyDb(stateDir, (db) => {
    const rows = db.prepare(
      `SELECT id, goal_id, idx, status, domain, instruction, planned_action_json, verification_json,
              verification_method, verification_actual, verification_pattern_family, failure_reason
         FROM friday_autonomous_steps
        WHERE goal_id = ?
        ORDER BY idx ASC`,
    ).all(goalId) as Array<{
      id: string;
      goal_id: string;
      idx: number;
      status: string;
      domain: string;
      instruction: string;
      planned_action_json: string | null;
      verification_json: string | null;
      verification_method: string | null;
      verification_actual: string | null;
      verification_pattern_family: string | null;
      failure_reason: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      goalId: row.goal_id,
      index: row.idx,
      status: row.status,
      domain: row.domain,
      instruction: row.instruction,
      plannedAction: row.planned_action_json
        ? JSON.parse(row.planned_action_json) as { toolName?: string; args?: Record<string, unknown> }
        : undefined,
      verification: row.verification_json
        ? JSON.parse(row.verification_json) as { type?: string; description?: string; expected?: string; passed?: boolean; actual?: string }
        : undefined,
      verificationMethod: row.verification_method ?? undefined,
      verificationActual: row.verification_actual ?? undefined,
      verificationPatternFamily: row.verification_pattern_family ?? undefined,
      failureReason: row.failure_reason ?? undefined,
    }));
  });
}

export async function waitForAutonomousSnapshot(
  stateDir: string,
  goalId: string,
  predicate: (input: { goal: AutonomousGoalSnapshot | null; steps: AutonomousStepSnapshot[] }) => boolean,
  opts: { maxMs?: number; intervalMs?: number } = {},
): Promise<{ goal: AutonomousGoalSnapshot; steps: AutonomousStepSnapshot[] }> {
  const settled = await pollUntil(
    async () => {
      const goal = readAutonomousGoal(stateDir, goalId);
      const steps = goal ? listAutonomousSteps(stateDir, goalId) : [];
      return { goal, steps };
    },
    predicate,
    opts,
  );
  if (!settled.goal) {
    throw new Error(`Autonomous goal ${goalId} disappeared before predicate settled`);
  }
  return { goal: settled.goal, steps: settled.steps };
}
