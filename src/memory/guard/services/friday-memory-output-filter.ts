import type { FridayMemoryItem, FridayMemorySearchResult } from "../../model/friday-memory.types.js";
import type { FridayMemoryGuardOutputFilter } from "../model/friday-memory-guard.types.js";
import { createFridayMemoryPiiGuard } from "./friday-memory-pii-guard.js";

import {
  FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS,
  FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS,
} from "../friday-memory-guard.constants.js";

const piiRedactor = createFridayMemoryPiiGuard("redact");

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function redactAndTruncate(value: string, maxChars: number): string {
  return truncateString(piiRedactor.scanAndTransform(value).transformedContent, maxChars);
}

// Redact PII from the metadata object and tag array on read-back (defense in depth: items
// stored before metadata/tag redaction existed must not leak PII when returned).
function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return piiRedactor.redactDeep(metadata).value as Record<string, unknown>;
}
function redactTags(tags: string[]): string[] {
  return piiRedactor.redactDeep(tags).value as string[];
}

export function createFridayMemoryOutputFilter(): FridayMemoryGuardOutputFilter {
  return {
    filterItem(item: FridayMemoryItem): FridayMemoryItem {
      return {
        ...item,
        content: redactAndTruncate(item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
        metadata: redactMetadata(item.metadata),
        tags: redactTags(item.tags),
      };
    },

    filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[] {
      const capped = results.slice(0, FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS);
      return capped.map((result) => ({
        ...result,
        item: {
          ...result.item,
          content: redactAndTruncate(result.item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
          metadata: redactMetadata(result.item.metadata),
          tags: redactTags(result.item.tags),
        },
        snippet: redactAndTruncate(result.snippet, FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS),
      }));
    },
  };
}
