import { FridayDomainError } from "#errors";
import type { FridaySqliteLayer } from "#state";
import type {
  FridayApprovalWorkflowService,
  FridayAutoFixActionRepository,
  FridayAutoFixDispatcherService,
  FridayAutoFixExecutionResult,
  FridayAutoFixExecutionService,
  FridayAutoFixRiskTier,
  FridayDiagnosisRecordRepository,
  FridayErrorIncidentRepository,
  FridayLearnedLessonRepository,
  FridaySelfHealingActionDetails,
  FridaySelfHealingApiService,
  FridaySelfHealingEventPublisher,
  FridaySelfLearningProcessResult,
  UUID,
} from "#learning";
import type {
  FridayAgentLoopExpertModeSummary,
  FridayAgentLoopHaltReason,
  FridayAgentLoopPolicyEntity,
  FridayAgentLoopRunEntity,
  FridayAgentLoopRunStatus,
  FridayAgentLoopTrigger,
  FridayExpertAutonomyEvidence,
  FridayExpertAutonomyHypothesis,
  FridayExpertAutonomyProbeStep,
  FridayExpertAutonomyRiskClass,
} from "../model/friday-agent-loop.types.js";
import type { FridayAgentLoopRepository } from "../persistence/friday-agent-loop-repository.js";
import type { FridayObservabilityApiService } from "../../observability/services/friday-observability-api-service.js";

export interface FridayAgentLoopRunDetails {
  run: FridayAgentLoopRunEntity;
  incident: ReturnType<FridaySelfHealingApiService["getIncident"]>;
  action: FridaySelfHealingActionDetails | null;
}

export interface FridayAgentLoopService {
  getPolicy(): FridayAgentLoopPolicyEntity;
  updatePolicy(input: Partial<Omit<FridayAgentLoopPolicyEntity, "id" | "updatedAt">>): FridayAgentLoopPolicyEntity;
  getExpertMode(userId?: string): FridayAgentLoopExpertModeSummary;
  updateExpertMode(
    input: Partial<
      Pick<
        FridayAgentLoopPolicyEntity,
        | "expertModeEnabled"
        | "expertModeUserIds"
        | "expertModeWorkspaceIds"
        | "expertModeEnvironments"
        | "contextInferenceAllowed"
        | "multiStepHypothesisSearchAllowed"
        | "safeProbeExecutionAllowed"
        | "crossSurfaceOrchestrationAllowed"
        | "highRiskFinalApprovalRequired"
        | "productionDestructiveActionApprovalRequired"
        | "probeBudget"
        | "timeBudgetMinutes"
      >
    >,
  ): FridayAgentLoopExpertModeSummary;
  listRuns(input: {
    userId?: string;
    status?: FridayAgentLoopRunStatus;
    limit?: number;
  }): FridayAgentLoopRunDetails[];
  listExpertRuns(input: {
    userId?: string;
    status?: FridayAgentLoopRunStatus;
    limit?: number;
  }): FridayAgentLoopRunDetails[];
  getRun(input: {
    loopRunId: string;
  }): FridayAgentLoopRunDetails | null;
  getExpertRun(input: {
    loopRunId: string;
  }): FridayAgentLoopRunDetails | null;
  pauseRun(input: {
    loopRunId: string;
  }): FridayAgentLoopRunDetails;
  resumeRun(input: {
    loopRunId: string;
  }): Promise<FridayAgentLoopRunDetails>;
  cancelRun(input: {
    loopRunId: string;
  }): FridayAgentLoopRunDetails;
  resumeCooldownRuns(input?: {
    limit?: number;
    trigger?: FridayAgentLoopTrigger;
    nowIso?: string;
  }): Promise<FridayAgentLoopRunDetails[]>;
  handleProcessResults(input: {
    results: FridaySelfLearningProcessResult[];
    correlationId?: string;
  }): Promise<FridayAgentLoopRunDetails[]>;
  syncAction(input: {
    actionId: UUID;
    trigger?: FridayAgentLoopTrigger;
    correlationId?: string;
  }): Promise<FridayAgentLoopRunDetails | null>;
  findRunByActionId(actionId: string): FridayAgentLoopRunEntity | null;
  findRunByIncidentId(incidentId: string): FridayAgentLoopRunEntity | null;
}

export interface CreateFridayAgentLoopServiceDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  loopRepo: FridayAgentLoopRepository;
  incidentRepo: FridayErrorIncidentRepository;
  diagnosisRepo: FridayDiagnosisRecordRepository;
  actionRepo: FridayAutoFixActionRepository;
  lessonRepo: FridayLearnedLessonRepository;
  approvalService: FridayApprovalWorkflowService;
  executionService: FridayAutoFixExecutionService;
  dispatcher: FridayAutoFixDispatcherService;
  selfHealing: FridaySelfHealingApiService;
  observability?: FridayObservabilityApiService;
  publishEvent?: FridaySelfHealingEventPublisher;
}

const DEFAULT_POLICY_ID = "default";

function buildDefaultPolicy(nowIso: string): FridayAgentLoopPolicyEntity {
  return {
    id: DEFAULT_POLICY_ID,
    mode: "tiered_supervised",
    paused: false,
    autoApplyLowRisk: true,
    maxAttemptsPerFingerprint: 3,
    cooldownMinutes: 30,
    requireRollbackPlan: true,
    requireAcceptanceCheck: true,
    expertModeEnabled: false,
    expertModeUserIds: [],
    expertModeWorkspaceIds: [],
    expertModeEnvironments: [],
    contextInferenceAllowed: true,
    multiStepHypothesisSearchAllowed: true,
    safeProbeExecutionAllowed: true,
    crossSurfaceOrchestrationAllowed: true,
    highRiskFinalApprovalRequired: true,
    productionDestructiveActionApprovalRequired: true,
    probeBudget: 4,
    timeBudgetMinutes: 20,
    updatedAt: nowIso,
  };
}

function requiresApproval(riskTier: FridayAutoFixRiskTier): boolean {
  return riskTier >= 2;
}

function hasRollbackPlan(details: FridaySelfHealingActionDetails): boolean {
  return details.evidence.selectedPlan.rollbackPlanAvailable;
}

function hasAcceptanceCheck(details: FridaySelfHealingActionDetails): boolean {
  return details.action.plan.steps.some((step) => step.verify !== undefined);
}

function addMinutes(nowIso: string, minutes: number): string {
  return new Date(new Date(nowIso).getTime() + minutes * 60_000).toISOString();
}

function currentWorkspaceId(): string {
  return process.env.FRIDAY_WORKSPACE_ID?.trim() || "default-workspace";
}

function currentEnvironment(): string {
  return process.env.FRIDAY_RUNTIME_ENV?.trim()
    || process.env.NODE_ENV?.trim()
    || "development";
}

function matchesScope(values: string[], currentValue: string): boolean {
  return values.length === 0 || values.includes(currentValue);
}

function isExpertModeActive(policy: FridayAgentLoopPolicyEntity, userId?: string): boolean {
  if (!policy.expertModeEnabled) {
    return false;
  }
  if (policy.expertModeUserIds.length > 0 && (!userId || !policy.expertModeUserIds.includes(userId))) {
    return false;
  }
  return (
    matchesScope(policy.expertModeWorkspaceIds, currentWorkspaceId())
    && matchesScope(policy.expertModeEnvironments, currentEnvironment())
  );
}

function toExpertModeSummary(
  policy: FridayAgentLoopPolicyEntity,
  userId?: string,
): FridayAgentLoopExpertModeSummary {
  return {
    enabled: policy.expertModeEnabled,
    activeForCurrentRuntime: isExpertModeActive(policy, userId),
    allowedUserIds: [...policy.expertModeUserIds],
    allowedWorkspaceIds: [...policy.expertModeWorkspaceIds],
    allowedEnvironments: [...policy.expertModeEnvironments],
    contextInferenceAllowed: policy.contextInferenceAllowed,
    multiStepHypothesisSearchAllowed: policy.multiStepHypothesisSearchAllowed,
    safeProbeExecutionAllowed: policy.safeProbeExecutionAllowed,
    crossSurfaceOrchestrationAllowed: policy.crossSurfaceOrchestrationAllowed,
    highRiskFinalApprovalRequired: policy.highRiskFinalApprovalRequired,
    productionDestructiveActionApprovalRequired: policy.productionDestructiveActionApprovalRequired,
    probeBudget: policy.probeBudget,
    timeBudgetMinutes: policy.timeBudgetMinutes,
  };
}

