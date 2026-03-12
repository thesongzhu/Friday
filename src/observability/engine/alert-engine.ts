/**
 * Alert Engine — Configurable alert rules with threshold-based and anomaly detection.
 *
 * Evaluates alert conditions against current metric/SLO state and manages
 * the alert lifecycle (pending → firing → acknowledged/escalated → resolved).
 * Supports threshold, absence, anomaly, and SLO burn-rate conditions.
 *
 * @module observability/engine
 */

import type {
  FridayAlertCondition,
  FridayAlertEvent,
  FridayAlertEventStatus,
  FridayAlertRule,
  FridayAlertSeverity,
  FridayBurnRate,
  FridayEscalationTier,
  FridayObservabilityModule,
  ISODateTime,
  UUID,
} from "../model/friday-observability.types.js";

import { FRIDAY_ALERT_SEVERITY_PRIORITY } from "../model/friday-observability.types.js";
import type { RunbookExecutor } from "./runbook-automation.js";

// ─── UUID Generation ───

function generateUUID(): UUID {
  const hex = Array.from(
    crypto.getRandomValues(new Uint8Array(16)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Recursively freeze objects/arrays to enforce runtime immutability. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested !== null && typeof nested === "object") {
      deepFreeze(nested);
    }
  }

  return Object.freeze(value);
}

/** Clone a value and return a deeply frozen copy. */
function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

// ─── Metric Provider Interface ───

/** Interface for providing current metric values to the alert engine. */
export interface AlertMetricProvider {
  /** Get the current value of a named metric. Returns null if unavailable. */
  getMetricValue(metricName: string): number | null;
  /** Get the timestamp of the last report for a named metric. Returns null if never reported. */
  getMetricLastReportedAt(metricName: string): ISODateTime | null;
}

/** Interface for providing current burn rate data. */
export interface AlertBurnRateProvider {
  /** Get burn rates for an SLO. */
  getBurnRates(sloId: string): FridayBurnRate[];
}

// ─── Evaluation Result ───

/** Result of evaluating a single alert condition. */
export interface AlertEvaluationResult {
  /** Whether the condition is met. */
  readonly fired: boolean;
  /** The observed metric value (if applicable). */
  readonly observedValue?: number;
  /** The threshold value (if applicable). */
  readonly thresholdValue?: number;
  /** Human-readable summary of why the condition fired (or did not). */
  readonly summary: string;
  /** Detailed description. */
  readonly details: string;
}

// ─── Alert Engine ───

/**
 * Evaluates alert rules and manages the alert event lifecycle.
 *
 * Usage:
 * ```ts
 * const engine = new FridayAlertEngine();
 * engine.addRule(rule);
 * engine.setMetricProvider(provider);
 * const events = engine.evaluateAll();
 * engine.acknowledgeAlert(events[0].id, "admin", "Investigating");
 * ```
 */
export class FridayAlertEngine {
  private readonly rules = new Map<UUID, FridayAlertRule>();
  private readonly activeEvents = new Map<UUID, FridayAlertEvent>();
  private metricProvider: AlertMetricProvider | null = null;
  private burnRateProvider: AlertBurnRateProvider | null = null;
  private runbookExecutor: RunbookExecutor | null = null;

  /** Anomaly detection baseline values: metricName → rolling values. */
  private readonly anomalyBaselines = new Map<string, number[]>();
  /** Maximum number of baseline samples per metric. */
  private readonly maxBaselineSamples = 100;

  // ─── Configuration ───

  /** Set the metric provider for condition evaluation. */
  setMetricProvider(provider: AlertMetricProvider): void {
    this.metricProvider = provider;
  }

  /** Set the burn rate provider for SLO burn-rate conditions. */
  setBurnRateProvider(provider: AlertBurnRateProvider): void {
    this.burnRateProvider = provider;
  }

  /** Set the runbook executor used for escalation automation. */
  setRunbookExecutor(executor: RunbookExecutor | null): void {
    this.runbookExecutor = executor;
  }

  /** Add or update an alert rule. */
  addRule(rule: FridayAlertRule): void {
    this.rules.set(rule.id, rule);
  }

  /** Remove an alert rule. Active events for this rule are not affected. */
  removeRule(ruleId: UUID): boolean {
    return this.rules.delete(ruleId);
  }

  /** Get a rule by ID. */
  getRule(ruleId: UUID): FridayAlertRule | null {
    const rule = this.rules.get(ruleId);
    return rule ? cloneAndFreeze(rule) : null;
  }

