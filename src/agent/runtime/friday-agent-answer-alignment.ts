import type { FridayAgentMessage } from "../model/friday-agent.types.js";
import type { FridayAgentConversationContext } from "./friday-agent-runtime.types.js";

const STATUS_TERMS =
  /\b(status|progress|running|waiting|completed|failed|blocked|in progress|eta|minutes?|seconds?)\b/i;
const CHINESE_STATUS_TERMS = /(状态|进度|运行|等待|完成|失败|阻塞|分钟|秒|还在)/;
const GENERIC_CONTEXT_REQUEST_TERMS =
  /\b(need more context|need more information|cannot determine what you mean|what do you mean|which one|that could refer to|please provide more context|referent is unclear|not clear what you refer to)\b/i;
const CHINESE_GENERIC_CONTEXT_REQUEST_TERMS = /(需要更多上下文|无法确定您具体指的内容|请提供更多上下文|请说明具体问题|无法判断您指的是什么|指代可能不太明确|指代不明确|您具体说明)/;
const GENERIC_TROUBLESHOOTING_TERMS =
  /\b(check|internet|network|permission|permissions|settings|reconfigure|update|common issues|common issue|try again|restart|troubleshoot|troubleshooting)\b/i;
const CHINESE_GENERIC_TROUBLESHOOTING_TERMS =
  /(网络问题|权限问题|应用程序设置|设置正确|重新配置|检查.*互联网|安装.*更新|常见的问题|常见问题|解决方法|如果您需要更具体的帮助|请提供更多信息)/;
const SPECULATION_TERMS =
  /\b(might|may|could|possibly|likely|due to|because of|common reasons|include|can happen when)\b/i;
const CHINESE_SPECULATION_TERMS =
  /(可能|可能是由于|可能由于|常见|通常|建议|您可以检查|您可以尝试|如果问题仍然存在)/;
const UNKNOWN_CAUSE_TERMS =
  /\b(unknown|not known|cannot verify|do not know|don't know|cannot confirm|can't confirm|won't speculate)\b/i;
const CHINESE_UNKNOWN_CAUSE_TERMS =
  /(原因未知|更深层原因未知|无法确认|目前不能确认|现在无法确认|不做额外假设|不做猜测|不会猜测)/;
const ENGLISH_ERROR_FACT_TERMS =
  /\b(error|invalid|failed|failure|unable|cannot|could not|couldn't|not connected|disconnected|denied|timeout|timed out|unsupported|missing)\b/i;
const CHINESE_ERROR_FACT_TERMS =
  /(错误|无效|失败|无法|未连接|没有连接|断开|拒绝|超时|不支持|缺少|无法直接读取|无效的\s*url)/i;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "for", "from", "how", "in", "is", "it", "of",
  "on", "or", "that", "the", "this", "to", "what", "when", "where", "which", "who", "why",
  "you", "your",
]);

const POSITIVE_ACTION_CLAIM_TERMS =
  /\b(successfully|completed|done|finished|opened|launched|focused|connected|transferred|switched|navigated|now you can|you can now)\b/i;
const CHINESE_POSITIVE_ACTION_CLAIM_TERMS =
  /(成功|已成功|已经成功|已完成|已经完成|已打开|已经打开|已启动|已经启动|已聚焦|已经聚焦|已连接|已经连接|已切换|已经切换|现在你可以)/;
const DEICTIC_LITERAL_FOLLOW_UP_TERMS =
  /^(?:here|there|that one|this one|same one|same issue|that issue|this issue|that part|this part|这里|这儿|这个|那个|同一个问题)$/i;
const ENGLISH_DEICTIC_LITERAL_ECHO_TERMS =
  /\b(?:about|regarding|for)\s+(?:the\s+)?(?:"|“)?(?:here|there|that one|this one)(?:"|”)?\s+(?:question|issue|part)\b/i;
const CHINESE_DEICTIC_LITERAL_ECHO_TERMS =
  /关于您提到的[“"]?(?:这里|这儿|这个|那个)[”"]?问题|关于[“"]?(?:这里|这儿|这个|那个)[”"]?问题/;

