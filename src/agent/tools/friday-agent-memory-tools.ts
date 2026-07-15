import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type {
  FridayMemoryGuardContext,
  FridayMemoryGuardServiceFactory,
  FridayMemoryService,
} from "#memory";
import type { FridayMemoryItem, FridayMemorySearchResult } from "#memory";
import { createFridayMemoryOutputFilter } from "#memory";
import type { FridayLearningEventAppendInput } from "#ledger";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import type { FridayLearnedFactView } from "../../learning/services/friday-learned-fact-memory-view.js";
import {
  FRIDAY_LEARNED_FACT_SOURCE,
  matchesLearnedFactQuery,
  toLearnedFactSearchResult,
} from "../../learning/services/friday-learned-fact-memory-view.js";
import {
  FRIDAY_SENSITIVE_LEARNING_REJECTION,
  isFridaySensitiveLearningCandidate,
} from "../../learning/services/friday-sensitive-learning-guard.js";

// ─── Deps ───

export interface CreateFridayAgentMemoryToolsDeps {
  memoryService: FridayMemoryService;
  listLearnedFacts?: (input: { userId: string; limit: number }) => FridayLearnedFactView[];
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  idGenerator?: () => string;
  nowIso?: () => string;
  resolveSessionMemoryNamespace?: (sessionKey: string) => Promise<string | undefined>;
  /**
   * Resolve the ORDERED, DEDUPED set of session-memory namespaces to consult on
   * recall (the dual-read list). When the namespace-hardening flag is OFF (default)
   * this is a single-element list equal to `resolveSessionMemoryNamespace`, so recall
   * behavior is byte-identical to today. When ON it is `[hardened, legacy]` deduped,
   * so memory written under the legacy namespace is still recalled (no destructive
   * re-key). When absent, recall falls back to the single-namespace path.
   */
  resolveSessionMemoryNamespaceCandidates?: (sessionKey: string) => Promise<string[] | undefined>;
  memoryGuardFactory?: FridayMemoryGuardServiceFactory;
  /**
   * Optional session or run identifier used to scope the memory namespace.
   * When provided, the default namespace "agent" becomes "agent:<sessionId>"
   * so that different agent runs do not pollute each other's memory space.
   */
  sessionId?: string;
}

// ─── Namespace scoping ───

// Learned facts are appended to memory_search results AFTER being written verbatim (they
// bypass the write-time PII guard). memory_search egresses across a TRUST BOUNDARY to the
// agent, so the learned-fact result is routed through the SAME production PII output filter
// (#1607) before it reaches the tool caller — redacting content/metadata/tags/snippet. This
// applies ONLY to learned facts; stored results come from `memoryService` unchanged (out of
// scope for this fix).
const memoryLearnedFactOutputFilter = createFridayMemoryOutputFilter();

const AGENT_MEMORY_BASE_NAMESPACE = "agent";
const USER_FACING_MEMORY_NAMESPACES = new Set(["default", "user", "preference"]);
const RESERVED_MEMORY_NAMESPACE_PREFIXES = ["system", "tenant"];

function normalizeAgentMemoryScopeId(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeAgentCustomNamespaceSegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
}

function resolveAgentScopedNamespace(input: {
  scopeId: string | undefined;
  segment?: string;
}): string {
  const scopeId = normalizeAgentMemoryScopeId(input.scopeId);
  const segment = input.segment ? normalizeAgentCustomNamespaceSegment(input.segment) : "";
  const scopeSuffix = scopeId ? `:${scopeId}` : "";
  return segment.length > 0
    ? `${AGENT_MEMORY_BASE_NAMESPACE}${scopeSuffix}.${segment}`
    : `${AGENT_MEMORY_BASE_NAMESPACE}${scopeSuffix}`;
}

function isUserFacingMemoryNamespace(namespace: string | undefined): boolean {
  return typeof namespace === "string" && USER_FACING_MEMORY_NAMESPACES.has(namespace);
}

