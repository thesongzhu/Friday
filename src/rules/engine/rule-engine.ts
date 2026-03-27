/**
 * Rule Engine — deterministic policy evaluation engine.
 *
 * Top-level facade that orchestrates:
 * - Policy bundle management (load, validate, cache, hot-reload)
 * - Rule evaluation against execution context (pre/post hooks)
 * - Decision computation (allow/deny/warn/audit)
 * - Audit log entry generation
 *
 * Design guarantees:
 * - Deterministic: same input always produces same output.
 * - No I/O in the evaluation hot path (audit log is enqueued, not flushed).
 * - Thread-safe: Node.js single-thread model + atomic index swaps.
 *
 * @module rules/engine
 */

import type {
  ContextRedactionRules,
  FridayEvaluationContext,
  FridayEvaluationResult,
  FridayEvaluationSource,
  FridayEvaluationTransition,
  FridayEvaluationTransitionReason,
  FridayEvaluationTransitionState,
  FridayMatchedRule,
  FridayPolicyBundle,
  FridayRule,
  FridayRuleDecision,
  FridayRuleHookHandler,
  FridayRuleHookPhase,
  FridayRuleHookRegistration,
  UUID,
} from "../model/friday-rules-engine.types.js";

import { FRIDAY_RULE_DECISION_PRIORITY } from "../model/friday-rules-engine.types.js";

import { type CompiledRule, FridayRuleIndex } from "./rule-index.js";
import { type BundleManagerStats, FridayPolicyBundleManager, type LoadedBundle } from "./policy-bundle-manager.js";
import { evaluateConditionGroup } from "./condition-evaluator.js";
import { redactContext, type RedactionResult } from "./context-redactor.js";

// ─── Types ───

/** Audit log entry produced by evaluation. */
export interface AuditLogEntry {
  evaluationId: UUID;
  auditReferenceId: UUID;
  actor: string;
  decision: FridayRuleDecision;
  resource: string;
  action: string;
  contextRedacted: RedactionResult;
  matchedRules: FridayMatchedRule[];
  matchedRuleIds: UUID[];
  durationMs: number;
  runId?: string;
  workflowId?: string;
  principalId?: string;
  evaluatedAt: string;
}

/** Callback for consuming audit log entries. */
export type AuditLogSink = (entry: AuditLogEntry) => void;

/** Callback for observing internal evaluation state transitions. */
export type FridayRuleEngineTransitionHandler = (transition: FridayEvaluationTransition) => void;

/** Configuration options for the rule engine. */
export interface FridayRuleEngineOptions {
  /** Callback to receive audit log entries. If not provided, entries are discarded. */
  auditLogSink?: AuditLogSink;
  /** Default decision when no rules match. Defaults to "allow". */
  defaultDecision?: FridayRuleDecision;
  /** Signature secrets for verifying signed policy bundles by key ID. */
  signatureSecrets?: Readonly<Record<string, string>>;
  /** Require signatures on all loaded policy bundles when true. */
  enforceBundleSignature?: boolean;
  /** Redaction rules used for audit context output. */
  redactionRules?: ContextRedactionRules;
  /** Optional global transition observer for all evaluations. */
  onTransition?: FridayRuleEngineTransitionHandler;
}

/** Per-call evaluation options. */
export interface FridayRuleEvaluationOptions {
  /** Include transition trace in the returned evaluation result. */
  includeTransitionTrace?: boolean;
  /** Optional per-call transition observer. */
  onTransition?: FridayRuleEngineTransitionHandler;
}

interface TransitionTracker {
  readonly trace: FridayEvaluationTransition[] | undefined;
  transition: (state: FridayEvaluationTransitionState, reason?: FridayEvaluationTransitionReason) => void;
}

const REQUIRED_EVALUATION_SCOPE = "rules:evaluate";

// ─── UUID Generation ───

