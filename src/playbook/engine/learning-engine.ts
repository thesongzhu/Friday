/**
 * Learning Engine — Extract patterns from execution traces and
 * generalize them into reusable playbook candidates.
 *
 * Implements the {@link FridayPlaybookCandidateGenerator} interface.
 * Processes run completion events, computes deterministic fingerprints,
 * and performs deduplication against existing candidates.
 *
 * @module playbook/engine
 */

import type {
  FridayPlaybookCandidate,
  FridayPlaybookCandidateGenerator,
  FridayPlaybookCostDimensions,
  FridayPlaybookEngineConfig,
  FridayPlaybookRunCompletionEvent,
  JsonObject,
  UUID,
} from "../model/friday-playbook.types.js";

import type { PlaybookStore } from "./playbook-store.js";

// ─── Pattern Extraction ───

/**
 * Extracted execution pattern from a completed run.
 * Contains only structural information — no runtime values.
 */
export interface ExecutionPattern {
  /** Ordered node sequence. */
  nodeSequence: Array<{ nodeType: string; adapterType?: string }>;
  /** Sorted tool names used during execution. */
  toolsUsed: string[];
  /** Sorted parameter keys (values excluded). */
  parameterKeys: string[];
  /** Input schema shapes (optional). */
  inputSchemas?: JsonObject[];
}

/**
 * Extract a normalized execution pattern from a run completion event.
 * Strips runtime-specific data (values, timestamps) and sorts sets
 * to produce deterministic output.
 */
export function extractPattern(event: FridayPlaybookRunCompletionEvent): ExecutionPattern {
  return {
    nodeSequence: event.nodeSequence.map((n) => ({
      nodeType: n.nodeType,
      ...(n.adapterType !== undefined ? { adapterType: n.adapterType } : {}),
    })),
    toolsUsed: [...event.toolsUsed].sort(),
    parameterKeys: [...event.parameterKeys].sort(),
    ...(event.inputSchemas ? { inputSchemas: event.inputSchemas } : {}),
  };
}

/**
 * Convert a pattern to a canonical JSON string for fingerprinting.
 * Object keys are sorted to ensure deterministic output.
 */
export function canonicalizePattern(pattern: ExecutionPattern): string {
  return stableStringify(pattern);
}

/**
 * Compute a stable, deterministic, NON-cryptographic fingerprint of a
 * normalized execution pattern.
 *
 * **B4 truth-labeling note (replaces prior "SHA-256 fingerprint" claim):**
 * This is FNV-1a 64-bit extended to 64 hex characters via an ad-hoc
 * mixing post-process. The 64-char hex shape resembles SHA-256 output
 * purely for downstream type/string compatibility — it is NOT a
 * cryptographic hash and MUST NOT be relied on for integrity, signing,
 * adversarial-input collision resistance, or any security-bearing
 * decision. It is suitable for in-memory deduplication of trusted
 * pattern objects where the only concern is "same input → same string".
 *
 * If a cryptographic fingerprint becomes required for an integrity or
 * signing use case, the right call is `crypto.subtle.digest('SHA-256',
 * ...)` — and the call sites should switch to that new function.
 */
export function computeStableFingerprint(pattern: ExecutionPattern): string {
  const input = canonicalizePattern(pattern);
  // FNV-1a 64-bit hash (split into two 32-bit parts for JS number safety)
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c ^ (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  const p1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const p2 = (h2 >>> 0).toString(16).padStart(8, "0");
  // Extend to 64 hex chars to resemble SHA-256 for compatibility with types
  const base = p1 + p2;
  let extended = base;
  while (extended.length < 64) {
    let h = 0x6a09e667;
    for (let j = 0; j < extended.length; j++) {
      h ^= extended.charCodeAt(j);
      h = Math.imul(h, 0x5bd1e995);
      h ^= h >>> 15;
    }
    h ^= extended.length;
    extended += (h >>> 0).toString(16).padStart(8, "0");
  }
  // Final 64-char hex string
  return extended.substring(0, 64);
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "null";
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue)
    .filter((key) => objectValue[key] !== undefined)
    .sort();

  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(objectValue[key])}`).join(",")}}`;
}

