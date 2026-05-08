import type { FridaySqliteLayer } from "#state";
import type {
  FridayContextCompactionBlockSummary,
  FridayContextCompactionSummary,
} from "../../providers/model/friday-provider-context.types.js";
import {
  createFridayAgentContextReplayRepository,
  type FridayAgentContextReplayRepository,
} from "../persistence/friday-agent-context-replay-repository.js";

const SENSITIVE_TEXT_PATTERNS: ReadonlyArray<{ pattern: RegExp; preserveLabel: boolean }> = [
  { pattern: /\b(?:sk|pk|rk|ak)-[A-Za-z0-9_-]{16,}\b/g, preserveLabel: false },
  { pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, preserveLabel: false },
  { pattern: /\b(?:password|passcode|secret)\s*[:=]\s*([^\s,;]+)/gi, preserveLabel: true },
  { pattern: /\b(?:api[_ -]?key|access[_ -]?token|secret[_ -]?key)\s*[:=]\s*([^\s,;]+)/gi, preserveLabel: true },
];

export interface FridayCompactionContextReplaySink {
  /**
   * Persist compaction summary as unconfirmed context replay evidence.
   * Calls are expected to be non-blocking at the runtime edge.
   */
  persist(params: {
    sessionKey: string;
    runId: string;
    summary: FridayContextCompactionSummary;
    blocks?: FridayContextCompactionBlockSummary[];
    compactedAt: string;
  }): Promise<FridayCompactionContextReplayPersistResult>;
}

export interface FridayCompactionContextReplayPersistResult {
  persisted: boolean;
  skippedReason?: "empty_summary";
  entryId?: string;
  sessionKey: string;
  runId: string;
  blockCount: number;
  evidenceTier: "audit_replay_evidence";
  trustLevel: "unconfirmed_summary";
  redactionApplied: boolean;
  redactionCount: number;
}

export interface CreateFridayCompactionContextReplaySinkDeps {
  db: FridaySqliteLayer;
  idGenerator: () => string;
  nowIso: () => string;
  repository?: FridayAgentContextReplayRepository;
}

function hasCompactionSummaryContent(summary: FridayContextCompactionSummary): boolean {
  return summary.summaryText.trim().length > 0
    || summary.decisions.length > 0
    || summary.todos.length > 0
    || summary.openQuestions.length > 0
    || summary.toolFailures.length > 0
    || summary.fileOperations.length > 0;
}

function redactContextReplayText(text: string): { text: string; count: number } {
  let redacted = text;
  let count = 0;
  for (const { pattern, preserveLabel } of SENSITIVE_TEXT_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      count += 1;
      if (preserveLabel) {
        const label = match.match(/^([^:=]+)\s*[:=]/u)?.[1]?.trim() ?? "secret";
        return `${label}: [redacted]`;
      }
      return "[redacted]";
    });
  }
  return { text: redacted, count };
}

function redactTextArray(values: readonly string[]): { values: string[]; count: number } {
  let count = 0;
  const redactedValues = values.map((value) => {
    const result = redactContextReplayText(value);
    count += result.count;
    return result.text;
  });
  return { values: redactedValues, count };
}

function redactCompactionSummary(
  summary: FridayContextCompactionSummary,
): { summary: FridayContextCompactionSummary; redactionCount: number } {
  const summaryText = redactContextReplayText(summary.summaryText);
  const decisions = redactTextArray(summary.decisions);
  const todos = redactTextArray(summary.todos);
  const openQuestions = redactTextArray(summary.openQuestions);
  const toolFailures = redactTextArray(summary.toolFailures);
  const fileOperations = redactTextArray(summary.fileOperations);

  return {
    summary: {
      summaryText: summaryText.text,
      decisions: decisions.values,
      todos: todos.values,
      openQuestions: openQuestions.values,
      toolFailures: toolFailures.values,
      fileOperations: fileOperations.values,
    },
    redactionCount: summaryText.count
      + decisions.count
      + todos.count
      + openQuestions.count
      + toolFailures.count
      + fileOperations.count,
  };
}

export function createFridayCompactionContextReplaySink(
  deps: CreateFridayCompactionContextReplaySinkDeps,
): FridayCompactionContextReplaySink {
  const repository = deps.repository ?? createFridayAgentContextReplayRepository();

  return {
    async persist(params) {
      const blockCount = params.blocks?.length ?? 0;
      if (!hasCompactionSummaryContent(params.summary)) {
        return {
          persisted: false,
          skippedReason: "empty_summary",
          sessionKey: params.sessionKey,
          runId: params.runId,
          blockCount,
          evidenceTier: "audit_replay_evidence",
          trustLevel: "unconfirmed_summary",
          redactionApplied: false,
          redactionCount: 0,
        };
      }

      const redactedSummary = redactCompactionSummary(params.summary);
      let blockRedactionCount = 0;
      const redactedBlocks = params.blocks?.map((block) => {
        const redactedBlock = redactCompactionSummary(block);
        blockRedactionCount += redactedBlock.redactionCount;
        return {
          ...block,
          ...redactedBlock.summary,
        };
      });
      const redactionCount = redactedSummary.redactionCount + blockRedactionCount;
      const entryId = deps.idGenerator();

      deps.db.withWriteTransaction((db) => {
        repository.appendCompactionSummary(db, {
          entryId,
          sessionKey: params.sessionKey,
          runId: params.runId,
          summary: redactedSummary.summary,
          blocks: redactedBlocks,
          metadata: {
            evidenceTier: "audit_replay_evidence",
            trustLevel: "unconfirmed_summary",
            redactionApplied: redactionCount > 0,
            redactionCount,
          },
          compactedAt: params.compactedAt,
          createdAt: deps.nowIso(),
        });
      });

      return {
        persisted: true,
        entryId,
        sessionKey: params.sessionKey,
        runId: params.runId,
        blockCount,
        evidenceTier: "audit_replay_evidence",
        trustLevel: "unconfirmed_summary",
        redactionApplied: redactionCount > 0,
        redactionCount,
      };
    },
  };
}
