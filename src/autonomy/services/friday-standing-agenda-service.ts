import type { FridaySqliteLayer } from "#state";
import { FridayDomainError } from "#errors";
import type {
  FridayAgendaItem,
  FridayAgendaRun,
  FridayAgendaRunStatus,
  FridayCreateStandingGoalInput,
  FridayImprovementRecord,
  FridayStandingGoal,
  FridayStandingGoalScope,
  FridayUpdateStandingGoalInput,
} from "../model/friday-controlled-autonomy.types.js";
import type { FridayAutonomyPolicyService } from "./friday-autonomy-policy-service.js";
import type { FridayCapabilityAcquisitionService } from "./friday-capability-acquisition-service.js";
import { inferRequiredCapabilities } from "./friday-capability-acquisition-service.js";

export interface CreateFridayStandingAgendaServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  policyService: FridayAutonomyPolicyService;
  acquisitionService: FridayCapabilityAcquisitionService;
}

export interface FridayStandingAgendaService {
  listStandingGoals(input: { userId: string; includeArchived?: boolean }): FridayStandingGoal[];
  createStandingGoal(input: FridayCreateStandingGoalInput): Promise<{ goal: FridayStandingGoal; agendaItem: FridayAgendaItem }>;
  updateStandingGoal(goalId: string, input: FridayUpdateStandingGoalInput): FridayStandingGoal;
  listAgenda(input: { userId: string; status?: string; limit?: number }): FridayAgendaItem[];
  approveAgendaItem(input: { agendaItemId: string; userId: string }): FridayAgendaItem;
  runAgendaItem(input: { agendaItemId: string; userId: string }): Promise<FridayAgendaRun>;
}

