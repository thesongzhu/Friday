import { createHash } from "node:crypto";

import type { FridayAgentMessage } from "#agent";

import type {
  FridayContextSelectionResult,
  FridayConversationBlock,
  FridayConversationHistoryBlockKind,
  FridayConversationHistoryBlockSummary,
  FridayConversationTaskLedger,
  FridayConversationTaskLedgerEntry,
  FridayConversationTurnKind,
  FridayEvidenceBlock,
  FridaySessionConversationFocusState,
  FridaySessionMessageRecord,
} from "../model/friday-session.types.js";

const MAX_TOPIC_SUMMARY_CHARS = 180;
const MAX_FOLLOW_UP_HISTORY = 12;
const MAX_STATUS_HISTORY = 6;
const MAX_SELECTED_BLOCKS = 6;
const MAX_RELEVANT_HISTORY_BLOCKS = 3;
const MAX_BLOCK_SUMMARY_CHARS = 240;
const MAX_TASK_LEDGER_ENTRIES = 8;
const FOLLOW_UP_HINTS =
  /\b(that|it|this|those|these|also|and|then|what about|more about|continue|same|again|summari[sz]e|summary|recap|recommendation|recommendations)\b/i;
const CHINESE_FOLLOW_UP_HINTS = /(这个|那个|这里|这儿|继续|还有|然后|刚刚|刚才|方才|上一个|同一个|总结|概括|再说|细讲)/;
const DEICTIC_FOLLOW_UP_HINTS = /\b(this one|that one|same one|same issue|that issue|this issue|that part|this part|here|there)\b/i;
const ADVISORY_CONTINUATION_HINTS = /\b(prefer|preference|recommend|recommendation|recommendations|should i|best)\b/i;
const TOPIC_SWITCH_HINTS =
  /\b(?:new topic|switch topics?|change topics?|different topic|unrelated question|separate question|another question)\b/i;
const CHINESE_TOPIC_SWITCH_HINTS =
  /(?:换个话题|换一个话题|切换话题|另一个话题|另外一个话题|无关问题|另一个问题|另外问|先不说|不聊这个|不说这个)/;
const EXPLICIT_CONTEXT_EXCLUSION_HINTS =
  /\b(?:do not|don't|dont|without|stop)\s+(?:mention|bring up|refer(?:ence)?|continue|use)\b/i;
const CHINESE_CONTEXT_EXCLUSION_HINTS =
  /(?:不要|别|不用|先不|不许|禁止)(?:再)?(?:提|提到|说|聊|引用|继续|带上|使用)/;
const STATUS_CHECK_HINTS =
  /\b(status update|check status|current status|what(?:'s| is) (?:the )?status|what(?:'s| is) (?:the )?(?:final )?result(?: now)?|progress|still working|still running|still executing|what are you doing|what's happening|how long|eta|done yet|finished yet)\b/i;
const CHINESE_STATUS_CHECK_HINTS = /(状态|进度|还在|多久|完成了吗|现在在做什么|刚才那个任务|那个任务结果呢|结果呢|还没好|ETA)/;
const CANCELLATION_STATUS_CHECK_HINTS =
  /\b(request (?:was )?(?:cancelled|canceled|aborted)|(?:cancelled|canceled|aborted) before completion|why (?:was|did|is).{0,80}(?:cancelled|canceled|aborted)|what happened.{0,80}(?:cancelled|canceled|aborted)|(?:run|task|request).{0,40}(?:cancelled|canceled|aborted))\b/i;
const CHINESE_CANCELLATION_STATUS_CHECK_HINTS =
  /(?:(?:为什么|为何).{0,40}(?:取消|中止|终止)|(?:请求|任务).{0,30}(?:取消|中止|终止)|(?:取消|中止|终止).{0,20}(?:完成前|之前))/;
const CONTINUE_HINTS =
  /\b(continue|go ahead|proceed|keep going|do it|start it|carry on)\b/i;
const CHINESE_CONTINUE_HINTS = /(继续|开始吧|继续做|接着做|往下做|执行吧)/;
const CHINESE_RECENT_ASSISTANT_FOLLOW_UP_HINTS =
  /(简单解释|解释一下|讲简单|说简单|说人话|展开一下|详细解释|细讲|总结一下|概括一下|什么意思)/;
const BARE_NUDGE_HINTS = /^(?:[?？]+|嗯+|啊+|所以呢|然后呢|怎么说)$/;
const EXPLICIT_LITERAL_RESPONSE_INSTRUCTION =
  /\b(?:answer|reply|respond|say)\s+(?:with\s+)?exactly\b|\b(?:only|just)\s+(?:answer|reply|respond|say)\b|\b(?:answer|reply|respond|say)\s+only\b/i;
const CHINESE_EXPLICIT_LITERAL_RESPONSE_INSTRUCTION = /(?:只|仅)(?:回复|回答|输出|返回|说)/;
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "can", "for", "from", "how", "i", "in",
  "is", "it", "me", "my", "of", "on", "one", "or", "please", "should", "short", "single",
  "sentence", "answer", "brief", "that", "the", "this", "to", "what", "when", "where",
  "which", "who", "why", "you", "your",
]);
const GENERIC_FOLLOW_UP_TOKENS = new Set([
  "again",
  "connect",
  "continue",
  "didnt",
  "failed",
  "fail",
  "here",
  "issue",
  "open",
  "part",
  "recap",
  "same",
  "summary",
  "there",
  "thing",
  "wrong",
  "为什么",
  "这里",
  "这个",
  "那个",
  "同一个",
  "连接",
  "打开",
  "失败",
  "原因",
  "什么",
  "是什",
  "是什么",
  "这是什么",
  "那是什么",
  "解释",
  "简单",
  "一下",
]);
const WEAK_CONTEXT_OVERLAP_TOKENS = new Set([
  "what",
  "why",
  "how",
  "this",
  "that",
  "here",
  "there",
  "same",
  "again",
  "cannot",
  "could",
  "did",
  "didnt",
  "do",
  "does",
  "doesnt",
  "dont",
  "thing",
  "not",
  "would",
  "什么",
  "是什",
  "是什么",
  "这是什么",
  "那是什么",
  "为什么",
  "怎么",
  "如何",
  "这个",
  "那个",
  "这里",
  "这儿",
  "解释",
  "简单",
  "一下",
  "意思",
]);

function hasSpecificFollowUpTokens(task: string): boolean {
  return tokenize(task).some((token) => !GENERIC_FOLLOW_UP_TOKENS.has(token));
}

function hasDeicticReference(task: string): boolean {
  const normalized = normalizeText(task).toLowerCase();
  return (
    /\b(this|that|it|these|those|same|previous|last|above|earlier)\b/i.test(normalized)
    || /(这个|那个|这里|这儿|它|这张|那张|刚刚|刚才|方才|上一个|前面|上一条|同一个)/.test(normalized)
  );
}

function isLikelyStandaloneQuestion(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0 || hasDeicticReference(normalized)) {
    return false;
  }
  const hasQuestionForm =
    /\b(?:what|who|where|when|why|how|can|could|should|would|is|are|do|does)\b/i.test(normalized)
    || /(是什么|怎么|如何|为什么|能不能|可以|是否|有没有)/.test(normalized);
  return hasQuestionForm && hasSpecificFollowUpTokens(normalized);
}

function isRecentAssistantRewriteRequest(task: string): boolean {
  const normalized = normalizeText(task);
  return (
    /\b(?:explain|explain it|explain that|simplify|make it simpler|in simple terms|summari[sz]e|recap|expand on that)\b/i.test(normalized)
    || CHINESE_RECENT_ASSISTANT_FOLLOW_UP_HINTS.test(normalized)
  );
}

function isBareNudgeTask(task: string): boolean {
  return BARE_NUDGE_HINTS.test(normalizeText(task));
}

function isCrossTopicRecapRequest(task: string): boolean {
  const normalized = normalizeText(task);
  return (
    /\b(all recommendations|overall recommendations|recommendations|recommendation|pull together|combine|roll up|wrap up)\b/i.test(normalized)
    || /(全部建议|整体建议|总的建议|汇总)/.test(normalized)
  );
}

function isRecentResultFollowUpTask(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0 || normalized.length > 160) {
    return false;
  }
  const hasRecentReference =
    /\b(?:just|last|previous|earlier|before (?:it )?(?:cancelled|canceled|aborted|timed out)|before timeout)\b/i.test(normalized)
    || /(?:刚刚|刚才|方才|上一个|上一条|取消前|中止前|终止前|超时前)/u.test(normalized);
  const asksForResult =
    /\b(?:what|which).{0,40}\b(?:found|find|discovered|saw|result|results|evidence|got)\b/i.test(normalized)
    || /\b(?:found|find|discovered|saw|result|results|evidence|got).{0,40}\b(?:what|which)\b/i.test(normalized)
    || /(?:找到|找到了|发现|查到|搜到|搜索到|看到|结果|线索|证据).{0,24}(?:什么|啥|哪些|多少|吗|了)?/u.test(normalized)
    || /(?:什么|啥|哪些).{0,24}(?:找到|发现|查到|搜到|搜索到|看到|结果|线索|证据)/u.test(normalized);
  return hasRecentReference && asksForResult;
}

function isShortOperationalTroubleshootingFollowUpTask(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0 || normalized.length > 72) {
    return false;
  }
  return (
    /\b(?:connect|connected|open|opened|load|loaded|work|worked|reply|replied|send|sent|receive|received|fail|failed|failure)\b/i.test(normalized)
    || /(连接|连上|打开|加载|运行|回复|发送|收到|失败|无法|不能|没|没有|看不到)/.test(normalized)
  );
}

function isShortContextualFollowUpTask(task: string): boolean {
  const normalized = normalizeText(task);
  return normalized.length <= 48
    || /\b(why|what|that|this|here|it|connect|open)\b/i.test(normalized)
    || /(为什么|什么|这里|这个|那个|连接|打不开|打开)/.test(normalized);
}

function isShortAssistantAnchorFollowUpTask(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0 || normalized.length > 48) {
    return false;
  }
  return (
    /\b(why|what|that|this|here|it|same|again|connect|didn't|did not|failed)\b/i.test(normalized)
    || /(为什么|什么|这里|这个|那个|同一个|还是|连接|打不开|失败|没连上)/.test(normalized)
  );
}

function isExplicitLiteralResponseInstruction(task: string): boolean {
  const normalized = normalizeText(task);
  return EXPLICIT_LITERAL_RESPONSE_INSTRUCTION.test(normalized)
    || CHINESE_EXPLICIT_LITERAL_RESPONSE_INSTRUCTION.test(normalized);
}

function isCancellationStatusCheck(task: string): boolean {
  const normalized = normalizeText(task);
  return CANCELLATION_STATUS_CHECK_HINTS.test(normalized)
    || CHINESE_CANCELLATION_STATUS_CHECK_HINTS.test(normalized);
}

