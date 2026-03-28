/**
 * Onboarding Engine — Step-by-step onboarding flows, progress tracking,
 * and checklist management.
 *
 * Manages onboarding flow definitions and per-user session state.
 * Supports conditional steps, skip logic, and completion callbacks.
 *
 * @module uix/engine
 */

import type {
  ISODateTime,
  JsonObject,
} from "../model/friday-uix.types.js";

// ─── Types ───

/** Status of an onboarding step within a session. */
export type OnboardingStepStatus = "pending" | "active" | "completed" | "skipped";

/** Status of an onboarding session. */
export type OnboardingSessionStatus = "not_started" | "in_progress" | "completed" | "dismissed";

/** A single step in an onboarding flow definition. */
export interface OnboardingStepDefinition {
  /** Unique step identifier within the flow. */
  id: string;
  /** Human-readable title. */
  title: string;
  /** Description or instruction text. */
  description?: string;
  /** Action label (e.g., "Connect Slack", "Create First Workflow"). */
  actionLabel?: string;
  /** Action URL or route path (deep link to the relevant feature). */
  actionPath?: string;
  /** Icon identifier. */
  icon?: string;
  /** Sort order (0-indexed). */
  sortOrder: number;
  /** Whether this step can be skipped. */
  skippable: boolean;
  /**
   * Condition key for showing this step.
   * Evaluated against session data (e.g., "hasSlackIntegration" must be falsy).
   */
  showConditionKey?: string;
  /** If true, the step is shown only when the condition key is falsy. */
  showConditionNegate?: boolean;
}

/** An onboarding flow definition (template). */
export interface OnboardingFlowDefinition {
  /** Unique flow identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description?: string;
  /** Ordered steps in the flow. */
  steps: OnboardingStepDefinition[];
  /** Whether the flow is currently active. */
  enabled: boolean;
  /** Version number for the flow definition. */
  version: number;
}

/** Per-step progress record in a user session. */
export interface OnboardingStepProgress {
  /** Step ID. */
  stepId: string;
  /** Current status. */
  status: OnboardingStepStatus;
  /** When the step was completed or skipped. */
  completedAt?: ISODateTime;
  /** Data collected from this step. */
  data: JsonObject;
}

/** Per-user onboarding session state. */
export interface OnboardingSession {
  /** Unique session identifier. */
  id: string;
  /** Flow ID this session tracks. */
  flowId: string;
  /** User principal ID. */
  principalId: string;
  /** Overall session status. */
  status: OnboardingSessionStatus;
  /** Per-step progress. */
  stepProgress: OnboardingStepProgress[];
  /** Index of the current active step (into the flow's visible steps). */
  currentStepIndex: number;
  /** When the session was started. */
  startedAt: ISODateTime;
  /** When the session was last updated. */
  updatedAt: ISODateTime;
  /** When the session was completed or dismissed. */
  finishedAt?: ISODateTime;
}

/** Checklist item derived from an onboarding session for display. */
export interface OnboardingChecklistItem {
  /** Step ID. */
  stepId: string;
  /** Title. */
  title: string;
  /** Description. */
  description?: string;
  /** Icon. */
  icon?: string;
  /** Action label. */
  actionLabel?: string;
  /** Action path. */
  actionPath?: string;
  /** Whether this item is complete. */
  completed: boolean;
  /** Whether this item was skipped. */
  skipped: boolean;
  /** Whether this item is the current active step. */
  active: boolean;
}

/** Progress summary for display. */
export interface OnboardingProgress {
  /** Total visible steps. */
  totalSteps: number;
  /** Completed steps count. */
  completedSteps: number;
  /** Skipped steps count. */
  skippedSteps: number;
  /** Completion percentage (0–100). */
  percentComplete: number;
}

/** Emitted telemetry event type for onboarding transitions. */
export type OnboardingTelemetryEventType =
  | "session_started"
  | "step_advanced"
  | "step_completed"
  | "step_skipped"
  | "step_rolled_back"
  | "session_completed"
  | "session_dismissed"
  | "session_failed";