interface StandingGoalRow {
  id: string;
  user_id: string;
  title: string;
  objective: string;
  scope_json: string;
  triggers_json: string;
  budget_json: string;
  risk_policy_json: string;
  success_criteria_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface AgendaItemRow {
  id: string;
  user_id: string;
  standing_goal_id: string | null;
  source: string;
  title: string;
  summary: string;
  status: string;
  risk_level: string;
  plan_json: string;
  required_capabilities_json: string;
  approval_required: number;
  created_at: string;
  updated_at: string;
}

interface AgendaRunRow {
  id: string;
  agenda_item_id: string;
  user_id: string;
  status: string;
  plan_json: string;
  capability_check_json: string;
  evidence_json: string;
  verification_json: string;
  cost_json: string;
  rollback_json: string;
  improvement_records_json: string;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

const DEFAULT_SCOPE: FridayStandingGoalScope = {
  allowedTopics: [],
  blockedTopics: [],
  allowedResources: [],
  blockedResources: [],
};

export function createFridayStandingAgendaService(
  deps: CreateFridayStandingAgendaServiceDeps,
): FridayStandingAgendaService {
  const { db, idGenerator, nowIso, policyService, acquisitionService } = deps;

  function listStandingGoals(input: { userId: string; includeArchived?: boolean }): FridayStandingGoal[] {
    const rows = db.withReadConnection((conn) =>
      conn.prepare(
        `SELECT * FROM friday_standing_goals
         WHERE user_id = ?
           AND (? = 1 OR status != 'archived')
         ORDER BY updated_at DESC`,
      ).all(input.userId, input.includeArchived ? 1 : 0) as StandingGoalRow[],
    );
    return rows.map(rowToStandingGoal);
  }

  async function createStandingGoal(input: FridayCreateStandingGoalInput): Promise<{ goal: FridayStandingGoal; agendaItem: FridayAgendaItem }> {
    const now = nowIso();
    const goal: FridayStandingGoal = {
      id: idGenerator(),
      userId: input.userId,
      title: normalizeTitle(input.title ?? input.objective),
      objective: input.objective.trim(),
      scope: {
        ...DEFAULT_SCOPE,
        ...(input.scope ?? {}),
      },
      triggers: input.triggers?.length ? input.triggers : [{ kind: "manual" }],
      budget: {
        ...policyService.getPolicy().budget,
        ...(input.budget ?? {}),
      },
      riskPolicy: input.riskPolicy ?? {},
      successCriteria: input.successCriteria?.length
        ? input.successCriteria
        : [{ id: "default", description: "The agenda run produces evidence and a verification result." }],
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    saveStandingGoal(goal);
    const agendaItem = await createAgendaFromGoal(goal);
    return { goal, agendaItem };
  }

  function updateStandingGoal(goalId: string, input: FridayUpdateStandingGoalInput): FridayStandingGoal {
    const current = getStandingGoal(goalId);
    if (!current) {
      throw new FridayDomainError("STANDING_GOAL_NOT_FOUND", "Standing goal not found", {
        httpStatus: 404,
      });
    }
    const updated: FridayStandingGoal = {
      ...current,
      title: input.title ? normalizeTitle(input.title) : current.title,
      objective: input.objective?.trim() ?? current.objective,
      scope: input.scope ? { ...current.scope, ...input.scope } : current.scope,
      triggers: input.triggers ?? current.triggers,
      budget: input.budget ? { ...current.budget, ...input.budget } : current.budget,
      riskPolicy: input.riskPolicy ? { ...current.riskPolicy, ...input.riskPolicy } : current.riskPolicy,
      successCriteria: input.successCriteria ?? current.successCriteria,
      status: input.status ?? current.status,
      updatedAt: nowIso(),
    };
    saveStandingGoal(updated);
    return updated;
  }

  function listAgenda(input: { userId: string; status?: string; limit?: number }): FridayAgendaItem[] {
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
    const rows = db.withReadConnection((conn) =>
      input.status
        ? conn.prepare(
            `SELECT * FROM friday_agenda_items
             WHERE user_id = ? AND status = ?
             ORDER BY created_at DESC
             LIMIT ?`,
          ).all(input.userId, input.status, limit) as AgendaItemRow[]
        : conn.prepare(
            `SELECT * FROM friday_agenda_items
             WHERE user_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
          ).all(input.userId, limit) as AgendaItemRow[],
    );
    return rows.map(rowToAgendaItem);
  }

  function approveAgendaItem(input: { agendaItemId: string; userId: string }): FridayAgendaItem {
    const item = requireAgendaItem(input.agendaItemId, input.userId);
    const approved = {
      ...item,
      status: "approved" as const,
      updatedAt: nowIso(),
    };
    saveAgendaItem(approved);
    return approved;
  }

  async function runAgendaItem(input: { agendaItemId: string; userId: string }): Promise<FridayAgendaRun> {
    const item = requireAgendaItem(input.agendaItemId, input.userId);
    const policy = policyService.getPolicy();
    const startedAt = nowIso();

    if (policy.paused) {
      return persistAgendaRun(buildBlockedRun(item, "Autonomy is paused; agenda execution is blocked.", startedAt));
    }
    if (item.approvalRequired && item.status !== "approved") {
      return persistAgendaRun(buildBlockedRun(item, "Agenda item requires approval before execution.", startedAt));
    }

    const running = {
      ...item,
      status: "running" as const,
      updatedAt: startedAt,
    };
    saveAgendaItem(running);

    const capabilityCheck = await acquisitionService.startRun({
      userId: input.userId,
      goal: `${item.title}\n${item.summary}`,
      requiredCapabilities: item.requiredCapabilities,
    });
    const blocked = capabilityCheck.status === "human_blocked" || !capabilityCheck.executionSuggestion.canExecute;
    const completedAt = nowIso();
    const improvementRecords = blocked
      ? [buildImprovementRecord({
          userId: input.userId,
          sourceRunId: undefined,
          targetType: "failure_lesson",
          summary: `Agenda blocked by capability gap: ${capabilityCheck.executionSuggestion.reason}`,
          now: completedAt,
          id: idGenerator(),
        })]
      : [buildImprovementRecord({
          userId: input.userId,
          sourceRunId: undefined,
          targetType: "source_ranking",
          summary: "Agenda capability check succeeded; prefer verified runtime sources for this goal pattern.",
          now: completedAt,
          id: idGenerator(),
        })];

    const run = persistAgendaRun({
      id: idGenerator(),
      agendaItemId: item.id,
      userId: input.userId,
      status: blocked ? "blocked" : "completed",
      plan: capabilityCheck.plan,
      capabilityCheck,
      evidence: {
        agendaItemId: item.id,
        standingGoalId: item.standingGoalId,
        executionMode: "controlled_agenda",
        note: blocked
          ? "Execution stopped before task action because a required capability is not available."
          : "Low-risk agenda run completed the capability gate and is ready for task execution.",
      },
      verification: {
        passed: !blocked,
        summary: blocked ? capabilityCheck.executionSuggestion.reason : "Capability gate passed.",
      },
      cost: {
        usd: 0,
        networkCalls: 0,
        externalDownloads: 0,
        runtimeMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
      },
      rollback: {
        attempted: false,
        summary: blocked ? "No side effects were applied before blocking." : "No rollback needed.",
      },
      improvementRecords,
      startedAt,
      completedAt,
      createdAt: startedAt,
      updatedAt: completedAt,
    });

    for (const record of improvementRecords) {
      saveImprovementRecord({ ...record, sourceRunId: run.id });
    }
    saveAgendaItem({
      ...running,
      status: blocked ? "blocked" : "completed",
      updatedAt: completedAt,
    });
    return {
      ...run,
      improvementRecords: improvementRecords.map((record) => ({ ...record, sourceRunId: run.id })),
    };
  }

  async function createAgendaFromGoal(goal: FridayStandingGoal): Promise<FridayAgendaItem> {
    const requiredCapabilities = inferRequiredCapabilities(goal.objective);
    const capabilityPlan = await acquisitionService.plan({
      userId: goal.userId,
      goal: goal.objective,
      requiredCapabilities,
    });
    const item: FridayAgendaItem = {
      id: idGenerator(),
      userId: goal.userId,
      standingGoalId: goal.id,
      source: "standing_goal",
      title: goal.title,
      summary: goal.objective,
      status: "proposed",
      riskLevel: capabilityPlan.humanBlockers.length > 0 ? "high" : capabilityPlan.approvalReasons.length > 0 ? "medium" : "low",
      plan: capabilityPlan.plan,
      requiredCapabilities,
      approvalRequired: capabilityPlan.humanBlockers.length > 0 || capabilityPlan.approvalReasons.length > 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    saveAgendaItem(item);
    return item;
  }

  return {
    listStandingGoals,
    createStandingGoal,
    updateStandingGoal,
    listAgenda,
    approveAgendaItem,
    runAgendaItem,
  };

  function getStandingGoal(goalId: string): FridayStandingGoal | null {
    const row = db.withReadConnection((conn) =>
      conn.prepare("SELECT * FROM friday_standing_goals WHERE id = ?").get(goalId) as StandingGoalRow | undefined,
    );
    return row ? rowToStandingGoal(row) : null;
  }

  function requireAgendaItem(agendaItemId: string, userId: string): FridayAgendaItem {
    const row = db.withReadConnection((conn) =>
      conn.prepare("SELECT * FROM friday_agenda_items WHERE id = ? AND user_id = ?").get(agendaItemId, userId) as AgendaItemRow | undefined,
    );
    if (!row) {
      throw new FridayDomainError("AGENDA_ITEM_NOT_FOUND", "Agenda item not found", {
        httpStatus: 404,
      });
    }
    return rowToAgendaItem(row);
  }

  function saveStandingGoal(goal: FridayStandingGoal): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO friday_standing_goals (
          id,
          user_id,
          title,
          objective,
          scope_json,
          triggers_json,
          budget_json,
          risk_policy_json,
          success_criteria_json,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          objective = excluded.objective,
          scope_json = excluded.scope_json,
          triggers_json = excluded.triggers_json,
          budget_json = excluded.budget_json,
          risk_policy_json = excluded.risk_policy_json,
          success_criteria_json = excluded.success_criteria_json,
          status = excluded.status,
          updated_at = excluded.updated_at`,
      ).run(
        goal.id,
        goal.userId,
        goal.title,
        goal.objective,
        JSON.stringify(goal.scope),
        JSON.stringify(goal.triggers),
        JSON.stringify(goal.budget),
        JSON.stringify(goal.riskPolicy),
        JSON.stringify(goal.successCriteria),
        goal.status,
        goal.createdAt,
        goal.updatedAt,
      );
    });
  }

  function saveAgendaItem(item: FridayAgendaItem): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO friday_agenda_items (
          id,
          user_id,
          standing_goal_id,
          source,
          title,
          summary,
          status,
          risk_level,
          plan_json,
          required_capabilities_json,
          approval_required,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          risk_level = excluded.risk_level,
          plan_json = excluded.plan_json,
          required_capabilities_json = excluded.required_capabilities_json,
          approval_required = excluded.approval_required,
          updated_at = excluded.updated_at`,
      ).run(
        item.id,
        item.userId,
        item.standingGoalId ?? null,
        item.source,
        item.title,
        item.summary,
        item.status,
        item.riskLevel,
        JSON.stringify(item.plan),
        JSON.stringify(item.requiredCapabilities),
        item.approvalRequired ? 1 : 0,
        item.createdAt,
        item.updatedAt,
      );
    });
  }

  function persistAgendaRun(run: FridayAgendaRun): FridayAgendaRun {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO friday_agenda_runs (
          id,
          agenda_item_id,
          user_id,
          status,
          plan_json,
          capability_check_json,
          evidence_json,
          verification_json,
          cost_json,
          rollback_json,
          improvement_records_json,
          started_at,
          completed_at,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.id,
        run.agendaItemId,
        run.userId,
        run.status,
        JSON.stringify(run.plan),
        JSON.stringify(run.capabilityCheck),
        JSON.stringify(run.evidence),
        JSON.stringify(run.verification),
        JSON.stringify(run.cost),
        JSON.stringify(run.rollback),
        JSON.stringify(run.improvementRecords),
        run.startedAt,
        run.completedAt ?? null,
        run.createdAt,
        run.updatedAt,
      );
    });
    return run;
  }

  function saveImprovementRecord(record: FridayImprovementRecord): void {
    db.withWriteTransaction((conn) => {
      conn.prepare(
        `INSERT INTO friday_improvement_records (
          id,
          user_id,
          source_run_id,
          source_type,
          target_type,
          target_id,
          summary,
          changes_json,
          evidence_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.userId,
        record.sourceRunId ?? null,
        record.sourceType,
        record.targetType,
        record.targetId ?? null,
        record.summary,
        JSON.stringify(record.changes),
        JSON.stringify(record.evidence),
        record.createdAt,
      );
    });
  }

