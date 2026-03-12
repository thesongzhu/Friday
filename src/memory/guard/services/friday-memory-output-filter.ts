import type { FridayMemoryItem, FridayMemorySearchResult } from "../../model/friday-memory.types.js";
import type { FridayMemoryGuardOutputFilter } from "../model/friday-memory-guard.types.js";

import {
  FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
} from "../friday-memory-guard.constants.js";

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

export function createFridayMemoryOutputFilter(): FridayMemoryGuardOutputFilter {
  return {
    filterItem(item: FridayMemoryItem): FridayMemoryItem {
      return {
        ...item,
        content: truncateString(item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
      };
    },

    filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[] {
      const capped = results.slice(0, FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS);
      return capped.map((result) => ({
        ...result,
        item: {
          ...result.item,
          content: truncateString(result.item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
        },
        snippet: truncateString(result.snippet, FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS),
      }));
    },
  };
}