function isReservedMemoryNamespace(namespace: string): boolean {
  const normalized = normalizeAgentCustomNamespaceSegment(namespace);
  return RESERVED_MEMORY_NAMESPACE_PREFIXES.some((prefix) =>
    normalized === prefix || normalized.startsWith(`${prefix}.`) || normalized.startsWith(`${prefix}-`));
}

function resolveAgentScopedExplicitNamespace(input: {
  explicitNamespace: string;
  implicitSessionNamespace?: string;
  scopeId?: string;
}): { namespace?: string; isUserFacing: boolean; error?: string } {
  const normalized = normalizeMemoryNamespace(input.explicitNamespace);
  if (normalized === AGENT_MEMORY_BASE_NAMESPACE) {
    return {
      namespace: resolveAgentScopedNamespace({ scopeId: input.scopeId }),
      isUserFacing: false,
    };
  }
  if (isUserFacingMemoryNamespace(normalized)) {
    return {
      namespace: input.implicitSessionNamespace
        ?? resolveAgentScopedNamespace({ scopeId: input.scopeId, segment: normalized }),
      isUserFacing: true,
    };
  }
  if (isReservedMemoryNamespace(normalized)) {
    return {
      isUserFacing: false,
      error: `Memory namespace '${input.explicitNamespace}' is reserved and cannot be used by agent memory tools.`,
    };
  }
  const segment = normalizeAgentCustomNamespaceSegment(normalized);
  if (!segment) {
    return {
      isUserFacing: false,
      error: "Memory namespace is invalid.",
    };
  }
  return {
    namespace: resolveAgentScopedNamespace({ scopeId: input.scopeId, segment }),
    isUserFacing: false,
  };
}

function normalizeMemoryNamespace(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const normalized = trimmed.toLowerCase().replace(/[\s_]+/g, "-");
  if (
    normalized === "default"
    || normalized === "user"
    || normalized === "preference"
    || normalized === "agent"
  ) {
    return normalized;
  }
  if (normalized === "user-preference" || normalized === "user-preferences" || normalized === "preferences") {
    return "preference";
  }
  if (normalized === "users") {
    return "user";
  }
  if (normalized === "memory" || normalized === "memories") {
    return "default";
  }
  return trimmed;
}

function normalizePreferenceTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function sanitizeExpiresAt(raw: string | undefined, nowIso?: () => string): string | undefined {
  if (!raw) {
    return undefined;
  }
  const expiresAtMs = Date.parse(raw);
  if (!Number.isFinite(expiresAtMs)) {
    return undefined;
  }
  const nowMs = Date.parse(nowIso ? nowIso() : new Date().toISOString());
  if (Number.isFinite(nowMs) && expiresAtMs <= nowMs) {
    return undefined;
  }
  return raw;
}

const MEMORY_SEARCH_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "answer",
  "do",
  "i",
  "in",
  "is",
  "me",
  "my",
  "of",
  "one",
  "please",
  "sentence",
  "the",
  "to",
  "what",
]);

const EXPLICIT_USER_FACT_STATEMENT_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:my codename is|my code phrase is|my passphrase is|my preferred name is|my name is)\b/i,
  /\b(?:i prefer|i like|i want|i need|call me|refer to me as)\b/i,
  /(我的代号是|我的口令是|我的名字是|我叫|我的昵称是|名字叫|昵称是|我更喜欢|我喜欢|我想要|请叫我|叫我|称呼我为|以后叫我|以后称呼我为)/u,
];

function tokenizeMemorySearchText(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !MEMORY_SEARCH_STOPWORDS.has(token));
}

function normalizeMemoryContentKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

function itemBelongsToSession(item: FridayMemoryItem, sessionId: string | undefined): boolean {
  if (!sessionId) {
    return false;
  }
  const sessionTag = `session:${sessionId}`;
  return item.source === sessionTag || item.tags.includes(sessionTag);
}

