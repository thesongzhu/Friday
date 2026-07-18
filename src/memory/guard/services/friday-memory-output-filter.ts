import type { FridayMemoryItem, FridayMemorySearchResult } from "../../model/friday-memory.types.js";
import type { FridayMemoryGuardOutputFilter } from "../model/friday-memory-guard.types.js";
import { createFridayMemoryPiiGuard } from "./friday-memory-pii-guard.js";
// SEC-EVENT-REDACTION-001 (round-14 / round-16): the SAME canonical secret-shape detector the shared
// guard's value/key legs compose — reused, NOT re-copied — so a secret-shaped TAG is dropped on egress
// exactly as a PII-bearing tag is (a "[REDACTED_SECRET]" marker is not a valid constrained-charset tag).
// round-16: the tag-drop decision composes the SAME raw ∪ Unicode-de-obfuscated secret detection the
// value leg (`redactSecretAndPiiValueString`) uses, so a secret hidden behind a zero-width splice /
// full-width form / combining mark in a TAG is dropped too (it survived the raw-only check before).
import { findSecretShapeSpans } from "../../../security/friday-secret-shape-redactor.js";
import { buildUnicodeDetectionCopy } from "../../../security/friday-unicode-pii-normalizer.js";

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

// Strip PII + secrets from metadata + tags on read-back (defense in depth: items stored before
// metadata/tag sensitive-value handling existed must not leak when returned). Metadata values are
// free-form, so PII AND secret shapes are redacted in place by the shared `redactDeep` (its round-14
// string-VALUE leg now composes the canonical secret detector with PII); a tag whose content is PII
// OR a secret shape is dropped (a "[EMAIL]" / "[REDACTED_SECRET]" marker would not be a valid tag),
// mirroring the store path's drop-and-surface handling.
function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return piiRedactor.redactDeep(metadata).value as Record<string, unknown>;
}
// A tag is a secret in RAW form, OR de-obfuscates to a secret through the shared Unicode detection copy
// (NFKD → strip combining marks / Cf → fold Nd digits) — the SAME `buildUnicodeDetectionCopy` primitive
// the value/key legs use. Running the canonical `findSecretShapeSpans` detector over BOTH forms mirrors
// the value leg's raw ∪ Unicode secret composition, so a `s<U+200B>k-…` / full-width `ｓｋ－…` / combining
// `sk-á…` secret TAG is caught. A pure-ASCII benign tag folds to itself (`changed === false`), so the
// second leg is skipped and the decision is byte-identical to the raw-only check — no over-drop.
function isSecretShapedTag(tag: string): boolean {
  if (findSecretShapeSpans(tag).length > 0) return true;
  const detection = buildUnicodeDetectionCopy(tag);
  return detection.changed && findSecretShapeSpans(detection.normalized).length > 0;
}
function dropSensitiveTags(tags: string[]): string[] {
  return tags.filter(
    (tag) => piiRedactor.scanAndTransform(tag).matches.length === 0 && !isSecretShapedTag(tag),
  );
}

function filterItemImpl(item: FridayMemoryItem): FridayMemoryItem {
  return {
    ...item,
    content: redactAndTruncate(item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
    // `source` is a FREE-FORM persisted string (accepted verbatim through `FridayMemoryStoreInput`
    // and the HTTP memory-store body), so a legacy/older-writer row can carry PII or a credential
    // VALUE inside it. The read-back filter redacted content/metadata/tags/snippet but PRESERVED
    // `source`, leaving it an unfiltered sensitive-data egress channel across the agent trust
    // boundary (memory_search serializes `r.item.source` verbatim) AND the HTTP memory routes
    // (memory.get/list/replay all return `filterItem(item).source`). Route it through the SAME
    // canonical PII + secret-VALUE transform as `content` (`redactAndTruncate` → the Unicode-aware
    // `scanAndTransform` → `redactSecretAndPiiValueString`): email/phone/SSN/card + raw AND
    // Unicode-obfuscated secret shapes (hf_/sk-/Bearer/…) become their canonical markers. That
    // transform is a PROVABLE STRICT SUPERSET — a `source` with no sensitive subspan folds through
    // every pass unchanged, so a benign identifier (`session:abc123`, `user`, `channel:telegram`,
    // `import:2026`, a UUID, `preference`) is returned BYTE-IDENTICAL. The boundary policy's reserved
    // `learned_fact` source (matched exactly downstream to surface the learning-boundary metadata) is
    // likewise benign, so it round-trips verbatim and the reservation stays intact.
    source: redactAndTruncate(item.source, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
    metadata: redactMetadata(item.metadata),
    tags: dropSensitiveTags(item.tags),
  };
}

function filterSearchResultImpl(result: FridayMemorySearchResult): FridayMemorySearchResult {
  return {
    ...result,
    item: filterItemImpl(result.item),
    snippet: redactAndTruncate(result.snippet, FRIDAY_MEMORY_GUARD_MAX_RESULT_SNIPPET_CHARS),
  };
}

// Redact PII from a learned-fact `value` (free-form `unknown`). Learned facts are appended to
// egress responses (uix / asset-inventory) AFTER the write-time guard, verbatim, so their
// value skips PII redaction entirely. These sibling routes return the RAW `value` field (a
// string or a nested object/array), not a stringified/truncated memory item, so we redact deep
// in place — preserving structure and type — via the SAME production redactor used by
// `redactMetadata`. Idempotent on already-redacted values.
function redactLearnedFactValueImpl(value: unknown): unknown {
  return piiRedactor.redactDeep(value).value;
}

export function createFridayMemoryOutputFilter(): FridayMemoryGuardOutputFilter {
  return {
    filterItem: filterItemImpl,
    filterSearchResult: filterSearchResultImpl,
    redactLearnedFactValue: redactLearnedFactValueImpl,
    filterSearchResults(results: FridayMemorySearchResult[]): FridayMemorySearchResult[] {
      return results
        .slice(0, FRIDAY_MEMORY_GUARD_MAX_SEARCH_RESULTS)
        .map(filterSearchResultImpl);
    },
  };
}
