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

// Strip PII from metadata + tags on read-back (defense in depth: items stored before
// metadata/tag PII handling existed must not leak PII when returned). Metadata values are
// free-form, so PII is redacted in place; a tag whose content is PII is dropped (a
// "[EMAIL]"-style marker would not be a valid tag), mirroring the store path.
function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return piiRedactor.redactDeep(metadata).value as Record<string, unknown>;
}
function dropPiiTags(tags: string[]): string[] {
  return tags.filter((tag) => piiRedactor.scanAndTransform(tag).matches.length === 0);
}

function filterItemImpl(item: FridayMemoryItem): FridayMemoryItem {
  return {
    ...item,
    content: redactAndTruncate(item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
    metadata: redactMetadata(item.metadata),
    tags: dropPiiTags(item.tags),
  };
}

function filterSearchResultImpl(result: FridayMemorySearchResult): FridayMemorySearchResult {
  return {
    ...result,
    item: filterItemImpl(result.item),
    snippet: redactAndTruncate(result.snippet, FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS),
  };
}

export function createFridayMemoryOutputFilter(): FridayMemoryGuardOutputFilter {
  return {
    filterItem: filterItemImpl,
    filterSearchResult: filterSearchResultImpl,
    filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[] {
      return results
        .slice(0, FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS)
        .map(filterSearchResultImpl);
    },
  };
}