function isShortChoiceReplyTask(task: string): boolean {
  const normalized = normalizeText(task)
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, "")
    .replace(/[。.!！?？]+$/u, "")
    .trim();
  if (normalized.length === 0 || normalized.length > 32) {
    return false;
  }
  return (
    /^(?:(?:option|plan)\s*)?[a-d](?:\s*(?:option|plan))?$/i.test(normalized)
    || /^(?:方案\s*)?[a-d](?:\s*方案)?$/i.test(normalized)
    || /^(?:#?\d{1,2}|[①②③④⑤⑥⑦⑧⑨])$/u.test(normalized)
    || /^(?:我)?(?:选|选择|用|要|就)\s*(?:方案\s*)?(?:[a-d]|#?\d{1,2})(?:\s*方案)?吧?$/iu.test(normalized)
    || /^(?:pick|choose|use|go with)\s+(?:(?:option|plan)\s*)?(?:[a-d]|#?\d{1,2})$/i.test(normalized)
    || /^(?:第)?[一二三四五六七八九](?:个|项|种|套)?(?:方案)?$/u.test(normalized)
    || /^(?:前者|后者)$/u.test(normalized)
  );
}

function isChoiceReplyTask(task: string): boolean {
  if (isShortChoiceReplyTask(task)) {
    return true;
  }

  const normalized = normalizeText(task)
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/gu, "")
    .trim();
  if (normalized.length === 0 || normalized.length > 220) {
    return false;
  }

  return (
    /^(?:(?:我)?(?:选|选择|用|要|就)\s*)?(?:方案\s*)?(?:[a-d]|#?\d{1,2}|[①②③④⑤⑥⑦⑧⑨])(?:\s*(?:方案|选项|option|plan))?(?:\s*[,，、:：.;；\-—]\s*|\s+(?:and|then|plus|with)\b|\s*(?:然后|并且|同时|再|接着|顺便))/iu.test(normalized)
    || /^(?:第)?[一二三四五六七八九](?:个|项|种|套)?(?:方案)?(?:\s*[,，、:：.;；\-—]\s*|\s*(?:然后|并且|同时|再|接着|顺便))/u.test(normalized)
    || /^(?:pick|choose|use|go with)\s+(?:(?:option|plan)\s*)?(?:[a-d]|#?\d{1,2})(?:\s+(?:and|then|plus|with)\b|\s*[,，、:：.;；\-—]\s*)/i.test(normalized)
  );
}

function isExplicitTopicSwitchTask(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0) {
    return false;
  }
  return TOPIC_SWITCH_HINTS.test(normalized)
    || CHINESE_TOPIC_SWITCH_HINTS.test(normalized)
    || EXPLICIT_CONTEXT_EXCLUSION_HINTS.test(normalized)
    || CHINESE_CONTEXT_EXCLUSION_HINTS.test(normalized);
}

function isRecallRequestTask(task: string): boolean {
  const normalized = normalizeText(task);
  if (normalized.length === 0) {
    return false;
  }
  const directRecallQuestion =
    /(?:暗号|代号|口令|编号|名字|名称|链接|地址|内容)\s*(?:是(?:什么|啥|哪(?:一个|个)?)|多少|[?？])/u.test(normalized)
    || /(?:是什么|是啥|哪(?:一个|个)|多少).{0,24}(?:暗号|代号|口令|编号|名字|名称|链接|地址|内容)/u.test(normalized)
    || /\b(?:what|which).{0,40}\b(?:codename|code phrase|passphrase|marker|secret|identifier|name|link|url|address)\b/i.test(normalized)
    || /\b(?:codename|code phrase|passphrase|marker|secret|identifier)\s*\?$/i.test(normalized);
  if (directRecallQuestion) {
    return true;
  }
  if (!hasDeicticReference(normalized)) {
    return false;
  }
  return /\b(?:previous|earlier|above|last|remember|recall|name|code|marker|secret|identifier)\b/i.test(normalized)
    || /(?:是什么|哪一个|哪个|名字|名称|代号|暗号|编号|链接|地址|内容|刚刚|刚才|之前|前面)/.test(normalized);
}

function establishesRecallableFact(text: string): boolean {
  return /\b(?:remember|keep|store|save)\s+(?:my\s+|the\s+)?(?:codename|code phrase|passphrase|marker|secret|identifier)\b/iu.test(text)
    || /\bmy\s+(?:codename|code phrase|passphrase|marker|secret|identifier)\s+(?:is|=|:)\b/iu.test(text)
    || /\b(?:codename|code phrase|passphrase|marker|secret|identifier)\s+(?:is|=|:)\b/iu.test(text)
    || /(?:记住|保存|记录|暗号是(?!什么|啥|哪)|代号是(?!什么|啥|哪)|口令是(?!什么|啥|哪)|编号是(?!什么|啥|哪)|名字是(?!什么|啥|哪)|名称是(?!什么|啥|哪))/u.test(text);
}

function isRecallQuestionRecord(text: string): boolean {
  return isRecallRequestTask(text) && !establishesRecallableFact(text);
}

function asksForMostRecentRecall(task: string): boolean {
  return /(?:刚刚|刚才|方才|刚说|刚提到|最新|最近|上一条|上一个)/u.test(task)
    || /\b(?:last|latest|most recent|just mentioned|just said)\b/i.test(task);
}

function asksForOlderRecallFact(task: string): boolean {
  return /(?:更早|最早|第一个|上上个|前一个|前一次|上一版|旧的|老的)/u.test(task)
    || /\b(?:earlier|older|old|previous version|first)\b/i.test(task);
}

function recallFieldTokens(text: string): Set<string> {
  const fields = new Set<string>();
  if (/(?:暗号|代号|口令|\b(?:codename|code phrase|passphrase|marker|secret|identifier)\b)/iu.test(text)) {
    fields.add("code");
  }
  if (/(?:名字|名称|\b(?:name|title)\b)/iu.test(text)) {
    fields.add("name");
  }
  if (/(?:编号|\b(?:number|id|identifier)\b)/iu.test(text)) {
    fields.add("identifier");
  }
  if (/(?:链接|地址|\b(?:link|url|address)\b)/iu.test(text)) {
    fields.add("link");
  }
  return fields;
}

function intersectsRecallFields(left: Set<string>, right: Set<string>): boolean {
  if (left.size === 0 || right.size === 0) {
    return false;
  }
  for (const field of left) {
    if (right.has(field)) {
      return true;
    }
  }
  return false;
}

function recallableFactMatchesFields(text: string, requestedFields: Set<string>): boolean {
  if (!establishesRecallableFact(text)) {
    return false;
  }
  return requestedFields.size === 0
    || intersectsRecallFields(requestedFields, recallFieldTokens(text));
}

function assistantAppearsToAskForChoice(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return false;
  }
  const hasTwoLetterOptions =
    /\b(?:option|plan)\s*a\b[\s\S]{0,1400}\b(?:option|plan)\s*b\b/i.test(normalized)
    || /\bA\s*[):.：、][\s\S]{0,1400}\bB\s*[):.：、]/.test(normalized)
    || /方案\s*A[\s\S]{0,1400}方案\s*B/i.test(normalized);
  const hasTwoNumberedOptions =
    /(?:^|\s)(?:1|①)\s*[):.：、][\s\S]{0,1400}(?:^|\s)(?:2|②)\s*[):.：、]/u.test(normalized)
    || /方案\s*(?:一|1|①)[\s\S]{0,1400}方案\s*(?:二|2|②)/u.test(normalized);
  const asksForChoice =
    /\b(?:which|prefer|choose|pick|select|option|plan)\b/i.test(normalized)
    || /(?:选择|选|偏好|确认|哪个|哪一个|哪种|第几个|前者|后者|方案)/u.test(normalized);
  const explicitChoiceQuestion =
    /\b(?:which (?:one|option|plan)|which do you prefer|pick one|choose one)\b/i.test(normalized)
    || /(?:你偏好哪个|你选哪个|选择哪个|确认哪个|选一个)/u.test(normalized);
  return ((hasTwoLetterOptions || hasTwoNumberedOptions) && asksForChoice) || explicitChoiceQuestion;
}

function assistantAppearsToAskQuestion(text: string): boolean {
  const normalized = normalizeText(text);
  if (normalized.length === 0) {
    return false;
  }
  const tail = normalized.slice(-240);
  return (
    /[?？]/u.test(tail)
    || assistantAppearsToAskForChoice(normalized)
    || /\b(?:please confirm|please choose|please pick|please select|which do you prefer|could you|can you|please provide)\b/i.test(tail)
    || /(?:请(?:确认|告诉|选择|提供)|你(?:偏好|选择|选|要|想要).{0,30}(?:哪个|哪一个|哪种|吗)|方便.{0,20}(?:继续|处理))/u.test(tail)
  );
}

export interface FridayPreparedConversationTurn {
  turnKind: FridayConversationTurnKind;
  historyMessages: FridayAgentMessage[];
  taskPrompt: string;
  previousTopicSummary?: string;
  currentTopicSummary?: string;
  selectedBlocks: FridayConversationBlock[];
  selectionReasons: string[];
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
}

export interface PrepareFridayConversationTurnInput {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  replyToMessageId?: string;
  evidenceBlocks?: FridayEvidenceBlock[];
}

export interface FinalizeFridayConversationFocusInput {
  task: string;
  responseText: string;
  runId: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  currentUserSequence?: number;
  replyAnchorMessageId?: string;
  replyAnchorSequence?: number;
  pendingPlanRunId?: string | null;
  harnessFocus?: {
    stage?: string;
    handoffArtifactId?: string;
    summary?: string;
  } | null;
  nowIso: string;
}

interface FridayConversationBlockCandidate {
  block: FridayConversationBlock;
  messages: FridayAgentMessage[];
  taskOverlap?: number;
  fallbackOnly?: boolean;
}

interface FridayConversationHistoryBlockCandidate {
  summary: FridayConversationHistoryBlockSummary;
  score: number;
  reason: string;
  messages: FridayAgentMessage[];
  taskOverlap: number;
}

function createEvidenceBlockCandidate(
  block: FridayEvidenceBlock,
): FridayConversationBlockCandidate {
  return {
    block: {
      id: block.id,
      source: block.source,
      summary: summarizeTopic(block.summary),
      score: block.score,
      reason: block.reason,
    },
    messages: [],
    fallbackOnly: false,
  };
}