function compareIsoTimestampsDescending(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) && !Number.isFinite(rightMs)) {
    return 0;
  }
  if (!Number.isFinite(leftMs)) {
    return 1;
  }
  if (!Number.isFinite(rightMs)) {
    return -1;
  }
  return rightMs - leftMs;
}

function shouldPreferMemoryCandidate(
  next: FridayMemorySearchResult,
  current: FridayMemorySearchResult,
  sessionId: string | undefined,
): boolean {
  if (next.score !== current.score) {
    return next.score > current.score;
  }
  const nextFromSession = itemBelongsToSession(next.item, sessionId);
  const currentFromSession = itemBelongsToSession(current.item, sessionId);
  if (nextFromSession !== currentFromSession) {
    return nextFromSession;
  }
  return compareIsoTimestampsDescending(next.item.updatedAt, current.item.updatedAt) < 0;
}

function applyMemoryCandidateScoreAdjustments(
  result: FridayMemorySearchResult,
  sessionId: string | undefined,
): FridayMemorySearchResult {
  let score = result.score;
  if (memoryContentLooksLikeUnknownPlaceholder(result.item.content)) {
    score -= 1.5;
  }
  if (itemBelongsToSession(result.item, sessionId)) {
    score += 0.1;
  }
  return {
    ...result,
    score,
  };
}

async function buildSessionLexicalCandidates(params: {
  deps: CreateFridayAgentMemoryToolsDeps;
  sessionId: string;
  namespace: string;
  query: string;
  limit: number;
}): Promise<FridayMemorySearchResult[]> {
  const queryTokens = tokenizeMemorySearchText(params.query);
  if (queryTokens.length === 0) {
    return [];
  }

  const items = await params.deps.memoryService.list({
    namespace: params.namespace,
    limit: Math.max(params.limit * 8, 50),
  });

  const ranked: FridayMemorySearchResult[] = [];
  for (const item of items) {
    const haystack = [
      item.content,
      item.tags.join(" "),
      item.source,
    ].join(" ").toLowerCase();
    const overlapCount = queryTokens.filter((token) => haystack.includes(token)).length;
    const fromCurrentSession = itemBelongsToSession(item, params.sessionId);
    if (overlapCount === 0) {
      continue;
    }
    const overlapScore = overlapCount / queryTokens.length;
    const sessionBoost = fromCurrentSession ? 0.85 : 0;
    ranked.push({
      item,
      score: 0.2 + overlapScore + sessionBoost,
      ftsScore: 0,
      semanticScore: 0,
      matchedBy: ["substring"],
      snippet: item.content.slice(0, 200),
    });
  }

  ranked.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    return compareIsoTimestampsDescending(left.item.updatedAt, right.item.updatedAt);
  });

  return ranked.slice(0, Math.max(params.limit * 2, params.limit));
}

function readExplicitNamespace(args: Record<string, unknown>): string | undefined {
  const rawNamespace = readStringParam(args, "namespace");
  if (!rawNamespace) {
    return undefined;
  }
  const normalized = normalizeMemoryNamespace(rawNamespace);
  return normalized.trim().length > 0 ? normalized : undefined;
}

function namespaceShouldOverlaySessionMemory(namespace: string | undefined): boolean {
  if (!namespace) {
    return false;
  }
  const normalized = normalizeMemoryNamespace(namespace);
  return normalized === "user"
    || normalized === "preference"
    || normalized === "default";
}

function resolveSessionIdFromArgs(
  args: Record<string, unknown>,
  fallback: string | undefined,
  signal: AbortSignal,
): string | undefined {
  const contextSessionKey = getFridayAgentToolExecutionContext(signal)?.sessionKey?.trim();
  if (contextSessionKey && contextSessionKey.length > 0) {
    return contextSessionKey;
  }
  const fromRuntime = args["__sessionId"];
  if (typeof fromRuntime === "string" && fromRuntime.trim().length > 0) {
    return fromRuntime;
  }
  return fallback;
}