  /** Get all rules. */
  getRules(): FridayAlertRule[] {
    return cloneAndFreeze(Array.from(this.rules.values()));
  }

  // ─── Condition Evaluation ───

  /** Evaluate a single alert condition against current state. */
  evaluateCondition(condition: FridayAlertCondition): AlertEvaluationResult {
    switch (condition.type) {
      case "threshold":
        return this.evaluateThreshold(condition);
      case "absence":
        return this.evaluateAbsence(condition);
      case "anomaly":
        return this.evaluateAnomaly(condition);
      case "slo_burn_rate":
        return this.evaluateBurnRate(condition);
    }
  }

  private evaluateThreshold(condition: FridayAlertCondition & { type: "threshold" }): AlertEvaluationResult {
    if (!this.metricProvider) {
      return { fired: false, summary: "No metric provider configured", details: "" };
    }
    const value = this.metricProvider.getMetricValue(condition.metricName);
    if (value === null) {
      return {
        fired: false,
        summary: `Metric "${condition.metricName}" not available`,
        details: `Cannot evaluate threshold: metric value is null`,
      };
    }

    let fired: boolean;
    switch (condition.operator) {
      case "gt": fired = value > condition.threshold; break;
      case "gte": fired = value >= condition.threshold; break;
      case "lt": fired = value < condition.threshold; break;
      case "lte": fired = value <= condition.threshold; break;
      case "eq": fired = value === condition.threshold; break;
    }

    return {
      fired,
      observedValue: value,
      thresholdValue: condition.threshold,
      summary: fired
        ? `${condition.metricName} = ${value} ${condition.operator} ${condition.threshold}`
        : `${condition.metricName} = ${value} (threshold ${condition.operator} ${condition.threshold} not breached)`,
      details: `Metric: ${condition.metricName}, Value: ${value}, Operator: ${condition.operator}, Threshold: ${condition.threshold}`,
    };
  }

  private evaluateAbsence(condition: FridayAlertCondition & { type: "absence" }): AlertEvaluationResult {
    if (!this.metricProvider) {
      return { fired: false, summary: "No metric provider configured", details: "" };
    }
    const lastReported = this.metricProvider.getMetricLastReportedAt(condition.metricName);
    if (lastReported === null) {
      return {
        fired: true,
        summary: `Metric "${condition.metricName}" has never reported`,
        details: `Absence threshold: ${condition.absenceMinutes} minutes`,
      };
    }

    const elapsedMs = Date.now() - new Date(lastReported).getTime();
    const elapsedMinutes = elapsedMs / 60_000;
    const fired = elapsedMinutes >= condition.absenceMinutes;

    return {
      fired,
      observedValue: Math.round(elapsedMinutes * 10) / 10,
      thresholdValue: condition.absenceMinutes,
      summary: fired
        ? `Metric "${condition.metricName}" absent for ${elapsedMinutes.toFixed(1)} min (threshold: ${condition.absenceMinutes} min)`
        : `Metric "${condition.metricName}" reported ${elapsedMinutes.toFixed(1)} min ago`,
      details: `Last reported: ${lastReported}, Absence threshold: ${condition.absenceMinutes} minutes`,
    };
  }

  private evaluateAnomaly(condition: FridayAlertCondition & { type: "anomaly" }): AlertEvaluationResult {
    if (!this.metricProvider) {
      return { fired: false, summary: "No metric provider configured", details: "" };
    }
    const value = this.metricProvider.getMetricValue(condition.metricName);
    if (value === null) {
      return {
        fired: false,
        summary: `Metric "${condition.metricName}" not available`,
        details: "Cannot evaluate anomaly: metric value is null",
      };
    }

    // Record value in baseline
    let baseline = this.anomalyBaselines.get(condition.metricName);
    if (!baseline) {
      baseline = [];
      this.anomalyBaselines.set(condition.metricName, baseline);
    }
    baseline.push(value);
    if (baseline.length > this.maxBaselineSamples) {
      baseline.shift();
    }

    // Need at least 10 samples for statistical significance
    if (baseline.length < 10) {
      return {
        fired: false,
        observedValue: value,
        summary: `Insufficient baseline data for "${condition.metricName}" (${baseline.length}/10 samples)`,
        details: `Need at least 10 samples for anomaly detection`,
      };
    }

    // Compute mean and standard deviation
    const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
    const variance = baseline.reduce((sum, v) => sum + (v - mean) ** 2, 0) / baseline.length;
    const stdDev = Math.sqrt(variance);

    // Avoid division by zero: if stdDev is 0, any deviation is anomalous
    const deviations = stdDev === 0
      ? (value === mean ? 0 : Infinity)
      : Math.abs(value - mean) / stdDev;
    const fired = deviations > condition.sensitivity;

    return {
      fired,
      observedValue: value,
      thresholdValue: condition.sensitivity,
      summary: fired
        ? `Anomaly detected: "${condition.metricName}" = ${value} (${deviations.toFixed(2)} σ from mean ${mean.toFixed(2)})`
        : `"${condition.metricName}" = ${value} within normal range (${deviations.toFixed(2)} σ)`,
      details: `Value: ${value}, Mean: ${mean.toFixed(4)}, StdDev: ${stdDev.toFixed(4)}, Deviations: ${deviations.toFixed(4)}, Sensitivity: ${condition.sensitivity}`,
    };
  }

