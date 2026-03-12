import type {
  FridayContextCompactionResult,
  FridayContextCompactionSummary,
  FridayProviderContextMessage,
} from "../model/friday-provider-context.types.js";
import type { FridayProviderTokenEstimator } from "./friday-provider-token-estimator.js";
import type { FridayProviderContextPruner } from "./friday-provider-context-pruner.js";

// ─── Constants ───

/** Trigger compaction when estimated tokens exceed this ratio of context window. */
const COMPACTION_TRIGGER_RATIO = 0.70;

/** Number of most-recent turns to always keep verbatim. */
const KEEP_RECENT_TURNS = 8;

/** Max tokens for the generated summary. */
const SUMMARY_MAX_TOKENS = 1_200;

// ─── Interface ───

export interface FridayProviderContextCompactor {
  compact(params: {
    systemPrompt: string;
    userPrompt: string;
    messages: readonly FridayProviderContextMessage[];
    contextWindowTokens: number;
    summarize: (prompt: { system: string; user: string }) => Promise<string>;
  }): Promise<FridayContextCompactionResult>;
}

// ─── Factory ───

export function createFridayProviderContextCompactor(deps: {
  estimator: FridayProviderTokenEstimator;
  pruner: FridayProviderContextPruner;
}): FridayProviderContextCompactor {
  const { estimator, pruner } = deps;

  return {
    async compact(params) {
      const { systemPrompt, userPrompt, messages, contextWindowTokens, summarize } = params;

      // Estimate baseline token usage (system + user + all messages)
      const baseTokens =
        estimator.estimateTextTokens(systemPrompt) +
        estimator.estimateTextTokens(userPrompt);
      const messageTokens = estimator.estimateMessagesTokens(
        messages.map((m) => ({ role: m.role, content: m.content })),
      );
      const totalBefore = baseTokens + messageTokens;
      const threshold = Math.floor(contextWindowTokens * COMPACTION_TRIGGER_RATIO);

      // No compaction needed
      if (totalBefore <= threshold) {
        return {
          compacted: false,
          estimatedTokensBefore: totalBefore,
          estimatedTokensAfter: totalBefore,
          keptMessages: [...messages],
          droppedMessages: [],
          prunedMessageCount: 0,
        };
      }

      // Step 1: prune oversized content in older messages
      const pruneResult = pruner.prune(messages);
      const prunedMessages = pruneResult.messages;

      // Step 2: split into old (to summarize) and recent (to keep)
      const keepCount = Math.min(KEEP_RECENT_TURNS, prunedMessages.length);
      const splitIndex = prunedMessages.length - keepCount;
      const oldMessages = prunedMessages.slice(0, splitIndex);
      const recentMessages = prunedMessages.slice(splitIndex);

      // If no old messages to summarize, just return pruned result
      if (oldMessages.length === 0) {
        const afterTokens =
          baseTokens +
          estimator.estimateMessagesTokens(
            recentMessages.map((m) => ({ role: m.role, content: m.content })),
          );
        return {
          compacted: pruneResult.prunedCount > 0,
          estimatedTokensBefore: totalBefore,
          estimatedTokensAfter: afterTokens,
          keptMessages: recentMessages,
          droppedMessages: [],
          prunedMessageCount: pruneResult.prunedCount,
        };
      }

      // Step 3: summarize old messages via LLM
      const summaryPrompt = buildSummaryPrompt(oldMessages);
      const rawSummary = await summarize(summaryPrompt);
      const summary = parseSummary(rawSummary);

      // Build a synthetic summary message to prepend
      const summaryMessage: FridayProviderContextMessage = {
        messageId: "compaction-summary",
        role: "system",
        content: formatSummaryAsContext(summary),
        createdAt: new Date().toISOString(),
      };

      const keptMessages = [summaryMessage, ...recentMessages];
      const afterTokens =
        baseTokens +
        estimator.estimateMessagesTokens(
          keptMessages.map((m) => ({ role: m.role, content: m.content })),
        );

      return {
        compacted: true,
        estimatedTokensBefore: totalBefore,
        estimatedTokensAfter: afterTokens,
        keptMessages,
        droppedMessages: oldMessages,
        prunedMessageCount: pruneResult.prunedCount,
        summary,
      };
    },
  };
}

// ─── Summary prompt ───

function buildSummaryPrompt(
  messages: readonly FridayProviderContextMessage[],
): { system: string; user: string } {
  const system = `You are a conversation compactor. Summarize the following conversation turns into a structured summary. Respond as JSON with fields: summaryText (string), decisions (string[]), todos (string[]), openQuestions (string[]), toolFailures (string[]), fileOperations (string[]). Max ${String(SUMMARY_MAX_TOKENS)} tokens.`;

  const turns = messages
    .map((m) => `[${m.role}] ${m.content.slice(0, 2000)}`)
    .join("\n\n");

  return { system, user: turns };
}

// ─── Parse summary JSON ───

function parseSummary(raw: string): FridayContextCompactionSummary {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      return {
        summaryText: typeof obj["summaryText"] === "string" ? obj["summaryText"] : raw,
        decisions: asStringArray(obj["decisions"]),
        todos: asStringArray(obj["todos"]),
        openQuestions: asStringArray(obj["openQuestions"]),
        toolFailures: asStringArray(obj["toolFailures"]),
        fileOperations: asStringArray(obj["fileOperations"]),
      };
    }
  } catch {
    // Fallback: use raw text as summary
  }
  return {
    summaryText: raw,
    decisions: [],
    todos: [],
    openQuestions: [],
    toolFailures: [],
    fileOperations: [],
  };
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string");
}

// ─── Format summary for context injection ───

function formatSummaryAsContext(summary: FridayContextCompactionSummary): string {
  const parts = [`[Conversation Summary]\n${summary.summaryText}`];
  if (summary.decisions.length > 0) {
    parts.push(`\n[Decisions]\n${summary.decisions.map((d) => `- ${d}`).join("\n")}`);
  }
  if (summary.todos.length > 0) {
    parts.push(`\n[TODOs]\n${summary.todos.map((t) => `- ${t}`).join("\n")}`);
  }
  if (summary.openQuestions.length > 0) {
    parts.push(`\n[Open Questions]\n${summary.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  if (summary.toolFailures.length > 0) {
    parts.push(`\n[Tool Failures]\n${summary.toolFailures.map((f) => `- ${f}`).join("\n")}`);
  }
  if (summary.fileOperations.length > 0) {
    parts.push(`\n[File Operations]\n${summary.fileOperations.map((f) => `- ${f}`).join("\n")}`);
  }
  return parts.join("\n");
}