function shouldIncludeLearnedFacts(namespace: string | undefined): boolean {
  if (!namespace) {
    return true;
  }
  const normalized = normalizeMemoryNamespace(namespace);
  return normalized === "preference"
    || normalized === "user"
    || normalized === "default"
    || normalized === "agent";
}

function shouldIncludeGuardedPrincipalMemory(namespace: string | undefined): boolean {
  if (!namespace) {
    return true;
  }
  const normalized = normalizeMemoryNamespace(namespace);
  return normalized === "preference"
    || normalized === "user"
    || normalized === "default"
    || normalized === "agent";
}

function taskPromptLooksLikeQuestion(taskPrompt: string | undefined): boolean {
  if (!taskPrompt || taskPrompt.trim().length === 0) {
    return false;
  }
  return /^\s*(?:what|which|who|can|could|would|do|did|does|is|are)\b/i.test(taskPrompt)
    || /^\s*(?:什么|哪个|谁|可以|能不能|是否|是不是)/u.test(taskPrompt)
    || taskPrompt.includes("?");
}

function taskPromptExplicitlyStatesUserFact(taskPrompt: string | undefined): boolean {
  if (!taskPrompt || taskPrompt.trim().length === 0) {
    return false;
  }
  return EXPLICIT_USER_FACT_STATEMENT_PATTERNS.some((pattern) => pattern.test(taskPrompt));
}

function memoryContentLooksLikeUnknownPlaceholder(content: string): boolean {
  return /\b(?:unknown|not specified|unspecified|not provided|currently unknown)\b/i.test(content)
    || /\b(?:not defined|undefined|user-defined)\b/i.test(content)
    || /(未知|未提供|未说明|不清楚)/u.test(content);
}

function resolvePrincipalId(
  args: Record<string, unknown>,
  signal: AbortSignal,
): string | undefined {
  const context = getFridayAgentToolExecutionContext(signal);
  const principalId = context?.principalId?.trim();
  if (principalId && principalId.length > 0) {
    return principalId;
  }
  const fromArgs = args["__principalId"];
  if (typeof fromArgs === "string" && fromArgs.trim().length > 0) {
    return fromArgs.trim();
  }
  return undefined;
}

function resolvePrincipalMemoryGuardContext(input: {
  args: Record<string, unknown>;
  signal: AbortSignal;
}): FridayMemoryGuardContext | undefined {
  const executionContext = getFridayAgentToolExecutionContext(input.signal);
  const principalId = resolvePrincipalId(input.args, input.signal);
  const hubId = normalizeAgentMemoryScopeId(executionContext?.tenantContext?.hubId);
  const userId = normalizeAgentMemoryScopeId(executionContext?.tenantContext?.userId)
    ?? principalId;
  if (!principalId || !hubId || !userId) {
    return undefined;
  }
  return {
    principalId,
    subject: {
      hubId,
      userId,
      accessLevel: "tenant",
    },
  };
}

function resolveMemoryScopeId(input: {
  sessionId: string | undefined;
  principalId: string | undefined;
}): string | undefined {
  return normalizeAgentMemoryScopeId(input.sessionId)
    ?? normalizeAgentMemoryScopeId(input.principalId);
}

/**
 * Resolve the dual-read candidate namespaces for recall. Returns the ORDERED,
 * DEDUPED list (primary/hardened first, legacy after) — or `[]` when no session
 * namespace applies. Prefers `resolveSessionMemoryNamespaceCandidates` (the dual-read
 * dep); falls back to the single-namespace `resolveSessionMemoryNamespace` for
 * callers that only wired the older dep (then the list has at most one entry, exactly
 * the pre-dual-read behavior).
 */
