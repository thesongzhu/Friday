import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayMemoryService } from "#memory";
import type { FridayLearningEventAppendInput } from "#ledger";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";
import { getFridayAgentToolExecutionContext } from "../runtime/friday-agent-tool-execution-context.js";
import type { FridayLearnedFactView } from "../../learning/services/friday-learned-fact-memory-view.js";
import { matchesLearnedFactQuery, toLearnedFactSearchResult } from "../../learning/services/friday-learned-fact-memory-view.js";

// ─── Deps ───

export interface CreateFridayAgentMemoryToolsDeps {
  memoryService: FridayMemoryService;
  listLearnedFacts?: (input: { userId: string; limit: number }) => FridayLearnedFactView[];
  learningEventWriter?: (events: FridayLearningEventAppendInput[]) => void;
  idGenerator?: () => string;
  nowIso?: () => string;
  /**
   * Optional session or run identifier used to scope the memory namespace.
   * When provided, the default namespace "agent" becomes "agent:<sessionId>"
   * so that different agent runs do not pollute each other's memory space.
   */
  sessionId?: string;
}

// ─── Namespace scoping ───

/**
 * Returns the namespace for memory operations.
 *
 * For user-facing namespaces ("default", "user", "preference"), we do NOT
 * scope by sessionId so that memories are accessible across sessions and
 * subagents. Only internal/agent namespaces get session-scoped to prevent
 * pollution between concurrent runs.
 */
function scopedNamespace(raw: string, sessionId: string | undefined): string {
  const normalized = normalizeMemoryNamespace(raw);
  // User-facing namespaces should be globally accessible, not session-scoped
  const userFacingNamespaces = new Set(["default", "user", "preference", "system"]);
  if (userFacingNamespaces.has(normalized)) return normalized;
  if (!sessionId) return normalized;
  return `${normalized}:${sessionId}`;
}

function normalizeMemoryNamespace(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }
  const normalized = trimmed.toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "user-preference" || normalized === "user-preferences" || normalized === "preferences") {
    return "preference";
  }
  if (normalized === "users") {
    return "user";
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

function readExplicitNamespace(args: Record<string, unknown>): string | undefined {
  const rawNamespace = readStringParam(args, "namespace");
  if (!rawNamespace) {
    return undefined;
  }
  const normalized = normalizeMemoryNamespace(rawNamespace);
  return normalized.trim().length > 0 ? normalized : undefined;
}

function resolveSessionIdFromArgs(
  args: Record<string, unknown>,
  fallback: string | undefined,
): string | undefined {
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

function resolvePrincipalId(
  args: Record<string, unknown>,
  signal: AbortSignal,
): string | undefined {
  const fromArgs = args["__principalId"];
  if (typeof fromArgs === "string" && fromArgs.trim().length > 0) {
    return fromArgs.trim();
  }
  const context = getFridayAgentToolExecutionContext(signal);
  const principalId = context?.principalId?.trim();
  return principalId && principalId.length > 0 ? principalId : undefined;
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
    /(叫我|称呼我为|把我叫做|被称为)\s*["“]?([^"”'。！？!,，\n]+)["”']?/u,
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
      const sessionId = resolveSessionIdFromArgs(args, deps.sessionId);
      const principalId = resolvePrincipalId(args, signal);
      const query = readStringParam(args, "query", { required: true });
      const explicitNamespace = readExplicitNamespace(args);
      const limit = readNumberParam(args, "limit", { integer: true }) ?? 10;

      try {
        const results = await deps.memoryService.search(query, {
          namespace: explicitNamespace,
          limit,
        });
        const learnedResults = principalId && deps.listLearnedFacts && shouldIncludeLearnedFacts(explicitNamespace)
          ? deps.listLearnedFacts({ userId: principalId, limit })
            .filter((fact) => matchesLearnedFactQuery(fact, query))
            .map((fact) => toLearnedFactSearchResult(fact, query))
          : [];
        const combined = [...results, ...learnedResults]
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
      const sessionId = resolveSessionIdFromArgs(args, deps.sessionId);
      const content = readStringParam(args, "content", { required: true });
      const explicitNamespace = readExplicitNamespace(args);
      const namespace = explicitNamespace ?? scopedNamespace("agent", sessionId);
      const expiresAt = sanitizeExpiresAt(readStringParam(args, "expiresAt"), deps.nowIso);

      const rawTags = args["tags"];
      const tags: string[] =
        Array.isArray(rawTags)
          ? rawTags.filter((t): t is string => typeof t === "string")
          : [];

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