function generateUuid(): UUID {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Rule Engine ───

export class FridayRuleEngine {
  private readonly ruleIndex: FridayRuleIndex;
  private readonly bundleManager: FridayPolicyBundleManager;
  private readonly hooks: FridayRuleHookRegistration[] = [];
  private readonly auditTrail: AuditLogEntry[] = [];
  private readonly auditLogSink: AuditLogSink | undefined;
  private readonly defaultDecision: FridayRuleDecision;
  private readonly redactionRules: ContextRedactionRules | undefined;
  private readonly onTransition: FridayRuleEngineTransitionHandler | undefined;

  constructor(options: FridayRuleEngineOptions = {}) {
    this.ruleIndex = new FridayRuleIndex();
    this.bundleManager = new FridayPolicyBundleManager(this.ruleIndex, {
      signatureSecrets: options.signatureSecrets,
      enforceBundleSignature: options.enforceBundleSignature,
    });
    this.auditLogSink = options.auditLogSink;
    this.defaultDecision = options.defaultDecision ?? "allow";
    this.redactionRules = options.redactionRules;
    this.onTransition = options.onTransition;
  }

  // ─── Evaluation ───

  /**
   * Evaluate an execution context against all loaded policy rules.
   *
   * 1. Find candidate rules by resource:action (O(1) bucket lookup).
   * 2. Evaluate each candidate's conditions against the context.
   * 3. Collect matched rules, compute final decision by priority.
   * 4. Emit audit log entry.
   *
   * Returns an EvaluationResult with the decision and all matched rules.
   */
  evaluate(
    context: FridayEvaluationContext,
    options: FridayRuleEvaluationOptions = {},
  ): FridayEvaluationResult {
    const tracker = this.createTransitionTracker(options);
    const result = this.hasRequiredScope(context)
      ? this.evaluateCore(context, tracker)
      : this.evaluateInsufficientScope(context, tracker);
    tracker.transition("done");
    return this.finalizeEvaluationResult(result, tracker);
  }

  /**
   * Evaluate context against rules and emit audit (without finalizing done-state).
   */
  private evaluateCore(context: FridayEvaluationContext, tracker: TransitionTracker): FridayEvaluationResult {
    const startTime = performance.now();
    const evaluationId = generateUuid();
    const auditReferenceId = generateUuid();
    tracker.transition("match");

    // Find candidate rules for this resource:action pair.
    const candidates = this.ruleIndex.findRulesSnapshot(context.resource, context.action);

    // Filter by policy bundle IDs if specified in context.
    const filteredCandidates = context.policyBundleIds?.length
      ? candidates.filter((c) => context.policyBundleIds!.includes(c.bundle.id))
      : candidates;

    // Evaluate all candidates (full-scan for deterministic matched-rules output).
    const matchedRules: FridayMatchedRule[] = [];
    for (const compiled of filteredCandidates) {
      if (evaluateConditionGroup(context, compiled.rule.conditions)) {
        matchedRules.push(toMatchedRule(compiled));
      }
    }

    tracker.transition("decide");
    // Compute final decision.
    const decision = computeFinalDecision(matchedRules, this.defaultDecision);

    // Find the message from the highest-priority matched rule with the winning decision.
    const message = findDecisionMessage(matchedRules, decision);

    const durationMs = Math.round((performance.now() - startTime) * 100) / 100;
    const evaluatedAt = new Date().toISOString();

    const result: FridayEvaluationResult = {
      evaluationId,
      decision,
      matchedRules,
      message,
      durationMs,
      allowed: decision !== "deny",
      evaluatedAt,
    };
    this.attachRuleDenyError(result, auditReferenceId);

    tracker.transition("audit");
    // Emit audit log entry (non-blocking).
    const auditSucceeded = this.emitAuditEntry(result, context, auditReferenceId);
    if (!auditSucceeded) {
      tracker.transition("rollback", "audit_sink_failure");
    }

    return result;
  }

  private evaluateInsufficientScope(
    context: FridayEvaluationContext,
    tracker: TransitionTracker,
  ): FridayEvaluationResult {
    const startTime = performance.now();
    const evaluationId = generateUuid();
    const auditReferenceId = generateUuid();
    const message = `Missing required scope: ${REQUIRED_EVALUATION_SCOPE}`;

    tracker.transition("decide");

    const result: FridayEvaluationResult = {
      evaluationId,
      decision: "deny",
      matchedRules: [],
      message,
      durationMs: Math.round((performance.now() - startTime) * 100) / 100,
      allowed: false,
      evaluatedAt: new Date().toISOString(),
      error: {
        code: "INSUFFICIENT_SCOPE",
        message,
        auditReferenceId,
      },
    };

    tracker.transition("audit");
    const auditSucceeded = this.emitAuditEntry(result, context, auditReferenceId);
    if (!auditSucceeded) {
      tracker.transition("rollback", "audit_sink_failure");
    }

    return result;
  }

  /**
   * Evaluate with pre/post hooks.
   *
   * Pre-hooks run before evaluation and may enrich the context.
   * Post-hooks run after evaluation with the result available.
   */
  async evaluateWithHooks(
    context: FridayEvaluationContext,
    options: FridayRuleEvaluationOptions = {},
  ): Promise<FridayEvaluationResult> {
    const tracker = this.createTransitionTracker(options);

    if (!this.hasRequiredScope(context)) {
      const result = this.evaluateInsufficientScope(context, tracker);
      tracker.transition("done");
      return this.finalizeEvaluationResult(result, tracker);
    }

    // Run pre-hooks.
    const preHooksSucceeded = await this.runHooks("pre", context.source, context);
    if (!preHooksSucceeded) {
      tracker.transition("rollback", "pre_hook_failure");
    }

    // Evaluate rules (synchronous hot path) and emit audit.
    const result = this.evaluateCore(context, tracker);

    // Run post-hooks.
    const postHooksSucceeded = await this.runHooks("post", context.source, context, result);
    if (!postHooksSucceeded) {
      tracker.transition("rollback", "post_hook_failure");
    }

    tracker.transition("done");
    return this.finalizeEvaluationResult(result, tracker);
  }

  // ─── Hook Management ───

  /** Register a pre-evaluation hook. */
  registerPreHook(source: FridayEvaluationSource, handler: FridayRuleHookHandler): void {
    this.hooks.push({ source, phase: "pre", handler });
  }

  /** Register a post-evaluation hook. */
  registerPostHook(source: FridayEvaluationSource, handler: FridayRuleHookHandler): void {
    this.hooks.push({ source, phase: "post", handler });
  }

  /** Remove all hooks for a given source. */
  removeHooks(source: FridayEvaluationSource): void {
    for (let i = this.hooks.length - 1; i >= 0; i--) {
      if (this.hooks[i].source === source) {
        this.hooks.splice(i, 1);
      }
    }
  }

  // ─── Policy Bundle Management (delegated) ───

  /** Load a policy bundle from YAML. */
  async loadPolicyBundleFromYaml(yamlContent: string): Promise<LoadedBundle> {
    return this.bundleManager.loadFromYaml(yamlContent);
  }

  /** Load a policy bundle from JSON. */
  loadPolicyBundleFromJson(jsonContent: string): LoadedBundle {
    return this.bundleManager.loadFromJson(jsonContent);
  }

  /** Load a policy bundle from a raw object. */
  loadPolicyBundleFromObject(raw: unknown): LoadedBundle {
    return this.bundleManager.loadFromObject(raw);
  }

  /** Load pre-constructed domain entities (e.g., from database). */
  loadDomainBundle(bundle: FridayPolicyBundle, rules: FridayRule[]): LoadedBundle {
    return this.bundleManager.loadDomainBundle(bundle, rules);
  }

  /** Remove a policy bundle. */
  removePolicyBundle(bundleId: UUID): boolean {
    return this.bundleManager.removeBundle(bundleId);
  }

  /** Get a loaded bundle. */
  getPolicyBundle(bundleId: UUID): LoadedBundle | undefined {
    return this.bundleManager.getBundle(bundleId);
  }

  /** Get all loaded bundles. */
  getAllPolicyBundles(): readonly LoadedBundle[] {
    return this.bundleManager.getAllBundles();
  }

  /** Get engine statistics. */
  getStats(): BundleManagerStats & { indexedRuleCount: number } {
    return {
      ...this.bundleManager.getStats(),
      indexedRuleCount: this.ruleIndex.size,
    };
  }

  /** Get in-memory audit trail entries (immutable snapshot). */
  getAuditTrail(): readonly AuditLogEntry[] {
    return cloneAndFreeze(this.auditTrail);
  }

  /** Clear all bundles, rules, and hooks. */
  clear(): void {
    this.bundleManager.clear();
    this.hooks.length = 0;
    this.auditTrail.length = 0;
  }

  // ─── Internal ───

  /** Run hooks for a given phase and source. */
  private async runHooks(
    phase: FridayRuleHookPhase,
    source: FridayEvaluationSource,
    context: FridayEvaluationContext,
    result?: FridayEvaluationResult,
  ): Promise<boolean> {
    let hadFailure = false;
    for (const hook of this.hooks) {
      if (hook.phase === phase && hook.source === source) {
        try {
          await hook.handler(context, result);
        } catch (err) {
          // Hook failures are isolated from enforcement decisions.
          console.warn("[friday][rule-engine] hook execution failed:", err instanceof Error ? err.message : String(err));
          hadFailure = true;
        }
      }
    }
    return !hadFailure;
  }

  private hasRequiredScope(context: FridayEvaluationContext): boolean {
    return context.scopes?.includes(REQUIRED_EVALUATION_SCOPE) ?? false;
  }

  private attachRuleDenyError(result: FridayEvaluationResult, auditReferenceId: UUID): void {
    if (result.decision !== "deny") {
      return;
    }

    result.error = {
      code: "RULE_DENIED",
      message: result.message ?? "Denied by policy",
      auditReferenceId,
    };
  }

  /** Emit an audit log entry to the sink. */
  private emitAuditEntry(
    result: FridayEvaluationResult,
    context: FridayEvaluationContext,
    auditReferenceId: UUID,
  ): boolean {
    const contextRedacted = redactContext(context.args, this.redactionRules);

    const entry: AuditLogEntry = {
      evaluationId: result.evaluationId,
      auditReferenceId,
      actor: resolveActor(context),
      decision: result.decision,
      resource: context.resource,
      action: context.action,
      contextRedacted,
      matchedRules: result.matchedRules,
      matchedRuleIds: result.matchedRules.map((matched) => matched.ruleId),
      durationMs: result.durationMs,
      runId: context.runId,
      workflowId: context.workflowId,
      principalId: context.principalId,
      evaluatedAt: result.evaluatedAt,
    };

    const entrySnapshot = cloneAndFreeze(entry);
    this.auditTrail.push(entrySnapshot);

    if (!this.auditLogSink) return true;

    try {
      this.auditLogSink(entrySnapshot);
      return true;
    } catch (err) {
      // Telemetry failures must not affect enforcement results.
      console.warn("[friday][rule-engine] audit log sink failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** Create a transition tracker for one evaluation call. */
  private createTransitionTracker(options: FridayRuleEvaluationOptions): TransitionTracker {
    const trace: FridayEvaluationTransition[] | undefined = options.includeTransitionTrace ? [] : undefined;
    let currentState: FridayEvaluationTransitionState = "init";

    return {
      trace,
      transition: (state: FridayEvaluationTransitionState, reason?: FridayEvaluationTransitionReason) => {
        const transition: FridayEvaluationTransition = {
          from: currentState,
          to: state,
          at: new Date().toISOString(),
          ...(reason ? { reason } : {}),
        };

        trace?.push(transition);
        this.emitTransition(transition, options.onTransition);
        currentState = state;
      },
    };
  }

  /** Emit transition callbacks while isolating callback failures. */
  private emitTransition(
    transition: FridayEvaluationTransition,
    localObserver?: FridayRuleEngineTransitionHandler,
  ): void {
    if (this.onTransition) {
      try {
        this.onTransition(transition);
      } catch (err) {
        // Transition observer failures must not affect enforcement results.
        console.warn("[friday][rule-engine] transition observer failed:", err instanceof Error ? err.message : String(err));
      }
    }

    if (localObserver) {
      try {
        localObserver(transition);
      } catch (err) {
        // Transition observer failures must not affect enforcement results.
        console.warn("[friday][rule-engine] local transition observer failed:", err instanceof Error ? err.message : String(err));
      }
    }
  }

  /** Attach optional trace to the result payload. */
  private finalizeEvaluationResult(
    result: FridayEvaluationResult,
    tracker: TransitionTracker,
  ): FridayEvaluationResult {
    if (tracker.trace) {
      result.transitionTrace = [...tracker.trace];
    }
    return result;
  }
}

// ─── Decision Logic ───

/** Convert a CompiledRule to a FridayMatchedRule. */
function toMatchedRule(compiled: CompiledRule): FridayMatchedRule {
  return {
    ruleId: compiled.rule.id,
    ruleName: compiled.rule.name,
    policyBundleId: compiled.rule.policyBundleId,
    decision: compiled.rule.decision,
    message: compiled.rule.message,
    priority: compiled.effectivePriority,
  };
}

/**
 * Compute the final decision from all matched rules.
 *
 * Decision priority: deny > warn > audit > allow.
 * The highest-priority decision always wins, regardless of rule priority numbers.
 * When no rules match, returns the default decision.
 */
function computeFinalDecision(
  matchedRules: readonly FridayMatchedRule[],
  defaultDecision: FridayRuleDecision,
): FridayRuleDecision {
  if (matchedRules.length === 0) return defaultDecision;

  let winningDecision = defaultDecision;
  let winningIndex = FRIDAY_RULE_DECISION_PRIORITY.length;

  for (const rule of matchedRules) {
    const index = FRIDAY_RULE_DECISION_PRIORITY.indexOf(rule.decision);
    if (index < winningIndex) {
      winningIndex = index;
      winningDecision = rule.decision;
    }
  }

  return winningDecision;
}

/**
 * Find the message from the highest-priority matched rule
 * that produced the winning decision.
 */
function findDecisionMessage(
  matchedRules: readonly FridayMatchedRule[],
  decision: FridayRuleDecision,
): string | undefined {
  // Rules are already sorted by effective priority (ascending) from the index.
  // Find the first one that matches the winning decision.
  for (const rule of matchedRules) {
    if (rule.decision === decision && rule.message) {
      return rule.message;
    }
  }
  return undefined;
}

function resolveActor(context: FridayEvaluationContext): string {
  return context.principalId
    ?? context.runId
    ?? context.workflowId
    ?? context.workflowRunId
    ?? context.sessionId
    ?? "unknown";
}

function cloneAndFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const target = value as Record<string, unknown>;
  for (const key of Object.keys(target)) {
    deepFreeze(target[key]);
  }

  return Object.freeze(value);
}