function formatHarnessHandoffSummary(
  focusState?: FridaySessionConversationFocusState | null,
): string | null {
  if (!focusState?.lastHarnessSummary) {
    return null;
  }
  return normalizeText([
    focusState.lastHarnessStage ? `stage ${focusState.lastHarnessStage}` : undefined,
    `summary ${focusState.lastHarnessSummary}`,
    focusState.lastHandoffArtifactId
      ? `handoff artifact ${focusState.lastHandoffArtifactId}`
      : undefined,
  ].filter((value): value is string => Boolean(value)).join("; "));
}

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function summarizeTopic(text: string): string {
  const normalized = normalizeText(text);
  if (normalized.length <= MAX_TOPIC_SUMMARY_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_TOPIC_SUMMARY_CHARS - 1)}…`;
}

function readStringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

function summarizeToolResultContent(content: string): string {
  const normalized = normalizeText(content)
    .replace(/\{[\s\S]*$/u, "")
    .replace(/\[truncated:[\s\S]*$/u, "")
    .trim();
  if (/DNS resolution failed/i.test(normalized)) {
    return "DNS resolution failed";
  }
  if (/HTTP 403 Forbidden/i.test(normalized) || /Cloudflare/i.test(normalized)) {
    return "HTTP 403 / Cloudflare blocked";
  }
  if (/Google Search|google\.com\/sorry|unusual traffic/i.test(normalized)) {
    return "Google search was blocked by anti-abuse page";
  }
  if (/HTTP 404/i.test(normalized) || /没有找到/u.test(normalized)) {
    return "404 / no page found";
  }
  const extracted = normalized.match(/Extracted text:\s*([\s\S]+)/i)?.[1]?.trim() ?? normalized;
  return clampSummary(extracted, 180);
}

function summarizeSessionToolCalls(toolCalls?: unknown[]): string | undefined {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return undefined;
  }
  const lines: string[] = [];
  for (const call of toolCalls) {
    if (!call || typeof call !== "object" || Array.isArray(call)) {
      continue;
    }
    const record = call as Record<string, unknown>;
    const toolName = readStringField(record, "toolName") ?? readStringField(record, "name") ?? "tool";
    if (toolName === "request_tool_pack") {
      continue;
    }
    const args = record.args;
    const url = readStringField(args, "url");
    const query = readStringField(args, "query") ?? readStringField(args, "q");
    const result = record.result;
    const resultContent = typeof result === "string"
      ? result
      : readStringField(result, "content")
        ?? readStringField(result, "text")
        ?? "";
    if (resultContent.trim().length === 0) {
      continue;
    }
    const target = url ?? query;
    lines.push(
      `${toolName}${target ? ` ${target}` : ""}: ${summarizeToolResultContent(resultContent)}`,
    );
    if (lines.length >= 8) {
      break;
    }
  }
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function buildRecentResultAnchorSummary(records: readonly FridaySessionMessageRecord[]): string {
  const latestUser = [...records].reverse().find((record) => record.role === "user");
  const latestAssistant = [...records].reverse().find((record) => record.role === "assistant");
  const toolSummary = latestAssistant ? summarizeSessionToolCalls(latestAssistant.toolCalls) : undefined;
  return [
    latestUser ? `Immediate previous user task: ${latestUser.contentText}` : undefined,
    latestAssistant ? `Immediate previous assistant terminal reply: ${latestAssistant.contentText}` : undefined,
    toolSummary ? `Partial tool evidence before the terminal reply:\n${toolSummary}` : undefined,
  ].filter((value): value is string => Boolean(value)).join("\n");
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

function countMeaningfulOverlap(left: Iterable<string>, right: Iterable<string>): number {
  return countOverlap(
    [...left].filter((token) => !WEAK_CONTEXT_OVERLAP_TOKENS.has(token)),
    [...right].filter((token) => !WEAK_CONTEXT_OVERLAP_TOKENS.has(token)),
  );
}

function fingerprintTopic(text: string): string {
  const normalized = summarizeTopic(text).toLowerCase();
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function mapSessionMessageToAgentMessage(
  message: FridaySessionMessageRecord,
): FridayAgentMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }
  if (typeof message.content === "string") {
    const content = message.content.trim();
    if (content.length > 0) {
      return { role: message.role, content };
    }
  }
  const fallbackText = message.contentText.trim();
  if (fallbackText.length > 0) {
    return { role: message.role, content: fallbackText };
  }
  return null;
}

export function classifyFridayConversationTurn(input: {
  task: string;
  focusState?: FridaySessionConversationFocusState | null;
  historyRecords?: FridaySessionMessageRecord[];
  currentUserSequence?: number;
  replyToMessageId?: string;
}): FridayConversationTurnKind {
  const task = normalizeText(input.task);
  const focusState = input.focusState ?? null;
  const taskLower = task.toLowerCase();
  const focusSummary = focusState?.currentTopicSummary ?? "";
  const hasFocus = Boolean(focusState?.currentTopicSummary);
  const taskTokens = tokenize(task);
  const focusTokens = tokenize(focusSummary);
  const overlap = countOverlap(taskTokens, focusTokens);
  const records = filterConversationRecords(input.historyRecords ?? [], input.currentUserSequence);
  const latestAssistant = findLatestRecord(records, "assistant");
  const latestUser = findLatestRecord(records, "user");
  const latestAssistantMeaningfulOverlap = countMeaningfulOverlap(
    taskTokens,
    tokenize(latestAssistant?.contentText ?? focusState?.assistantAnchorSummary ?? ""),
  );
  const latestUserMeaningfulOverlap = countMeaningfulOverlap(taskTokens, tokenize(latestUser?.contentText ?? ""));
  const hasReplyAnchor = Boolean(resolveReplyAnchorRecord(records, input.replyToMessageId));
  const hasUnresolvedReplyAnchor = Boolean(input.replyToMessageId?.trim()) && !hasReplyAnchor;
  const hasAssistantAnchor = Boolean(latestAssistant?.contentText || focusState?.assistantAnchorSummary);
  const shortTask = task.length > 0 && task.length <= 120;
  const choiceReply = isChoiceReplyTask(task);
  const latestAssistantAsksForChoice = assistantAppearsToAskForChoice(
    latestAssistant?.contentText ?? focusState?.assistantAnchorSummary ?? "",
  );
  const latestAssistantAskedQuestion =
    Boolean(focusState?.lastAssistantAskedQuestion)
    || assistantAppearsToAskQuestion(latestAssistant?.contentText ?? "");
  const advisoryContinuation =
    ADVISORY_CONTINUATION_HINTS.test(taskLower)
    && ADVISORY_CONTINUATION_HINTS.test(focusSummary.toLowerCase());
  const followUpHint =
    FOLLOW_UP_HINTS.test(taskLower)
    || CHINESE_FOLLOW_UP_HINTS.test(task)
    || DEICTIC_FOLLOW_UP_HINTS.test(taskLower);
  const literalResponseInstruction = isExplicitLiteralResponseInstruction(task);
  const explicitTopicSwitch = isExplicitTopicSwitchTask(task);
  const recentResultFollowUp = isRecentResultFollowUpTask(task);
  const recallRequest = !recentResultFollowUp && isRecallRequestTask(task);
  const requestedRecallFields = recallRequest ? recallFieldTokens(task) : new Set<string>();
  const hasRecallableAnchor = recallRequest && (
    recallableFactMatchesFields(focusSummary, requestedRecallFields)
    || records.some((record) => recallableFactMatchesFields(record.contentText, requestedRecallFields))
  );
  const assistantOverlapSignal = latestAssistantMeaningfulOverlap >= 1;
  const userOverlapSignal = latestUserMeaningfulOverlap >= 1;
  const deicticRecallSignal =
    hasDeicticReference(task)
    || DEICTIC_FOLLOW_UP_HINTS.test(taskLower)
    || CHINESE_FOLLOW_UP_HINTS.test(task)
    || /\b(?:previous|earlier|above|before|that|this|it)\b/i.test(taskLower);

  if (STATUS_CHECK_HINTS.test(taskLower) || CHINESE_STATUS_CHECK_HINTS.test(task) || isCancellationStatusCheck(task)) {
    return "status_check";
  }
  if (CONTINUE_HINTS.test(taskLower) || CHINESE_CONTINUE_HINTS.test(task)) {
    return "continue_active_task";
  }
  if (hasReplyAnchor || (hasUnresolvedReplyAnchor && hasAssistantAnchor)) {
    return "follow_up";
  }
  if (recentResultFollowUp && (latestUser || latestAssistant || hasFocus)) {
    return "follow_up";
  }
  if (hasRecallableAnchor) {
    return "follow_up";
  }
  if (explicitTopicSwitch && !hasReplyAnchor && !hasUnresolvedReplyAnchor) {
    return "new_topic";
  }
  if (
    literalResponseInstruction
    && !hasReplyAnchor
    && !(deicticRecallSignal && (hasFocus || assistantOverlapSignal || userOverlapSignal))
  ) {
    return "new_topic";
  }
  if (latestAssistant && isRecentAssistantRewriteRequest(task)) {
    return "follow_up";
  }
  if (latestUser && isBareNudgeTask(task)) {
    return "follow_up";
  }
  if (choiceReply && latestAssistantAsksForChoice) {
    return "clarification";
  }
  if (hasFocus && hasAssistantAnchor && isShortOperationalTroubleshootingFollowUpTask(task)) {
    return "follow_up";
  }
  if (
    !hasReplyAnchor
    && !hasUnresolvedReplyAnchor
    && isLikelyStandaloneQuestion(task)
    && !assistantOverlapSignal
    && !userOverlapSignal
  ) {
    return "new_topic";
  }
  if (
    latestAssistantAskedQuestion && shortTask
  ) {
    return "clarification";
  }
  if (
    hasFocus
    && hasAssistantAnchor
    && isShortAssistantAnchorFollowUpTask(task)
    && (hasDeicticReference(task) || assistantOverlapSignal)
  ) {
    return "follow_up";
  }
  if (
    (hasFocus || assistantOverlapSignal || userOverlapSignal)
    && (
      overlap >= 2
      || assistantOverlapSignal
      || userOverlapSignal
      || advisoryContinuation
      || followUpHint
    )
  ) {
    return "follow_up";
  }
  return "new_topic";
}

function filterConversationRecords(
  historyRecords: FridaySessionMessageRecord[],
  currentUserSequence?: number,
): FridaySessionMessageRecord[] {
  if (typeof currentUserSequence !== "number") {
    return [...historyRecords];
  }
  return historyRecords.filter((record) => record.sequence < currentUserSequence);
}

function findLatestRecord(
  records: FridaySessionMessageRecord[],
  role: "user" | "assistant",
): FridaySessionMessageRecord | undefined {
  return [...records].reverse().find((record) => record.role === role);
}

function findRecordIndex(
  records: FridaySessionMessageRecord[],
  messageId: string,
): number {
  return records.findIndex((record) => record.id === messageId);
}

function resolveSourceMessageId(record: FridaySessionMessageRecord): string | undefined {
  const sourceMessageId = record.metadata?.sourceMessageId;
  return typeof sourceMessageId === "string" && sourceMessageId.trim().length > 0
    ? sourceMessageId.trim()
    : undefined;
}

function resolveReplyAnchorRecord(
  records: FridaySessionMessageRecord[],
  replyToMessageId?: string,
): FridaySessionMessageRecord | undefined {
  if (!replyToMessageId || replyToMessageId.trim().length === 0) {
    return undefined;
  }
  const normalizedReplyId = replyToMessageId.trim();
  return records.find((record) =>
    record.id === normalizedReplyId || resolveSourceMessageId(record) === normalizedReplyId);
}

function clampSummary(text: string, limit = MAX_BLOCK_SUMMARY_CHARS): string {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 1)}…`;
}