  function buildBlockedRun(item: FridayAgendaItem, reason: string, startedAt: string): FridayAgendaRun {
    const fallbackCapabilityCheck = {
      id: `blocked-${idGenerator()}`,
      userId: item.userId,
      goal: item.summary,
      status: "human_blocked" as const,
      requiredCapabilities: item.requiredCapabilities,
      missingCapabilities: item.requiredCapabilities,
      matrixSummary: {
        available: 0,
        needsVerification: 0,
        needsUserAction: item.requiredCapabilities.length,
        installable: 0,
        unsupported: 0,
      },
      policySnapshot: policyService.getPolicy(),
      candidates: [],
      plan: item.plan,
      humanBlockers: [reason],
      approvalReasons: [],
      verificationResults: [],
      registeredCapabilities: [],
      executionSuggestion: {
        canExecute: false,
        reason,
        requiredCapabilities: item.requiredCapabilities,
        nextAction: "complete_human_setup" as const,
      },
      createdAt: startedAt,
      updatedAt: startedAt,
    };
    const record = buildImprovementRecord({
      userId: item.userId,
      sourceRunId: undefined,
      targetType: "failure_lesson",
      summary: reason,
      now: startedAt,
      id: idGenerator(),
    });
    return {
      id: idGenerator(),
      agendaItemId: item.id,
      userId: item.userId,
      status: "blocked",
      plan: item.plan,
      capabilityCheck: fallbackCapabilityCheck,
      evidence: { reason },
      verification: { passed: false, summary: reason },
      cost: { usd: 0, networkCalls: 0, externalDownloads: 0, runtimeMs: 0 },
      rollback: { attempted: false, summary: "No side effects were applied." },
      improvementRecords: [record],
      startedAt,
      completedAt: startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    };
  }
}

