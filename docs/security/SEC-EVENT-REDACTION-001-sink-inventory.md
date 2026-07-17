# SEC-EVENT-REDACTION-001 + PRIV-UNICODE-REDACTION-001 — redaction sink × branch inventory (round-14)

Mechanical map of **every production redaction sink that emits strings to a persistence or egress
surface**, and, for each sink × branch, the **canonical transform** applied or an **explicit,
justified exception**. Goal: prove there is no cell where a secret or PII (raw or Unicode) escapes.

Round-14 root fix: the shared guard's string-**VALUE** leg (`redactStringLeaf` inside `redactDeep`,
and `scanAndTransform`) previously composed **only** the PII detectors — never the shared secret-shape
redactor — so a secret-shaped string VALUE escaped every `redactDeep`/`scanAndTransform` consumer
(memory egress, the learned-fact output filter, and the public UIX / asset-inventory routes returned
it verbatim). The value leg now composes the **one canonical** secret detector
(`findSecretShapeSpans` / `redactSecretShapesInString` in `friday-secret-shape-redactor.ts`) **with**
the existing PII processing — the exact composition `redactKey` already applies to a KEY (round-12/13)
and the audit writer's content leaf applies to a VALUE. Reused, never re-copied.

## Canonical transforms (the shared vocabulary)

| Symbol | Meaning | Marker |
|---|---|---|
| `PII-raw` | `findMatches` (ASCII) + `redactContent` | `[EMAIL]`/`[SSN_US]`/`[CREDIT_CARD]`/`[PHONE_US]` |
| `PII-fw` | `findMatches` full-width fold (`foldWidthForMatching`, **U+3000/U+FF0C-safe**) | same |
| `PII-uni` | PII over the NFKD detection copy (`findPiiSpans` via `redactUnicodeObfuscated`) | same |
| `SEC-raw` | `redactSecretShapesInString` (in-place, prefix-preserving credential subspan) | `[REDACTED_SECRET]` |
| `SEC-uni` | `findSecretSpans` via `redactUnicodeObfuscated` (de-obfuscated, prefix bytes preserved) | `[REDACTED_SECRET]` |
| `KEY` | `redactKey` = `[findSecretSpans, findPiiSpans]` (Unicode) + `redactSecretShapesInString` + `findMatches` residual, secret ≻ PII; pure-`\p{Nd}` exempt | `[REDACTED_SECRET]` / PII markers |
| `NUM` | `transformScalar` numeric gate — redact only under a sensitive KEY **and** value-shape match | PII markers |
| `DROP` | sensitive-tag drop (a `[…]` marker is not a valid tag) | tag removed |

The **value-string** composition (round-14) is `redactSecretAndPiiValueString` =
`SEC-uni` (Pass 1, skipped on pure ASCII) → `SEC-raw` (Pass 2) → `PII-raw`+`PII-fw` residual (Pass 3).
It reuses `[findSecretSpans]` and `findMatches`/`redactContent` — no sink-local detector.

## Sink × branch matrix

Sinks 2–9 all funnel through the **shared guard** (`scanAndTransform` for strings, `redactDeep` for
deep values → `redactStringLeaf` for string leaves, `redactKey` for keys), so the round-14 value-leg
change fixes them uniformly. Sink 1 (audit) **wraps** `redactDeep` with additional channel-phone +
forensic-leaf passes.