function inferRiskClass(input: {
  action: FridaySelfHealingActionDetails | null;
  policy: FridayAgentLoopPolicyEntity;
}): FridayExpertAutonomyRiskClass {
  if (!input.action) {
    return "safe_probe";
  }
  const planText = `${input.action.action.plan.title} ${input.action.action.plan.summary}`.toLowerCase();
  if (
    planText.includes("delete")
    || planText.includes("credential")
    || planText.includes("production")
    || planText.includes("secret")
  ) {
    return "destructive_or_sensitive";
  }
  if (input.action.action.riskTier >= 2 || input.policy.productionDestructiveActionApprovalRequired) {
    return "bounded_repair";
  }
  return "safe_probe";
}

function buildExpertEvidence(input: {
  incident: NonNullable<ReturnType<FridaySelfHealingApiService["getIncident"]>>;
  action: FridaySelfHealingActionDetails | null;
  policy: FridayAgentLoopPolicyEntity;
}): FridayExpertAutonomyEvidence {
  const objective = input.action?.action.plan.title
    ?? `Resolve ${input.incident.incident.category} incident`;
  const assumptions: string[] = [];
  if (input.policy.contextInferenceAllowed) {
    assumptions.push(`Workspace is ${currentWorkspaceId()}.`);
    assumptions.push(`Environment defaults to ${currentEnvironment()}.`);
  }
  if (input.action?.risk.requiresApproval) {
    assumptions.push("A final approval may still be required before mutating high-risk state.");
  }
  const unknowns: string[] = [];
  if (!input.incident.diagnosis) {
    unknowns.push("No diagnosis record was attached to the incident.");
  }
  if (!input.action) {
    unknowns.push("No actionable fix plan is available yet.");
  }
  const hypotheses: FridayExpertAutonomyHypothesis[] = [
    {
      id: "primary-hypothesis",
      summary: input.incident.diagnosis
        ? `The diagnosis record suggests ${input.incident.incident.category} failure fingerprint ${input.incident.diagnosis.errorFingerprint}.`
        : `The incident signature ${input.incident.incident.signature} is the most likely failure source.`,
      confidence: input.incident.diagnosis?.confidence ?? 0.55,
      validationCost: "low",
      supportingEvidence: [
        `incident:${input.incident.incident.incidentId}`,
        input.incident.diagnosis ? `diagnosis:${input.incident.diagnosis.id}` : "diagnosis:missing",
      ],
      status: "chosen",
    },
  ];
  const probeSteps: FridayExpertAutonomyProbeStep[] = input.policy.safeProbeExecutionAllowed
    ? [
      {
        id: "probe-read-diagnosis",
        title: "Inspect current diagnosis evidence",
        kind: "read_only_inspection",
        summary: "Read the incident, diagnosis, and prior lesson evidence before applying a repair.",
        safe: true,
        status: "completed",
        evidence: input.incident.diagnosis
          ? `confidence:${input.incident.diagnosis.confidence}`
          : "diagnosis-missing",
      },
      {
        id: "probe-acceptance-check",
        title: "Confirm acceptance coverage",
        kind: "simulation",
        summary: "Check whether the selected repair can be verified and rolled back.",
        safe: true,
        status: input.action ? "completed" : "blocked",
        evidence: input.action
          ? `rollback:${input.action.evidence.selectedPlan.rollbackPlanAvailable};acceptance:${input.action.evidence.acceptanceResult.reason}`
          : "action-missing",
      },
    ]
    : [];
  return {
    objective,
    planSummary: input.action?.action.plan.summary
      ?? "Friday still needs to generate a bounded repair plan before it can proceed.",
    assumptions,
    unknowns,
    hypotheses,
    probeSteps,
    evidenceGathered: [
      `incident:${input.incident.incident.incidentId}`,
      input.action ? `action:${input.action.action.actionId}` : "action:none",
    ],
    repairAttempted: input.action?.action.plan.title,
    acceptanceOutcome: input.action?.evidence.acceptanceResult.reason,
    rollbackOutcome: input.action?.evidence.rollbackResult.available
      ? "Rollback is available if verification fails."
      : "Rollback is not available.",
  };
}