function extractFileOperations(text: string): string[] {
  const matches = text.match(/(?:^|\s)(?:\.{0,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?:\.[A-Za-z0-9._-]+)?/g) ?? [];
  return [...new Set(matches.map((match) => match.trim()).filter((match) => match.length > 0))].slice(0, 4);
}

function classifyConversationHistoryBlockKind(
  records: readonly FridaySessionMessageRecord[],
): FridayConversationHistoryBlockKind {
  const combined = records.map((record) => record.contentText).join("\n").toLowerCase();
  if (
    /\b(plan|approval|approve|approved|reject|rejected|clarif(?:y|ication)|awaiting plan|awaiting clarification|review required)\b/i.test(combined)
    || /(计划|批准|审批|驳回|澄清|需要更多信息|等待批准)/.test(combined)
  ) {
    return "plan_block";
  }
  if (
    STATUS_CHECK_HINTS.test(combined)
    || CHINESE_STATUS_CHECK_HINTS.test(combined)
    || isCancellationStatusCheck(combined)
  ) {
    return "task_status_block";
  }
  if (
    /\b(subagent|delegat(?:e|ed|ion)|worker|child run|spawned|spawn_subagent|hand[- ]?off)\b/i.test(combined)
    || /(子任务|子代理|委派|工作线程|分配给)/.test(combined)
  ) {
    return "delegated_task_block";
  }
  if (
    /\b(failed|failure|error|unable|cannot|could not|couldn't|blocked|timed out|not connected|invalid|denied)\b/i.test(combined)
    || /(失败|错误|无法|不能|未连接|阻止|超时|无效|拒绝)/.test(combined)
  ) {
    return "tool_failure_block";
  }
  const hasUser = records.some((record) => record.role === "user");
  const hasAssistant = records.some((record) => record.role === "assistant");
  return hasUser && hasAssistant ? "topic_block" : "conversation_block";
}

function summarizeConversationHistoryBlock(
  records: readonly FridaySessionMessageRecord[],
): FridayConversationHistoryBlockSummary {
  const kind = classifyConversationHistoryBlockKind(records);
  const userSummaries = records
    .filter((record) => record.role === "user")
    .map((record) => clampSummary(record.contentText, 140));
  const assistantSummaries = records
    .filter((record) => record.role === "assistant")
    .map((record) => clampSummary(record.contentText, 160));
  const summaryText = clampSummary(
    [
      userSummaries.length > 0 ? `User: ${userSummaries.join(" | ")}` : undefined,
      assistantSummaries.length > 0 ? `Assistant: ${assistantSummaries.join(" | ")}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  const combined = records.map((record) => record.contentText).join("\n");
  const toolFailures = kind === "tool_failure_block"
    ? records.map((record) => clampSummary(record.contentText, 120)).slice(-2)
    : [];
  const openQuestions = records
    .filter((record) => record.role === "user" && /(?:\?|？)\s*$/.test(record.contentText.trim()))
    .map((record) => clampSummary(record.contentText, 120))
    .slice(-2);
  const decisions = records
    .filter((record) => record.role === "assistant" && /\b(recommend|decide|should|best|prefer|plan)\b/i.test(record.contentText))
    .map((record) => clampSummary(record.contentText, 120))
    .slice(0, 3);
  const todos = records
    .filter((record) => /\b(todo|next|follow up|need to|should)\b/i.test(record.contentText) || /(下一步|待办|需要)/.test(record.contentText))
    .map((record) => clampSummary(record.contentText, 120))
    .slice(0, 3);

  return {
    id: `history-block:${records[0]?.id ?? "unknown"}:${records[records.length - 1]?.id ?? "unknown"}`,
    kind,
    summaryText,
    decisions,
    todos,
    openQuestions,
    toolFailures,
    fileOperations: extractFileOperations(combined),
    messageIds: records.map((record) => record.id),
    sequenceStart: records[0]?.sequence,
    sequenceEnd: records[records.length - 1]?.sequence,
  };
}

function buildConversationHistoryBlocks(
  records: readonly FridaySessionMessageRecord[],
): FridayConversationHistoryBlockSummary[] {
  if (records.length === 0) {
    return [];
  }

  const blocks: FridayConversationHistoryBlockSummary[] = [];
  let current: FridaySessionMessageRecord[] = [];

  const flushCurrent = () => {
    if (current.length === 0) {
      return;
    }
    blocks.push(summarizeConversationHistoryBlock(current));
    current = [];
  };

  for (const record of records) {
    if (record.role === "user" && current.some((entry) => entry.role === "user")) {
      flushCurrent();
    }
    current.push(record);
  }
  flushCurrent();
  return blocks;
}

function formatConversationHistoryBlockSummary(
  block: FridayConversationHistoryBlockSummary,
): string {
  const parts = [`${block.kind}: ${block.summaryText}`];
  if (block.decisions.length > 0) {
    parts.push(`decisions=${block.decisions.join(" | ")}`);
  }
  if (block.todos.length > 0) {
    parts.push(`todos=${block.todos.join(" | ")}`);
  }
  if (block.openQuestions.length > 0) {
    parts.push(`openQuestions=${block.openQuestions.join(" | ")}`);
  }
  if (block.toolFailures.length > 0) {
    parts.push(`toolFailures=${block.toolFailures.join(" | ")}`);
  }
  if (block.fileOperations.length > 0) {
    parts.push(`fileOperations=${block.fileOperations.join(" | ")}`);
  }
  return parts.join(" | ");
}

function rehydrateConversationHistoryBlockMessages(
  block: FridayConversationHistoryBlockSummary,
  records: readonly FridaySessionMessageRecord[],
): FridayAgentMessage[] {
  return block.messageIds
    .map((messageId) => records.find((record) => record.id === messageId))
    .filter((record): record is FridaySessionMessageRecord => Boolean(record))
    .map(mapSessionMessageToAgentMessage)
    .filter((message): message is FridayAgentMessage => message !== null);
}

function createMessageBlockCandidate(input: {
  id: string;
  source: FridayConversationBlock["source"];
  summary: string;
  score: number;
  reason: string;
  records: FridaySessionMessageRecord[];
}): FridayConversationBlockCandidate {
  const historyMessages = input.records
    .map(mapSessionMessageToAgentMessage)
    .filter((message): message is FridayAgentMessage => message !== null);
  return {
    block: {
      id: input.id,
      source: input.source,
      summary: summarizeTopic(input.summary),
      score: input.score,
      reason: input.reason,
      messageIds: input.records.map((record) => record.id),
      sequenceStart: input.records[0]?.sequence,
      sequenceEnd: input.records[input.records.length - 1]?.sequence,
    },
    messages: historyMessages,
  };
}

function createHistoryBlockCandidate(input: {
  summary: FridayConversationHistoryBlockSummary;
  score: number;
  reason: string;
  records: readonly FridaySessionMessageRecord[];
  taskOverlap: number;
}): FridayConversationHistoryBlockCandidate {
  return {
    summary: input.summary,
    score: input.score,
    reason: input.reason,
    messages: rehydrateConversationHistoryBlockMessages(input.summary, input.records),
    taskOverlap: input.taskOverlap,
  };
}

function buildAnchorWindow(
  records: FridaySessionMessageRecord[],
  anchorRecord: FridaySessionMessageRecord,
): FridaySessionMessageRecord[] {
  const anchorIndex = findRecordIndex(records, anchorRecord.id);
  if (anchorIndex < 0) {
    return [anchorRecord];
  }

  if (anchorRecord.role === "assistant") {
    const previousUser = [...records.slice(0, anchorIndex)]
      .reverse()
      .find((record) => record.role === "user");
    return previousUser ? [previousUser, anchorRecord] : [anchorRecord];
  }

  const nextAssistant = records
    .slice(anchorIndex + 1)
    .find((record) => record.role === "assistant");
  return nextAssistant ? [anchorRecord, nextAssistant] : [anchorRecord];
}

function deriveSelectedAssistantFact(input: {
  selectedBlocks: FridayConversationBlock[];
  focusState?: FridaySessionConversationFocusState | null;
}): string | undefined {
  const replyAnchorSummary = input.selectedBlocks
    .find((block) => block.source === "reply_anchor")
    ?.summary
    ?.trim();
  if (replyAnchorSummary) {
    const assistantMatch = replyAnchorSummary.match(/assistant:\s*([\s\S]+)$/i);
    const replyAssistantFact = assistantMatch?.[1]?.trim() ?? replyAnchorSummary;
    if (replyAssistantFact.length > 0) {
      return replyAssistantFact;
    }
  }

  const assistantAnchorSummary = input.selectedBlocks
    .find((block) => block.source === "assistant_anchor")
    ?.summary
    ?.trim();
  if (assistantAnchorSummary && assistantAnchorSummary.length > 0) {
    return assistantAnchorSummary;
  }

  const persistedAssistantAnchor = input.focusState?.assistantAnchorSummary?.trim();
  if (persistedAssistantAnchor && persistedAssistantAnchor.length > 0) {
    return persistedAssistantAnchor;
  }

  return undefined;
}

function resolveActiveTaskLedgerEntry(
  focusState?: FridaySessionConversationFocusState | null,
): FridayConversationTaskLedgerEntry | undefined {
  const ledger = focusState?.taskLedger;
  if (!ledger?.activeTaskId || !Array.isArray(ledger.tasks)) {
    return undefined;
  }
  return ledger.tasks.find((task) => task.id === ledger.activeTaskId && task.status === "active");
}

function formatTaskLedgerEntry(task: FridayConversationTaskLedgerEntry): string {
  const parts = [
    `active task: ${task.title}`,
    task.summary && task.summary !== task.title ? `summary: ${task.summary}` : undefined,
    task.lastUserText ? `last user turn: ${task.lastUserText}` : undefined,
    task.lastAssistantSummary ? `last assistant answer: ${task.lastAssistantSummary}` : undefined,
    task.toolProfile ? `tool profile: ${task.toolProfile}` : undefined,
    task.openQuestions?.length ? `open questions: ${task.openQuestions.join(" | ")}` : undefined,
  ];
  return normalizeText(parts.filter((value): value is string => Boolean(value)).join("; "));
}

function isTrivialTopicSummary(summary?: string): boolean {
  const normalized = normalizeText(summary ?? "").toLowerCase();
  if (normalized.length === 0) {
    return true;
  }
  return /^(?:hi|hello|hey|thanks|thank you|ok|okay|yo|你好|嗨|谢谢|好的|嗯|哈喽)[!.。！\s]*$/iu.test(normalized);
}

function isSubstantiveTaskText(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.length > 16
    || /\b(workflow|automation|skill|plugin|repo|github|url|https?:\/\/|debug|fix|build|test|deploy|memory|session)\b/i.test(normalized)
    || /(工作流|自动化|技能|插件|仓库|源码|修复|调试|构建|测试|部署|记忆|上下文|会话|源码)/u.test(normalized);
}

function inferTaskToolProfile(text: string): string | undefined {
  const normalized = normalizeText(text).toLowerCase();
  if (/\b(workflow|automation|schedule|cron|trigger|dag|pipeline)\b|工作流|自动化|定时|触发器/u.test(normalized)) {
    return "workflow";
  }
  if (/\b(skill|skills|plugin|marketplace)\b|技能|插件|市场/u.test(normalized)) {
    return "skill";
  }
  if (/\b(code|repo|repository|file|fix|debug|test|build|typescript|javascript|python|git|commit|diff|pr)\b|代码|仓库|文件|修复|调试|测试|构建/u.test(normalized)) {
    return "code";
  }
  if (/\b(browser|click|open page|navigate|screenshot)\b|浏览器|点击|打开网页|截图/u.test(normalized)) {
    return "browser";
  }
  if (/\b(memory|remember|preference|recall)\b|记忆|记住|偏好/u.test(normalized)) {
    return "memory";
  }
  return undefined;
}

function derivePromptTopicSummary(input: {
  focusState?: FridaySessionConversationFocusState | null;
  selectedBlocks: FridayConversationBlock[];
}): string | undefined {
  const activeTask = resolveActiveTaskLedgerEntry(input.focusState);
  if (activeTask?.summary && !isTrivialTopicSummary(activeTask.summary)) {
    return activeTask.summary;
  }

  const focusSummary = input.focusState?.currentTopicSummary?.trim();
  if (focusSummary && !isTrivialTopicSummary(focusSummary)) {
    return focusSummary;
  }

  const assistantFact = deriveSelectedAssistantFact({
    selectedBlocks: input.selectedBlocks,
    focusState: input.focusState,
  });
  if (assistantFact && assistantAppearsToAskForChoice(assistantFact)) {
    return summarizeTopic(assistantFact);
  }

  return focusSummary;
}

function resolvePreparedCurrentTopicSummary(input: {
  task: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  selectedBlocks: FridayConversationBlock[];
}): string | undefined {
  if (input.turnKind === "new_topic") {
    return summarizeTopic(input.task);
  }

  const promptTopic = derivePromptTopicSummary({
    focusState: input.focusState,
    selectedBlocks: input.selectedBlocks,
  });
  if (promptTopic && !isTrivialTopicSummary(promptTopic)) {
    return promptTopic;
  }

  return input.focusState?.currentTopicSummary ?? summarizeTopic(input.task);
}

function extractOpenQuestions(text: string): string[] {
  return normalizeText(text)
    .split(/(?<=[?？])\s+/u)
    .map((part) => part.trim())
    .filter((part) => /[?？]/u.test(part))
    .map((part) => clampSummary(part, 120))
    .slice(0, 3);
}

function shouldReplaceStaleCurrentTopic(input: {
  previousSummary?: string;
  task: string;
  turnKind: FridayConversationTurnKind;
}): boolean {
  if (input.turnKind === "status_check") {
    return false;
  }
  return isTrivialTopicSummary(input.previousSummary) && isSubstantiveTaskText(input.task);
}

function deriveCurrentTopicForFocus(input: {
  task: string;
  turnKind: FridayConversationTurnKind;
  previous?: FridaySessionConversationFocusState | null;
}): { summary: string; fingerprint: string; startSequence?: number } {
  if (input.turnKind === "new_topic" || shouldReplaceStaleCurrentTopic({
    previousSummary: input.previous?.currentTopicSummary,
    task: input.task,
    turnKind: input.turnKind,
  })) {
    const summary = summarizeTopic(input.task);
    return {
      summary,
      fingerprint: fingerprintTopic(input.task),
    };
  }

  const activeTask = resolveActiveTaskLedgerEntry(input.previous);
  const previousSummary = input.previous?.currentTopicSummary;
  const summary = previousSummary && !isTrivialTopicSummary(previousSummary)
    ? previousSummary
    : activeTask?.summary && !isTrivialTopicSummary(activeTask.summary)
      ? activeTask.summary
      : summarizeTopic(input.task);
  return {
    summary,
    fingerprint: input.previous?.currentTopicFingerprint ?? fingerprintTopic(summary),
    startSequence: input.previous?.currentTopicStartSequence,
  };
}

function updateTaskLedger(input: {
  task: string;
  responseText: string;
  turnKind: FridayConversationTurnKind;
  previous?: FridaySessionConversationFocusState | null;
  topicSummary: string;
  topicFingerprint: string;
  currentUserSequence?: number;
  nowIso: string;
}): FridayConversationTaskLedger | undefined {
  const previousLedger = input.previous?.taskLedger;
  if (input.turnKind === "status_check") {
    return previousLedger
      ? { ...previousLedger, updatedAt: input.nowIso }
      : undefined;
  }

  let tasks = Array.isArray(previousLedger?.tasks) ? [...previousLedger.tasks] : [];
  let activeTaskId = previousLedger?.activeTaskId;
  const activeExists = Boolean(activeTaskId && tasks.some((task) => task.id === activeTaskId));
  const startNewTask = input.turnKind === "new_topic" || !activeExists || shouldReplaceStaleCurrentTopic({
    previousSummary: input.previous?.currentTopicSummary,
    task: input.task,
    turnKind: input.turnKind,
  });
  const toolProfile = inferTaskToolProfile(`${input.task}\n${input.responseText}`) ?? undefined;
  const openQuestions = extractOpenQuestions(input.responseText);
  const existingMatch = tasks.find((task) => task.fingerprint === input.topicFingerprint);

  if (startNewTask) {
    if (activeTaskId) {
      tasks = tasks.map((task) =>
        task.id === activeTaskId && task.status === "active"
          ? { ...task, status: "paused", updatedAt: input.nowIso }
          : task);
    }
    const id = existingMatch?.id ?? `task:${input.topicFingerprint}`;
    activeTaskId = id;
    const nextTask: FridayConversationTaskLedgerEntry = {
      ...(existingMatch ?? {
        id,
        fingerprint: input.topicFingerprint,
        title: input.topicSummary,
        summary: input.topicSummary,
        status: "active",
        createdAt: input.nowIso,
      }),
      title: existingMatch?.title ?? input.topicSummary,
      summary: input.topicSummary,
      status: "active",
      startSequence: existingMatch?.startSequence ?? input.currentUserSequence,
      lastSequence: input.currentUserSequence,
      lastUserText: summarizeTopic(input.task),
      lastAssistantSummary: summarizeTopic(input.responseText),
      toolProfile: toolProfile ?? existingMatch?.toolProfile,
      openQuestions: openQuestions.length > 0 ? openQuestions : undefined,
      updatedAt: input.nowIso,
    };
    tasks = [nextTask, ...tasks.filter((task) => task.id !== id)];
  } else if (activeTaskId) {
    tasks = tasks.map((task) => {
      if (task.id !== activeTaskId) {
        return task;
      }
      return {
        ...task,
        summary: task.summary && !isTrivialTopicSummary(task.summary) ? task.summary : input.topicSummary,
        status: "active",
        lastSequence: input.currentUserSequence,
        lastUserText: summarizeTopic(input.task),
        lastAssistantSummary: summarizeTopic(input.responseText),
        toolProfile: toolProfile ?? task.toolProfile,
        openQuestions: openQuestions.length > 0 ? openQuestions : undefined,
        updatedAt: input.nowIso,
      };
    });
  }

  const orderedTasks = tasks
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    .slice(0, MAX_TASK_LEDGER_ENTRIES);

  return {
    activeTaskId,
    tasks: orderedTasks,
    updatedAt: input.nowIso,
  };
}

function buildConversationBlockSelection(input: {
  task: string;
  historyRecords: FridaySessionMessageRecord[];
  focusState?: FridaySessionConversationFocusState | null;
  turnKind: FridayConversationTurnKind;
  replyToMessageId?: string;
  evidenceBlocks?: FridayEvidenceBlock[];
}): FridayContextSelectionResult & { historyMessages: FridayAgentMessage[]; replyAnchorMessageId?: string; replyAnchorSequence?: number } {
  const taskTokens = tokenize(input.task);
  const taskLower = normalizeText(input.task).toLowerCase();
  const taskHasSpecificFollowUpTokens = hasSpecificFollowUpTokens(input.task);
  const shortContextualFollowUp = isShortContextualFollowUpTask(input.task) && !taskHasSpecificFollowUpTokens;
  const shortAssistantAnchorFollowUp = isShortAssistantAnchorFollowUpTask(input.task) && !taskHasSpecificFollowUpTokens;
  const recentResultFollowUp = isRecentResultFollowUpTask(input.task);
  const recallRequest = input.turnKind !== "status_check" && !recentResultFollowUp && isRecallRequestTask(input.task);
  const requestedRecallFields = recallRequest ? recallFieldTokens(input.task) : new Set<string>();
  const focusState = input.focusState ?? null;
  const records = input.historyRecords;
  const candidates: FridayConversationBlockCandidate[] = [];
  const seenCandidateIds = new Set<string>();

  const registerCandidate = (candidate: FridayConversationBlockCandidate | null) => {
    if (!candidate || seenCandidateIds.has(candidate.block.id) || candidate.block.score <= 0) {
      return;
    }
    seenCandidateIds.add(candidate.block.id);
    candidates.push(candidate);
  };

  const replyAnchor = resolveReplyAnchorRecord(records, input.replyToMessageId);
  const hasUnresolvedReplyAnchor = Boolean(input.replyToMessageId?.trim()) && !replyAnchor;
  const recentAssistantRewriteRequest = isRecentAssistantRewriteRequest(input.task);
  const crossTopicRecapRequest = isCrossTopicRecapRequest(input.task);
  const bareNudgeTask = isBareNudgeTask(input.task);
  const latestAssistant = findLatestRecord(records, "assistant");
  const latestUser = findLatestRecord(records, "user");
  const shortChoiceReplyAnswersLatestAssistant = Boolean(
    isChoiceReplyTask(input.task)
    && latestAssistant
    && assistantAppearsToAskForChoice(latestAssistant.contentText),
  );
  const preferLatestAssistantAnchor = !replyAnchor && (
    hasUnresolvedReplyAnchor
    || (recentAssistantRewriteRequest && !crossTopicRecapRequest)
    || shortChoiceReplyAnswersLatestAssistant
  );
  const preferRecentUserAnchor = !replyAnchor && bareNudgeTask;
  const preferRecencyAnchor = preferLatestAssistantAnchor || preferRecentUserAnchor;
  const replyAnchorInCurrentTopicWindow = Boolean(
    replyAnchor
    && typeof focusState?.currentTopicStartSequence === "number"
    && replyAnchor.sequence >= focusState.currentTopicStartSequence,
  );
  if (replyAnchor) {
    registerCandidate(createMessageBlockCandidate({
      id: `reply:${replyAnchor.id}`,
      source: "reply_anchor",
      summary: buildAnchorWindow(records, replyAnchor).map((record) => `${record.role}: ${record.contentText}`).join("\n"),
      score: 100,
      reason: "Explicit reply target matched a prior session message.",
      records: buildAnchorWindow(records, replyAnchor),
    }));
  }

  if (recentResultFollowUp && (latestUser || latestAssistant)) {
    const latestAssistantIndex = latestAssistant ? findRecordIndex(records, latestAssistant.id) : -1;
    const previousUserForAssistant = latestAssistantIndex >= 0
      ? [...records.slice(0, latestAssistantIndex)].reverse().find((record) => record.role === "user")
      : undefined;
    const anchorRecords = [
      previousUserForAssistant ?? latestUser,
      latestAssistant,
    ].filter((record): record is FridaySessionMessageRecord => Boolean(record));
    const messageIds = anchorRecords.map((record) => record.id);
    registerCandidate({
      block: {
        id: `recent-result:${messageIds.join(":")}`,
        source: "assistant_anchor",
        summary: buildRecentResultAnchorSummary(anchorRecords),
        score: 220,
        reason: "Current turn asks what was found in the immediately previous task, so the latest task/result pair is the primary anchor.",
        messageIds,
        sequenceStart: anchorRecords[0]?.sequence,
        sequenceEnd: anchorRecords[anchorRecords.length - 1]?.sequence,
      },
      messages: anchorRecords
        .map(mapSessionMessageToAgentMessage)
        .filter((message): message is FridayAgentMessage => message !== null),
      fallbackOnly: false,
    });
  }

  if (latestAssistant) {
    const assistantOverlap = countOverlap(taskTokens, tokenize(latestAssistant.contentText));
    const assistantScore = (assistantOverlap * 20)
      + (preferLatestAssistantAnchor ? 96 : 0)
      + (
        !replyAnchor
        && (
          FOLLOW_UP_HINTS.test(taskLower)
          || DEICTIC_FOLLOW_UP_HINTS.test(taskLower)
          || CHINESE_FOLLOW_UP_HINTS.test(input.task)
        )
        ? 18
        : 0
      )
      + (
        (input.turnKind === "follow_up" || input.turnKind === "clarification")
        && (
          assistantOverlap > 0
          || preferLatestAssistantAnchor
          || (!replyAnchor && shortAssistantAnchorFollowUp)
          || replyAnchorInCurrentTopicWindow
        )
        ? 10
        : 0
      );
    if (!(recallRequest && assistantOverlap === 0 && !preferLatestAssistantAnchor)) {
      registerCandidate({
        ...createMessageBlockCandidate({
          id: `assistant:${latestAssistant.id}`,
          source: "assistant_anchor",
          summary: latestAssistant.contentText,
          score: assistantScore,
          reason: preferLatestAssistantAnchor
            ? hasUnresolvedReplyAnchor
              ? "Platform reply target was not found locally, so the latest assistant answer is used as the safest reply anchor."
              : shortChoiceReplyAnswersLatestAssistant
                ? "Latest assistant answer is preferred because the user replied with an option choice."
                : "Latest assistant answer is preferred for a short rewrite or explanation request."
            : assistantOverlap > 0
            ? `Current turn overlaps the latest assistant answer (${String(assistantOverlap)} token match(es)).`
            : "Latest assistant answer is a plausible short-follow-up anchor.",
          records: buildAnchorWindow(records, latestAssistant),
        }),
        taskOverlap: assistantOverlap,
        fallbackOnly: assistantOverlap === 0 && !preferLatestAssistantAnchor,
      });
    }
  }

  if (
    latestUser
    && !(recallRequest && (isExplicitTopicSwitchTask(latestUser.contentText) || isRecallQuestionRecord(latestUser.contentText)))
  ) {
    const userOverlap = countOverlap(taskTokens, tokenize(latestUser.contentText));
    const userScore = (userOverlap * 14)
      + (preferRecentUserAnchor ? 80 : 0)
      + (
        input.turnKind === "follow_up"
        && (!replyAnchor || preferRecentUserAnchor || replyAnchorInCurrentTopicWindow || userOverlap > 0)
        ? 8
        : 0
      );
    registerCandidate({
      ...createMessageBlockCandidate({
        id: `user:${latestUser.id}`,
        source: "recent_user",
        summary: latestUser.contentText,
        score: userScore,
        reason: preferRecentUserAnchor
          ? "The latest user message is preferred because the current turn is a bare nudge."
          : userOverlap > 0
          ? `Current turn overlaps the most recent user turn (${String(userOverlap)} token match(es)).`
          : "Most recent user turn is a fallback short-context anchor.",
        records: [latestUser],
      }),
      taskOverlap: userOverlap,
      fallbackOnly: userOverlap === 0 && !preferRecentUserAnchor,
    });
  }

  if (
    focusState?.currentTopicSummary
    && !preferRecencyAnchor
    && !(recallRequest && isExplicitTopicSwitchTask(focusState.currentTopicSummary))
    && !(recallRequest && !recallableFactMatchesFields(focusState.currentTopicSummary, requestedRecallFields))
  ) {
    const focusOverlap = countOverlap(taskTokens, tokenize(focusState.currentTopicSummary));
    const focusScore = (focusOverlap * 12)
      + (
        !replyAnchor
        && (input.turnKind === "follow_up" || input.turnKind === "clarification")
        ? 8
        : replyAnchorInCurrentTopicWindow
        ? 8
        : 0
      );
    registerCandidate({
      block: {
        id: "focus:current-topic",
        source: "focus_topic",
        summary: focusState.currentTopicSummary,
        score: focusScore,
        reason: focusOverlap > 0
          ? `Current topic summary matches this turn (${String(focusOverlap)} token match(es)).`
          : "Persisted focus topic kept as a low-weight context block.",
      },
      messages: [],
      taskOverlap: focusOverlap,
      fallbackOnly: focusOverlap === 0,
    });
  }

  const activeTask = resolveActiveTaskLedgerEntry(focusState);
  if (
    activeTask
    && !preferRecencyAnchor
    && !(recallRequest && isExplicitTopicSwitchTask(formatTaskLedgerEntry(activeTask)))
    && !(recallRequest && !recallableFactMatchesFields(formatTaskLedgerEntry(activeTask), requestedRecallFields))
    && (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
  ) {
    const taskLedgerSummary = formatTaskLedgerEntry(activeTask);
    const ledgerOverlap = countOverlap(taskTokens, tokenize(taskLedgerSummary));
    registerCandidate({
      block: {
        id: `task-ledger:${activeTask.id}`,
        source: "task_ledger",
        summary: taskLedgerSummary,
        score: (ledgerOverlap * 14) + 28,
        reason: ledgerOverlap > 0
          ? `Active task ledger matches this turn (${String(ledgerOverlap)} token match(es)).`
          : "Active task ledger kept as the bounded current-task memory.",
        sequenceStart: activeTask.startSequence,
        sequenceEnd: activeTask.lastSequence,
      },
      messages: [],
      taskOverlap: ledgerOverlap,
      fallbackOnly: ledgerOverlap === 0,
    });
  }

  if (
    focusState?.lastHarnessSummary
    && (input.turnKind === "follow_up" || input.turnKind === "continue_active_task")
  ) {
    const harnessSummary = formatHarnessHandoffSummary(focusState);
    if (harnessSummary) {
      registerCandidate({
        block: {
          id: "evidence:harness",
          source: "harness_block",
          summary: harnessSummary,
          score: 89,
          reason: "Persisted harness handoff is preferred over replaying broader topic history for resume-style follow-ups.",
        },
        messages: [],
      });
    }
  }

  const mostRecentRecallRequested = recallRequest && !preferRecencyAnchor
    ? asksForMostRecentRecall(input.task)
    : false;
  const shouldPreferLatestRecallFact = recallRequest
    && !preferRecencyAnchor
    && (mostRecentRecallRequested || (requestedRecallFields.size > 0 && !asksForOlderRecallFact(input.task)));
  const latestRecallFactSequence = shouldPreferLatestRecallFact
    ? records.reduce((latest, record) => {
      if (!recallableFactMatchesFields(record.contentText, requestedRecallFields)) {
        return latest;
      }
      return Math.max(latest, record.sequence);
    }, Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;

  if (recallRequest && !preferRecencyAnchor) {
    for (const record of records) {
      if (record.role !== "user" && record.role !== "assistant") {
        continue;
      }
      if (latestUser && record.id === latestUser.id && isExplicitTopicSwitchTask(record.contentText)) {
        continue;
      }
      if (isExplicitTopicSwitchTask(record.contentText)) {
        continue;
      }
      if (record.role === "user" && isRecallQuestionRecord(record.contentText)) {
        continue;
      }
      if (
        requestedRecallFields.size > 0
        && !recallableFactMatchesFields(record.contentText, requestedRecallFields)
      ) {
        continue;
      }
      if (
        shouldPreferLatestRecallFact
        && Number.isFinite(latestRecallFactSequence)
        && recallableFactMatchesFields(record.contentText, requestedRecallFields)
        && record.sequence < latestRecallFactSequence
      ) {
        continue;
      }
      const recordTokens = tokenize(record.contentText);
      const overlap = countOverlap(taskTokens, recordTokens);
      const meaningfulOverlap = countMeaningfulOverlap(taskTokens, recordTokens);
      if (overlap <= 0 && meaningfulOverlap <= 0) {
        continue;
      }
      const rememberLikeBonus = establishesRecallableFact(record.contentText)
        ? 64
        : 0;
      const earliestSequence = records[0]?.sequence ?? record.sequence;
      const recencyBonus = Math.min(36, Math.max(0, record.sequence - earliestSequence) / 2);
      const score = (meaningfulOverlap * 22) + (overlap * 8) + rememberLikeBonus + recencyBonus;
      registerCandidate({
        ...createMessageBlockCandidate({
          id: `recall:${record.id}`,
          source: "conversation_block",
          summary: record.contentText,
          score,
          reason: `Historical recall anchor matched this turn (${String(overlap)} token match(es), ${String(meaningfulOverlap)} meaningful match(es)).`,
          records: buildAnchorWindow(records, record),
        }),
        taskOverlap: Math.max(overlap, meaningfulOverlap),
        fallbackOnly: false,
      });
    }
  }

  const useCrossTopicRecapWindow =
    !preferRecencyAnchor
    &&
    input.turnKind === "follow_up"
    && isCrossTopicRecapRequest(input.task);

  const topicWindowRecords = (
    !preferRecencyAnchor
    && !recallRequest
    &&
    (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
    && typeof focusState?.currentTopicStartSequence === "number"
  )
    ? records.filter((record) => record.sequence >= focusState.currentTopicStartSequence!)
    : [];
  if (topicWindowRecords.length > 1) {
    const topicWindowSummary = topicWindowRecords
      .map((record) => `${record.role}: ${record.contentText}`)
      .join("\n");
    const topicWindowOverlap = countOverlap(taskTokens, tokenize(topicWindowSummary));
    const topicWindowBaseScore = replyAnchor
      ? (replyAnchorInCurrentTopicWindow ? 24 : 0)
      : 36;
    const topicWindowScore = topicWindowBaseScore + (topicWindowOverlap * 10);
    if (topicWindowRecords.length > MAX_FOLLOW_UP_HISTORY) {
      registerCandidate({
        block: {
          id: `topic-window:${String(focusState?.currentTopicStartSequence)}`,
          source: "focus_topic",
          summary: summarizeTopic(topicWindowSummary),
          score: topicWindowScore,
          reason: "Current turn is still inside the persisted topic window; the long topic window is now represented as a compacted summary block.",
          sequenceStart: topicWindowRecords[0]?.sequence,
          sequenceEnd: topicWindowRecords[topicWindowRecords.length - 1]?.sequence,
        },
        messages: [],
        taskOverlap: topicWindowOverlap,
        fallbackOnly: topicWindowOverlap === 0,
      });
    } else {
      registerCandidate({
        ...createMessageBlockCandidate({
          id: `topic-window:${String(focusState?.currentTopicStartSequence)}`,
          source: "focus_topic",
          summary: topicWindowSummary,
          score: topicWindowScore,
          reason: "Current turn is still inside the persisted topic window.",
          records: topicWindowRecords,
        }),
        taskOverlap: topicWindowOverlap,
        fallbackOnly: topicWindowOverlap === 0,
      });
    }
  }

  if (input.turnKind === "status_check" && (focusState?.activeRunId || focusState?.pendingPlanRunId || focusState?.activeSubagentIds?.length)) {
    const activeSummary = [
      focusState.activeRunId ? `Active run: ${focusState.activeRunId}` : undefined,
      focusState.pendingPlanRunId ? `Pending plan run: ${focusState.pendingPlanRunId}` : undefined,
      focusState.activeSubagentIds?.length ? `Active subagents: ${focusState.activeSubagentIds.join(", ")}` : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    registerCandidate({
      block: {
        id: "focus:active-run",
        source: "active_run",
        summary: activeSummary,
        score: 95,
        reason: "Status questions should anchor to the active run snapshot before answering.",
      },
      messages: [],
    });
  }

  for (const evidenceBlock of input.evidenceBlocks ?? []) {
    registerCandidate(createEvidenceBlockCandidate(evidenceBlock));
  }

  const historyBlockCandidates: FridayConversationHistoryBlockCandidate[] = [];
  const seenHistoryBlockIds = new Set<string>();
  const registerHistoryBlock = (candidate: FridayConversationHistoryBlockCandidate | null) => {
    if (!candidate || seenHistoryBlockIds.has(candidate.summary.id) || candidate.score <= 0) {
      return;
    }
    seenHistoryBlockIds.add(candidate.summary.id);
    historyBlockCandidates.push(candidate);
  };

  const candidateHistoryRecords = replyAnchor || preferRecencyAnchor
    ? []
    : useCrossTopicRecapWindow
    ? records
    : topicWindowRecords.length > MAX_FOLLOW_UP_HISTORY
      ? topicWindowRecords
      : records;
  if (
    candidateHistoryRecords.length > MAX_FOLLOW_UP_HISTORY
    && input.turnKind !== "new_topic"
  ) {
    const alreadyAnchoredMessageIds = new Set(
      candidates.flatMap((candidate) => candidate.block.messageIds ?? []),
    );
    const historyBlocks = buildConversationHistoryBlocks(candidateHistoryRecords);
    const totalBlockCount = historyBlocks.length;
    const focusTokens = tokenize(focusState?.currentTopicSummary ?? "");

    historyBlocks.forEach((block, index) => {
      const unanchoredMessageIds = block.messageIds.filter((messageId) => !alreadyAnchoredMessageIds.has(messageId));
      if (unanchoredMessageIds.length === 0) {
        return;
      }

      if (recallRequest && !preferRecencyAnchor) {
        const blockRecords = block.messageIds
          .map((messageId) => candidateHistoryRecords.find((record) => record.id === messageId))
          .filter((record): record is FridaySessionMessageRecord => Boolean(record));
        const allMatchingFactSequences = blockRecords
          .filter((record) => recallableFactMatchesFields(record.contentText, requestedRecallFields))
          .map((record) => record.sequence);
        const userMatchingFactSequences = blockRecords
          .filter((record) => record.role === "user" && recallableFactMatchesFields(record.contentText, requestedRecallFields))
          .map((record) => record.sequence);
        const hasRecallQuestion = blockRecords.some((record) =>
          record.role === "user" && isRecallQuestionRecord(record.contentText));

        if (
          allMatchingFactSequences.length === 0
          || (hasRecallQuestion && userMatchingFactSequences.length === 0)
          || (
            shouldPreferLatestRecallFact
            && Number.isFinite(latestRecallFactSequence)
            && Math.max(...allMatchingFactSequences) < latestRecallFactSequence
          )
        ) {
          return;
        }
      }

      const formattedSummary = formatConversationHistoryBlockSummary(block);
      const blockTokens = tokenize(formattedSummary);
      const taskOverlap = countOverlap(taskTokens, blockTokens);
      const focusOverlap = focusTokens.length > 0 ? countOverlap(focusTokens, blockTokens) : 0;
      const recencyBonus = Math.max(1, totalBlockCount - index);
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
      const score = (taskOverlap * 14) + (focusOverlap * 8) + recencyBonus + kindBonus;

      registerHistoryBlock(createHistoryBlockCandidate({
        summary: {
          ...block,
          messageIds: unanchoredMessageIds,
        },
        score,
        reason: taskOverlap > 0 || focusOverlap > 0
          ? `Compacted ${block.kind} matched the current turn (${String(taskOverlap)} task token match(es), ${String(focusOverlap)} focus token match(es)).`
          : `Compacted ${block.kind} kept as a recency-weighted history block.`,
        records: candidateHistoryRecords,
        taskOverlap,
      }));
    });
  }

  const scoreThreshold = input.turnKind === "new_topic" ? 60 : 1;
  const hasMatchedHistoryBlock = !replyAnchor && historyBlockCandidates.some((candidate) => candidate.taskOverlap > 0);
  const selectedCandidates = candidates
    .filter((candidate) => !hasMatchedHistoryBlock || !candidate.fallbackOnly || candidate.block.source === "reply_anchor")
    .filter((candidate) => candidate.block.score >= scoreThreshold || candidate.block.source === "reply_anchor")
    .sort((left, right) => right.block.score - left.block.score || left.block.id.localeCompare(right.block.id))
    .slice(0, input.turnKind === "status_check" ? 3 : 4);
  const selectedHistoryCandidates = historyBlockCandidates
    .filter((candidate) => candidate.score >= scoreThreshold)
    .sort((left, right) => right.score - left.score || left.summary.id.localeCompare(right.summary.id))
    .slice(0, input.turnKind === "status_check" ? 1 : MAX_RELEVANT_HISTORY_BLOCKS);
  const selectionReasons = [
    ...selectedCandidates.map((candidate) => `${candidate.block.source} → ${candidate.block.reason}`),
    ...selectedHistoryCandidates.map((candidate) => `${candidate.summary.kind} → ${candidate.reason}`),
  ];

  const historyMessageLimit = input.turnKind === "status_check"
    ? MAX_STATUS_HISTORY
    : MAX_FOLLOW_UP_HISTORY + 6;
  const prioritizedHistoryEntries: Array<{ id: string; sequence: number; message: FridayAgentMessage }> = [];
  const seenHistoryMessageIds = new Set<string>();

  const appendHistoryMessages = (messageIds: readonly string[], messages: readonly FridayAgentMessage[]) => {
    messageIds.forEach((messageId, index) => {
      if (seenHistoryMessageIds.has(messageId) || prioritizedHistoryEntries.length >= historyMessageLimit) {
        return;
      }
      const record = records.find((entry) => entry.id === messageId);
      const mapped = messages[index]
        ?? (record ? mapSessionMessageToAgentMessage(record) : null);
      if (record && mapped) {
        seenHistoryMessageIds.add(messageId);
        prioritizedHistoryEntries.push({
          id: record.id,
          sequence: record.sequence,
          message: mapped,
        });
      }
    });
  };

  for (const candidate of selectedCandidates) {
    appendHistoryMessages(candidate.block.messageIds ?? [], candidate.messages);
  }
  for (const candidate of selectedHistoryCandidates) {
    appendHistoryMessages(candidate.summary.messageIds, candidate.messages);
  }

  if (useCrossTopicRecapWindow && records.length > 0) {
    const maxCount = input.turnKind === "status_check" ? MAX_STATUS_HISTORY : MAX_FOLLOW_UP_HISTORY;
    for (const record of records.slice(Math.max(0, records.length - maxCount))) {
      if (seenHistoryMessageIds.has(record.id) || prioritizedHistoryEntries.length >= historyMessageLimit) {
        continue;
      }
      const mapped = mapSessionMessageToAgentMessage(record);
      if (mapped) {
        seenHistoryMessageIds.add(record.id);
        prioritizedHistoryEntries.push({ id: record.id, sequence: record.sequence, message: mapped });
      }
    }
  }

  const historyMessages = prioritizedHistoryEntries
    .sort((left, right) => left.sequence - right.sequence)
    .map((entry) => entry.message);

  const selectedBlocks = [
    ...selectedCandidates.map((candidate) => candidate.block),
    ...selectedHistoryCandidates.map((candidate): FridayConversationBlock => ({
      id: candidate.summary.id,
      source: candidate.summary.kind,
      summary: formatConversationHistoryBlockSummary(candidate.summary),
      score: candidate.score,
      reason: candidate.reason,
      messageIds: candidate.summary.messageIds,
      sequenceStart: candidate.summary.sequenceStart,
      sequenceEnd: candidate.summary.sequenceEnd,
    })),
  ]
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, MAX_SELECTED_BLOCKS);

  return {
    selectedBlocks,
    selectionReasons,
    historyMessages,
    replyAnchorMessageId: replyAnchor?.id,
    replyAnchorSequence: replyAnchor?.sequence,
  };
}

function buildTaskPrompt(input: {
  task: string;
  turnKind: FridayConversationTurnKind;
  focusState?: FridaySessionConversationFocusState | null;
  selectedBlocks: FridayConversationBlock[];
}): string {
  const task = normalizeText(input.task);
  const hasExplicitReplyAnchor = input.selectedBlocks.some((block) => block.source === "reply_anchor");
  const assistantFactSummary = deriveSelectedAssistantFact({
    selectedBlocks: input.selectedBlocks,
    focusState: input.focusState,
  });
  const previousTopicSummary = derivePromptTopicSummary({
    focusState: input.focusState,
    selectedBlocks: input.selectedBlocks,
  })?.trim();
  const isShortAssistantFactFollowUp = Boolean(
    assistantFactSummary
    && (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
    && isShortContextualFollowUpTask(task),
  );
  const selectedBlockSummary = input.selectedBlocks.length > 0
    ? input.selectedBlocks
      .map((block) => `- [${block.source}] ${block.summary}`)
      .join("\n")
    : undefined;
  const hasRecentUserAnchor = input.selectedBlocks.some((block) => block.source === "recent_user");
  const hasHistoryOnlySelection = input.selectedBlocks.length > 0
    && input.selectedBlocks.every((block) => block.source.endsWith("_block"));
  const hasRecentResultAnchor = input.selectedBlocks.some((block) => block.id.startsWith("recent-result:"));
  const explicitTopicSwitch = isExplicitTopicSwitchTask(task);
  const literalFormatInstruction = isExplicitLiteralResponseInstruction(task);

  if (input.turnKind === "new_topic" && explicitTopicSwitch) {
    return [
      "This user explicitly switched away from the prior topic or excluded prior context.",
      `Current question: ${task}`,
      "Answer only the current question.",
      "Do not mention, restate, or continue the previous topic unless the user explicitly asks to recall it.",
    ].join("\n");
  }

  if (input.turnKind === "new_topic" && literalFormatInstruction) {
    return [
      "This user started a literal response request.",
      `Current question: ${task}`,
      "Do not reuse previous user text, previous assistant text, or prior response anchors.",
      "Answer only the current literal request.",
    ].join("\n");
  }

  if (input.turnKind === "new_topic" && previousTopicSummary) {
    return [
      "This user started a new question.",
      `Current question: ${task}`,
      "A previous topic exists, but it was intentionally not selected.",
      "Answer only the current question. Do not answer or continue prior topics unless the user explicitly references them.",
    ].join("\n");
  }

  if (input.turnKind === "status_check") {
    return [
      `The user is asking for a status update: ${task}`,
      previousTopicSummary
        ? `Active topic reference: ${previousTopicSummary}`
        : "No active topic summary is available.",
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : "No anchored status blocks were selected.",
      "Use the task_status tool before answering.",
      "Do not retry, resume, or reconstruct the original task in this turn unless the user explicitly asked for a new action.",
      "Do not answer the content of the previous task unless the user explicitly asked for that content.",
      "If you do not have deterministic status evidence in this turn, say that clearly instead of assuming.",
    ].join("\n");
  }

  if (
    literalFormatInstruction
    && selectedBlockSummary
    && (input.turnKind === "follow_up" || input.turnKind === "clarification" || input.turnKind === "continue_active_task")
  ) {
    return [
      "The user is asking for a tightly formatted answer from referenced context.",
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "Use the selected context only to resolve the referent.",
      "Respect the latest user's output-format constraint exactly; do not add explanation, caveats, or extra framing.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if (input.turnKind === "clarification" && previousTopicSummary) {
    return [
      `The user is replying to your clarification request: ${task}`,
      `Current topic: ${previousTopicSummary}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      hasExplicitReplyAnchor
        ? "An explicit reply anchor was selected. Treat that anchor as the user's intended referent even if the latest turn is short or deictic."
        : undefined,
      "Use this answer to continue the current topic.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if (input.turnKind === "clarification" && hasExplicitReplyAnchor) {
    return [
      `The user is clarifying a point about this referenced context: ${task}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      "An explicit reply anchor was selected. Treat that anchor as the user's intended referent even if the latest turn is short or deictic.",
      "Answer the referenced point directly from the anchored context before asking for more detail.",
      "Do not switch to generic advice or external research unless the user explicitly asked for that broader scope.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasExplicitReplyAnchor) {
    return [
      "The user is following up on a specifically referenced earlier exchange.",
      assistantFactSummary ? `Referenced assistant fact: ${assistantFactSummary}` : undefined,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
      "Do not reinterpret this as a generic troubleshooting or research request unless the user explicitly broadens the scope.",
      "Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous.",
      "Explain the referenced assistant fact directly before adding any broader caveat.",
      "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasHistoryOnlySelection) {
    return [
      "The user is following up on an earlier referenced session context, not necessarily the most recent topic.",
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "Answer from the relevant anchors directly.",
      "Do not prepend or restate the most recent topic unless one of the selected anchors actually references it.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasRecentUserAnchor && isBareNudgeTask(task)) {
    return [
      "The user sent a short nudge that refers to their immediately previous message.",
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "Answer the immediately previous user message directly.",
      "Do not switch back to an older topic unless the previous user message explicitly referenced it.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasRecentResultAnchor) {
    return [
      "The user is asking what was found in the immediately previous task.",
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "Answer from the immediately previous task/result pair and its partial tool evidence.",
      "If the previous task timed out or was cancelled, say that it did not finish, then summarize only the evidence already captured before timeout/cancellation.",
      "Do not switch to durable memory, older topic blocks, or unrelated prior tasks unless the immediate previous task/result pair is empty.",
      "Do not restart or retry the original task unless the user explicitly asks for a new action.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if (isShortAssistantFactFollowUp && assistantFactSummary) {
    return [
      "The user is following up on the latest assistant-stated fact.",
      `Referenced assistant fact: ${assistantFactSummary}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      hasExplicitReplyAnchor
        ? "An explicit reply anchor was selected. Treat that anchor as the user's intended referent even if the latest turn is short or deictic."
        : "Treat this short follow-up as referring to the referenced assistant fact even if the user uses deictic wording like “这里/这个/that one/why didn’t it connect”.",
      `Latest user turn: ${task}`,
      "Explain the referenced assistant fact directly before adding any broader caveat.",
      "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
      "If the deeper cause is unknown, say that explicitly instead of speculating.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && previousTopicSummary) {
    return [
      `Continue the current topic: ${previousTopicSummary}`,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      hasExplicitReplyAnchor
        ? "An explicit reply anchor was selected. Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous."
        : undefined,
      `Latest user turn: ${task}`,
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  if ((input.turnKind === "follow_up" || input.turnKind === "continue_active_task") && hasExplicitReplyAnchor) {
    return [
      "The user is following up on a specifically referenced earlier exchange.",
      assistantFactSummary ? `Referenced assistant fact: ${assistantFactSummary}` : undefined,
      selectedBlockSummary ? `Relevant anchors:\n${selectedBlockSummary}` : undefined,
      `Latest user turn: ${task}`,
      "An explicit reply anchor was selected. Answer the referenced point directly from the anchored context.",
      "Do not reinterpret this as a generic troubleshooting or research request unless the user explicitly broadens the scope.",
      "Do not ask what 'this/that/here' refers to unless the reply anchor itself is ambiguous.",
      "Explain the referenced assistant fact directly before adding any broader caveat.",
      "Do not claim a new action, a new success state, or a new result unless this turn produced new deterministic evidence.",
    ].filter((value): value is string => Boolean(value)).join("\n");
  }

  return task;
}

export function prepareFridayConversationTurn(
  input: PrepareFridayConversationTurnInput,
): FridayPreparedConversationTurn {
  const focusState = input.focusState ?? null;
  const filteredRecords = filterConversationRecords(input.historyRecords, input.currentUserSequence);
  const turnKind = classifyFridayConversationTurn({
    task: input.task,
    focusState,
    historyRecords: filteredRecords,
    currentUserSequence: input.currentUserSequence,
    replyToMessageId: input.replyToMessageId,
  });
  const selection = buildConversationBlockSelection({
    task: input.task,
    historyRecords: filteredRecords,
    focusState,
    turnKind,
    replyToMessageId: input.replyToMessageId,
    evidenceBlocks: input.evidenceBlocks,
  });
  const currentTopicSummary = resolvePreparedCurrentTopicSummary({
    task: input.task,
    turnKind,
    focusState,
    selectedBlocks: selection.selectedBlocks,
  });

  return {
    turnKind,
    historyMessages: selection.historyMessages,
    taskPrompt: buildTaskPrompt({
      task: input.task,
      turnKind,
      focusState,
      selectedBlocks: selection.selectedBlocks,
    }),
    previousTopicSummary: turnKind === "new_topic"
      ? focusState?.currentTopicSummary
      : currentTopicSummary,
    currentTopicSummary,
    selectedBlocks: selection.selectedBlocks,
    selectionReasons: selection.selectionReasons,
    replyAnchorMessageId: selection.replyAnchorMessageId,
    replyAnchorSequence: selection.replyAnchorSequence,
  };
}

export function finalizeFridayConversationFocus(
  input: FinalizeFridayConversationFocusInput,
): FridaySessionConversationFocusState {
  const previous = input.focusState ?? null;
  const harnessStage = input.harnessFocus === undefined
    ? previous?.lastHarnessStage
    : input.harnessFocus === null
      ? undefined
      : input.harnessFocus.stage;
  const handoffArtifactId = input.harnessFocus === undefined
    ? previous?.lastHandoffArtifactId
    : input.harnessFocus === null
      ? undefined
      : input.harnessFocus.handoffArtifactId;
  const harnessSummary = input.harnessFocus === undefined
    ? previous?.lastHarnessSummary
    : input.harnessFocus === null
      ? undefined
      : input.harnessFocus.summary;
  const topicForFocus = deriveCurrentTopicForFocus({
    task: input.task,
    turnKind: input.turnKind,
    previous,
  });
  const currentTopicSummary = topicForFocus.summary;
  const currentTopicFingerprint = topicForFocus.fingerprint;
  const currentTopicStartSequence = input.turnKind === "new_topic"
    || shouldReplaceStaleCurrentTopic({
      previousSummary: previous?.currentTopicSummary,
      task: input.task,
      turnKind: input.turnKind,
    })
    ? input.currentUserSequence
    : topicForFocus.startSequence ?? input.currentUserSequence;
  const activeSubagentIds = previous?.activeSubagentIds;
  const assistantAskedQuestion = assistantAppearsToAskQuestion(input.responseText);
  const assistantAnchorSummary = summarizeTopic(input.responseText);
  const assistantAnchorFingerprint = fingerprintTopic(input.responseText);
  const taskLedger = updateTaskLedger({
    task: input.task,
    responseText: input.responseText,
    turnKind: input.turnKind,
    previous,
    topicSummary: currentTopicSummary,
    topicFingerprint: currentTopicFingerprint,
    currentUserSequence: input.currentUserSequence,
    nowIso: input.nowIso,
  });

  return {
    currentTopicFingerprint,
    currentTopicSummary,
    currentTopicStartSequence,
    taskLedger,
    assistantAnchorSummary,
    assistantAnchorFingerprint,
    replyAnchorMessageId: input.replyAnchorMessageId,
    replyAnchorSequence: input.replyAnchorSequence,
    lastAnsweredQuestion: summarizeTopic(input.task),
    lastAssistantAskedQuestion: assistantAskedQuestion,
    lastRunId: input.turnKind === "status_check" && previous?.lastRunId
      ? previous.lastRunId
      : input.runId,
    activeRunId: previous?.activeRunId && previous.activeRunId !== input.runId
      ? previous.activeRunId
      : undefined,
    activeSubagentIds: activeSubagentIds && activeSubagentIds.length > 0 ? activeSubagentIds : undefined,
    pendingPlanRunId: input.pendingPlanRunId === null
      ? undefined
      : input.pendingPlanRunId ?? previous?.pendingPlanRunId,
    lastTurnKind: input.turnKind,
    lastHarnessStage: harnessStage,
    lastHandoffArtifactId: handoffArtifactId,
    lastHarnessSummary: harnessSummary,
    operationalMode: previous?.operationalMode,
    preModeRestore: previous?.preModeRestore,
    updatedAt: input.nowIso,
  };
}
