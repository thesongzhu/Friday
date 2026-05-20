import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";

export interface FridayLearnedFactView {
  key: string;
  value: unknown;
  confidence: number;
  evidenceCount: number;
  lastConfirmedAt: string;
}

export const FRIDAY_LEARNED_FACT_ID_PREFIX = "learned-fact:";
export const FRIDAY_LEARNED_FACT_NAMESPACE = "preference";
export const FRIDAY_LEARNED_FACT_SOURCE = "learned_fact";
export const FRIDAY_LEARNED_FACT_TRUST_LEVEL = "confidence_scored_learning";
export const FRIDAY_LEARNED_FACT_MEMORY_BOUNDARY = "separate_from_durable_memory";
export const FRIDAY_LEARNED_FACT_EVIDENCE_BOUNDARY = "preference_fact_evidence";
export const FRIDAY_LEARNED_FACT_CONTEXT_USE_BOUNDARY = "learning_context_service_gated";
export const FRIDAY_LEARNED_FACT_PROMPT_INJECTION_BOUNDARY = "not_direct_prompt_injection";
export const FRIDAY_LEARNED_FACT_REVIEW_BOUNDARY = "not_review_center_confirmed";
export const FRIDAY_LEARNED_FACT_REVOCATION_BOUNDARY = "clear_delete_or_synthetic_memory_delete";

function stringifyLearnedFactValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? encoded : String(value);
  } catch {
    return String(value);
  }
}

const LEARNED_FACT_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "do",
  "i",
  "is",
  "me",
  "my",
  "please",
  "should",
  "the",
  "to",
  "what",
  "you",
  "your",
]);

function normalizeLearnedFactText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, "\"")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function tokenizeLearnedFactText(text: string): string[] {
  const normalized = normalizeLearnedFactText(text);
  if (normalized.length === 0) {
    return [];
  }
  return normalized
    .split(/[^a-z0-9\u4e00-\u9fff]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !LEARNED_FACT_QUERY_STOPWORDS.has(token));
}

function buildLearnedFactAliasText(key: string): string {
  const normalizedKey = key.toLowerCase().replace(/[:_]+/g, " ");
  const aliases = [normalizedKey];

  if (/(^|[:_])display[_:]name$|(^|[:_])name$/.test(key.toLowerCase())) {
    aliases.push(
      "name nickname preferred name preference preferred call me what should you call me what should i call you what to call user",
      "名字 昵称 称呼 叫我 我的名字 我叫什么名字 我的名字是什么 你应该叫我什么 你该怎么称呼我 怎么称呼我 用户名字 用户昵称",
    );
  }
  if (/favorite[_:]color|colour/.test(key.toLowerCase())) {
    aliases.push("favorite color favourite colour color");
  }

  return aliases.join(" ");
}

export function createLearnedFactSyntheticId(key: string): string {
  return `${FRIDAY_LEARNED_FACT_ID_PREFIX}${key}`;
}

export function isLearnedFactSyntheticId(id: string): boolean {
  return id.startsWith(FRIDAY_LEARNED_FACT_ID_PREFIX);
}

export function readLearnedFactKeyFromSyntheticId(id: string): string | null {
  if (!isLearnedFactSyntheticId(id)) {
    return null;
  }
  const key = id.slice(FRIDAY_LEARNED_FACT_ID_PREFIX.length).trim();
  return key.length > 0 ? key : null;
}

export function toLearnedFactMemoryItem(fact: FridayLearnedFactView): FridayMemoryItem {
  return {
    id: createLearnedFactSyntheticId(fact.key),
    namespace: FRIDAY_LEARNED_FACT_NAMESPACE,
    key: fact.key,
    content: stringifyLearnedFactValue(fact.value),
    source: FRIDAY_LEARNED_FACT_SOURCE,
    tags: ["learned", "preference_fact"],
    metadata: {
      learnedFact: true,
      trustLevel: FRIDAY_LEARNED_FACT_TRUST_LEVEL,
      memoryBoundary: FRIDAY_LEARNED_FACT_MEMORY_BOUNDARY,
      evidenceBoundary: FRIDAY_LEARNED_FACT_EVIDENCE_BOUNDARY,
      contextUseBoundary: FRIDAY_LEARNED_FACT_CONTEXT_USE_BOUNDARY,
      promptInjectionBoundary: FRIDAY_LEARNED_FACT_PROMPT_INJECTION_BOUNDARY,
      reviewBoundary: FRIDAY_LEARNED_FACT_REVIEW_BOUNDARY,
      revocationBoundary: FRIDAY_LEARNED_FACT_REVOCATION_BOUNDARY,
      evidenceCount: fact.evidenceCount,
      lastConfirmedAt: fact.lastConfirmedAt,
    },
    confidence: fact.confidence,
    createdAt: fact.lastConfirmedAt,
    updatedAt: fact.lastConfirmedAt,
  };
}

export function matchesLearnedFactQuery(fact: FridayLearnedFactView, query: string): boolean {
  const needle = normalizeLearnedFactText(query);
  if (!needle) {
    return true;
  }
  const haystack = normalizeLearnedFactText(
    `${fact.key}\n${buildLearnedFactAliasText(fact.key)}\n${stringifyLearnedFactValue(fact.value)}`,
  );
  if (haystack.includes(needle)) {
    return true;
  }

  const queryTokens = tokenizeLearnedFactText(query);
  if (queryTokens.length === 0) {
    return false;
  }
  const haystackTokens = new Set(tokenizeLearnedFactText(haystack));
  let overlap = 0;
  for (const token of queryTokens) {
    if (haystackTokens.has(token)) {
      overlap += 1;
    }
  }
  if (queryTokens.length === 1) {
    return overlap === 1;
  }
  const requiredOverlap = Math.min(queryTokens.length, Math.max(2, Math.ceil(queryTokens.length * 0.6)));
  return overlap >= requiredOverlap;
}

export function toLearnedFactSearchResult(
  fact: FridayLearnedFactView,
  query: string,
): FridayMemorySearchResult {
  const item = toLearnedFactMemoryItem(fact);
  const snippet = item.content.length > 160 ? `${item.content.slice(0, 157)}...` : item.content;
  const score = Math.min(0.99, 0.7 + Math.max(0, Math.min(0.25, fact.confidence * 0.25)));
  return {
    item,
    score,
    ftsScore: 0,
    semanticScore: 0,
    matchedBy: matchesLearnedFactQuery(fact, query) ? ["substring"] : [],
    snippet,
  };
}
