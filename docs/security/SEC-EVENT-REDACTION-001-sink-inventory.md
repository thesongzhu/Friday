# SEC-EVENT-REDACTION-001 + PRIV-UNICODE-REDACTION-001 — redaction sink × branch inventory (round-15)

Mechanical map of **every production redaction sink that emits strings to a persistence or egress
surface**, and, for each sink × branch, the **canonical transform** applied or an **explicit,
justified exception**. Goal: prove no cell lets a secret or PII (raw or Unicode) escape a PUBLIC or
persisted surface with **less** protection than the owner-scoped 0600 audit sink.

## Round-15 — what changed and why (reconciliation of the prior overclaim)

Round-14 closed the string-**VALUE** shape leg. But it left a REAL divergence the round-14 inventory
wrongly declared closed:

- The **audit** sink (`friday-hub-audit-log-writer.ts` `buildContentSkeleton`) whole-value-**nukes**
  a value under a sensitive-secret **KEY NAME** via `isSensitiveSecretFieldName` — an opaque,
  **shapeless** credential (a `password` value such as `hunter2plainword`, a `token` value such as
  `opaquevaluewithnoshape` — illustrative fakes) is catchable ONLY by its key.
- The shared guard's `redactDeep` object branch (`friday-memory-pii-guard.ts`) computed
  `sensitiveTypeForKey` (numeric-PII typing) but **never** called `isSensitiveSecretFieldName`. So the
  PUBLIC memory egress (uix / asset-inventory / `/memory` routes, the learned-fact output filter,
  metadata) returned a shapeless credential under a sensitive key **VERBATIM**, while the audit sink
  redacted the SAME input. Public egress was **LESS** protected than the private audit sink.

**Round-15 root fix (two parts, both reuse the CANONICAL primitives — no divergent copies):**

1. **Key-name nuke parity.** `redactDeep`'s object branch now calls the SAME exported
   `isSensitiveSecretFieldName` predicate the audit writer uses, and whole-value-nukes the value under
   a sensitive-secret KEY NAME to `[REDACTED_SECRET]` — regardless of the value's SHAPE or TYPE
   (scalar / object / array / number), in redact mode only, carrying no guard tag. The sensitive-key
   set is the audit writer's EXACT set (reused, not redefined) and is **DISJOINT** from the audit
   forensic-identifier allowlist (ids vs credentials), so memory's disposition equals audit's for
   every sensitive-secret key — **provably neither broader nor narrower**.