/** A telemetry/audit event emitted by onboarding transitions. */
export interface OnboardingTelemetryEvent {
  /** Event type. */
  type: OnboardingTelemetryEventType;
  /** Session identifier. */
  sessionId: string;
  /** Flow identifier. */
  flowId: string;
  /** Principal identifier. */
  principalId: string;
  /** Actor identifier. */
  actorId: string;
  /** Event timestamp. */
  timestamp: ISODateTime;
  /** Step identifier for step-scoped events. */
  stepId?: string;
  /** Source step identifier for transition events. */
  fromStepId?: string;
  /** Destination step identifier for transition events. */
  toStepId?: string;
  /** Source status. */
  fromStatus?: OnboardingSessionStatus;
  /** Destination status. */
  toStatus?: OnboardingSessionStatus;
  /** Failure/dismiss reason. */
  reason?: string;
}

/** Per-session timing and KPI metrics. */
export interface OnboardingSessionMetrics {
  /** Session identifier. */
  sessionId: string;
  /** Flow identifier. */
  flowId: string;
  /** Principal identifier. */
  principalId: string;
  /** Session start timestamp. */
  startedAt: ISODateTime;
  /** Session completion timestamp. */
  completedAt?: ISODateTime;
  /** Session dismissal timestamp. */
  dismissedAt?: ISODateTime;
  /** First dead-end/failure timestamp. */
  failedAt?: ISODateTime;
  /** End-to-end completion time in milliseconds. */
  completionTimeMs?: number;
  /** Whether a dead-end/failure transition occurred. */
  deadEndDetected: boolean;
  /** Whether this session completed successfully on first run. */
  firstRunSuccess: boolean;
  /** Per-step accumulated durations in milliseconds. */
  stepDurationsMs: Record<string, number>;
}

/** Aggregate onboarding KPI metrics and telemetry snapshot. */
export interface OnboardingMetrics {
  /** Total sessions seen by this engine instance. */
  totalSessions: number;
  /** Sessions that reached completed state. */
  completedSessions: number;
  /** Sessions dismissed by the user. */
  dismissedSessions: number;
  /** Sessions that had at least one failure/dead-end event. */
  failedSessions: number;
  /** Ratio of first-run successful sessions (0.0–1.0). */
  firstRunSuccessRate: number;
  /** Ratio of sessions with dead-ends/failures (0.0–1.0). */
  deadEndRate: number;
  /** Average completion time in milliseconds for completed sessions. */
  averageCompletionTimeMs: number;
  /** Per-session metrics. */
  sessions: OnboardingSessionMetrics[];
  /** Persisted audit/telemetry events. */
  events: OnboardingTelemetryEvent[];
}

/** Read/write interface for the onboarding engine. */
export interface OnboardingEngine {
  // ─── Flow Definitions ───
  registerFlow(flow: OnboardingFlowDefinition): void;
  unregisterFlow(flowId: string): boolean;
  getFlow(flowId: string): OnboardingFlowDefinition | undefined;
  getAllFlows(): OnboardingFlowDefinition[];

  // ─── Sessions ───
  startSession(flowId: string, principalId: string, conditionData?: JsonObject): OnboardingSession | undefined;
  getSession(sessionId: string): OnboardingSession | undefined;
  getSessionByUser(flowId: string, principalId: string): OnboardingSession | undefined;

  // ─── Step Progression ───
  completeStep(sessionId: string, stepId: string, data?: JsonObject): OnboardingSession | undefined;
  skipStep(sessionId: string, stepId: string): OnboardingSession | undefined;
  goBackStep(sessionId: string): OnboardingSession | undefined;
  dismissSession(sessionId: string): OnboardingSession | undefined;

  // ─── Display Helpers ───
  getChecklist(sessionId: string): OnboardingChecklistItem[];
  getProgress(sessionId: string): OnboardingProgress | undefined;
  getMetrics(): OnboardingMetrics;
}

// ─── Helpers ───