  private evaluateBurnRate(condition: FridayAlertCondition & { type: "slo_burn_rate" }): AlertEvaluationResult {
    if (!this.burnRateProvider) {
      return { fired: false, summary: "No burn rate provider configured", details: "" };
    }

    const burnRates = this.burnRateProvider.getBurnRates(condition.sloId);
    if (burnRates.length === 0) {
      return {
        fired: false,
        summary: `No burn rate data for SLO "${condition.sloId}"`,
        details: "Cannot evaluate burn rate: no data available",
      };
    }

    // Find short and long window burn rates
    const shortWindow = burnRates.find((br) => br.windowMinutes === condition.shortWindowMinutes);
    const longWindow = burnRates.find((br) => br.windowMinutes === condition.longWindowMinutes);

    if (!shortWindow || !longWindow) {
      return {
        fired: false,
        summary: `Missing burn rate windows for SLO "${condition.sloId}"`,
        details: `Required: ${condition.shortWindowMinutes}m and ${condition.longWindowMinutes}m windows`,
      };
    }

    // Both windows must exceed the threshold (multi-window burn-rate alerting)
    const shortExceeds = shortWindow.rate >= condition.burnRateThreshold;
    const longExceeds = longWindow.rate >= condition.burnRateThreshold;
    const fired = shortExceeds && longExceeds;

    return {
      fired,
      observedValue: longWindow.rate,
      thresholdValue: condition.burnRateThreshold,
      summary: fired
        ? `SLO burn rate exceeded: short=${shortWindow.rate.toFixed(2)}× long=${longWindow.rate.toFixed(2)}× (threshold: ${condition.burnRateThreshold}×)`
        : `SLO burn rate within limits: short=${shortWindow.rate.toFixed(2)}× long=${longWindow.rate.toFixed(2)}×`,
      details: `SLO: ${condition.sloId}, Short window (${condition.shortWindowMinutes}m): ${shortWindow.rate.toFixed(4)}×, Long window (${condition.longWindowMinutes}m): ${longWindow.rate.toFixed(4)}×, Threshold: ${condition.burnRateThreshold}×`,
    };
  }

  // ─── Rule Evaluation & Event Lifecycle ───

  /** Evaluate a single rule and create/update alert events as needed. */
  evaluateRule(ruleId: UUID): FridayAlertEvent | null {
    const rule = this.rules.get(ruleId);
    if (!rule || !rule.enabled) return null;

    const result = this.evaluateCondition(rule.condition);

    // Find existing active event for this rule
    const existingEvent = this.findActiveEventForRule(ruleId);

    if (result.fired) {
      if (!existingEvent) {
        return this.createPendingAlertEvent(rule, result);
      }
      return this.handleActiveFiringEvent(existingEvent, rule, result);
    }

    // Condition cleared — resolve any active event
    if (existingEvent && existingEvent.status !== "resolved") {
      return this.resolveAlert(existingEvent.id);
    }

    return null;
  }

