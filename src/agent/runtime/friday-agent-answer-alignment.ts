import type { FridayAgentMessage } from "../model/friday-agent.types.js";
import type { FridayAgentConversationContext } from "./friday-agent-runtime.types.js";

const STATUS_TERMS =
  /\b(status|progress|running|waiting|completed|failed|blocked|in progress|eta|minutes?|seconds?)\b/i;
const CHINESE_STATUS_TERMS = /(状态|进度|运行|等待|完成|失败|阻塞|分钟|秒|还在)/;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "for", "from", "how", "in", "is", "it", "of",
  "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "who", "why",
  "you", "your",
]);

export interface FridayAnswerAlignmentDecision {
  retryPrompt?: string;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function tokenize(text: string): string[] {
  return normalizeText(text)
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

function latestAssistantSummary(historyMessages: FridayAgentMessage[]): string | undefined {
  const assistantMessages = historyMessages
    .filter((message) => message.role === "assistant")
    .map((message) => typeof message.content === "string" ? message.content : "")
    .filter((message) => message.trim().length > 0);
  return assistantMessages.length > 0
    ? assistantMessages[assistantMessages.length - 1]
    : undefined;
}

export function evaluateFridayAnswerAlignment(params: {
  task: string;
  responseText: string;
  historyMessages: FridayAgentMessage[];
  conversationContext?: FridayAgentConversationContext;
}): FridayAnswerAlignmentDecision {
  const responseText = normalizeText(params.responseText);
  if (responseText.length === 0) {
    return {};
  }

  const turnKind = params.conversationContext?.turnKind;
  const responseTokens = tokenize(responseText);
  const currentTaskTokens = tokenize(params.task);
  const previousTopicTokens = tokenize(params.conversationContext?.previousTopicSummary ?? latestAssistantSummary(params.historyMessages) ?? "");
  const currentOverlap = countOverlap(responseTokens, currentTaskTokens);
  const previousOverlap = countOverlap(responseTokens, previousTopicTokens);

  if (turnKind === "status_check") {
    const hasStatusLanguage = STATUS_TERMS.test(responseText) || CHINESE_STATUS_TERMS.test(responseText);
    if (!hasStatusLanguage) {
      return {
        retryPrompt: [
          "You answered the content of a task instead of the user's current status question.",
          `Current status question: ${params.task}`,
          "Answer only with deterministic task status or say that you cannot verify the status yet.",
        ].join("\n"),
      };
    }
  }

  if (turnKind === "new_topic" && previousOverlap >= 2 && currentOverlap === 0) {
    return {
      retryPrompt: [
        "You answered the previous topic instead of the user's current question.",
        `Current question: ${params.task}`,
        params.conversationContext?.previousTopicSummary
          ? `Previous topic to avoid unless explicitly requested: ${params.conversationContext.previousTopicSummary}`
          : "Ignore the previous topic unless the user explicitly referenced it.",
        "Answer only the current question. If you cannot answer it from the available evidence, say that clearly.",
      ].join("\n"),
    };
  }

  return {};
}
