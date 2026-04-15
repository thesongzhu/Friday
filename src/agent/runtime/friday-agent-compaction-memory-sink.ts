/**
 * Compaction Memory Sink: persists structured compaction summaries as memory
 * items so they survive beyond the current session and can be retrieved in
 * future sessions via the workspace context loader.
 *
 * Items are stored with TTL to prevent unbounded growth.  Important items
 * will be re-extracted and promoted by the session memory extraction service.
 */

import type {
  FridayContextCompactionBlockSummary,
  FridayContextCompactionSummary,
} from "../../providers/model/friday-provider-context.types.js";
import type { FridayMemoryService } from "../../memory/services/friday-memory-service.types.js";

// ─── Constants ───

/** TTL for compaction summary items (7 days). */
const COMPACTION_SUMMARY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** TTL for tool failure items (3 days — shorter, more transient). */
const COMPACTION_FAILURE_TTL_SECONDS = 3 * 24 * 60 * 60;

/** Base confidence for auto-extracted compaction items (lower than user-explicit). */
const COMPACTION_BASE_CONFIDENCE = 0.6;

/** Slightly higher confidence for tool failures (more actionable). */
const COMPACTION_FAILURE_CONFIDENCE = 0.7;

// ─── Interface ───

export interface FridayCompactionMemorySink {
  /**
   * Persist compaction summary as memory items.
   * This method is designed to be called non-blocking (fire-and-forget).
   */
  persist(params: {
    sessionKey: string;
    runId: string;
    summary: FridayContextCompactionSummary;
    blocks?: FridayContextCompactionBlockSummary[];
    compactedAt: string;
  }): Promise<void>;
}

// ─── Factory ───

export interface CreateFridayCompactionMemorySinkDeps {
  memoryService: FridayMemoryService;
  idGenerator: () => string;
  nowIso: () => string;
}

export function createFridayCompactionMemorySink(
  deps: CreateFridayCompactionMemorySinkDeps,
): FridayCompactionMemorySink {
  const { memoryService } = deps;

  return {
    async persist(params) {
      const { sessionKey, runId, summary, compactedAt } = params;
      // Encode sessionKey to avoid colons breaking source parsing downstream.
      // The context formatter splits on ":" to extract sessionKey back out.
      const safeSessionKey = sessionKey.replace(/:/g, "_");
      const source = `compaction:${safeSessionKey}:${runId}`;
      const baseTags = ["compaction", "auto", sessionKey];

      const storePromises: Promise<unknown>[] = [];

      // ── Decisions ──
      if (summary.decisions.length > 0) {
        storePromises.push(
          memoryService.store("compaction.decisions", summary.decisions.join("\n"), {
            source,
            key: `decisions:${runId}`,
            tags: [...baseTags, "decisions"],
            metadata: { compactedAt, count: summary.decisions.length },
            ttlSeconds: COMPACTION_SUMMARY_TTL_SECONDS,
            memoryType: "episode",
            confidence: COMPACTION_BASE_CONFIDENCE,
          }),
        );
      }

      // ── TODOs ──
      if (summary.todos.length > 0) {
        storePromises.push(
          memoryService.store("compaction.todos", summary.todos.join("\n"), {
            source,
            key: `todos:${runId}`,
            tags: [...baseTags, "todos"],
            metadata: { compactedAt, count: summary.todos.length },
            ttlSeconds: COMPACTION_SUMMARY_TTL_SECONDS,
            memoryType: "procedure",
            confidence: COMPACTION_BASE_CONFIDENCE,
          }),
        );
      }

      // ── Tool failures ──
      if (summary.toolFailures.length > 0) {
        storePromises.push(
          memoryService.store("compaction.failures", summary.toolFailures.join("\n"), {
            source,
            key: `failures:${runId}`,
            tags: [...baseTags, "failures"],
            metadata: { compactedAt, count: summary.toolFailures.length },
            ttlSeconds: COMPACTION_FAILURE_TTL_SECONDS,
            memoryType: "episode",
            confidence: COMPACTION_FAILURE_CONFIDENCE,
          }),
        );
      }

      // ── File operations ──
      if (summary.fileOperations.length > 0) {
        storePromises.push(
          memoryService.store("compaction.files", summary.fileOperations.join("\n"), {
            source,
            key: `files:${runId}`,
            tags: [...baseTags, "files"],
            metadata: { compactedAt, count: summary.fileOperations.length },
            ttlSeconds: COMPACTION_SUMMARY_TTL_SECONDS,
            memoryType: "fact",
            confidence: COMPACTION_BASE_CONFIDENCE,
          }),
        );
      }

      // ── Consolidated summary ──
      if (summary.summaryText.length > 0) {
        storePromises.push(
          memoryService.store("compaction.summary", summary.summaryText, {
            source,
            key: `summary:${runId}`,
            tags: [...baseTags, "summary"],
            metadata: {
              compactedAt,
              decisionsCount: summary.decisions.length,
              todosCount: summary.todos.length,
              openQuestionsCount: summary.openQuestions.length,
              failuresCount: summary.toolFailures.length,
            },
            ttlSeconds: COMPACTION_SUMMARY_TTL_SECONDS,
            memoryType: "episode",
            confidence: 0.5, // Lower — consolidated text is less precise
          }),
        );
      }

      // ── Open questions ──
      if (summary.openQuestions.length > 0) {
        storePromises.push(
          memoryService.store("compaction.questions", summary.openQuestions.join("\n"), {
            source,
            key: `questions:${runId}`,
            tags: [...baseTags, "questions"],
            metadata: { compactedAt, count: summary.openQuestions.length },
            ttlSeconds: COMPACTION_SUMMARY_TTL_SECONDS,
            memoryType: "episode",
            confidence: COMPACTION_BASE_CONFIDENCE,
          }),
        );
      }

      // Execute all stores concurrently, swallowing individual failures
      const results = await Promise.allSettled(storePromises);
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        // Log but don't throw — memory persistence must never block the agent loop
        // The caller should wrap this in void + .catch() anyway
      }
    },
  };
}