| # | Sink (file · function) | string-VALUE (raw sec / uni sec / PII) | object-KEY (sec / PII, raw+uni) | structured / nested / array | typed / numeric |
|---|---|---|---|---|---|
| 1 | Audit `details_json` + `audit.jsonl` · `friday-hub-audit-log-writer.ts` `redactAuditDetails` | Pass1 `redactContentPrePass` + Pass2 `redactDeep` (now `SEC-raw`+`SEC-uni`+`PII`) + Pass3 `redactContentLeaf` (`SEC-raw`+`SEC-uni`+phones+`PII-uni`). **secret ∪ PII ∪ Unicode-PII** ✓ | `KEY` (via `redactDeep`) + `isSensitiveSecretFieldName` whole-value nuke ✓ | 3-pass cycle-aware skeleton; `AuditForensicRef` leaves cut out, run through identifier-leaf (`SEC-raw`+phones) ✓ | `NUM` (via `redactDeep`); forensic phone-shaped id preserved ✓ |
| 2 | Memory `filterItem.content` · `friday-memory-output-filter.ts` `redactAndTruncate`→`scanAndTransform` | `SEC-raw`✓ `SEC-uni`✓ `PII-raw`/`PII-fw`✓ · Unicode-PII = **exception E1** | n/a (string) | n/a | n/a |
| 3 | Memory `filterSearchResult.snippet` · `redactAndTruncate`→`scanAndTransform` | same as #2 ✓ / E1 | n/a | n/a | n/a |
| 4 | Memory `filterItem.metadata` · `redactMetadata`→`redactDeep` | `redactStringLeaf`: `SEC-raw`✓ `SEC-uni`✓ `PII`✓ / E1 | `KEY` ✓ | `redactDeep` iterative traversal ✓ | `NUM` ✓ |
| 5 | Memory `filterItem.tags` · `dropSensitiveTags` | `DROP` on PII **or** secret shape (round-14) ✓ | n/a | n/a | n/a |
| 6 | Memory `redactLearnedFactValue` · `redactDeep` | `redactStringLeaf`: `SEC-raw`✓ `SEC-uni`✓ `PII`✓ / E1 | `KEY` ✓ | `redactDeep` ✓ | `NUM` ✓ |
| 7 | Public route `friday-uix-routes.ts` learned-facts (GET list / PATCH update) → `redactLearnedFactValue` | inherits #6 ✓ (the Advisor's exact leak) / E1 | inherits #6 ✓ | inherits #6 ✓ | inherits #6 ✓ |
| 8 | Public route `friday-asset-inventory-routes.ts` inventory list (learned_fact `details.value`) → `redactLearnedFactValue` | inherits #6 ✓ / E1 | inherits #6 ✓ | inherits #6 ✓ | inherits #6 ✓ |
| 9 | Memory store path · `friday-memory-guard-service.ts` `scanAndTransform(content)` + `redactDeep(metadata)` + tag drop | redact mode: `SEC`+`PII`✓ / E1 (default mode `redact`) | `KEY` ✓ | `redactDeep` ✓ | `NUM` ✓ · **exception E2** (store tag drop is PII-only; egress #5 drops secret tags) |

Every ✓ cell redacts the sensitive span to a canonical marker; no secret or PII (raw, full-width, or
Unicode-obfuscated **secret**) escapes any cell.

## Exceptions (intentional, justified)

- **E1 — Unicode-obfuscated PII-by-value in the memory VALUE leg (`PII-uni`) is NOT applied.**
  The value leg keeps PII on `findMatches` (`PII-raw`+`PII-fw`), which **deliberately does not fold
  U+3000 / U+FF0C** (`foldWidthForMatching` scope decision). Running the PII **card** detector over the
  NFKD detection copy (`PII-uni`) folds an ideographic space / full-width comma into an ASCII
  space/comma that the card regex `[ -]` bridges, turning two benign full-width digit groups into a
  **false 16-digit card** — an over-redaction the guard's own `full-width ideographic-space non-bridge`
  test forbids. So `PII-uni` is confined to the **KEY** leg (`redactKey`, where the guard already ships
  it) and the **audit content** path (`redactUnicodeContentLeaf`, whose owner-scoped 0600 sink accepts
  the tradeoff). The memory value leg's PII behavior is therefore **byte-identical to pre-round-14**
  (a provable STRICT SUPERSET: only secret redactions are added). Unicode-obfuscated **secrets** in
  values ARE covered (`SEC-uni`) because secret shapes are contiguous/structured and never bridge.

- **E2 — Store-path (#9) tag drop is PII-only.** `friday-memory-guard-service.ts` drops PII-bearing
  tags; a secret-shaped tag stored at rest is dropped on egress by the output filter's
  `dropSensitiveTags` (#5). Egress is fully covered; the at-rest store is owner-scoped.

- **Canonical audit columns disclosed separately.** `redactAuditDetails` never touches the canonical
  `audit_logs` columns (id / ts / actor / action / resource / request/trace ids / result); only the
  caller-supplied `details` payload is redacted. Those columns are the record's own disclosed metadata.

## Convergence (one canonical composition, no divergence)

`friday-secret-shape-redactor.ts` is the **single** secret detector; both the guard
(`friday-memory-pii-guard.ts`, key + value legs) and the audit writer
(`friday-hub-audit-log-writer.ts`) import it — no sink-local copy. Round-14 makes the **value** leg
compose it exactly as the **key** leg (round-12/13) and the audit **content** leaf already do, and uses
the **same** `[REDACTED_SECRET]` marker (`SECRET_MARKER` ≡ `AUDIT_SECRET_MARKER` ≡
`FRIDAY_DEFAULT_SECRET_MARKER`). Because secret redaction is idempotent, the audit writer's own secret
passes (needed for its channel-phone + `AuditForensicRef` legs) now run **before or after** `redactDeep`
with a byte-identical final result — verified by the full audit suite staying green.