export interface FridayAnswerAlignmentDecision {
  retryPrompt?: string;
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function hasCjkText(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}

function explicitlyRequestsEnglish(task: string): boolean {
  return /\b(?:in english|answer in english|reply in english|translate (?:it )?to english)\b/i.test(task)
    || /(?:用英文|英文回答|回复英文|翻译成英文)/u.test(task);
}

function isMostlyNonNaturalLanguage(responseText: string): boolean {
  return /```/.test(responseText)
    || /^[\s\p{P}\p{S}A-Z0-9_.:/-]+$/u.test(responseText);
}

function tokenize(text: string): string[] {
  const expandToken = (token: string): string[] => {
    if (/^[\u4e00-\u9fff]+$/u.test(token)) {
      const expanded = new Set<string>([token]);
      if (token.length >= 2) {
        for (let index = 0; index < token.length - 1; index++) {
          expanded.add(token.slice(index, index + 2));
        }
      }
      return [...expanded];
    }
    return [token];
  };

  const normalizeToken = (token: string): string => {
    if (!/^[a-z0-9]+$/i.test(token)) {
      return token;
    }
    if (token.length > 5 && token.endsWith("ing")) {
      return token.slice(0, -3);
    }
    if (token.length > 4 && token.endsWith("ed")) {
      return token.slice(0, -2);
    }
    if (token.length > 4 && token.endsWith("es")) {
      return token.slice(0, -2);
    }
    if (token.length > 3 && token.endsWith("s")) {
      return token.slice(0, -1);
    }
    return token;
  };

  return normalizeText(text)
    .replace(/([\u4e00-\u9fff])([a-z0-9])/gi, "$1 $2")
    .replace(/([a-z0-9])([\u4e00-\u9fff])/gi, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .map(normalizeToken)
    .flatMap(expandToken)
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

function selectedBlockSummary(
  conversationContext?: FridayAgentConversationContext,
): string {
  const selectedBlocks = conversationContext?.selectedBlocks ?? [];
  if (selectedBlocks.length === 0) {
    return "";
  }
  return selectedBlocks.map((block) => block.summary).join("\n");
}

function selectedBlockBySource(
  conversationContext: FridayAgentConversationContext | undefined,
  source: string,
): string | undefined {
  return conversationContext?.selectedBlocks
    ?.find((block) => block.source === source)
    ?.summary;
}

function hasCapabilityContradiction(
  conversationContext: FridayAgentConversationContext | undefined,
  responseText: string,
): boolean {
  const summary = selectedBlockBySource(conversationContext, "capabilities_block");
  if (!summary) {
    return false;
  }

  const response = normalizeText(responseText);
  const summaryNormalized = normalizeText(summary);
  const discordEnabled = /messaging enabled \(discord\)/i.test(summaryNormalized);
  const mcpEnabled = /\bMCP enabled\b/i.test(summaryNormalized);
  const providerBlocked = /provider mutations blocked by read.?only/i.test(summaryNormalized);

  const responseDiscordDisabled =
    /\bdiscord\b(?:[^.;,\n]{0,40})?(?:disabled|not enabled|unavailable)\b/i.test(response);
  const responseDiscordEnabled =
    /\bdiscord\b(?:[^.;,\n]{0,40})?\benabled\b/i.test(response) && !responseDiscordDisabled;
  if (discordEnabled && responseDiscordDisabled) {
    return true;
  }
  if (!discordEnabled && responseDiscordEnabled) {
    return true;
  }

  const responseMcpDisabled =
    /\bmcp\b(?:[^.;,\n]{0,40})?(?:disabled|not enabled|unavailable)\b/i.test(response);
  const responseMcpEnabled =
    /\bmcp\b(?:[^.;,\n]{0,40})?\benabled\b/i.test(response) && !responseMcpDisabled;
  if (mcpEnabled && responseMcpDisabled) {
    return true;
  }
  if (!mcpEnabled && responseMcpEnabled) {
    return true;
  }

  const responseProviderAvailable =
    /provider mutation(?:s)? .*not blocked by read.?only/i.test(response)
    || /provider mutation(?:s)? .*available/i.test(response);
  const responseProviderBlocked =
    /provider mutation(?:s)? .*blocked by read.?only/i.test(response)
    && !responseProviderAvailable;
  if (providerBlocked && responseProviderAvailable) {
    return true;
  }
  if (!providerBlocked && responseProviderBlocked) {
    return true;
  }

  return false;
}

function deriveAnchoredAssistantFact(
  conversationContext: FridayAgentConversationContext | undefined,
): string {
  const replyAnchorSummary = (conversationContext?.selectedBlocks ?? [])
    .filter((block) => block.source === "reply_anchor")
    .map((block) => block.summary)
    .join("\n");
  if (replyAnchorSummary.length > 0) {
    const assistantMatch = replyAnchorSummary.match(/assistant:\s*([\s\S]+)$/i);
    return assistantMatch?.[1]?.trim() ?? replyAnchorSummary;
  }

  const assistantAnchorSummary = (conversationContext?.selectedBlocks ?? [])
    .find((block) => block.source === "assistant_anchor")
    ?.summary
    ?.trim();
  return assistantAnchorSummary ?? "";
}

function anchoredAssistantSpecificTokens(
  conversationContext: FridayAgentConversationContext | undefined,
  currentTaskTokens: string[],
): string[] {
  const assistantFact = deriveAnchoredAssistantFact(conversationContext);
  if (assistantFact.length === 0) {
    return [];
  }
  const currentTaskTokenSet = new Set(currentTaskTokens);
  return tokenize(assistantFact).filter((token) => !currentTaskTokenSet.has(token));
}

function anchoredAssistantSalientTokens(
  conversationContext: FridayAgentConversationContext | undefined,
  currentTaskTokens: string[],
): string[] {
  const assistantSummary = deriveAnchoredAssistantFact(conversationContext);
  if (assistantSummary.length === 0) {
    return [];
  }

  const clauses = assistantSummary
    .split(/[\n。！？!?；;]+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
  const salientClauses = clauses.filter((clause) =>
    ENGLISH_ERROR_FACT_TERMS.test(clause) || CHINESE_ERROR_FACT_TERMS.test(clause));
  if (salientClauses.length === 0) {
    return [];
  }

  const currentTaskTokenSet = new Set(currentTaskTokens);
  return tokenize(salientClauses.join("\n"))
    .filter((token) => !currentTaskTokenSet.has(token));
}

function isShortReplyFollowUp(task: string): boolean {
  const normalized = normalizeText(task);
  return normalized.length <= 48
    || /\b(why|what|that|this|here|it|connect|open)\b/i.test(normalized)
    || /(为什么|什么|这里|这个|那个|连接|打不开|打开)/.test(normalized);
}

function isPureDeicticLiteralTask(task: string): boolean {
  return DEICTIC_LITERAL_FOLLOW_UP_TERMS.test(normalizeText(task));
}

function hasAnchoredAssistantFact(
  conversationContext: FridayAgentConversationContext | undefined,
): boolean {
  return deriveAnchoredAssistantFact(conversationContext).length > 0;
}

function anchorFactLooksNegative(
  conversationContext: FridayAgentConversationContext | undefined,
): boolean {
  const assistantFact = deriveAnchoredAssistantFact(conversationContext);
  return assistantFact.length > 0
    && (
      ENGLISH_ERROR_FACT_TERMS.test(assistantFact)
      || CHINESE_ERROR_FACT_TERMS.test(assistantFact)
    );
}

function responseClaimsPositiveActionState(responseText: string): boolean {
  return (
    POSITIVE_ACTION_CLAIM_TERMS.test(responseText)
    || CHINESE_POSITIVE_ACTION_CLAIM_TERMS.test(responseText)
  );
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
  const anchoredContextTokens = tokenize(
    selectedBlockSummary(params.conversationContext)
    || params.conversationContext?.previousTopicSummary
    || latestAssistantSummary(params.historyMessages)
    || "",
  );
  const currentOverlap = countOverlap(responseTokens, currentTaskTokens);
  const anchoredOverlap = countOverlap(responseTokens, anchoredContextTokens);
  const anchoredAssistantSpecificOverlap = countOverlap(
    responseTokens,
    anchoredAssistantSpecificTokens(params.conversationContext, currentTaskTokens),
  );
  const anchoredAssistantSalientOverlap = countOverlap(
    responseTokens,
    anchoredAssistantSalientTokens(params.conversationContext, currentTaskTokens),
  );
  const hasExplicitReplyAnchor = Boolean(
    params.conversationContext?.selectedBlocks?.some((block) => block.source === "reply_anchor"),
  );
  const hasAssistantFactAnchor = hasAnchoredAssistantFact(params.conversationContext);
  const anchorBlocks = (params.conversationContext?.selectedBlocks ?? [])
    .filter((block) => block.source === "reply_anchor" || block.source === "assistant_anchor");

  if (
    hasCjkText(params.task)
    && !hasCjkText(responseText)
    && !explicitlyRequestsEnglish(params.task)
    && !isMostlyNonNaturalLanguage(responseText)
  ) {
    return {
      retryPrompt: [
        "The latest user message is in Chinese, but your answer was not.",
        `Current user message: ${params.task}`,
        "Rewrite the answer in concise Chinese. Keep the same facts and do not add new claims.",
      ].join("\n"),
    };
  }

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

  if (hasCapabilityContradiction(params.conversationContext, responseText)) {
    return {
      retryPrompt: [
        "You contradicted deterministic runtime capability facts selected for this turn.",
        `Current question: ${params.task}`,
        `Capability facts:\n- ${selectedBlockBySource(params.conversationContext, "capabilities_block")}`,
        "Answer only with the selected deterministic capability facts.",
        "Do not negate or reinterpret those facts.",
      ].join("\n"),
    };
  }

  if (turnKind === "new_topic" && anchoredOverlap >= 2 && currentOverlap === 0) {
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

  if (
    hasAssistantFactAnchor
    && (
      GENERIC_CONTEXT_REQUEST_TERMS.test(responseText)
      || CHINESE_GENERIC_CONTEXT_REQUEST_TERMS.test(responseText)
    )
  ) {
    return {
      retryPrompt: [
        "You asked the user for more context even though an explicit reply anchor was already selected for this turn.",
        `Current turn: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Answer the referenced point directly. If the user is asking about a prior statement, first explain what that referenced statement means.",
        "If the underlying root cause is unknown, say that the root cause is unknown after restating the anchored fact.",
        "Do not ask the user what 'this/that/here' refers to unless the selected anchor itself is ambiguous.",
      ].join("\n"),
    };
  }

  if (
    (turnKind === "follow_up" || turnKind === "clarification" || turnKind === "continue_active_task")
    && currentOverlap === 0
    && anchoredOverlap === 0
  ) {
    return {
      retryPrompt: [
        "You answered something that does not match the user's current follow-up.",
        `Current follow-up: ${params.task}`,
        params.conversationContext?.selectedBlocks?.length
          ? `Relevant anchors:\n${params.conversationContext.selectedBlocks.map((block) => `- [${block.source}] ${block.summary}`).join("\n")}`
          : "No selected context blocks were available.",
        "Answer the user's latest follow-up using the anchored context, or say clearly that you cannot determine the answer from the available evidence.",
      ].join("\n"),
    };
  }

  if (
    hasExplicitReplyAnchor
    && (turnKind === "follow_up" || turnKind === "clarification" || turnKind === "continue_active_task")
    && anchoredAssistantSpecificOverlap === 0
  ) {
    return {
      retryPrompt: [
        "You answered an anchored follow-up without carrying forward any concrete detail from the referenced assistant fact.",
        `Current follow-up: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Answer the anchored follow-up directly and mention the relevant anchored fact(s).",
        "If the user is asking why/what/about a referenced prior statement, explain that prior statement first before giving any broader caveats.",
        "If you do not know the deeper cause, explicitly say the deeper cause is unknown after restating the anchored fact.",
        "Do not switch to generic troubleshooting, broad web research, or vague clarification unless the reply anchor itself is ambiguous.",
      ].join("\n"),
    };
  }

  if (
    hasAssistantFactAnchor
    && (turnKind === "follow_up" || turnKind === "clarification" || turnKind === "continue_active_task")
    && (
      GENERIC_TROUBLESHOOTING_TERMS.test(responseText)
      || CHINESE_GENERIC_TROUBLESHOOTING_TERMS.test(responseText)
    )
    && (anchoredAssistantSalientOverlap === 0 || isShortReplyFollowUp(params.task))
  ) {
    return {
      retryPrompt: [
        "You answered an anchored follow-up with generic troubleshooting instead of the concrete fact from the referenced earlier reply.",
        `Current follow-up: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Do not give a generic checklist.",
        "First restate the anchored fact from the earlier reply, then say whether a deeper root cause is known or still unknown.",
      ].join("\n"),
    };
  }

  if (
    hasAssistantFactAnchor
    && isShortReplyFollowUp(params.task)
    && (
      SPECULATION_TERMS.test(responseText)
      || CHINESE_SPECULATION_TERMS.test(responseText)
    )
    && !(
      UNKNOWN_CAUSE_TERMS.test(responseText)
      || CHINESE_UNKNOWN_CAUSE_TERMS.test(responseText)
    )
  ) {
    return {
      retryPrompt: [
        "You answered a short anchored follow-up by speculating about root causes instead of sticking to the verified earlier fact.",
        `Current follow-up: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Restate the anchored fact first.",
        "If the deeper cause is not verified, say the deeper cause is currently unknown instead of inventing troubleshooting causes.",
      ].join("\n"),
    };
  }

  if (
    hasExplicitReplyAnchor
    && isShortReplyFollowUp(params.task)
    && anchoredAssistantSalientTokens(params.conversationContext, currentTaskTokens).length > 0
    && anchoredAssistantSalientOverlap === 0
  ) {
    return {
      retryPrompt: [
        "This short anchored follow-up should stay attached to the concrete error/failure fact from the earlier reply.",
        `Current follow-up: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Explain the referenced earlier fact directly before adding any broader caveat.",
        "If the deeper cause is unknown, say that explicitly after restating the anchored fact.",
      ].join("\n"),
    };
  }

  if (
    hasAssistantFactAnchor
    && isPureDeicticLiteralTask(params.task)
    && (
      ENGLISH_DEICTIC_LITERAL_ECHO_TERMS.test(responseText)
      || CHINESE_DEICTIC_LITERAL_ECHO_TERMS.test(responseText)
    )
  ) {
    return {
      retryPrompt: [
        "The user used a pure deictic follow-up such as '这里/that one', but you echoed that literal token as if it were a new standalone issue.",
        `Current follow-up: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Treat the deictic phrase only as a pointer to the anchored earlier fact.",
        "Do not add a separate sentence like 'the issue about here/that one is unknown'.",
        "Answer the anchored fact directly and, if needed, say only whether the deeper cause is known or unknown.",
      ].join("\n"),
    };
  }

  if (
    hasAssistantFactAnchor
    && !hasExplicitReplyAnchor
    && isShortReplyFollowUp(params.task)
    && anchorFactLooksNegative(params.conversationContext)
    && responseClaimsPositiveActionState(responseText)
  ) {
    return {
      retryPrompt: [
        "You turned a short anchored follow-up into a new successful action/result, which contradicts the earlier anchored fact.",
        `Current follow-up: ${params.task}`,
        `Reply/assistant anchor(s):\n${anchorBlocks
          .map((block) => `- ${block.summary}`)
          .join("\n")}`,
        "Do not claim a new successful action, new connection, or new completion state unless this turn produced new deterministic evidence.",
        "First restate the anchored earlier fact. If the deeper cause is unknown, say that explicitly instead of inventing a new outcome.",
      ].join("\n"),
    };
  }

  return {};
}