function getVisibleSteps(
  flow: OnboardingFlowDefinition,
  conditionData: JsonObject,
): OnboardingStepDefinition[] {
  return flow.steps
    .filter((step) => {
      if (!step.showConditionKey) return true;
      const conditionValue = conditionData[step.showConditionKey];
      const isTruthy = conditionValue !== null && conditionValue !== undefined &&
        conditionValue !== false && conditionValue !== "" && conditionValue !== 0;
      return step.showConditionNegate ? !isTruthy : isTruthy;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

function now(): ISODateTime {
  return new Date().toISOString();
}

function deepFreeze(value: object, seen: WeakSet<object>): void {
  if (seen.has(value)) return;
  seen.add(value);

  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") {
      deepFreeze(child, seen);
    }
  }

  Object.freeze(value);
}

function cloneAndFreeze<T>(value: T): T {
  const cloned = structuredClone(value);
  if (cloned !== null && typeof cloned === "object") {
    deepFreeze(cloned, new WeakSet());
  }
  return cloned;
}

interface SessionMetricState {
  sessionId: string;
  flowId: string;
  principalId: string;
  startedAt: ISODateTime;
  startedAtMs: number;
  completedAt?: ISODateTime;
  dismissedAt?: ISODateTime;
  failedAt?: ISODateTime;
  completionTimeMs?: number;
  deadEndDetected: boolean;
  firstRunSuccess: boolean;
  stepDurationsMs: Record<string, number>;
  activeStepId?: string;
  activeStepStartedAtMs?: number;
}

// ─── Factory ───

/** P2-02: Optional persistence callbacks for surviving process restarts. */
export interface OnboardingPersistence {
  save: (session: OnboardingSession) => void;
  loadActive: () => OnboardingSession[];
}

/** Create an onboarding engine instance. */
export function createOnboardingEngine(options?: { persistence?: OnboardingPersistence }): OnboardingEngine {
  const persistence = options?.persistence;
  const flows = new Map<string, OnboardingFlowDefinition>();
  const sessions = new Map<string, OnboardingSession>();
  /** Secondary index: `${flowId}:${principalId}` → session ID. */
  const userFlowIndex = new Map<string, string>();
  /** Per-session metrics for KPI instrumentation. */
  const metricsBySession = new Map<string, SessionMetricState>();
  /** Persisted telemetry/audit events. */
  const telemetryEvents: OnboardingTelemetryEvent[] = [];
  let sessionCounter = 0;

  // P2-02: Restore active sessions from persistence layer on startup.
  if (persistence) {
    try {
      const restored = persistence.loadActive();
      for (const session of restored) {
        sessions.set(session.id, session);
        userFlowIndex.set(`${session.flowId}:${session.principalId}`, session.id);
        sessionCounter = Math.max(sessionCounter, Number(session.id.replace(/\D/g, "")) || 0);
      }
    } catch (err) {
      console.warn("[friday][onboarding] failed to restore sessions:", err instanceof Error ? err.message : String(err));
    }
  }

  function persistSession(session: OnboardingSession): void {
    try {
      persistence?.save(session);
    } catch (err) {
      console.warn("[friday][onboarding] persist failed:", err instanceof Error ? err.message : String(err));
    }
  }

  function userFlowKey(flowId: string, principalId: string): string {
    return `${flowId}:${principalId}`;
  }

  function emitTelemetry(event: Omit<OnboardingTelemetryEvent, "timestamp">): void {
    telemetryEvents.push({
      ...event,
      timestamp: now(),
    });
  }

  function findSessionMetricState(sessionId: string): SessionMetricState | undefined {
    return metricsBySession.get(sessionId);
  }

  function activateStepTiming(sessionId: string, stepId: string, atMs: number): void {
    const metrics = findSessionMetricState(sessionId);
    if (!metrics) return;
    metrics.activeStepId = stepId;
    metrics.activeStepStartedAtMs = atMs;
  }

  function recordActiveStepDuration(sessionId: string, stepId: string, atMs: number): void {
    const metrics = findSessionMetricState(sessionId);
    if (!metrics) return;
    if (metrics.activeStepId !== stepId || metrics.activeStepStartedAtMs === undefined) return;

    const elapsed = Math.max(0, atMs - metrics.activeStepStartedAtMs);
    const current = metrics.stepDurationsMs[stepId] ?? 0;
    metrics.stepDurationsMs[stepId] = current + elapsed;
    metrics.activeStepId = undefined;
    metrics.activeStepStartedAtMs = undefined;
  }

  function recordFailure(session: OnboardingSession, reason: string, stepId?: string): void {
    const metrics = findSessionMetricState(session.id);
    const failureTime = now();
    if (metrics) {
      if (metrics.failedAt === undefined) {
        metrics.failedAt = failureTime;
      }
      metrics.deadEndDetected = true;
      metrics.firstRunSuccess = false;
    }

    emitTelemetry({
      type: "session_failed",
      sessionId: session.id,
      flowId: session.flowId,
      principalId: session.principalId,
      actorId: session.principalId,
      stepId,
      fromStatus: session.status,
      toStatus: session.status,
      reason,
    });
  }

  function normalizeActiveState(session: OnboardingSession): number | undefined {
    const activeIndexes: number[] = [];
    for (let i = 0; i < session.stepProgress.length; i++) {
      if (session.stepProgress[i].status === "active") {
        activeIndexes.push(i);
      }
    }

    let targetIndex: number | undefined;
    const currentEntry = session.stepProgress[session.currentStepIndex];
    if (currentEntry && currentEntry.status === "active") {
      targetIndex = session.currentStepIndex;
    } else if (activeIndexes.length > 0) {
      targetIndex = activeIndexes[0];
    } else {
      const firstPending = session.stepProgress.findIndex((step) => step.status === "pending");
      if (firstPending !== -1) {
        session.stepProgress[firstPending].status = "active";
        targetIndex = firstPending;
      }
    }

    for (let i = 0; i < session.stepProgress.length; i++) {
      if (session.stepProgress[i].status === "active" && i !== targetIndex) {
        session.stepProgress[i].status = "pending";
      }
    }

    if (targetIndex !== undefined) {
      session.currentStepIndex = targetIndex;
      const activeStepId = session.stepProgress[targetIndex].stepId;
      const metrics = findSessionMetricState(session.id);
      if (metrics && metrics.activeStepId !== activeStepId) {
        activateStepTiming(session.id, activeStepId, Date.now());
      }
    }

    return targetIndex;
  }

  function advanceToNextPending(
    session: OnboardingSession,
    fromStepId: string | undefined,
    transitionTime: ISODateTime,
    transitionTimeMs: number,
  ): void {
    for (const step of session.stepProgress) {
      if (step.status === "active") {
        step.status = "pending";
      }
    }

    const nextPendingIndex = session.stepProgress.findIndex((step) => step.status === "pending");
    if (nextPendingIndex === -1) {
      const previousStatus = session.status;
      session.status = "completed";
      session.finishedAt = transitionTime;
      if (session.stepProgress.length > 0) {
        session.currentStepIndex = session.stepProgress.length - 1;
      }
      persistSession(session);

      const metrics = findSessionMetricState(session.id);
      if (metrics && metrics.completedAt === undefined) {
        metrics.completedAt = transitionTime;
        metrics.completionTimeMs = Math.max(0, transitionTimeMs - metrics.startedAtMs);
        metrics.firstRunSuccess = !metrics.deadEndDetected && metrics.dismissedAt === undefined;
        metrics.activeStepId = undefined;
        metrics.activeStepStartedAtMs = undefined;
      }

      emitTelemetry({
        type: "session_completed",
        sessionId: session.id,
        flowId: session.flowId,
        principalId: session.principalId,
        actorId: session.principalId,
        fromStatus: previousStatus,
        toStatus: session.status,
      });
      return;
    }

    session.currentStepIndex = nextPendingIndex;
    const nextStep = session.stepProgress[nextPendingIndex];
    nextStep.status = "active";
    activateStepTiming(session.id, nextStep.stepId, transitionTimeMs);

    emitTelemetry({
      type: "step_advanced",
      sessionId: session.id,
      flowId: session.flowId,
      principalId: session.principalId,
      actorId: session.principalId,
      stepId: nextStep.stepId,
      fromStepId,
      toStepId: nextStep.stepId,
      fromStatus: session.status,
      toStatus: session.status,
    });
  }

  return {
    // ─── Flow Definitions ───

    registerFlow(flow) {
      flows.set(flow.id, structuredClone(flow));
    },

    unregisterFlow(flowId) {
      return flows.delete(flowId);
    },

    getFlow(flowId) {
      const flow = flows.get(flowId);
      return flow !== undefined ? cloneAndFreeze(flow) : undefined;
    },

    getAllFlows() {
      return cloneAndFreeze([...flows.values()]);
    },

    // ─── Sessions ───

    startSession(flowId, principalId, conditionData = {}) {
      const flow = flows.get(flowId);
      if (!flow || !flow.enabled) return undefined;

      const key = userFlowKey(flowId, principalId);
      const existing = userFlowIndex.get(key);
      if (existing !== undefined) {
        const existingSession = sessions.get(existing);
        if (existingSession !== undefined) {
          return cloneAndFreeze(existingSession);
        }
        userFlowIndex.delete(key);
      }

      const visibleSteps = getVisibleSteps(flow, conditionData);
      if (visibleSteps.length === 0) return undefined;

      const startedAt = now();
      const startedAtMs = Date.now();
      const sessionId = `onb-session-${++sessionCounter}`;
      const stepProgress: OnboardingStepProgress[] = visibleSteps.map((step, i) => ({
        stepId: step.id,
        status: i === 0 ? "active" as const : "pending" as const,
        data: {},
      }));

      const session: OnboardingSession = {
        id: sessionId,
        flowId,
        principalId,
        status: "in_progress",
        stepProgress,
        currentStepIndex: 0,
        startedAt,
        updatedAt: startedAt,
      };

      const firstStepId = stepProgress[0].stepId;
      metricsBySession.set(sessionId, {
        sessionId,
        flowId,
        principalId,
        startedAt,
        startedAtMs,
        deadEndDetected: false,
        firstRunSuccess: false,
        stepDurationsMs: {},
        activeStepId: firstStepId,
        activeStepStartedAtMs: startedAtMs,
      });

      sessions.set(sessionId, session);
      userFlowIndex.set(key, sessionId);
      persistSession(session);

      emitTelemetry({
        type: "session_started",
        sessionId,
        flowId,
        principalId,
        actorId: principalId,
        fromStatus: "not_started",
        toStatus: session.status,
      });
      emitTelemetry({
        type: "step_advanced",
        sessionId,
        flowId,
        principalId,
        actorId: principalId,
        stepId: firstStepId,
        toStepId: firstStepId,
        fromStatus: session.status,
        toStatus: session.status,
      });

      return cloneAndFreeze(session);
    },

    getSession(sessionId) {
      const session = sessions.get(sessionId);
      return session !== undefined ? cloneAndFreeze(session) : undefined;
    },

    getSessionByUser(flowId, principalId) {
      const id = userFlowIndex.get(userFlowKey(flowId, principalId));
      if (id === undefined) return undefined;
      const session = sessions.get(id);
      return session !== undefined ? cloneAndFreeze(session) : undefined;
    },

    // ─── Step Progression ───

    completeStep(sessionId, stepId, data = {}) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== "in_progress") return undefined;

      const activeIndex = normalizeActiveState(session);
      if (activeIndex === undefined) {
        recordFailure(session, "no_active_step", stepId);
        return undefined;
      }

      const activeStep = session.stepProgress[activeIndex];
      if (activeStep.stepId !== stepId || activeStep.status !== "active") {
        recordFailure(session, "step_not_active", stepId);
        return undefined;
      }

      const transitionTime = now();
      const transitionTimeMs = Date.now();
      recordActiveStepDuration(session.id, stepId, transitionTimeMs);

      activeStep.status = "completed";
      activeStep.completedAt = transitionTime;
      activeStep.data = structuredClone(data);
      session.updatedAt = transitionTime;
      persistSession(session);

      emitTelemetry({
        type: "step_completed",
        sessionId: session.id,
        flowId: session.flowId,
        principalId: session.principalId,
        actorId: session.principalId,
        stepId,
        fromStatus: session.status,
        toStatus: session.status,
      });

      advanceToNextPending(session, stepId, transitionTime, transitionTimeMs);
      return cloneAndFreeze(session);
    },

    skipStep(sessionId, stepId) {
      const session = sessions.get(sessionId);
      if (!session || session.status !== "in_progress") return undefined;

      const flow = flows.get(session.flowId);
      if (!flow) {
        recordFailure(session, "flow_not_found", stepId);
        return undefined;
      }

      const activeIndex = normalizeActiveState(session);
      if (activeIndex === undefined) {
        recordFailure(session, "no_active_step", stepId);
        return undefined;
      }

      const activeStep = session.stepProgress[activeIndex];
      if (activeStep.stepId !== stepId || activeStep.status !== "active") {
        recordFailure(session, "step_not_active", stepId);
        return undefined;
      }

      const stepDef = flow.steps.find((s) => s.id === stepId);
      if (!stepDef || !stepDef.skippable) {
        recordFailure(session, "step_not_skippable", stepId);
        return undefined;
      }

      const transitionTime = now();
      const transitionTimeMs = Date.now();
      recordActiveStepDuration(session.id, stepId, transitionTimeMs);

      activeStep.status = "skipped";
      activeStep.completedAt = transitionTime;
      session.updatedAt = transitionTime;
      persistSession(session);

      emitTelemetry({
        type: "step_skipped",
        sessionId: session.id,
        flowId: session.flowId,
        principalId: session.principalId,
        actorId: session.principalId,
        stepId,
        fromStatus: session.status,
        toStatus: session.status,
      });

      advanceToNextPending(session, stepId, transitionTime, transitionTimeMs);
      return cloneAndFreeze(session);
    },

    goBackStep(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      if (session.status !== "in_progress") {
        recordFailure(session, "session_not_in_progress");
        return undefined;
      }

      const activeIndex = normalizeActiveState(session);
      if (activeIndex === undefined) {
        recordFailure(session, "no_active_step");
        return undefined;
      }
      if (activeIndex === 0) {
        recordFailure(session, "already_at_first_step", session.stepProgress[activeIndex].stepId);
        return undefined;
      }

      let previousCompletedIndex: number | undefined;
      for (let i = activeIndex - 1; i >= 0; i--) {
        if (session.stepProgress[i].status === "completed") {
          previousCompletedIndex = i;
          break;
        }
      }

      if (previousCompletedIndex === undefined) {
        recordFailure(session, "no_previous_completed_step", session.stepProgress[activeIndex].stepId);
        return undefined;
      }

      const transitionTime = now();
      const transitionTimeMs = Date.now();
      const currentStep = session.stepProgress[activeIndex];
      const previousCompletedStep = session.stepProgress[previousCompletedIndex];

      recordActiveStepDuration(session.id, currentStep.stepId, transitionTimeMs);

      currentStep.status = "pending";
      delete currentStep.completedAt;

      previousCompletedStep.status = "active";
      delete previousCompletedStep.completedAt;

      session.currentStepIndex = previousCompletedIndex;
      session.updatedAt = transitionTime;
      persistSession(session);
      activateStepTiming(session.id, previousCompletedStep.stepId, transitionTimeMs);

      emitTelemetry({
        type: "step_rolled_back",
        sessionId: session.id,
        flowId: session.flowId,
        principalId: session.principalId,
        actorId: session.principalId,
        stepId: previousCompletedStep.stepId,
        fromStepId: currentStep.stepId,
        toStepId: previousCompletedStep.stepId,
        fromStatus: session.status,
        toStatus: session.status,
      });

      return cloneAndFreeze(session);
    },

    dismissSession(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return undefined;
      if (session.status !== "in_progress") {
        recordFailure(session, "session_not_in_progress");
        return undefined;
      }

      const activeIndex = normalizeActiveState(session);
      if (activeIndex !== undefined) {
        const activeStep = session.stepProgress[activeIndex];
        recordActiveStepDuration(session.id, activeStep.stepId, Date.now());
      }

      const previousStatus = session.status;
      const dismissTime = now();
      session.status = "dismissed";
      session.finishedAt = dismissTime;
      session.updatedAt = dismissTime;
      persistSession(session);

      const metrics = findSessionMetricState(session.id);
      if (metrics) {
        metrics.dismissedAt = dismissTime;
        metrics.firstRunSuccess = false;
        metrics.activeStepId = undefined;
        metrics.activeStepStartedAtMs = undefined;
      }

      emitTelemetry({
        type: "session_dismissed",
        sessionId: session.id,
        flowId: session.flowId,
        principalId: session.principalId,
        actorId: session.principalId,
        fromStatus: previousStatus,
        toStatus: session.status,
        reason: "user_dismissed",
      });

      return cloneAndFreeze(session);
    },

    // ─── Display Helpers ───

    getChecklist(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return [];

      const flow = flows.get(session.flowId);
      if (!flow) return [];

      const checklist = session.stepProgress.map((progress) => {
        const stepDef = flow.steps.find((s) => s.id === progress.stepId);
        return {
          stepId: progress.stepId,
          title: stepDef?.title ?? progress.stepId,
          description: stepDef?.description,
          icon: stepDef?.icon,
          actionLabel: stepDef?.actionLabel,
          actionPath: stepDef?.actionPath,
          completed: progress.status === "completed",
          skipped: progress.status === "skipped",
          active: progress.status === "active",
        };
      });
      return cloneAndFreeze(checklist);
    },

    getProgress(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return undefined;

      const total = session.stepProgress.length;
      const completed = session.stepProgress.filter((s) => s.status === "completed").length;
      const skipped = session.stepProgress.filter((s) => s.status === "skipped").length;
      const percentComplete = total > 0 ? Math.round(((completed + skipped) / total) * 100) : 0;

      return cloneAndFreeze({
        totalSteps: total,
        completedSteps: completed,
        skippedSteps: skipped,
        percentComplete,
      });
    },

    getMetrics() {
      const sessionMetrics: OnboardingSessionMetrics[] = [...metricsBySession.values()]
        .map((entry) => ({
          sessionId: entry.sessionId,
          flowId: entry.flowId,
          principalId: entry.principalId,
          startedAt: entry.startedAt,
          completedAt: entry.completedAt,
          dismissedAt: entry.dismissedAt,
          failedAt: entry.failedAt,
          completionTimeMs: entry.completionTimeMs,
          deadEndDetected: entry.deadEndDetected,
          firstRunSuccess: entry.firstRunSuccess,
          stepDurationsMs: { ...entry.stepDurationsMs },
        }))
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

      const totalSessions = sessionMetrics.length;
      const completedSessions = sessionMetrics.filter((m) => m.completedAt !== undefined).length;
      const dismissedSessions = sessionMetrics.filter((m) => m.dismissedAt !== undefined).length;
      const failedSessions = sessionMetrics.filter((m) => m.deadEndDetected).length;
      const firstRunSuccesses = sessionMetrics.filter((m) => m.firstRunSuccess).length;
      const completionTimes = sessionMetrics
        .map((m) => m.completionTimeMs)
        .filter((value): value is number => value !== undefined);
      const averageCompletionTimeMs = completionTimes.length === 0
        ? 0
        : Math.round(completionTimes.reduce((sum, value) => sum + value, 0) / completionTimes.length);

      return cloneAndFreeze({
        totalSessions,
        completedSessions,
        dismissedSessions,
        failedSessions,
        firstRunSuccessRate: totalSessions === 0 ? 0 : firstRunSuccesses / totalSessions,
        deadEndRate: totalSessions === 0 ? 0 : failedSessions / totalSessions,
        averageCompletionTimeMs,
        sessions: sessionMetrics,
        events: telemetryEvents.slice(),
      });
    },
  };
}