async function resolveImplicitSessionNamespaceCandidates(params: {
  deps: CreateFridayAgentMemoryToolsDeps;
  explicitNamespace: string | undefined;
  sessionId: string | undefined;
}): Promise<string[]> {
  if (
    (params.explicitNamespace && !namespaceShouldOverlaySessionMemory(params.explicitNamespace))
    || !params.sessionId
  ) {
    return [];
  }
  try {
    if (params.deps.resolveSessionMemoryNamespaceCandidates) {
      const candidates = await params.deps.resolveSessionMemoryNamespaceCandidates(params.sessionId);
      const cleaned = (candidates ?? [])
        .filter((ns): ns is string => typeof ns === "string" && ns.trim().length > 0)
        .map((ns) => ns.trim());
      // Dedup defensively (the dep already dedups, but a stale persisted-namespace
      // tail could repeat the primary).
      return [...new Set(cleaned)];
    }
    if (params.deps.resolveSessionMemoryNamespace) {
      const namespace = await params.deps.resolveSessionMemoryNamespace(params.sessionId);
      return typeof namespace === "string" && namespace.trim().length > 0 ? [namespace.trim()] : [];
    }
    return [];
  } catch {
    return [];
  }
}

async function resolveImplicitSessionNamespace(params: {
  deps: CreateFridayAgentMemoryToolsDeps;
  explicitNamespace: string | undefined;
  sessionId: string | undefined;
}): Promise<string | undefined> {
  // The PRIMARY session namespace is the FIRST dual-read candidate (hardened-when-on,
  // legacy-when-off) — keeping this single value consistent with the candidate list.
  const candidates = await resolveImplicitSessionNamespaceCandidates(params);
  return candidates[0];
}

/**
 * Search each legacy/stale session namespace (the dual-read candidate TAIL) and flatten the
 * union. `memoryService.search` stays single-namespace per call — the dedup happens at the
 * caller. Empty `namespaces` ⇒ no query (the common flag-off / no-dotted-segment case).
 */
async function searchLegacyDualReadNamespaces(params: {
  deps: CreateFridayAgentMemoryToolsDeps;
  query: string;
  agentNamespace: string;
  namespaces: string[];
  limit: number;
}): Promise<FridayMemorySearchResult[]> {
  if (params.namespaces.length === 0) {
    return [];
  }
  const perNamespace = await Promise.all(
    params.namespaces.map((ns) =>
      params.deps.memoryService.search(params.query, {
        namespace: [params.agentNamespace, ns],
        limit: Math.max(params.limit * 2, params.limit),
      }),
    ),
  );
  return perNamespace.flat();
}

