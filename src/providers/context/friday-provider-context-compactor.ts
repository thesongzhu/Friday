import type {
  FridayContextCompactionBlockKind,
  FridayContextCompactionBlockSummary,
  FridayContextCompactionResult,
  FridayContextCompactionSummary,
  FridayProviderContextMessage,
} from "../model/friday-provider-context.types.js";
import type { FridayProviderTokenEstimator } from "./friday-provider-token-estimator.js";
import type { FridayProviderContextPruner } from "./friday-provider-context-pruner.js";

const COMPACTION_TRIGGER_RATIO = 0.70;
const MAX_RAW_BLOCKS = 3;

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "for", "from", "how", "i", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "who",
  "why", "you", "your",
]);

interface FridayProviderContextCompactionBlock {
  id: string;
  kind: FridayContextCompactionBlockKind;
  messages: FridayProviderContextMessage[];
  summary: FridayContextCompactionBlockSummary;
  score: number;
}

export interface FridayProviderContextCompactor {
  compact(params: {
    systemPrompt: string;
    userPrompt: string;
    messages: readonly FridayProviderContextMessage[];
    contextWindowTokens: number;
    summarize: (prompt: { system: string; user: string }) => Promise<string>;
  }): Promise<FridayContextCompactionResult>;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function clampSummary(text: string, limit = 220): string {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .replace(/([\u4e00-\u9fff])([a-z0-9])/gi, "$1 $2")
    .replace(/([a-z0-9])([\u4e00-\u9fff])/gi, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function countOverlap(left: Iterable<string>, right: Iterable<string>): number {
  const rightSet = new Set(right);
  let matches = 0;
  for (const token of left) {
    if (rightSet.has(token)) {
      matches++;
    }
  }
  return matches;
}

function extractFileOperations(text: string): string[] {
  const matches = text.match(/(?:^|\s)(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?/g) ?? [];
  return [...new Set(matches.map((match) => match.trim()).filter((match) => match.length > 0))].slice(0, 4);
}

function classifyBlockKind(messages: readonly FridayProviderContextMessage[]): FridayContextCompactionBlockKind {
  const combined = messages.map((message) => message.content).join("\n").toLowerCase();
  if (
    /\b(plan|approval|approve|approved|reject|clarif(?:y|ication)|awaiting plan|awaiting clarification)\b/i.test(combined)
    || /(计划|批准|审批|驳回|澄清|等待批准)/.test(combined)
  ) {
    return "plan_block";
  }
  if (
    /\b(status|progress|still running|still working|blocked|eta|done yet)\b/i.test(combined)
    || /(状态|进度|还在|阻塞|ETA|完成了吗)/.test(combined)
  ) {
    return "task_status_block";
  }
  if (
    /\b(subagent|delegat(?:e|ed|ion)|worker|child run|spawned)\b/i.test(combined)
    || /(子任务|子代理|委派|工作线程)/.test(combined)
  ) {
    return "delegated_task_block";
  }
  if (
    /\b(failed|failure|error|unable|cannot|could not|couldn't|blocked|timed out|not connected|invalid|denied)\b/i.test(combined)
    || /(失败|错误|无法|未连接|超时|无效|拒绝)/.test(combined)
  ) {
    return "tool_failure_block";
  }
  const hasUser = messages.some((message) => message.role === "user");
  const hasAssistant = messages.some((message) => message.role === "assistant");
  return hasUser && hasAssistant ? "topic_block" : "conversation_block";
}

function summarizeBlock(messages: readonly FridayProviderContextMessage[]): FridayContextCompactionBlockSummary {
  const kind = classifyBlockKind(messages);
  const userSummaries = messages
    .filter((message) => message.role === "user")
    .map((message) => clampSummary(message.content, 120));
  const assistantSummaries = messages
    .filter((message) => message.role === "assistant" || message.role === "tool-result")
    .map((message) => clampSummary(message.content, 140));
  const summaryText = clampSummary(
    [
      userSummaries.length > 0 ? `User: ${userSummaries.join(" | ")}` : undefined,
      assistantSummaries.length > 0 ? `Assistant: ${assistantSummaries.join(" | ")}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const combined = messages.map((message) => message.content).join("\n");
  const toolFailures = kind === "tool_failure_block"
    ? messages.map((message) => clampSummary(message.content, 120)).slice(-2)
    : [];
  const openQuestions = messages
    .filter((message) => message.role === "user" && /(?:\?|？)\s*$/.test(message.content.trim()))
    .map((message) => clampSummary(message.content, 120))
    .slice(-2);
  const decisions = messages
    .filter((message) => /\b(recommend|decide|should|best|prefer|plan)\b/i.test(message.content))
    .map((message) => clampSummary(message.content, 120))
    .slice(0, 3);
  const todos = messages
    .filter((message) => /\b(todo|next|follow up|need to|should)\b/i.test(message.content) || /(下一步|待办|需要)/.test(message.content))
    .map((message) => clampSummary(message.content, 120))
    .slice(0, 3);

  return {
    id: `block:${messages[0]?.messageId ?? "unknown"}:${messages[messages.length - 1]?.messageId ?? "unknown"}`,
    kind,
    summaryText,
    decisions,
    todos,
    openQuestions,
    toolFailures,
    fileOperations: extractFileOperations(combined),
    messageIds: messages.map((message) => message.messageId),
  };
}

function buildBlocks(messages: readonly FridayProviderContextMessage[]): FridayProviderContextCompactionBlock[] {
  if (messages.length === 0) {
    return [];
  }

  const rawBlocks: FridayProviderContextMessage[][] = [];
  let current: FridayProviderContextMessage[] = [];

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    rawBlocks.push(current);
    current = [];
  };

  for (const message of messages) {
    if (message.role === "user" && current.some((entry) => entry.role === "user")) {
      flushCurrent();
    }
    current.push(message);
  }
  flushCurrent();

  return rawBlocks.map((blockMessages) => ({
    id: `block:${blockMessages[0]?.messageId ?? "unknown"}`,
    kind: classifyBlockKind(blockMessages),
    messages: blockMessages,
    summary: summarizeBlock(blockMessages),
    score: 0,
  }));
}

function scoreBlocks(
  blocks: readonly FridayProviderContextCompactionBlock[],
  userPrompt: string,
): FridayProviderContextCompactionBlock[] {
  const taskTokens = tokenize(userPrompt);
  const totalBlocks = blocks.length;
  return blocks.map((block, index) => {
    const summaryTokens = tokenize([
      block.summary.summaryText,
      ...block.summary.decisions,
      ...block.summary.todos,
      ...block.summary.openQuestions,
      ...block.summary.toolFailures,
      ...block.summary.fileOperations,
    ].join("\n"));
    const taskOverlap = countOverlap(taskTokens, summaryTokens);
    const recencyBonus = Math.max(1, totalBlocks - index);
    const kindBonus = block.kind === "tool_failure_block"
      ? 14
      : block.kind === "task_status_block"
        ? 12
        : block.kind === "delegated_task_block"
          ? 10
          : block.kind === "plan_block"
            ? 8
            : block.kind === "topic_block"
              ? 6
              : 4;
    return {
      ...block,
      score: (taskOverlap * 14) + recencyBonus + kindBonus,
    };
  });
}

function formatSummaryContext(blocks: readonly FridayContextCompactionBlockSummary[]): string {
  const parts = ["[Conversation Block Summaries]"];
  blocks.forEach((block, index) => {
    parts.push(`\n[Block ${String(index + 1)} | ${block.kind}]`);
    parts.push(block.summaryText);
    if (block.decisions.length > 0) {
      parts.push(`Decisions: ${block.decisions.join(" | ")}`);
    }
    if (block.todos.length > 0) {
      parts.push(`TODOs: ${block.todos.join(" | ")}`);
    }
    if (block.openQuestions.length > 0) {
      parts.push(`Open questions: ${block.openQuestions.join(" | ")}`);
    }
    if (block.toolFailures.length > 0) {
      parts.push(`Tool failures: ${block.toolFailures.join(" | ")}`);
    }
    if (block.fileOperations.length > 0) {
      parts.push(`File operations: ${block.fileOperations.join(" | ")}`);
    }
  });
  return parts.join("\n");
}

function combineSummaries(blocks: readonly FridayContextCompactionBlockSummary[]): FridayContextCompactionSummary {
  return {
    summaryText: blocks.map((block) => `[${block.kind}] ${block.summaryText}`).join("\n"),
    decisions: blocks.flatMap((block) => block.decisions),
    todos: blocks.flatMap((block) => block.todos),
    openQuestions: blocks.flatMap((block) => block.openQuestions),
    toolFailures: blocks.flatMap((block) => block.toolFailures),
    fileOperations: blocks.flatMap((block) => block.fileOperations),
  };
}

export function createFridayProviderContextCompactor(deps: {
  estimator: FridayProviderTokenEstimator;
  pruner: FridayProviderContextPruner;
}): FridayProviderContextCompactor {
  const { estimator, pruner } = deps;

  return {
    async compact(params) {
      const { systemPrompt, userPrompt, messages, contextWindowTokens } = params;

      const baseTokens =
        estimator.estimateTextTokens(systemPrompt) +
        estimator.estimateTextTokens(userPrompt);
      const messageTokens = estimator.estimateMessagesTokens(
        messages.map((message) => ({ role: message.role, content: message.content })),
      );
      const totalBefore = baseTokens + messageTokens;
      const threshold = Math.floor(contextWindowTokens * COMPACTION_TRIGGER_RATIO);

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

      const pruneResult = pruner.prune(messages);
      const prunedMessages = pruneResult.messages;
      const scoredBlocks = scoreBlocks(buildBlocks(prunedMessages), userPrompt);

      if (scoredBlocks.length <= MAX_RAW_BLOCKS) {
        const afterTokens =
          baseTokens +
          estimator.estimateMessagesTokens(
            prunedMessages.map((message) => ({ role: message.role, content: message.content })),
          );
        return {
          compacted: pruneResult.prunedCount > 0,
          estimatedTokensBefore: totalBefore,
          estimatedTokensAfter: afterTokens,
          keptMessages: prunedMessages,
          droppedMessages: [],
          prunedMessageCount: pruneResult.prunedCount,
          blocks: scoredBlocks.map((block) => block.summary),
        };
      }

      const rawBlockIds = new Set(
        [...scoredBlocks]
          .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
          .slice(0, MAX_RAW_BLOCKS)
          .map((block) => block.id),
      );
      const rawBlocks = scoredBlocks
        .filter((block) => rawBlockIds.has(block.id))
        .sort((left, right) =>
          (left.messages[0]?.createdAt ?? "").localeCompare(right.messages[0]?.createdAt ?? ""),
        );
      const summarizedBlocks = scoredBlocks
        .filter((block) => !rawBlockIds.has(block.id))
        .sort((left, right) =>
          (left.messages[0]?.createdAt ?? "").localeCompare(right.messages[0]?.createdAt ?? ""),
        );

      const summaryMessage: FridayProviderContextMessage | null = summarizedBlocks.length > 0
        ? {
            messageId: "compaction-summary",
            role: "system",
            content: formatSummaryContext(summarizedBlocks.map((block) => block.summary)),
            createdAt: new Date().toISOString(),
          }
        : null;

      const keptMessages = [
        ...(summaryMessage ? [summaryMessage] : []),
        ...rawBlocks.flatMap((block) => block.messages),
      ];
      const afterTokens =
        baseTokens +
        estimator.estimateMessagesTokens(
          keptMessages.map((message) => ({ role: message.role, content: message.content })),
        );

      return {
        compacted: true,
        estimatedTokensBefore: totalBefore,
        estimatedTokensAfter: afterTokens,
        keptMessages,
        droppedMessages: summarizedBlocks.flatMap((block) => block.messages),
        prunedMessageCount: pruneResult.prunedCount,
        summary: summarizedBlocks.length > 0
          ? combineSummaries(summarizedBlocks.map((block) => block.summary))
          : undefined,
        blocks: scoredBlocks.map((block) => block.summary),
      };
    },
  };
}