export function createFridayAgentLoopService(
  deps: CreateFridayAgentLoopServiceDeps,
): FridayAgentLoopService {
  const ensurePolicy = (): FridayAgentLoopPolicyEntity => {
    const existing = deps.db.withWriteTransaction((db) => {
      const current = deps.loopRepo.getPolicy(db);
      if (current) {
        return current;
      }
      const created = buildDefaultPolicy(deps.nowIso());
      deps.loopRepo.upsertPolicy(db, created);
      return created;
    });
    return existing;
  };

  const buildRunDetails = (run: FridayAgentLoopRunEntity): FridayAgentLoopRunDetails => ({
    run,
    incident: deps.selfHealing.getIncident({ incidentId: run.incidentId }),
    action: run.actionId ? deps.selfHealing.getAction({ actionId: run.actionId }) : null,
  });

  const buildRunDetailsList = (runs: FridayAgentLoopRunEntity[]): FridayAgentLoopRunDetails[] => {
    const incidentsById = new Map(
      deps.selfHealing
        .listIncidentDetailsByIds({
          incidentIds: runs.map((run) => run.incidentId),
        })
        .map((incident) => [incident.incident.incidentId, incident] as const),
    );
    const actionIds = runs.flatMap((run) => (run.actionId ? [run.actionId] : []));
    const actionsById = new Map(
      deps.selfHealing
        .listActionDetailsByIds({
          actionIds,
        })
        .map((action) => [action.action.actionId, action] as const),
    );
    return runs.map((run) => ({
      run,
      incident: incidentsById.get(run.incidentId) ?? deps.selfHealing.getIncident({ incidentId: run.incidentId }),
      action: run.actionId
        ? actionsById.get(run.actionId) ?? deps.selfHealing.getAction({ actionId: run.actionId })
        : null,
    }));
  };

  const emitLoopEvent = async (
    event: string,
    run: FridayAgentLoopRunEntity,
    details: FridayAgentLoopRunDetails,
  ): Promise<void> => {
    deps.publishEvent?.publish(
      `agent-loop:${run.userId}`,
      event,
      {
        loopRunId: run.loopRunId,
        incidentId: run.incidentId,
        actionId: run.actionId,
        status: run.status,
        riskTier: run.riskTier,
        attemptNumber: run.attemptNumber,
        approvalRequired: run.approvalRequired,
        haltReason: run.haltReason,
      },
      run.correlationId,
    );
    await deps.observability?.recordAgentLoopEvent({
      event,
      run,
      details,
    });
  };

  const createRun = (input: {
    incidentId: string;
    action: FridaySelfHealingActionDetails | null;
    trigger: FridayAgentLoopTrigger;
    correlationId?: string;
    status: FridayAgentLoopRunStatus;
    haltReason?: FridayAgentLoopHaltReason;
    lastError?: string;
    pausedAt?: string;
    cooldownUntil?: string;
  }): FridayAgentLoopRunEntity => {
    const incident = deps.selfHealing.getIncident({ incidentId: input.incidentId });
    if (!incident) {
      throw new FridayDomainError("AGENT_LOOP_INCIDENT_NOT_FOUND", "Incident not found", {
        httpStatus: 404,
      });
    }
    const fingerprint = input.action?.action.plan.evidence.fingerprint
      ?? incident.diagnosis?.errorFingerprint
      ?? incident.incident.signature;
    const policy = ensurePolicy();
    const expertModeEnabled = isExpertModeActive(policy, incident.incident.userId);
    const expertEvidence = buildExpertEvidence({
      incident,
      action: input.action,
      policy,
    });
    const riskClass = inferRiskClass({
      action: input.action,
      policy,
    });
    const requiresFinalApproval = (
      riskClass === "destructive_or_sensitive"
      || (input.action?.action.riskTier ?? 0) >= 2
    ) && policy.highRiskFinalApprovalRequired;
    const attemptNumber = deps.db.withReadConnection((db) =>
      deps.loopRepo.countFailuresByFingerprint(db, incident.incident.userId, fingerprint)
    ) + 1;
    const nowIso = deps.nowIso();
    const run: FridayAgentLoopRunEntity = {
      loopRunId: deps.idGenerator(),
      userId: incident.incident.userId,
      incidentId: incident.incident.incidentId,
      actionId: input.action?.action.actionId,
      fingerprint,
      trigger: input.trigger,
      status: input.status,
      riskTier: input.action?.action.riskTier ?? 2,
      approvalRequired: requiresFinalApproval,
      attemptNumber,
      rollbackAttempted: false,
      rollbackSucceeded: false,
      haltReason: input.haltReason,
      lastError: input.lastError,
      correlationId: input.correlationId,
      pausedAt: input.pausedAt,
      cooldownUntil: input.cooldownUntil,
      expertModeEnabled,
      riskClass,
      requiresFinalApproval,
      assumptions: expertEvidence.assumptions,
      unknowns: expertEvidence.unknowns,
      hypotheses: expertEvidence.hypotheses,
      probeSteps: expertEvidence.probeSteps,
      probeBudget: policy.probeBudget,
      objective: expertEvidence.objective,
      planSummary: expertEvidence.planSummary,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    return deps.db.withWriteTransaction((db) => deps.loopRepo.insertRun(db, run));
  };

  const updateRun = (
    loopRunId: string,
    patch: Partial<FridayAgentLoopRunEntity>,
  ): FridayAgentLoopRunEntity => {
    const updated = deps.db.withWriteTransaction((db) =>
      deps.loopRepo.updateRun(db, loopRunId, {
        ...patch,
        updatedAt: deps.nowIso(),
      })
    );
    if (!updated) {
      throw new FridayDomainError("AGENT_LOOP_RUN_NOT_FOUND", "Agent loop run not found", {
        httpStatus: 404,
      });
    }
    return updated;
  };

  const finalizeExecution = async (input: {
    run: FridayAgentLoopRunEntity;
    result: FridayAutoFixExecutionResult;
  }): Promise<FridayAgentLoopRunDetails> => {
    const details = input.run.actionId
      ? deps.selfHealing.getAction({ actionId: input.run.actionId })
      : null;
    const nowIso = deps.nowIso();
    const lessonId = details?.evidence.extractedLesson?.id;
    const failureCount = deps.db.withReadConnection((db) =>
      deps.loopRepo.countFailuresByFingerprint(db, input.run.userId, input.run.fingerprint),
    ) + (input.result.success ? 0 : 1);
    const policy = ensurePolicy();

    let status: FridayAgentLoopRunStatus;
    let haltReason: FridayAgentLoopHaltReason | undefined;
    let cooldownUntil: string | undefined;

    if (input.result.success && input.result.verificationPassed) {
      status = "verified";
    } else if (failureCount >= policy.maxAttemptsPerFingerprint) {
      status = "halted";
      haltReason = "failure_budget_exhausted";
    } else if (input.result.rollbackAttempted && input.result.rollbackSucceeded) {
      status = policy.cooldownMinutes > 0 ? "cooldown" : "rolled_back";
      cooldownUntil = policy.cooldownMinutes > 0 ? addMinutes(nowIso, policy.cooldownMinutes) : undefined;
    } else {
      status = "failed";
      haltReason = input.result.verificationPassed ? "execution_failed" : "verification_failed";
    }

    const updated = updateRun(input.run.loopRunId, {
      status,
      verificationPassed: input.result.verificationPassed,
      rollbackAttempted: input.result.rollbackAttempted,
      rollbackSucceeded: input.result.rollbackSucceeded,
      haltReason,
      lastError: input.result.errorMessage,
      lessonId,
      cooldownUntil,
      completedAt: nowIso,
    });
    const nextDetails = buildRunDetails(updated);
    await emitLoopEvent("agent-loop.run.completed", updated, nextDetails);
    return nextDetails;
  };

  const executeRun = async (
    run: FridayAgentLoopRunEntity,
    trigger: FridayAgentLoopTrigger,
  ): Promise<FridayAgentLoopRunDetails> => {
    const actionDetails = run.actionId
      ? deps.selfHealing.getAction({ actionId: run.actionId })
      : null;
    if (!actionDetails || !run.actionId) {
      const updated = updateRun(run.loopRunId, {
        trigger,
        status: "failed",
        haltReason: "execution_failed",
        lastError: "No action was available for this loop run",
        completedAt: deps.nowIso(),
      });
      const details = buildRunDetails(updated);
      await emitLoopEvent("agent-loop.run.failed", updated, details);
      return details;
    }

    const approval = actionDetails.approval;
    const executing = updateRun(run.loopRunId, {
      trigger,
      status: "running",
      approvalRequired: requiresApproval(actionDetails.action.riskTier),
      startedAt: deps.nowIso(),
      pausedAt: undefined,
      resumedAt: trigger === "manual_resume" ? deps.nowIso() : undefined,
      haltReason: undefined,
      lastError: undefined,
    });
    await emitLoopEvent("agent-loop.run.started", executing, buildRunDetails(executing));

    let result: FridayAutoFixExecutionResult;
    if (run.requiresFinalApproval) {
      if (approval?.status !== "approved") {
        const pending = updateRun(run.loopRunId, {
          status: "awaiting_approval",
          haltReason: "approval_required",
        });
        const details = buildRunDetails(pending);
        await emitLoopEvent("agent-loop.run.awaiting-approval", pending, details);
        return details;
      }
      result = await deps.dispatcher.runApprovedAction(actionDetails.action.actionId);
    } else {
      result = await deps.executionService.execute(actionDetails.action.actionId);
    }

    return finalizeExecution({
      run: executing,
      result,
    });
  };

  const maybeCreateOrAdvanceRun = async (input: {
    incidentId: string;
    trigger: FridayAgentLoopTrigger;
    correlationId?: string;
  }): Promise<FridayAgentLoopRunDetails | null> => {
    const policy = ensurePolicy();
    const incident = deps.selfHealing.getIncident({ incidentId: input.incidentId });
    if (!incident) {
      return null;
    }
    const action = incident.action ?? null;

    if (policy.paused) {
      const run = createRun({
        incidentId: incident.incident.incidentId,
        action,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "paused",
        haltReason: "policy_paused",
        pausedAt: deps.nowIso(),
      });
      const details = buildRunDetails(run);
      await emitLoopEvent("agent-loop.run.paused", run, details);
      return details;
    }

    if (!action) {
      const run = createRun({
        incidentId: incident.incident.incidentId,
        action: null,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "halted",
        haltReason: "execution_failed",
        lastError: "No actionable fix plan was created for this incident",
      });
      const details = buildRunDetails(run);
      await emitLoopEvent("agent-loop.run.halted", run, details);
      return details;
    }

    const failureCount = deps.db.withReadConnection((db) =>
      deps.loopRepo.countFailuresByFingerprint(
        db,
        action.action.userId,
        action.action.plan.evidence.fingerprint,
      ),
    );
    if (failureCount >= policy.maxAttemptsPerFingerprint) {
      const halted = createRun({
        incidentId: incident.incident.incidentId,
        action,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "halted",
        haltReason: "failure_budget_exhausted",
        lastError: "Friday paused itself after repeated failures on this fingerprint",
      });
      const details = buildRunDetails(halted);
      await emitLoopEvent("agent-loop.run.halted", halted, details);
      return details;
    }

    const requiresFinalApproval = (
      inferRiskClass({ action, policy }) === "destructive_or_sensitive"
      || requiresApproval(action.action.riskTier)
    ) && policy.highRiskFinalApprovalRequired;

    if (requiresFinalApproval) {
      const awaiting = createRun({
        incidentId: incident.incident.incidentId,
        action,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "awaiting_approval",
        haltReason: "approval_required",
      });
      const details = buildRunDetails(awaiting);
      await emitLoopEvent("agent-loop.run.awaiting-approval", awaiting, details);
      return details;
    }

    if (policy.requireRollbackPlan && !hasRollbackPlan(action)) {
      const halted = createRun({
        incidentId: incident.incident.incidentId,
        action,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "halted",
        haltReason: "missing_rollback_plan",
        lastError: "Friday skipped this fix because it has no rollback plan",
      });
      const details = buildRunDetails(halted);
      await emitLoopEvent("agent-loop.run.halted", halted, details);
      return details;
    }

    if (policy.requireAcceptanceCheck && !hasAcceptanceCheck(action)) {
      const halted = createRun({
        incidentId: incident.incident.incidentId,
        action,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "halted",
        haltReason: "missing_acceptance_check",
        lastError: "Friday skipped this fix because it has no acceptance verification",
      });
      const details = buildRunDetails(halted);
      await emitLoopEvent("agent-loop.run.halted", halted, details);
      return details;
    }

    if (!policy.autoApplyLowRisk) {
      const paused = createRun({
        incidentId: incident.incident.incidentId,
        action,
        trigger: input.trigger,
        correlationId: input.correlationId,
        status: "paused",
        haltReason: "policy_paused",
        pausedAt: deps.nowIso(),
      });
      const details = buildRunDetails(paused);
      await emitLoopEvent("agent-loop.run.paused", paused, details);
      return details;
    }

    const run = createRun({
      incidentId: incident.incident.incidentId,
      action,
      trigger: input.trigger,
      correlationId: input.correlationId,
      status: "running",
    });
    return executeRun(run, input.trigger);
  };

  return {
    getPolicy() {
      return ensurePolicy();
    },

    updatePolicy(input) {
      const current = ensurePolicy();
      const next: FridayAgentLoopPolicyEntity = {
        ...current,
        ...input,
        id: DEFAULT_POLICY_ID,
        updatedAt: deps.nowIso(),
      };
      return deps.db.withWriteTransaction((db) => deps.loopRepo.upsertPolicy(db, next));
    },

    getExpertMode(userId) {
      return toExpertModeSummary(ensurePolicy(), userId);
    },

    updateExpertMode(input) {
      const current = ensurePolicy();
      const next = deps.db.withWriteTransaction((db) =>
        deps.loopRepo.upsertPolicy(db, {
          ...current,
          ...input,
          id: DEFAULT_POLICY_ID,
          updatedAt: deps.nowIso(),
        }),
      );
      return toExpertModeSummary(next);
    },

    listRuns(input) {
      const runs = deps.db.withReadConnection((db) => deps.loopRepo.listRuns(db, input));
      return buildRunDetailsList(runs);
    },

    listExpertRuns(input) {
      const runs = deps.db.withReadConnection((db) => deps.loopRepo.listRuns(db, input));
      return buildRunDetailsList(runs.filter((run) => run.expertModeEnabled));
    },

    getRun(input) {
      const run = deps.db.withReadConnection((db) => deps.loopRepo.getRunById(db, input.loopRunId));
      return run ? buildRunDetails(run) : null;
    },

    getExpertRun(input) {
      const run = deps.db.withReadConnection((db) => deps.loopRepo.getRunById(db, input.loopRunId));
      if (!run || !run.expertModeEnabled) {
        return null;
      }
      return buildRunDetails(run);
    },

    pauseRun(input) {
      const current = this.getRun({ loopRunId: input.loopRunId });
      if (!current) {
        throw new FridayDomainError("AGENT_LOOP_RUN_NOT_FOUND", "Agent loop run not found", {
          httpStatus: 404,
        });
      }
      if (current.run.status === "verified" || current.run.status === "cancelled") {
        return current;
      }
      const updated = updateRun(input.loopRunId, {
        status: "paused",
        haltReason: "manual_pause",
        pausedAt: deps.nowIso(),
      });
      return buildRunDetails(updated);
    },

    async resumeRun(input) {
      const current = this.getRun({ loopRunId: input.loopRunId });
      if (!current) {
        throw new FridayDomainError("AGENT_LOOP_RUN_NOT_FOUND", "Agent loop run not found", {
          httpStatus: 404,
        });
      }
      if (current.run.status === "cancelled" || current.run.status === "verified") {
        return current;
      }
      const updated = updateRun(input.loopRunId, {
        resumedAt: deps.nowIso(),
      });
      return executeRun(updated, "manual_resume");
    },

    cancelRun(input) {
      const current = this.getRun({ loopRunId: input.loopRunId });
      if (!current) {
        throw new FridayDomainError("AGENT_LOOP_RUN_NOT_FOUND", "Agent loop run not found", {
          httpStatus: 404,
        });
      }
      if (current.action?.approval?.status === "pending") {
        void deps.approvalService.reject({
          requestId: current.action.approval.requestId,
          respondedBy: "agent-loop",
          reason: "Cancelled by operator",
          nowIso: deps.nowIso(),
        });
      }
      const updated = updateRun(input.loopRunId, {
        status: "cancelled",
        haltReason: "manual_cancel",
        cancelledAt: deps.nowIso(),
        completedAt: deps.nowIso(),
      });
      return buildRunDetails(updated);
    },

    async resumeCooldownRuns(input) {
      const nowIso = input?.nowIso ?? deps.nowIso();
      const policy = ensurePolicy();
      const candidates = deps.db.withReadConnection((db) =>
        deps.loopRepo.listRuns(db, {
          status: "cooldown",
          limit: input?.limit ?? 10,
        }),
      ).filter((run) => !run.cooldownUntil || run.cooldownUntil <= nowIso);

      const resumed: FridayAgentLoopRunDetails[] = [];
      for (const candidate of candidates) {
        if (policy.paused) {
          const paused = updateRun(candidate.loopRunId, {
            status: "paused",
            haltReason: "policy_paused",
            pausedAt: nowIso,
            cooldownUntil: undefined,
          });
          const pausedDetails = buildRunDetails(paused);
          await emitLoopEvent("agent-loop.run.paused", paused, pausedDetails);
          resumed.push(pausedDetails);
          continue;
        }

        const failureCount = deps.db.withReadConnection((db) =>
          deps.loopRepo.countFailuresByFingerprint(db, candidate.userId, candidate.fingerprint),
        );
        if (failureCount >= policy.maxAttemptsPerFingerprint) {
          const halted = updateRun(candidate.loopRunId, {
            status: "halted",
            haltReason: "failure_budget_exhausted",
            lastError: "Friday paused itself after repeated failures on this fingerprint",
            cooldownUntil: undefined,
            completedAt: nowIso,
          });
          const haltedDetails = buildRunDetails(halted);
          await emitLoopEvent("agent-loop.run.halted", halted, haltedDetails);
          resumed.push(haltedDetails);
          continue;
        }

        const action = candidate.actionId
          ? deps.selfHealing.getAction({ actionId: candidate.actionId })
          : null;
        if (!action) {
          const failed = updateRun(candidate.loopRunId, {
            status: "failed",
            haltReason: "execution_failed",
            lastError: "No action was available for this loop run",
            cooldownUntil: undefined,
            completedAt: nowIso,
          });
          const failedDetails = buildRunDetails(failed);
          await emitLoopEvent("agent-loop.run.failed", failed, failedDetails);
          resumed.push(failedDetails);
          continue;
        }

        const updated = updateRun(candidate.loopRunId, {
          attemptNumber: candidate.attemptNumber + 1,
          trigger: input?.trigger ?? "cooldown_elapsed",
          status: "running",
          cooldownUntil: undefined,
          completedAt: undefined,
          resumedAt: nowIso,
          pausedAt: undefined,
          haltReason: undefined,
          lastError: undefined,
        });
        resumed.push(await executeRun(updated, input?.trigger ?? "cooldown_elapsed"));
      }
      return resumed;
    },

    async handleProcessResults(input) {
      const loopRuns: FridayAgentLoopRunDetails[] = [];
      for (const result of input.results) {
        for (const incident of result.incidentsCreated) {
          const created = await maybeCreateOrAdvanceRun({
            incidentId: incident.incidentId,
            trigger: "incident_opened",
            correlationId: input.correlationId,
          });
          if (created) {
            loopRuns.push(created);
          }
        }
      }
      return loopRuns;
    },

    async syncAction(input) {
      const current = deps.db.withReadConnection((db) =>
        deps.loopRepo.getLatestRunByActionId(db, input.actionId)
      );
      if (!current) {
        return null;
      }
      const action = deps.selfHealing.getAction({ actionId: input.actionId });
      if (!action) {
        return buildRunDetails(current);
      }

      if (action.approval?.status === "approved" && action.action.status === "planned") {
        const updated = updateRun(current.loopRunId, {
          status: "running",
          haltReason: undefined,
          resumedAt: deps.nowIso(),
          trigger: input.trigger ?? "approval_granted",
          correlationId: input.correlationId ?? current.correlationId,
        });
        return executeRun(updated, input.trigger ?? "approval_granted");
      }

      let nextStatus = current.status;
      let nextReason = current.haltReason;
      if (action.approval?.status === "pending") {
        nextStatus = "awaiting_approval";
        nextReason = "approval_required";
      } else if (action.action.status === "rejected") {
        nextStatus = "halted";
        nextReason = "action_rejected";
      } else if (action.action.status === "rolled_back") {
        nextStatus = "rolled_back";
        nextReason = current.haltReason;
      } else if (action.action.status === "applied" && action.action.outcome === "success") {
        nextStatus = "verified";
        nextReason = undefined;
      } else if (action.action.status === "applied" && action.action.outcome === "failed") {
        nextStatus = "failed";
        nextReason = "execution_failed";
      }

      const updated = updateRun(current.loopRunId, {
        status: nextStatus,
        haltReason: nextReason,
        verificationPassed: action.evidence.acceptanceResult.passed,
        rollbackAttempted: action.evidence.rollbackResult.rollbackAttempted,
        rollbackSucceeded: action.evidence.rollbackResult.rollbackSucceeded,
        lessonId: action.evidence.extractedLesson?.id,
        completedAt: nextStatus === "awaiting_approval" ? undefined : deps.nowIso(),
      });
      const details = buildRunDetails(updated);
      await emitLoopEvent("agent-loop.run.synced", updated, details);
      return details;
    },

    findRunByActionId(actionId) {
      return deps.db.withReadConnection((db) => deps.loopRepo.getLatestRunByActionId(db, actionId));
    },

    findRunByIncidentId(incidentId) {
      return deps.db.withReadConnection((db) => deps.loopRepo.getLatestRunByIncidentId(db, incidentId));
    },
  };
}
