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
// SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 (round-4, Defect 1): the CANONICAL value-PII preserving fold
// (#1618, relocated to the shared `src/security/` leaf). Detects Unicode-obfuscated PII (zero-width /
// combining / fullwidth / precomposed email·phone·SSN·card) over a fold that PRESERVES compat-whitespace
// (U+3000 / U+00A0 / …) and No/Nl digit-likes, so it never fabricates an ideographic-space-bridged card
// the shared guard would not. Reused (NOT re-copied) by BOTH this memory egress leg and the realtime
// event redactor, closing the round-14 "value leg does not cover Unicode-obfuscated PII" gap here.
import { redactUnicodeResistantPii } from "../../../security/friday-value-pii-fold.js";

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

// The CANONICAL free-form VALUE redaction for every free-form string egressed on read-back
// (`content`, `source`, `namespace`, `expiresAt`, and the search `snippet`), applied consistently on
// BOTH the agent `memory_search` trust boundary and the HTTP get/list/search/replay routes (all route
// through `filterItem` / `filterSearchResult`). It composes, in order:
//   (1) the shared guard's canonical value transform (`scanAndTransform` → `redactSecretAndPiiValueString`)
//       — raw email/phone/SSN/card PII ∪ raw AND Unicode-obfuscated SECRET shapes → canonical markers;
//   (2) SEC-AGENT-MEMORY-SEARCH-RAW-EGRESS-001 round-4 Defect 1 — Unicode-obfuscated PII coverage via the
//       shared preserving fold `redactUnicodeResistantPii`, run with the guard's OWN PII detector
//       (`scanAndTransform(normalized).matches`) over the NON-DESTRUCTIVE detection copy. This is the
//       EXACT pattern the realtime event redactor uses. Before round-4 leg (1) ran the Unicode pass for
//       SECRET shapes ONLY (`redactSecretAndPiiValueString`'s documented gap), so a zero-width-spliced
//       email in `source` egressed VERBATIM; leg (2) closes that.
// NON-BRIDGE / no-over-redaction is RETAINED: leg (2)'s fold PRESERVES U+3000 / U+FF0C / No·Nl
// digit-likes, so a benign fullwidth-digit run separated by an ideographic space does NOT fabricate a
// `[CREDIT_CARD]`, and benign multilingual text round-trips byte-identical. STRICT SUPERSET: a value
// with no sensitive subspan (a benign identifier, a valid ISO timestamp, a benign namespace) folds
// through every pass unchanged and is returned BYTE-IDENTICAL.
function redactFreeFormValue(value: string): string {
  const afterSecretsAndRawPii = piiRedactor.scanAndTransform(value).transformedContent;
  return redactUnicodeResistantPii(
    afterSecretsAndRawPii,
    (normalized) => piiRedactor.scanAndTransform(normalized).matches,
  );
}

// `redactFreeFormValue` + a content egress-SIZE cap, for the two fields that carry an intentional
// read-back size defense: `content` (the agent-facing payload) and the search `snippet`. Truncation is
// applied AFTER redaction so a sensitive span is never split across the cut. This is NOT applied to the
// identifier-ish free-form fields (`source`, `namespace`, `expiresAt`) — those have no egress-size role
// and truncating them would silently drop benign, addressable data on read-back (round-4 Defect 3).
function redactAndTruncate(value: string, maxChars: number): string {
  return truncateString(redactFreeFormValue(value), maxChars);
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
    // `content` — the agent-facing payload. Bounded at WRITE to 64 KiB
    // (`FRIDAY_MEMORY_GUARD_MAX_CONTENT_BYTES`) but the read-back cap `MAX_RESULT_CONTENT_CHARS` (8192)
    // is a DELIBERATE, pre-existing egress-SIZE defense (limits how much a single memory row dumps into
    // an agent's context window), so its truncation is INTENTIONAL, not a silent no-op. Redaction now
    // ALSO covers Unicode-obfuscated PII (Defect 1) and truncation runs AFTER redaction (no split span).
    content: redactAndTruncate(item.content, FRIDAY_MEMORY_GUARD_MAX_RESULT_CONTENT_CHARS),
    // FIELD-ENUMERATION (round-3) + round-4 policy split. `filterItemImpl` covers EVERY free-form
    // persisted string field, but with the CORRECT per-field policy:
    //   • `key` (round-4 Defect 2) — an addressable IDENTIFIER, so it routes through the guard's
    //     identifier-aware `redactStructuredKey` (all-`\p{Nd}` exempt — a pure-decimal key of ANY
    //     script is an ambiguous business id preserved BYTE-IDENTICAL — while a credential-shaped key
    //     `hf_…`/`sk-…`/`ghp_…`/`AKIA…` and a formatted-PII key SSN-/email-shaped STILL redact), NOT the
    //     free-form value transform (which would fold a 16-digit key to `[CREDIT_CARD]`, corrupting a
    //     benign id). The store-time `validateKey` regex ADMITS these credential shapes and the HTTP
    //     `validateStoreBody` performs NO key check, so a client can POST `key="hf_…"` and read it back
    //     on memory.get / memory.list / store-idempotency-replay.
    //   • `namespace` / `expiresAt` — free-form VALUE fields (not addressable identifiers), so they take
    //     the canonical value redaction `redactFreeFormValue` (raw PII ∪ raw/Unicode secret ∪
    //     Unicode-obfuscated PII), NON-truncating. `validateNamespace` rejects most secret shapes at
    //     write and a real ISO `expiresAt` carries no sensitive subspan, so the STRICT-SUPERSET transform
    //     returns both BYTE-IDENTICAL for benign inputs. A non-string/absent `expiresAt` passes through
    //     unchanged (never coerced).
    key: piiRedactor.redactStructuredKey(item.key),
    namespace: redactFreeFormValue(item.namespace),
    // `source` (round-2 finding; round-4 Defect 3) is a FREE-FORM persisted string accepted VERBATIM
    // through `FridayMemoryStoreInput` and the HTTP store body with NO write-time length bound, so a
    // legacy/older-writer row can carry PII or a credential VALUE inside it and it egresses across the
    // agent trust boundary (`memory_search` serializes `r.item.source`) AND the HTTP routes
    // (memory.get/list/replay return `filterItem(item).source`). Route it through the canonical
    // `redactFreeFormValue` (email/phone/SSN/card + raw AND Unicode-obfuscated PII + raw/Unicode secret
    // shapes → canonical markers) — NON-TRUNCATING. Round-2 used the content SIZE cap here, silently
    // truncating a benign 10 KiB `source` on read-back (Defect 3); `source` has no egress-size role, so
    // truncating it only drops benign, addressable data. STRICT SUPERSET — a `source` with no sensitive
    // subspan (`session:abc123`, `user`, `channel:telegram`, a UUID, the reserved `learned_fact` source)
    // folds through unchanged and is returned BYTE-IDENTICAL, so the learning-boundary reservation holds.
    source: redactFreeFormValue(item.source),
    metadata: redactMetadata(item.metadata),
    tags: dropSensitiveTags(item.tags),
    expiresAt:
      typeof item.expiresAt === "string" ? redactFreeFormValue(item.expiresAt) : item.expiresAt,
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
