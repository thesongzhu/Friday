/**
 * Compaction Context Loader: retrieves persisted compaction summaries for the
 * current session and formats them into an explicit prompt fragment.
 *
 * This is the readback half of the compaction loop: summaries written to
 * memory can now re-enter subsequent runs through a dedicated path instead of
 * piggybacking on learned-preference injection.
 */

import type { FridayMemoryService } from "../../memory/services/friday-memory-service.types.js";
import { formatCompactionContextForPrompt, groupCompactionMemoryItems } from "./friday-agent-compaction-context-formatter.js";

const COMPACTION_NAMESPACES = [
  "compaction.decisions",
  "compaction.todos",
  "compaction.failures",
  "compaction.files",
  "compaction.questions",
  "compaction.summary",
] as const;

export interface FridayCompactionContextLoadResult {
  fragment: string;
  blockCount: number;
  sources: string[];
  sessionKey?: string;
}

export interface FridayCompactionContextLoader {
  loadContext(input: { sessionKey?: string }): Promise<FridayCompactionContextLoadResult>;
}

export interface CreateFridayCompactionContextLoaderDeps {
  memoryService: FridayMemoryService;
}

export function createFridayCompactionContextLoader(
  deps: CreateFridayCompactionContextLoaderDeps,
): FridayCompactionContextLoader {
  const { memoryService } = deps;

  return {
    async loadContext(input) {
      const sessionKey = input.sessionKey?.trim();
      if (!sessionKey) {
        return { fragment: "", blockCount: 0, sources: [] };
      }

      const memoryItems = await memoryService.list({
        namespace: [...COMPACTION_NAMESPACES],
        tagsAny: [sessionKey],
        limit: 40,
      });
      const scopedItems = memoryItems.filter((item) => {
        const tags = item.tags ?? [];
        return tags.includes(sessionKey) || item.source?.startsWith(`compaction:${sessionKey}:`) === true;
      });
      const blocks = groupCompactionMemoryItems(scopedItems);
      const fragment = formatCompactionContextForPrompt(blocks);

      return {
        fragment,
        blockCount: blocks.length,
        sources: [...new Set(scopedItems.map((item) => item.source).filter((value): value is string => typeof value === "string"))],
        sessionKey,
      };
    },
  };
}