/** Minimum evidence threshold to transition from observed to pending. */
const PENDING_THRESHOLD = 3;

// ─── Learning Engine ───

/** Dependencies for creating a learning engine. */
export interface LearningEngineDeps {
  store: PlaybookStore;
  config: FridayPlaybookEngineConfig;
}

/** Create a candidate generator (learning engine) instance. */
export function createLearningEngine(deps: LearningEngineDeps): FridayPlaybookCandidateGenerator {
  const { store, config } = deps;

  return {
    async processCompletedRun(
      event: FridayPlaybookRunCompletionEvent,
    ): Promise<FridayPlaybookCandidate | null> {
      const pattern = extractPattern(event);
      const fingerprint = computeStableFingerprint(pattern);
      const existing = store.getCandidateByFingerprint(fingerprint, event.workflowType);

      if (event.success) {
        return handleSuccessfulRun(event, pattern, fingerprint, existing);
      }
      return handleFailedRun(event, existing);
    },
  };

  function handleSuccessfulRun(
    event: FridayPlaybookRunCompletionEvent,
    pattern: ExecutionPattern,
    fingerprint: string,
    existing: FridayPlaybookCandidate | undefined,
  ): FridayPlaybookCandidate {
    const now = config.nowIso();

    if (existing) {
      const updated: FridayPlaybookCandidate = {
        ...existing,
        evidenceCount: existing.evidenceCount + 1,
        successCount: existing.successCount + 1,
        totalDurationMs: existing.totalDurationMs + event.durationMs,
        totalCost: addCosts(existing.totalCost, event.cost),
        sourceRunIds: [...existing.sourceRunIds, event.runId],
        tags: mergeUnique(existing.tags, event.tags),
        lastObservedAt: event.completedAt,
        updatedAt: now,
        status:
          existing.status === "observed" && existing.evidenceCount + 1 >= PENDING_THRESHOLD
            ? "pending"
            : existing.status,
      };
      store.saveCandidate(updated);
      return updated;
    }

    const candidate: FridayPlaybookCandidate = {
      id: config.generateId(),
      fingerprint,
      workflowType: event.workflowType,
      tags: [...event.tags],
      pattern: pattern as unknown as JsonObject,
      status: "observed",
      evidenceCount: 1,
      successCount: 1,
      failureCount: 0,
      totalDurationMs: event.durationMs,
      totalCost: { ...event.cost },
      sourceRunIds: [event.runId],
      firstObservedAt: event.completedAt,
      lastObservedAt: event.completedAt,
      createdAt: now,
      updatedAt: now,
    };
    store.saveCandidate(candidate);
    return candidate;
  }

  function handleFailedRun(
    event: FridayPlaybookRunCompletionEvent,
    existing: FridayPlaybookCandidate | undefined,
  ): FridayPlaybookCandidate | null {
    if (!existing) return null;

    const now = config.nowIso();
    const updated: FridayPlaybookCandidate = {
      ...existing,
      failureCount: existing.failureCount + 1,
      updatedAt: now,
    };
    store.saveCandidate(updated);
    return updated;
  }
}

// ─── Helpers ───

function addCosts(
  a: FridayPlaybookCostDimensions,
  b: FridayPlaybookCostDimensions,
): FridayPlaybookCostDimensions {
  return {
    tokenCost: a.tokenCost + b.tokenCost,
    apiCallCost: a.apiCallCost + b.apiCallCost,
    latencyMs: a.latencyMs + b.latencyMs,
  };
}

function mergeUnique(a: string[], b: string[]): string[] {
  const set = new Set(a);
  for (const item of b) set.add(item);
  return [...set].sort();
}