function buildImprovementRecord(input: {
  id: string;
  userId: string;
  sourceRunId?: string;
  targetType: FridayImprovementRecord["targetType"];
  summary: string;
  now: string;
}): FridayImprovementRecord {
  return {
    id: input.id,
    userId: input.userId,
    sourceRunId: input.sourceRunId,
    sourceType: "agenda_run",
    targetType: input.targetType,
    summary: input.summary,
    changes: {
      modelTraining: false,
      persistedTo: input.targetType,
    },
    evidence: {
      rationale: "Friday self-improvement updates strategy/memory/routing/evals only; it does not train model weights.",
    },
    createdAt: input.now,
  };
}

function normalizeTitle(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function rowToStandingGoal(row: StandingGoalRow): FridayStandingGoal {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    objective: row.objective,
    scope: readJson(row.scope_json, DEFAULT_SCOPE),
    triggers: readJson(row.triggers_json, []),
    budget: readJson(row.budget_json, {}),
    riskPolicy: readJson(row.risk_policy_json, {}),
    successCriteria: readJson(row.success_criteria_json, []),
    status: row.status as FridayStandingGoal["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAgendaItem(row: AgendaItemRow): FridayAgendaItem {
  return {
    id: row.id,
    userId: row.user_id,
    ...(row.standing_goal_id ? { standingGoalId: row.standing_goal_id } : {}),
    source: row.source as FridayAgendaItem["source"],
    title: row.title,
    summary: row.summary,
    status: row.status as FridayAgendaItem["status"],
    riskLevel: row.risk_level as FridayAgendaItem["riskLevel"],
    plan: readJson(row.plan_json, []),
    requiredCapabilities: readJson(row.required_capabilities_json, []),
    approvalRequired: row.approval_required === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