  /** Evaluate all enabled rules. Returns newly created or updated events. */
  evaluateAll(): FridayAlertEvent[] {
    const events: FridayAlertEvent[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.enabled) continue;
      const event = this.evaluateRule(rule.id);
      if (event) events.push(event);
    }
    return events;
  }

  /** Handle an existing active event when the condition remains true. */
  private handleActiveFiringEvent(
    event: FridayAlertEvent,
    rule: FridayAlertRule,
    result: AlertEvaluationResult,
  ): FridayAlertEvent {
    const refreshed = this.refreshEventFromEvaluation(event, result);
    if (refreshed.status === "pending") {
      return this.transitionPendingToFiring(refreshed, rule);
    }
    return this.checkEscalation(refreshed, rule);
  }

  /** Create a new alert event in the pending state. */
  private createPendingAlertEvent(rule: FridayAlertRule, result: AlertEvaluationResult): FridayAlertEvent {
    const now = new Date().toISOString();
    const { module, metricName, sloId } = this.resolveEventContext(rule);

    const event: FridayAlertEvent = {
      id: generateUUID(),
      ruleId: rule.id,
      severity: rule.severity,
      status: "pending",
      summary: result.summary,
      details: result.details,
      module,
      sloId,
      metricName,
      observedValue: result.observedValue,
      thresholdValue: result.thresholdValue,
      notifiedChannelIds: [],
      currentEscalationTier: 0,
      detectedAt: now,
    };

    this.activeEvents.set(event.id, event);
    return event;
  }

  /** Transition a pending event to firing once the grouping/sustained window is met. */
  private transitionPendingToFiring(event: FridayAlertEvent, rule: FridayAlertRule): FridayAlertEvent {
    if (event.status !== "pending") return event;

    const windowMs = Math.max(0, rule.groupingWindowMin) * 60_000;
    const detectedAtMs = this.toEpochMs(event.detectedAt);
    const nowMs = Date.now();

    if (detectedAtMs === null || nowMs < detectedAtMs) {
      return event;
    }

    const sustainedForMs = nowMs - detectedAtMs;
    if (sustainedForMs < windowMs) {
      return event;
    }

    const updated: FridayAlertEvent = {
      ...event,
      status: "firing",
      firedAt: new Date(nowMs).toISOString(),
      notifiedChannelIds: this.mergeChannelIds(event.notifiedChannelIds, rule.channelIds),
    };
    this.activeEvents.set(updated.id, updated);
    return updated;
  }

  /** Check whether an active event should be escalated. */
  private checkEscalation(event: FridayAlertEvent, rule: FridayAlertRule): FridayAlertEvent {
    if (
      event.status === "pending"
      || event.status === "acknowledged"
      || event.status === "resolved"
    ) {
      return event;
    }

    const nextTier = this.getNextEscalationTier(rule, event.currentEscalationTier);
    if (!nextTier) return event;

    const nowMs = Date.now();
    const referenceTime = event.currentEscalationTier === 0
      ? this.toEpochMs(event.firedAt)
      : (this.toEpochMs(event.escalatedAt) ?? this.toEpochMs(event.firedAt));

    if (referenceTime === null || nowMs < referenceTime) {
      return event;
    }

    const requiredMs = Math.max(0, nextTier.timeoutMinutes) * 60_000;
    if ((nowMs - referenceTime) < requiredMs) {
      return event;
    }

    const updated: FridayAlertEvent = {
      ...event,
      status: "escalated",
      currentEscalationTier: nextTier.tier,
      escalatedAt: new Date(nowMs).toISOString(),
      notifiedChannelIds: this.mergeChannelIds(event.notifiedChannelIds, nextTier.channelIds),
    };

    this.activeEvents.set(updated.id, updated);
    this.runbookExecutor?.triggerOnEscalation(updated, rule, nextTier);
    return updated;
  }

  /** Refresh summary/details/value fields from the latest evaluation. */
  private refreshEventFromEvaluation(
    event: FridayAlertEvent,
    result: AlertEvaluationResult,
  ): FridayAlertEvent {
    const updated: FridayAlertEvent = {
      ...event,
      summary: result.summary,
      details: result.details,
      observedValue: result.observedValue,
      thresholdValue: result.thresholdValue,
    };
    this.activeEvents.set(updated.id, updated);
    return updated;
  }

  /** Resolve common alert context fields from rule condition. */
  private resolveEventContext(rule: FridayAlertRule): {
    module: FridayObservabilityModule;
    metricName?: string;
    sloId?: string;
  } {
    let module: FridayObservabilityModule = "observability";
    let metricName: string | undefined;
    let sloId: string | undefined;

    if (
      rule.condition.type === "threshold"
      || rule.condition.type === "absence"
      || rule.condition.type === "anomaly"
    ) {
      metricName = rule.condition.metricName;
    } else if (rule.condition.type === "slo_burn_rate") {
      sloId = rule.condition.sloId;
    }

    return { module, metricName, sloId };
  }

  /** Get the next escalation tier after the current tier index. */
  private getNextEscalationTier(
    rule: FridayAlertRule,
    currentTier: number,
  ): FridayEscalationTier | null {
    const next = rule.escalationTiers.find((tier) => tier.tier === (currentTier + 1));
    return next ?? null;
  }

  /** Parse an ISO timestamp into epoch ms, returning null for invalid values. */
  private toEpochMs(timestamp: ISODateTime | undefined): number | null {
    if (!timestamp) return null;
    const parsed = new Date(timestamp).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Merge notification channels while preserving first-seen order. */
  private mergeChannelIds(existing: readonly UUID[], next: readonly UUID[]): UUID[] {
    return Array.from(new Set([...existing, ...next]));
  }

  // ─── Alert Actions ───

  /** Acknowledge an alert. Prevents further escalation. */
  acknowledgeAlert(eventId: UUID, acknowledgedBy: string, note?: string): FridayAlertEvent | null {
    const event = this.activeEvents.get(eventId);
    if (!event) return null;
    if (event.status === "pending") return null;
    if (event.status === "resolved") return null;
    if (event.status === "acknowledged") return event;

    const updated: FridayAlertEvent = {
      ...event,
      status: "acknowledged",
      acknowledgedAt: new Date().toISOString(),
      acknowledgedBy,
      acknowledgeNote: note,
    };
    this.activeEvents.set(updated.id, updated);
    return updated;
  }

  /** Resolve an alert (condition cleared). */
  resolveAlert(eventId: UUID): FridayAlertEvent | null {
    const event = this.activeEvents.get(eventId);
    if (!event) return null;
    if (event.status === "resolved") return event;

    const updated: FridayAlertEvent = {
      ...event,
      status: "resolved",
      resolvedAt: new Date().toISOString(),
    };
    this.activeEvents.set(updated.id, updated);
    return updated;
  }

  // ─── Query ───

  /** Get an active event by ID. */
  getEvent(eventId: UUID): FridayAlertEvent | null {
    const event = this.activeEvents.get(eventId);
    return event ? cloneAndFreeze(event) : null;
  }

  /** Get all active events. */
  getActiveEvents(): FridayAlertEvent[] {
    return cloneAndFreeze(Array.from(this.activeEvents.values()).filter(
      (e) => e.status !== "resolved",
    ));
  }

  /** Get all events (including resolved). */
  getAllEvents(): FridayAlertEvent[] {
    return cloneAndFreeze(Array.from(this.activeEvents.values()));
  }

  /** Find an active (non-resolved) event for a given rule. */
  findActiveEventForRule(ruleId: UUID): FridayAlertEvent | null {
    for (const event of this.activeEvents.values()) {
      if (event.ruleId === ruleId && event.status !== "resolved") {
        return event;
      }
    }
    return null;
  }

  /** Get events filtered by severity (returns immutable snapshots). */
  getEventsBySeverity(severity: FridayAlertSeverity): FridayAlertEvent[] {
    return cloneAndFreeze(Array.from(this.activeEvents.values()).filter((e) => e.severity === severity));
  }

  /** Get events filtered by status (returns immutable snapshots). */
  getEventsByStatus(status: FridayAlertEventStatus): FridayAlertEvent[] {
    return cloneAndFreeze(Array.from(this.activeEvents.values()).filter((e) => e.status === status));
  }

  /** Get the highest severity among active (non-resolved) events. Returns null if no active events. */
  getHighestActiveSeverity(): FridayAlertSeverity | null {
    const active = this.getActiveEvents();
    if (active.length === 0) return null;
    for (const severity of FRIDAY_ALERT_SEVERITY_PRIORITY) {
      if (active.some((e) => e.severity === severity)) return severity;
    }
    return null;
  }

  /** Clear resolved events older than the given cutoff. */
  purgeResolvedBefore(cutoff: ISODateTime): number {
    let purged = 0;
    for (const [id, event] of this.activeEvents) {
      if (event.status === "resolved" && event.resolvedAt && event.resolvedAt < cutoff) {
        this.activeEvents.delete(id);
        purged++;
      }
    }
    return purged;
  }

  /** Reset all state (for testing). */
  reset(): void {
    this.rules.clear();
    this.activeEvents.clear();
    this.anomalyBaselines.clear();
    this.metricProvider = null;
    this.burnRateProvider = null;
    this.runbookExecutor = null;
  }
}
