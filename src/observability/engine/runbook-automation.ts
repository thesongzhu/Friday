/**
 * Runbook Automation — Escalation-triggered runbook execution.
 *
 * Provides a lightweight in-memory registry and executor for automating
 * operational runbooks when alert events escalate.
 *
 * **B4 truth-labeling note (proof_pending; NOT wired into production):**
 * `RunbookRegistry`, `RunbookExecutor`, `RunbookDefinition`,
 * `RunbookExecutionContext`, and `RunbookExecutionResult` are exported
 * via the parent barrel but have ZERO production import sites as of
 * the B4 capability inventory. The observability `createService` path
 * constructs the alert evaluation scheduler WITHOUT a runbook registry
 * — escalating alerts notify destinations (Slack/SMTP) but do not
 * trigger any automated runbook. Only the existing scheduler unit
 * test (`friday-alert-evaluation-scheduler.test.ts`) and this
 * module's own tests instantiate the registry.
 *
 * The exports are preserved via the parent barrel so a future
 * "wire-runbook-automation-into-alert-engine" slice can hook them in
 * without a contract break. A one-time `console.info` advisory fires
 * at first `RunbookRegistry` construction so anyone wiring it in
 * production sees the proof_pending state in logs.
 *
 * @module observability/engine
 */

import type {
  FridayAlertEvent,
  FridayAlertRule,
  FridayEscalationTier,
  ISODateTime,
  UUID,
} from "../model/friday-observability.types.js";

/** Context passed to a runbook when an alert escalation occurs. */
export interface RunbookExecutionContext {
  /** Escalated alert event snapshot. */
  readonly event: FridayAlertEvent;
  /** Alert rule snapshot. */
  readonly rule: FridayAlertRule;
  /** Escalation tier that triggered the execution. */
  readonly tier: FridayEscalationTier;
  /** When the execution was triggered. */
  readonly triggeredAt: ISODateTime;
}

/** A registered runbook definition. */
export interface RunbookDefinition {
  /** Runbook identifier. */
  readonly id: UUID;
  /** Human-readable runbook name. */
  readonly name: string;
  /** Rule this runbook is associated with. */
  readonly ruleId: UUID;
  /** Optional description. */
  readonly description?: string;
  /** Runbook action to execute on escalation. */
  readonly execute: (context: RunbookExecutionContext) => void;
}

/** Execution result for a single runbook invocation. */
export interface RunbookExecutionResult {
  /** Runbook identifier. */
  readonly runbookId: UUID;
  /** Alert rule identifier. */
  readonly ruleId: UUID;
  /** Alert event identifier. */
  readonly eventId: UUID;
  /** Escalation tier number. */
  readonly tier: number;
  /** Invocation outcome. */
  readonly status: "success" | "failed";
  /** When execution was attempted. */
  readonly executedAt: ISODateTime;
  /** Error message on failure. */
  readonly errorMessage?: string;
}

let runbookRegistryAdvisoryEmitted = false;

/** Warn-once advisory at first RunbookRegistry construction. See file header. */
function emitRunbookRegistryAdvisoryOnce(): void {
  if (runbookRegistryAdvisoryEmitted) return;
  runbookRegistryAdvisoryEmitted = true;
  console.info(
    "[friday][observability][runbook-automation] advisory: RunbookRegistry is constructed but has zero production import sites as of the B4 capability inventory; the observability alert evaluation scheduler runs WITHOUT runbook automation. Wiring runbook escalation is proof_pending — see file header.",
  );
}

/** Registry of runbooks keyed by rule. */
export class RunbookRegistry {
  private readonly runbooks = new Map<UUID, RunbookDefinition>();
  private readonly runbookIdsByRule = new Map<UUID, Set<UUID>>();

  constructor() {
    emitRunbookRegistryAdvisoryOnce();
  }

  /** Register or replace a runbook definition. */
  registerRunbook(runbook: RunbookDefinition): void {
    const existing = this.runbooks.get(runbook.id);
    if (existing) {
      this.detachRunbookId(existing.ruleId, existing.id);
    }

    this.runbooks.set(runbook.id, runbook);

    let ids = this.runbookIdsByRule.get(runbook.ruleId);
    if (!ids) {
      ids = new Set<UUID>();
      this.runbookIdsByRule.set(runbook.ruleId, ids);
    }
    ids.add(runbook.id);
  }

  /** Unregister a runbook. */
  unregisterRunbook(runbookId: UUID): boolean {
    const existing = this.runbooks.get(runbookId);
    if (!existing) return false;

    this.runbooks.delete(runbookId);
    this.detachRunbookId(existing.ruleId, runbookId);
    return true;
  }

  /** Get a runbook by ID. */
  getRunbook(runbookId: UUID): RunbookDefinition | null {
    return this.runbooks.get(runbookId) ?? null;
  }

  /** Get all runbooks registered for a specific rule. */
  getRunbooksForRule(ruleId: UUID): RunbookDefinition[] {
    const ids = this.runbookIdsByRule.get(ruleId);
    if (!ids) return [];

    const runbooks: RunbookDefinition[] = [];
    for (const id of ids) {
      const runbook = this.runbooks.get(id);
      if (runbook) runbooks.push(runbook);
    }
    return runbooks;
  }

  /** Clear all runbooks. */
  clear(): void {
    this.runbooks.clear();
    this.runbookIdsByRule.clear();
  }

  private detachRunbookId(ruleId: UUID, runbookId: UUID): void {
    const ids = this.runbookIdsByRule.get(ruleId);
    if (!ids) return;

    ids.delete(runbookId);
    if (ids.size === 0) {
      this.runbookIdsByRule.delete(ruleId);
    }
  }
}

/** Executes runbooks for escalation events and tracks history. */
export class RunbookExecutor {
  private readonly executionHistory: RunbookExecutionResult[] = [];

  constructor(private readonly registry: RunbookRegistry) {}

  /** Trigger all runbooks associated with a rule escalation. */
  triggerOnEscalation(
    event: FridayAlertEvent,
    rule: FridayAlertRule,
    tier: FridayEscalationTier,
  ): RunbookExecutionResult[] {
    const runbooks = this.registry.getRunbooksForRule(rule.id);
    if (runbooks.length === 0) return [];

    const executedAt = new Date().toISOString();
    const results: RunbookExecutionResult[] = [];

    for (const runbook of runbooks) {
      const context: RunbookExecutionContext = {
        event: structuredClone(event),
        rule: structuredClone(rule),
        tier: structuredClone(tier),
        triggeredAt: executedAt,
      };

      try {
        runbook.execute(context);
        results.push({
          runbookId: runbook.id,
          ruleId: rule.id,
          eventId: event.id,
          tier: tier.tier,
          status: "success",
          executedAt,
        });
      } catch (error) {
        results.push({
          runbookId: runbook.id,
          ruleId: rule.id,
          eventId: event.id,
          tier: tier.tier,
          status: "failed",
          executedAt,
          errorMessage: error instanceof Error ? error.message : "Runbook execution failed",
        });
      }
    }

    this.executionHistory.push(...results);
    return results;
  }

  /** Read execution history. */
  getExecutionHistory(): readonly RunbookExecutionResult[] {
    return this.executionHistory.map((result) => ({ ...result }));
  }

  /** Clear execution history. */
  clearExecutionHistory(): void {
    this.executionHistory.length = 0;
  }
}
