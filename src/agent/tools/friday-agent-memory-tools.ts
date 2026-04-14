import type { FridayAgentToolDefinition, FridayAgentToolResult } from "../model/friday-agent.types.js";
import type { FridayMemoryService } from "#memory";
import {
  errorResult,
  jsonResult,
  readNumberParam,
  readStringParam,
} from "./friday-agent-tool-helpers.js";

// ─── Deps ───

export interface CreateFridayAgentMemoryToolsDeps {
  memoryService: FridayMemoryService;
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
  // User-facing namespaces should be globally accessible, not session-scoped
  const userFacingNamespaces = new Set(["default", "user", "preference", "system"]);
  if (userFacingNamespaces.has(raw)) return raw;
  if (!sessionId) return raw;
  return `${raw}:${sessionId}`;
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
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const sessionId = resolveSessionIdFromArgs(args, deps.sessionId);
      const query = readStringParam(args, "query", { required: true });
      const rawNamespace = readStringParam(args, "namespace");
      const limit = readNumberParam(args, "limit", { integer: true }) ?? 10;

      try {
        const results = await deps.memoryService.search(query, {
          namespace: rawNamespace
            ? scopedNamespace(rawNamespace, sessionId)
            : undefined,
          limit,
        });

        const mapped = results.map((r) => ({
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
      _signal: AbortSignal,
    ): Promise<FridayAgentToolResult> {
      const sessionId = resolveSessionIdFromArgs(args, deps.sessionId);
      const content = readStringParam(args, "content", { required: true });
      const rawNamespace = readStringParam(args, "namespace") ?? "agent";
      const namespace = scopedNamespace(rawNamespace, sessionId);
      const expiresAt = readStringParam(args, "expiresAt");

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
