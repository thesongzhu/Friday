/**
 * Rule Index — in-memory index for O(1) rule lookup by resource:action.
 *
 * Rules are grouped by composite key `${resource}:${action}` and sorted
 * by explicit tuple priority within each bucket:
 * (bundle.priority, rule.priority, bundle.id, rule.id).
 *
 * The index is rebuilt atomically on any rule mutation, ensuring concurrent
 * evaluations always see a consistent snapshot.
 *
 * @module rules/engine
 */

import type {
  FridayPolicyBundle,
  FridayRule,
  FridayRuleAction,
  FridayRuleResource,
} from "../model/friday-rules-engine.types.js";
import { precompileConditionGroupRegex } from "./condition-evaluator.js";

// ─── Types ───

/** A compiled rule with pre-compiled regex patterns for hot-path performance. */
export interface CompiledRule {
  /** The original rule definition. */
  rule: FridayRule;
  /** The parent policy bundle (for priority ordering). */
  bundle: FridayPolicyBundle;
  /**
   * Numeric priority derived from the tuple ordering for deterministic output.
   */
  effectivePriority: number;
}

interface PendingCompiledRule {
  rule: FridayRule;
  bundle: FridayPolicyBundle;
  sortOrdinal: number;
}

// ─── Index Key ───

/** Build the composite index key for a resource:action pair. */
export function buildIndexKey(resource: FridayRuleResource, action: FridayRuleAction): string {
  return `${resource}:${action}`;
}

// ─── Rule Index ───

export class FridayRuleIndex {
  /** Indexed rules by resource:action key. Sorted by tuple priority. */
  private buckets: Map<string, readonly CompiledRule[]> = new Map();

  /** Total number of indexed rules. */
  private count = 0;

  /** Rebuild the entire index from a set of bundles and their rules. */
  rebuild(entries: ReadonlyArray<{ bundle: FridayPolicyBundle; rules: FridayRule[] }>): void {
    const pending = new Map<string, PendingCompiledRule[]>();
    let total = 0;
    let hasActiveRules = false;
    let minRulePriority = 0;
    let maxRulePriority = 0;
    let sortOrdinal = 0;

    for (const { bundle, rules } of entries) {
      if (!bundle.enabled) continue;
      const bundleSnapshot = deepFreeze(structuredClone(bundle));

      for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.deletedAt) continue;

        precompileConditionGroupRegex(rule.conditions);

        const ruleSnapshot = deepFreeze(structuredClone(rule));
        if (!hasActiveRules) {
          hasActiveRules = true;
          minRulePriority = ruleSnapshot.priority;
          maxRulePriority = ruleSnapshot.priority;
        } else {
          minRulePriority = Math.min(minRulePriority, ruleSnapshot.priority);
          maxRulePriority = Math.max(maxRulePriority, ruleSnapshot.priority);
        }

        const key = buildIndexKey(rule.resource, rule.action);
        const compiled: PendingCompiledRule = {
          rule: ruleSnapshot,
          bundle: bundleSnapshot,
          sortOrdinal,
        };
        sortOrdinal++;

        let bucket = pending.get(key);
        if (!bucket) {
          bucket = [];
          pending.set(key, bucket);
        }
        bucket.push(compiled);
        total++;
      }
    }

    const priorityStride = hasActiveRules ? maxRulePriority - minRulePriority + 1 : 1;
    const next = new Map<string, readonly CompiledRule[]>();

    // Sort each bucket by explicit tuple ordering:
    // 1) bundle priority, 2) rule priority, 3) stable tie-breakers.
    for (const [key, bucket] of pending) {
      bucket.sort((a, b) => {
        if (a.bundle.priority !== b.bundle.priority) {
          return a.bundle.priority - b.bundle.priority;
        }
        if (a.rule.priority !== b.rule.priority) {
          return a.rule.priority - b.rule.priority;
        }
        if (a.bundle.id !== b.bundle.id) {
          return a.bundle.id.localeCompare(b.bundle.id);
        }
        if (a.rule.id !== b.rule.id) {
          return a.rule.id.localeCompare(b.rule.id);
        }
        return a.sortOrdinal - b.sortOrdinal;
      });

      const compiledBucket = bucket.map((entry) => deepFreeze({
        rule: entry.rule,
        bundle: entry.bundle,
        effectivePriority:
          entry.bundle.priority * priorityStride + (entry.rule.priority - minRulePriority),
      } satisfies CompiledRule));

      next.set(key, Object.freeze(compiledBucket));
    }

    // Atomic swap.
    this.buckets = next;
    this.count = total;
  }

  /**
   * Find all compiled rules matching a resource:action pair.
   * Returns an empty array if no rules match (default-allow).
   */
  findRules(resource: FridayRuleResource, action: FridayRuleAction): readonly CompiledRule[] {
    const bucket = this.buckets.get(buildIndexKey(resource, action)) ?? EMPTY_BUCKET;
    if (bucket.length === 0) return EMPTY_BUCKET;
    return Object.freeze(bucket.map((compiled) => deepFreeze(structuredClone(compiled))));
  }

  /**
   * Internal fast-path accessor for immutable snapshots.
   * Used by the evaluation hot path to avoid per-evaluation cloning.
   */
  findRulesSnapshot(resource: FridayRuleResource, action: FridayRuleAction): readonly CompiledRule[] {
    return this.buckets.get(buildIndexKey(resource, action)) ?? EMPTY_BUCKET;
  }

  /** Get the total number of indexed (active) rules. */
  get size(): number {
    return this.count;
  }

  /** Get all indexed rules (for testing/debugging). */
  getAllRules(): readonly CompiledRule[] {
    const all: CompiledRule[] = [];
    for (const bucket of this.buckets.values()) {
      all.push(...bucket.map((compiled) => deepFreeze(structuredClone(compiled))));
    }
    return Object.freeze(all);
  }

  /** Clear the index. */
  clear(): void {
    this.buckets.clear();
    this.count = 0;
  }
}

const EMPTY_BUCKET: readonly CompiledRule[] = Object.freeze([]);

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