function extractStoredPreferenceValue(input: {
  content: string;
  taskPrompt?: string;
}): string | null {
  const candidates = [input.taskPrompt, input.content].filter((value): value is string => Boolean(value?.trim()));
  const patterns = [
    /\bcall me\s+["']?([^"'!?.,\n]+)["']?/i,
    /\bwhat should you call me\??\s*["']?([^"'!?.,\n]+)["']?/i,
    /\bmy name is\s+["']?([^"'!?.,\n]+)["']?/i,
    /\brefer to me as\s+["']?([^"'!?.,\n]+)["']?/i,
    /(叫我|称呼我为|把我叫做|被称为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
    /(我的名字是|我叫|我的昵称是|名字叫|昵称是|以后叫我|以后称呼我为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
  ] as const;

  for (const candidate of candidates) {
    for (const pattern of patterns) {
      const match = candidate.match(pattern);
      const rawValue = match?.[2] ?? match?.[1];
      if (typeof rawValue === "string" && rawValue.trim().length > 0) {
        return rawValue.trim();
      }
    }

    const quotedValue = candidate.match(/["“]([^"”\n]+)["”]/u)?.[1];
    if (typeof quotedValue === "string" && quotedValue.trim().length > 0) {
      return quotedValue.trim();
    }
  }

  return null;
}

function maybeMirrorStoredPreference(params: {
  args: Record<string, unknown>;
  deps: CreateFridayAgentMemoryToolsDeps;
  signal: AbortSignal;
  tags: string[];
  content: string;
}): void {
  if (!params.deps.learningEventWriter || !params.deps.idGenerator || !params.deps.nowIso) {
    return;
  }

  const principalId = resolvePrincipalId(params.args, params.signal);
  if (!principalId) {
    return;
  }

  const normalizedTags = params.tags.map((tag) => normalizePreferenceTag(tag));
  const looksLikeNamePreference = normalizedTags.includes("name")
    || normalizedTags.includes("user_preference")
    || /(?:call me|what should you call me|叫我|称呼我为|把我叫做|被称为)/iu.test(params.content);
  if (!looksLikeNamePreference) {
    return;
  }

  const executionContext = getFridayAgentToolExecutionContext(params.signal);
  const value = extractStoredPreferenceValue({
    content: params.content,
    taskPrompt: executionContext?.taskPrompt,
  });
  if (!value) {
    return;
  }

  params.deps.learningEventWriter([
    {
      eventId: params.deps.idGenerator(),
      ts: params.deps.nowIso(),
      userId: principalId,
      runId: executionContext?.runId,
      kind: "user_correction",
      payload: {
        feedbackKind: "preference",
        correctedField: "user_name",
        newValue: value,
        field: "user_name",
        value,
        context: params.content,
      },
    },
  ]);
}

// ─── Factory ───

export function createFridayAgentMemoryTools(
  deps: CreateFridayAgentMemoryToolsDeps,
): FridayAgentToolDefinition[] {
  return [
    createMemorySearchTool(deps),
    createMemoryStoreTool(deps),
  ];
}

// ─── memory_search ───

function createMemorySearchTool(
  deps: CreateFridayAgentMemoryToolsDeps,
): FridayAgentToolDefinition {
  return {
    name: "memory_search",
    description:
      "Search Friday's memory for relevant information. Returns matching items ranked by relevance.",
    parameters: {
      properties: {
        query: { type: "string", description: "Search query text" },
        namespace: { type: "string", description: "Optional namespace to scope search" },
        limit: { type: "number", description: "Maximum number of results (default 10)" },
      },
      required: ["query"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const sessionId = resolveSessionIdFromArgs(args, deps.sessionId, signal);
      const principalId = resolvePrincipalId(args, signal);
      const scopeId = resolveMemoryScopeId({ sessionId, principalId });
      const query = readStringParam(args, "query", { required: true });
      const explicitNamespace = readExplicitNamespace(args);
      // Dual-read: the ORDERED, DEDUPED session-namespace candidates. When the
      // hardening flag is OFF (default) this is a single entry (== the legacy
      // namespace), so everything below behaves byte-identically to today. When ON
      // it is `[hardened, legacy]` and we ALSO search the legacy tail so memory
      // written before the flip is still recalled (no destructive re-key).
      const implicitSessionNamespaceCandidates = await resolveImplicitSessionNamespaceCandidates({
        deps,
        explicitNamespace,
        sessionId,
      });
      const implicitSessionNamespace = implicitSessionNamespaceCandidates[0];
      // The dual-read TAIL (legacy + any stale persisted namespace). Empty in the
      // common (flag-off, or no-dotted-segment) case — so this adds ZERO extra queries
      // unless a real legacy bucket exists.
      const legacyDualReadNamespaces = implicitSessionNamespaceCandidates.slice(1);
      const limit = readNumberParam(args, "limit", { integer: true }) ?? 10;
      const agentNamespace = resolveAgentScopedNamespace({ scopeId });
      const explicitResolution = explicitNamespace
        ? resolveAgentScopedExplicitNamespace({
          explicitNamespace,
          implicitSessionNamespace,
          scopeId,
        })
        : undefined;
      if (explicitResolution?.error) {
        return errorResult(`Memory search rejected: ${explicitResolution.error}`);
      }
      const scopedNamespace = explicitResolution?.namespace
        ?? (implicitSessionNamespace ? [agentNamespace, implicitSessionNamespace] : agentNamespace);

      try {
        const scopedResults = await deps.memoryService.search(query, {
          namespace: scopedNamespace,
          limit: implicitSessionNamespace ? Math.max(limit * 2, limit) : limit,
        });
        // DUAL-READ union: search each legacy/stale session namespace (the candidate
        // tail) so memory written under the pre-hardening namespace is still recalled.
        // `memoryService.search` stays SINGLE-namespace per call — the union + dedup is
        // done here at the consumer. Empty list ⇒ no extra search (flag-off / no dotted
        // segment), so this is a no-op for the common case.
        const legacyDualReadResults = await searchLegacyDualReadNamespaces({
          deps,
          query,
          agentNamespace,
          namespaces: legacyDualReadNamespaces,
          limit,
        });
        const memoryGuardFactory = deps.memoryGuardFactory;
        const guardedContext = memoryGuardFactory && shouldIncludeGuardedPrincipalMemory(explicitNamespace)
          ? resolvePrincipalMemoryGuardContext({ args, signal })
          : undefined;
        const guardedResults = guardedContext && memoryGuardFactory
          ? await memoryGuardFactory.forContext(guardedContext).search(query, {
            limit: Math.max(limit * 2, limit),
          })
          : [];
        const shouldUseSessionFallback =
          Boolean(implicitSessionNamespace && sessionId)
          && (
            !explicitNamespace
            || namespaceShouldOverlaySessionMemory(explicitNamespace)
            || scopedResults.length === 0
          );
        // Lexical fallback over ALL session-namespace candidates (primary + legacy tail),
        // so legacy session memory is lexically scanned too under flag-on — not just the
        // hardened primary. With one candidate (flag-off / no dotted segment) this is the
        // single-namespace scan of before.
        const sessionLexicalCandidates =
          shouldUseSessionFallback && implicitSessionNamespace && sessionId
            ? (await Promise.all(
                implicitSessionNamespaceCandidates.map((ns) =>
                  buildSessionLexicalCandidates({
                    deps,
                    sessionId,
                    namespace: ns,
                    query,
                    limit,
                  }),
                ),
              )).flat()
            : [];
        const dedupedResults = (() => {
          const merged = [
            ...scopedResults,
            ...legacyDualReadResults,
            ...guardedResults,
            ...sessionLexicalCandidates,
          ];
          const directlySearchedIds = new Set(
            [...scopedResults, ...legacyDualReadResults, ...guardedResults].map(
              (candidate) => candidate.item.id,
            ),
          );
          const seen = new Set<string>();
          const itemsByContent = new Map<string, FridayMemorySearchResult>();
          for (const result of merged) {
            if (seen.has(result.item.id)) {
              continue;
            }
            seen.add(result.item.id);
            const boostedResult = directlySearchedIds.has(result.item.id)
              ? { ...result, score: result.score + 1 }
              : result;
            const adjustedResult = applyMemoryCandidateScoreAdjustments(boostedResult, sessionId);
            const contentKey = normalizeMemoryContentKey(boostedResult.item.content);
            const existing = itemsByContent.get(contentKey);
            if (!existing || shouldPreferMemoryCandidate(adjustedResult, existing, sessionId)) {
              itemsByContent.set(contentKey, adjustedResult);
            }
          }
          return [...itemsByContent.values()];
        })();
        const learnedResults = principalId && deps.listLearnedFacts && shouldIncludeLearnedFacts(explicitNamespace)
          ? deps.listLearnedFacts({ userId: principalId, limit })
            .filter((fact) => matchesLearnedFactQuery(fact, query))
            // Egress PII filter across the agent trust boundary (learned facts only).
            .map((fact) => memoryLearnedFactOutputFilter.filterSearchResult(toLearnedFactSearchResult(fact, query)))
          : [];
        const combined = [...dedupedResults, ...learnedResults]
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        const mapped = combined.map((r) => ({
          content: r.item.content,
          score: r.score,
          metadata: {
            id: r.item.id,
            namespace: r.item.namespace,
            tags: r.item.tags,
            source: r.item.source,
            createdAt: r.item.createdAt,
            ...(r.item.source === FRIDAY_LEARNED_FACT_SOURCE
              ? {
                trustLevel: r.item.metadata.trustLevel,
                memoryBoundary: r.item.metadata.memoryBoundary,
                evidenceBoundary: r.item.metadata.evidenceBoundary,
                contextUseBoundary: r.item.metadata.contextUseBoundary,
                promptInjectionBoundary: r.item.metadata.promptInjectionBoundary,
                reviewBoundary: r.item.metadata.reviewBoundary,
                revocationBoundary: r.item.metadata.revocationBoundary,
              }
              : {}),
          },
        }));

        return jsonResult(mapped);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Memory search failed: ${message}`);
      }
    },
  };
}

// ─── memory_store ───

function createMemoryStoreTool(
  deps: CreateFridayAgentMemoryToolsDeps,
): FridayAgentToolDefinition {
  return {
    name: "memory_store",
    description:
      "Store information in Friday's memory for later retrieval.",
    parameters: {
      properties: {
        content: { type: "string", description: "Content to store" },
        namespace: { type: "string", description: "Namespace to store in (default 'agent')" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for categorization",
        },
        expiresAt: { type: "string", description: "ISO 8601 expiration timestamp" },
      },
      required: ["content"],
    },
    async execute(
      args: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const sessionId = resolveSessionIdFromArgs(args, deps.sessionId, signal);
      const principalId = resolvePrincipalId(args, signal);
      const scopeId = resolveMemoryScopeId({ sessionId, principalId });
      const content = readStringParam(args, "content", { required: true });
      const explicitNamespace = readExplicitNamespace(args);
      const implicitSessionNamespace = await resolveImplicitSessionNamespace({
        deps,
        explicitNamespace,
        sessionId,
      });
      const explicitResolution = explicitNamespace
        ? resolveAgentScopedExplicitNamespace({
          explicitNamespace,
          implicitSessionNamespace,
          scopeId,
        })
        : undefined;
      if (explicitResolution?.error) {
        return errorResult(`Memory store rejected: ${explicitResolution.error}`);
      }
      const namespace = explicitResolution?.namespace ?? resolveAgentScopedNamespace({ scopeId });
      const expiresAt = sanitizeExpiresAt(readStringParam(args, "expiresAt"), deps.nowIso);

      const rawTags = args["tags"];
      const tags: string[] =
        Array.isArray(rawTags)
          ? rawTags.filter((t): t is string => typeof t === "string")
          : [];
      const executionContext = getFridayAgentToolExecutionContext(signal);

      if (isFridaySensitiveLearningCandidate(content, tags, executionContext?.taskPrompt)) {
        return errorResult(`Memory store rejected: ${FRIDAY_SENSITIVE_LEARNING_REJECTION}`);
      }

      const storingUserFacingMemory =
        explicitResolution?.isUserFacing === true
        || tags.some((tag) => normalizePreferenceTag(tag) === "preference");

      if (
        storingUserFacingMemory
        && !taskPromptExplicitlyStatesUserFact(executionContext?.taskPrompt)
      ) {
        return errorResult(
          "Memory store rejected: do not persist user memory unless the current user message explicitly states that fact or preference.",
        );
      }

      if (
        storingUserFacingMemory
        && taskPromptLooksLikeQuestion(executionContext?.taskPrompt)
        && memoryContentLooksLikeUnknownPlaceholder(content)
      ) {
        return errorResult(
          "Memory store rejected: do not persist unknown placeholder facts for user memory from a question-only prompt.",
        );
      }

      try {
        // source is always "agent" to label the origin of stored items
        const item = await deps.memoryService.store(namespace, content, {
          source: "agent",
          tags,
          expiresAt,
        });
        maybeMirrorStoredPreference({
          args,
          deps,
          signal,
          tags,
          content,
        });

        return jsonResult({
          itemId: item.id,
          stored: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResult(`Memory store failed: ${message}`);
      }
    },
  };
}