2. **Shape extension.** The shared `friday-secret-shape-redactor.ts` was audited against all common
   real-world provider formats; the SECRET underscore/prefix forms it missed were added. This benefits
   audit + memory + realtime (#1618), which all consume the one canonical detector.

The prior claims **"no secret escapes any cell"** and **"one canonical composition, no divergence"**
were **FALSE** for the sensitive-key + shapeless-value cell (audit nuked; memory did not). This
round-15 revision states the reconciliation and corrects the convergence claim (see the last section).

## Secret-shape coverage (the ONE canonical detector — `friday-secret-shape-redactor.ts`)

| Provider / form | Shape | Status |
|---|---|---|
| OpenAI | `sk-` / `sk-proj-` | pre-existing |
| Anthropic | `sk-ant-…` | covered by the `sk-` shape (`-` is inside the value class) |
| Stripe SECRET / RESTRICTED | `sk_live_` / `sk_test_` / `rk_live_` / `rk_test_` | **added round-15** |
| Stripe webhook signing secret | `whsec_` | **added round-15** |
| Stripe PUBLISHABLE | `pk_live_` / `pk_test_` | **DELIBERATELY EXCLUDED** (client-safe, not a secret) |
| GitHub | `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_` + `github_pat_` | pre-existing |
| Google API key | `AIza…` (39-char) | **added round-15** |
| npm access token | `npm_…` (36-char body) | **added round-15** |
| Slack | `xoxb-`/`xoxp-`/`xoxa-`/`xoxr-`/`xoxs-` | pre-existing |
| AWS access-key id | `AKIA…` + STS/temporary (`ASIA`/`AGPA`/…) | pre-existing |
| AWS SECRET access key | shapeless 40-char base64 | **key-name only** (`secretAccessKey`) — no shape by design |
| JWT | `eyJ….….…` | pre-existing |
| PEM private key | `-----BEGIN … PRIVATE KEY-----` | pre-existing |
| Bearer / `Authorization: Bearer` | scheme kept, credential redacted | pre-existing |
| Generic `key=value` / `key: value` | credential label kept, value redacted (also catches `"apiKey":"…"` in stringified JSON) | pre-existing |

## Sensitive KEY-NAME set (the ONE canonical predicate — `isSensitiveSecretFieldName`)

`password`/`passwd`/`passphrase`/`passcode`, `secret`/`clientSecret`/`appSecret`/`secretKey`/
`secretAccessKey`, `token`/`accessToken`/`refreshToken`/`sessionToken`/`idToken`/`bearerToken`,
`apiKey`/`apiSecret`/`privateKey`, `authorization`/`cookie`/`setCookie`, `credential`/`credentials`.
Normalized via the shared Unicode detection primitive (NFKD → strip `\p{M}`/Cf → fold `\p{Nd}`) THEN
strip `-`/`_`/whitespace + lowercase, so an obfuscated key (`ａｐｉ＿ｋｅｙ`, `api​Key`, `tóken`) classifies
identically to its ASCII form (round-9). Both the audit writer AND `redactDeep` (round-15) import this
one function — no sink-local copy.

## Canonical transforms (the shared vocabulary)

| Symbol | Meaning | Marker |
|---|---|---|
| `PII-raw` | `findMatches` (ASCII) + `redactContent` | `[EMAIL]`/`[SSN_US]`/`[CREDIT_CARD]`/`[PHONE_US]` |
| `PII-fw` | `findMatches` full-width fold (`foldWidthForMatching`, **U+3000/U+FF0C-safe**) | same |
| `PII-uni` | PII over the NFKD detection copy (`findPiiSpans` via `redactUnicodeObfuscated`) | same |
| `SEC-raw` | `redactSecretShapesInString` (in-place, prefix-preserving credential subspan) | `[REDACTED_SECRET]` |
| `SEC-uni` | `findSecretSpans` via `redactUnicodeObfuscated` (de-obfuscated, prefix bytes preserved) | `[REDACTED_SECRET]` |
| `KEY` | `redactKey` = `[findSecretSpans, findPiiSpans]` (Unicode) + `redactSecretShapesInString` + `findMatches` residual, secret ≻ PII; pure-`\p{Nd}` exempt | `[REDACTED_SECRET]` / PII markers |
| `KEYNAME-NUKE` | **round-15**: value under `isSensitiveSecretFieldName(key)` → whole value nuked (raw + Unicode-obfuscated key, any value type), redact mode | `[REDACTED_SECRET]` |
| `NUM` | `transformScalar` numeric gate — redact only under a sensitive PII KEY **and** value-shape match | PII markers |
| `DROP` | sensitive-tag drop (a `[…]` marker is not a valid tag) | tag removed |

The **value-string** composition (round-14) is `redactSecretAndPiiValueString` =
`SEC-uni` (Pass 1, skipped on pure ASCII) → `SEC-raw` (Pass 2) → `PII-raw`+`PII-fw` residual (Pass 3).
The **object-KEY** branch (round-15) applies `KEYNAME-NUKE` FIRST (whole-value replace, no descent),
else `KEY` on the key + the value legs on the value. Both reuse the shared detectors — no sink copy.

## Sink × branch matrix

Sinks 2–11 all funnel through the **shared guard** (`scanAndTransform` for strings, `redactDeep` for
deep values → `redactStringLeaf` for string leaves, `redactKey` for keys, **`KEYNAME-NUKE` for values
under a sensitive-secret key**), so the round-14 value-leg + round-15 key-name-nuke fixes them
uniformly. Sink 1 (audit) **wraps** `redactDeep` with additional channel-phone + forensic-leaf passes.

| # | Sink (file · function) | string-VALUE (raw sec / uni sec / PII) | object-KEY-name value (raw+uni) | secret-shaped KEY (sec / PII) | structured / typed |
|---|---|---|---|---|---|
| 1 | Audit `details_json` + `audit.jsonl` · `friday-hub-audit-log-writer.ts` `redactAuditDetails` | Pass1 pre-pass + Pass2 `redactDeep` + Pass3 content-leaf (`SEC`+`PII`+Unicode) ✓ | `isSensitiveSecretFieldName` nuke (raw+uni) ✓ | `KEY` (via `redactDeep`) ✓ | `NUM`; forensic leaf preserved ✓ |
| 2 | Memory `filterItem.content` · `friday-memory-output-filter.ts` `redactAndTruncate`→`scanAndTransform` | `SEC-raw`✓ `SEC-uni`✓ `PII`✓ · Unicode-PII = **E1** | n/a (string, no key) | n/a | n/a |
| 3 | Memory `filterSearchResult.snippet` · `redactAndTruncate`→`scanAndTransform` | same as #2 ✓ / E1 | n/a | n/a | n/a |
| 4 | Memory `filterItem.metadata` · `redactMetadata`→`redactDeep` | `SEC-raw`✓ `SEC-uni`✓ `PII`✓ / E1 | **`KEYNAME-NUKE` ✓ (round-15)** | `KEY` ✓ | `NUM` ✓ |
| 5 | Memory `filterItem.tags` · `dropSensitiveTags` | `DROP` on PII **or** secret shape ✓ | n/a | n/a | n/a |
| 6 | Memory `redactLearnedFactValue` · `redactDeep` (returns the STRUCTURED value) | `SEC-raw`✓ `SEC-uni`✓ `PII`✓ / E1 | **`KEYNAME-NUKE` ✓ (round-15)** | `KEY` ✓ | `NUM` ✓ |
| 7 | Public route `friday-uix-routes.ts` learned-facts (GET list / PATCH update) → `redactLearnedFactValue` | inherits #6 ✓ (the Advisor's exact leak) / E1 | inherits #6 ✓ (round-15) | inherits #6 ✓ | inherits #6 ✓ |
| 8 | Public route `friday-asset-inventory-routes.ts` inventory list (learned_fact `details.value`) → `redactLearnedFactValue` | inherits #6 ✓ / E1 | inherits #6 ✓ (round-15) | inherits #6 ✓ | inherits #6 ✓ |
| 9 | Memory store path · `friday-memory-guard-service.ts` `scanAndTransform(content)` + `redactDeep(metadata)` + tag drop | redact mode: `SEC`+`PII`✓ / E1 | `KEYNAME-NUKE` ✓ (round-15, metadata) | `KEY` ✓ | `NUM` · **E2** (store tag drop PII-only) |
| 10 | Public route `friday-memory-routes.ts` (GET `/v1/memory/items` list, POST `/v1/memory/search`) → `filterItem` / `filterSearchResult` | stored `content`/`snippet`: `SEC`+`PII`✓ / E1. Learned-fact `value` is **stringified into content** (string leg: shapes incl. `"apiKey":"…"` assignment ✓; a shapeless cred embedded in stringified JSON is not object-key-nuked — **same boundary as the audit content-leaf**, E3) | stored `metadata`: **`KEYNAME-NUKE` ✓ (round-15)** | `KEY` ✓ | `NUM` ✓ |
| 11 | Agent-tool learned-fact search · `friday-agent-memory-tools.ts` → `filterSearchResult` | stored/appended `content`/`snippet`: `SEC`+`PII`✓ / E1; learned-fact `value` stringified into content (as #10, E3) | boundary `metadata`: `KEYNAME-NUKE` ✓ (no user creds in boundary metadata) | `KEY` ✓ | `NUM` ✓ |

Every ✓ cell redacts the sensitive span (or nukes the sensitive-key value) to a canonical marker.
Public/persisted egress is now **at least as protected as the 0600 audit sink** for the
sensitive-key + shapeless-value class — the round-15 reconciliation.

## Exceptions (intentional, justified)

- **E1 — Unicode-obfuscated PII-by-value in the memory VALUE leg (`PII-uni`) is NOT applied.**
  The value leg keeps PII on `findMatches` (`PII-raw`+`PII-fw`), which **deliberately does not fold
  U+3000 / U+FF0C**. Running the PII **card** detector over the NFKD copy folds an ideographic space /
  full-width comma into an ASCII space/comma the card regex `[ -]` bridges, turning two benign
  full-width digit groups into a **false 16-digit card** — over-redaction the guard's own
  `ideographic-space non-bridge` test forbids. So `PII-uni` is confined to the **KEY** leg and the
  **audit content** path (owner-scoped 0600). The memory value leg's PII behavior is therefore
  **byte-identical to pre-round-14** (a provable STRICT SUPERSET). Unicode-obfuscated **secrets** in
  values ARE covered (`SEC-uni`); Unicode-obfuscated sensitive **KEY NAMES** are covered
  (`KEYNAME-NUKE` normalizes the key through the shared detection primitive).

- **E2 — Store-path (#9) tag drop is PII-only.** A secret-shaped tag stored at rest is dropped on
  egress by the output filter's `dropSensitiveTags` (#5). Egress is fully covered; the at-rest store
  is owner-scoped.

- **E3 — Learned-fact `value` on the `/memory` + agent-tool sinks is STRINGIFIED into `content`.**
  Sinks #10/#11 project a learned fact into a memory item whose `content = JSON.stringify(value)`
  (`toLearnedFactMemoryItem`). The string content leg redacts secret SHAPES + PII (including the
  `"apiKey":"…"` assignment form) but does not parse object keys OUT of a JSON string, so a
  **shapeless** credential embedded in stringified JSON is not key-name-nuked. This is the **SAME
  boundary as the audit content-leaf** (which likewise does not parse keys out of a content string),
  so it is NOT a memory-vs-audit divergence. The structured-value surfaces that DO expose object keys
  — `redactLearnedFactValue` (uix #7 / asset-inventory #8) and `metadata` (#4/#10) — get the full
  `KEYNAME-NUKE`.

- **Canonical audit columns disclosed separately.** `redactAuditDetails` never touches the canonical
  `audit_logs` columns (id / ts / actor / action / resource / request/trace ids / result); only the
  caller-supplied `details` payload is redacted.

## Convergence (one canonical composition — divergence corrected)

`friday-secret-shape-redactor.ts` is the **single** secret detector + the **single**
`isSensitiveSecretFieldName` predicate; both the guard (`friday-memory-pii-guard.ts`, key + value +
**key-name-nuke** legs) and the audit writer (`friday-hub-audit-log-writer.ts`) import them — no
sink-local copy. Round-15 makes the memory object branch apply the SAME key-name nuke the audit sink
applies, using the SAME `[REDACTED_SECRET]` marker (`SECRET_MARKER` ≡ `AUDIT_SECRET_MARKER` ≡
`FRIDAY_DEFAULT_SECRET_MARKER`).

The prior **"byte-identical final result"** convergence claim is corrected: the audit `redactDeep`
Pass 2 now sees skeletons whose sensitive-key values were already nuked to the marker by
`buildContentSkeleton` Pass 1, so the new `redactDeep` key-name nuke is an **idempotent re-nuke**
there (verified by the full audit suite staying green). The precise statement is: **audit and memory
now produce byte-identical output for a sensitive-key credential — both nuke it to
`[REDACTED_SECRET]`** (fail-safe, `secret ≥ PII` precedence). The only intended difference from the
pre-round-15 memory output is exactly this: a value under a sensitive-secret key that previously
egressed verbatim (or PII-only) now redacts as the secret marker.
