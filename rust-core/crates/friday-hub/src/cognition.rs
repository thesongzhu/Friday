//! Memory-recall cognition (PROOF-MEMORY-001). Hub-only — recall is Hub-side
//! (`07` §9 / `02` §7); the phone never recalls. Pure logic over the rows
//! [`friday_storage::memory::recall_confirmed`] returns (already filtered to one
//! principal's `Confirmed`, content-bearing memory).
//!
//! Two cognition steps run before a recalled memory may be injected into a
//! provider prompt:
//! 1. **Rank + bound** — score by recency half-life decay, sort, and cap at
//!    `top_k` so recall injects a BOUNDED amount of context (recall adds prompt
//!    tokens, which must stay bounded + ledgered, `07` §1/§3).
//! 2. **PII redaction** — detect + mask email / phone / SSN / credit-card (the
//!    last Luhn-validated) before the text leaves the Hub, ported from the oracle
//!    PII guard. This is defense-in-depth ON TOP of the Context Passport gate.
//!
//! **Honest scope:** there is NO semantic / EMBEDDING recall here — the oracle's
//! hybrid VECTOR search (`friday-memory-hybrid.ts`) has no Rust counterpart (that is
//! greenfield / NO-GO and is NOT claimed). There IS now an OPTIONAL, flag-gated FTS5
//! KEYWORD-relevance blend ([`rank_recall_hybrid`], default-OFF behind
//! `FRIDAY_HYBRID_RECALL_ENABLED`): when ON, it re-ranks the SAME owner-scoped
//! candidate set by `bm25` keyword relevance blended with the recency decay; when OFF,
//! recall is recency-decay only via [`rank_recall`], BYTE-IDENTICAL to the pre-hybrid
//! path. The SQL query still did the same-principal + Confirmed + content-bearing
//! filtering, so this layer adds bounded ranking (recency-only OR hybrid), a
//! defense-in-depth trust re-check, and redaction. The keyword index NEVER widens the
//! candidate set (it only re-orders rows the owner already owns — owner-isolation is
//! inherited from the SQL), so hybrid recall can never leak another owner's memory.
//!
//! **PII-port fidelity (honest deviations from the oracle PII guard):**
//! - **SSN** drops the oracle's invalid-prefix look-aheads (the Rust engine is
//!   look-around-free) → matches the plain 3-2-4 shape (over-match, safe).
//! - **Boundaries** use ONLY a LEADING `(?-u:\b)` (ASCII) on Email/SSN/Phone; the
//!   TRAILING `(?-u:\b)` is removed. The Rust `regex` `\b` is Unicode-aware (a CJK char
//!   is a word char), so a plain `\b` would not fire between CJK and an adjacent ASCII
//!   PII run and would LEAK it; the ASCII `(?-u:\b)` treats CJK as a boundary. The
//!   trailing boundary was removed because it UNDER-matched (the dangerous direction)
//!   when an ASCII word/digit char is glued AFTER the value (`alice@example.com1`,
//!   `123-45-67890`) — dropping it makes those redact. (Over-match is the safe direction.)
//! - **Phone** requires a full 10 digits; the oracle also matches bare 7-digit
//!   locals. This is a DELIBERATE under-match — a bare 7-digit pattern would
//!   over-redact benign numbers; disclosed, not a parity claim.
//! - **Residual under-matches (disclosed):** a value with an ASCII word/digit char glued
//!   to its LEFT (e.g. `x123-45-6789`) still under-matches — only the leading boundary
//!   remains, and removing it too would let patterns start mid-ASCII-token. Credit-card
//!   detection is group-aligned (see `luhn_card_subspan`): a PAN glued to a stray digit
//!   mid-group, or inside one >19-digit run, is not isolated. Both are pre-existing,
//!   behind the Passport gate for recall, and never leak MORE than before.
//!
//! Redaction is defense-in-depth; the Context Passport sensitive-flag gate is the
//! primary control and is NOT replaced by this.

use friday_core::{gate_transfer, PassportItem, PassportItemKind};
use friday_storage::memory::MemoryRow;
use regex::Regex;
use std::sync::OnceLock;

/// A category of personally-identifiable information the recall redactor detects
/// (ported from the oracle `friday-memory-pii-guard.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PiiKind {
    Email,
    Phone,
    Ssn,
    CreditCard,
}

impl PiiKind {
    /// The opaque marker a detected span is replaced with (the value never leaves
    /// the Hub; a reader sees THAT a kind of PII was present, not WHAT it was).
    pub fn tag(self) -> &'static str {
        match self {
            PiiKind::Email => "[EMAIL]",
            PiiKind::Phone => "[PHONE]",
            PiiKind::Ssn => "[SSN]",
            PiiKind::CreditCard => "[CREDIT_CARD]",
        }
    }
}

/// One recalled memory, ready to inject: PII-redacted `content`, its provenance,
/// the recency-decay `score`, and `sensitive` (so the caller can still route it
/// through the Context Passport gate — redaction does not replace that gate).
#[derive(Clone, Debug, PartialEq)]
pub struct RecalledMemory {
    pub memory_id: String,
    /// Already PII-redacted (see [`redact_pii`]).
    pub content: String,
    /// Recency-decay relevance in `(0, 1]` — `1.0` just-confirmed, → `0` with age.
    pub score: f64,
    pub sensitive: bool,
    /// `true` if PII was found and masked out of `content`.
    pub redacted: bool,
}

/// Default recall recency half-life (~30 days, in ms): a memory's relevance halves
/// for every half-life of age since confirmation.
pub const DEFAULT_HALF_LIFE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Default max confirmed memories injected into one prompt (bounds recall's token cost).
/// Shared by the agent loop and the `friday_ask` surface so both inject the same amount.
pub const DEFAULT_RECALL_TOP_K: usize = 8;

// The PII patterns, compiled once. Ordered most-specific-first; overlapping
// matches are resolved earliest-start-wins in `redact_pii`.
fn pii_patterns() -> &'static [(PiiKind, Regex)] {
    static PATTERNS: OnceLock<Vec<(PiiKind, Regex)>> = OnceLock::new();
    // NOTE the boundaries are the ASCII word boundary `(?-u:\b)`, NOT a plain `\b`.
    // The Rust `regex` crate's `\b` is UNICODE-aware (a CJK char is a word char), so
    // a plain `\b` does NOT fire between a CJK char and an adjacent ASCII PII run —
    // e.g. `电话212-555-0143` / `邮箱alice@example.com` (idiomatic Chinese writes no
    // space) would pass through UNREDACTED. That is a real leak in the operator's
    // language. `(?-u:\b)` restores the oracle's ASCII-`\b` semantics (CJK acts as a
    // boundary) so CJK-adjacent PII redacts.
    PATTERNS.get_or_init(|| {
        vec![
            // No TRAILING `(?-u:\b)`: a trailing boundary UNDER-matches when an ASCII
            // word/digit char is glued directly after the value (e.g. `alice@example.com1`)
            // — and under-matching leaks a real value, the dangerous direction. The TLD
            // class `[A-Z]{2,}` already bounds the right edge, so dropping the trailing
            // boundary makes the glued case redact. Leading `(?-u:\b)` is KEPT — it gives
            // the CJK-adjacency semantics (CJK is a non-word char under ASCII `\b`).
            (
                PiiKind::Email,
                Regex::new(r"(?i)(?-u:\b)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}").unwrap(),
            ),
            // SSN: 3-2-4 nine-digit shape. (The oracle additionally excludes invalid
            // prefixes via look-ahead; the Rust `regex` crate is look-around-free, so
            // we match the plain shape. Over-matching a non-SSN 9-digit run is the
            // SAFE direction for a privacy-redaction boundary — under-matching, which
            // would leak a real SSN, is the dangerous one.) No TRAILING boundary, same
            // glued-digit reason as Email (`123-45-67890` must still redact the SSN).
            (
                PiiKind::Ssn,
                Regex::new(r"(?-u:\b)\d{3}[- ]?\d{2}[- ]?\d{4}").unwrap(),
            ),
            // Credit-card candidate: 13–19 digits with any space/dash separators
            // between them (`[ -]*`, matching the oracle, so a multi-separator card
            // like `4111 - 1111 - 1111 - 1111` is still caught). The greedy candidate can
            // ANNEX a following separator-joined digit group; `redact_pii` therefore
            // Luhn-validates the longest 13–19 digit SUB-window via `luhn_card_subspan`
            // (not the whole greedy span) so a real card is never dropped when an extra
            // group is swallowed.
            (
                PiiKind::CreditCard,
                Regex::new(r"(?-u:\b)(?:\d[ -]*){13,19}(?-u:\b)").unwrap(),
            ),
            // North-American phone (10 digits, optional +1 / grouping / separators).
            // No TRAILING boundary (same glued-digit reason as Email/SSN).
            (
                PiiKind::Phone,
                Regex::new(r"(?-u:\b)(?:\+1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}")
                    .unwrap(),
            ),
        ]
    })
}

/// Validate a credit-card candidate by the Luhn checksum (digits only; 13–19 long).
fn luhn_valid(s: &str) -> bool {
    let digits: Vec<u32> = s.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let mut sum = 0u32;
    let mut double = false;
    for &d in digits.iter().rev() {
        let mut x = d;
        if double {
            x *= 2;
            if x > 9 {
                x -= 9;
            }
        }
        sum += x;
        double = !double;
    }
    sum % 10 == 0
}

/// Within a credit-card *candidate* (a run of digits separated by spaces/dashes, as
/// matched by the card regex), find the byte span of the longest Luhn-valid 13–19 digit
/// window formed by a contiguous sequence of WHOLE separator-delimited digit groups,
/// mapped to absolute offsets via `base`. `None` if no group-aligned window validates.
///
/// This is the fix for the greedy-annex leak: the card regex's `[ -]*` separator class
/// can swallow a trailing separator-joined digit group that follows a real card, so the
/// whole span (card + extra digits) fails Luhn. The old code then DROPPED the entire
/// candidate, leaving a real Luhn-valid PAN un-redacted. Instead we scan WHOLE-group
/// windows and redact the longest Luhn-valid card inside it.
///
/// DELIBERATELY group-aligned, NOT digit-indexed: a digit-by-digit window over arbitrary
/// 13–19 digit sub-runs would pervasively over-redact — almost every long digit run
/// (order ids, the Luhn-invalid `4111…1112`, a 19-digit number) contains *some* Luhn-valid
/// 13–19 digit sub-window, so digit-indexing would mask benign numbers across the shared
/// memory-recall path. Group-alignment matches how cards are actually written.
/// RESIDUAL (disclosed, pre-existing, behind the Passport gate for recall): a PAN that
/// ends/starts mid-group (e.g. a glued typo digit `…1881 0` making a 5-digit last group)
/// or sits inside one >19-digit contiguous run is not isolated by group windows. These
/// degrade to a partial redaction, never a worse leak than before this fix.
fn luhn_card_subspan(candidate: &str, base: usize) -> Option<(usize, usize)> {
    let bytes = candidate.as_bytes();
    // Maximal ASCII-digit groups as (start_byte, end_byte) within `candidate`.
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let s = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            groups.push((s, i));
        } else {
            i += 1;
        }
    }
    let mut best: Option<(usize, usize, usize)> = None; // (start, end, ndigits)
    for a in 0..groups.len() {
        let mut ndigits = 0usize;
        for b in a..groups.len() {
            ndigits += groups[b].1 - groups[b].0; // ASCII digits are 1 byte each
            if ndigits > 19 {
                break;
            }
            if ndigits >= 13 && luhn_valid(&candidate[groups[a].0..groups[b].1]) {
                let better = match best {
                    Some((bs, _, bn)) => ndigits > bn || (ndigits == bn && groups[a].0 < bs),
                    None => true,
                };
                if better {
                    best = Some((groups[a].0, groups[b].1, ndigits));
                }
            }
        }
    }
    best.map(|(s, e, _)| (base + s, base + e))
}

#[derive(Clone, Copy)]
struct Span {
    start: usize,
    end: usize,
    kind: PiiKind,
}

/// Redact every PII span in `content`, replacing each with its kind marker (e.g.
/// `[EMAIL]`). Returns the redacted text and the DISTINCT kinds found (stable
/// order). A credit-card candidate is redacted ONLY if it passes the Luhn check.
/// Overlapping matches are resolved earliest-start-wins so a span is never
/// double-replaced.
pub fn redact_pii(content: &str) -> (String, Vec<PiiKind>) {
    let mut spans: Vec<Span> = Vec::new();
    for (kind, re) in pii_patterns() {
        for m in re.find_iter(content) {
            if *kind == PiiKind::CreditCard {
                // Redact the longest Luhn-valid sub-window, not the whole greedy span,
                // so an annexed trailing group can't make a real card fail Luhn and drop.
                if let Some((start, end)) = luhn_card_subspan(m.as_str(), m.start()) {
                    spans.push(Span {
                        start,
                        end,
                        kind: *kind,
                    });
                }
                continue;
            }
            spans.push(Span {
                start: m.start(),
                end: m.end(),
                kind: *kind,
            });
        }
    }
    if spans.is_empty() {
        return (content.to_string(), Vec::new());
    }
    // Earliest-start first; for equal starts prefer the longer span.
    spans.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
    let mut kept: Vec<Span> = Vec::new();
    let mut last_end = 0usize;
    for s in spans {
        if s.start >= last_end {
            last_end = s.end;
            kept.push(s);
        }
    }
    // Replace end-to-start so earlier byte offsets stay valid.
    let mut result = content.to_string();
    for s in kept.iter().rev() {
        result.replace_range(s.start..s.end, s.kind.tag());
    }
    let mut kinds: Vec<PiiKind> = Vec::new();
    for s in &kept {
        if !kinds.contains(&s.kind) {
            kinds.push(s.kind);
        }
    }
    (result, kinds)
}

/// Rank a principal's recall rows by recency-decay, cap at `top_k`, and redact PII
/// in each. The input is expected to be `recall_confirmed`'s output (already
/// same-principal + Confirmed + content-bearing), but this re-checks the trust
/// invariant as defense-in-depth: a row that is not durable + auto-usable, or has
/// no/empty content, is DROPPED (a candidate / inferred item is never recalled as
/// a fact — `07` §9, even if one leaked past the SQL filter).
///
/// `half_life_ms` controls the decay (see [`DEFAULT_HALF_LIFE_MS`]); `top_k` bounds
/// how much context recall may inject. A `top_k` of 0 recalls nothing.
pub fn rank_recall(
    rows: &[MemoryRow],
    now_ms: i64,
    top_k: usize,
    half_life_ms: i64,
) -> Vec<RecalledMemory> {
    let hl = half_life_ms.max(1) as f64;
    let mut scored: Vec<(f64, &MemoryRow)> = rows
        .iter()
        .filter(|r| r.state.is_durable() && r.confidence.auto_usable())
        .filter(|r| r.content.as_deref().is_some_and(|c| !c.is_empty()))
        .map(|r| {
            let anchor = r.confirmed_at.unwrap_or(r.created_at);
            // Clamp age to >= 0 so future-dated (clock-skew) rows never exceed 1.0.
            let age = (now_ms - anchor).max(0) as f64;
            let score = 0.5_f64.powf(age / hl);
            (score, r)
        })
        .collect();
    // Highest score first; deterministic tie-break by recency then id.
    scored.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then(b.1.confirmed_at.cmp(&a.1.confirmed_at))
            .then(a.1.memory_id.cmp(&b.1.memory_id))
    });
    scored
        .into_iter()
        .take(top_k)
        .map(|(score, r)| {
            let (content, kinds) = redact_pii(r.content.as_deref().unwrap_or(""));
            RecalledMemory {
                memory_id: r.memory_id.clone(),
                content,
                score,
                sensitive: r.sensitive,
                redacted: !kinds.is_empty(),
            }
        })
        .collect()
}

/// Default blend weight on FTS5 keyword relevance in the hybrid recall score (the rest is
/// recency). `0.6` keyword + `0.4` recency: high enough that a strongly keyword-relevant but
/// OLDER memory out-ranks a recent-but-irrelevant one (the whole point of hybrid recall —
/// recency-only would drop the relevant item), while recency still breaks ties among
/// comparably-relevant items and a zero-keyword-match item degrades gracefully to its recency
/// score scaled by `(1 - weight)`. A weight in `[0, 1]`; `0.0` reproduces recency-only.
pub const DEFAULT_FTS_WEIGHT: f64 = 0.6;

/// Build a SAFE FTS5 `MATCH` query string from raw query text (e.g. the current task/question).
///
/// Raw user text fed straight to `MATCH` throws `fts5: syntax error` on punctuation, quotes, a
/// bare `*`, or the bareword keywords `AND`/`OR`/`NOT`/`NEAR`. So we TOKENIZE on
/// non-alphanumeric boundaries (keeping Unicode letters/digits, so CJK runs survive as tokens),
/// DROP empty tokens, wrap EACH surviving token in double quotes (an FTS5 "string" — which is
/// matched literally and cannot be a syntax keyword or operator), and join them with ` OR ` so
/// ANY token matching contributes (recall is best-effort relevance, not a conjunctive search).
/// An embedded `"` in a token is escaped FTS5-style (doubled) so it can never break out of the
/// quoted string.
///
/// Returns `None` when there is NO usable token (empty/blank/punctuation-only query) — the
/// caller then SKIPS FTS entirely and falls back to recency-only (byte-identical to today). This
/// is the invariant that makes flag-ON-with-empty-query degrade exactly to the OFF path.
pub fn build_fts_match_query(raw: &str) -> Option<String> {
    let tokens: Vec<String> = raw
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        // Quote each token as an FTS5 string literal; double any embedded quote.
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if tokens.is_empty() {
        return None;
    }
    Some(tokens.join(" OR "))
}

/// HYBRID rank: blend FTS5 keyword relevance (`keyword_scores`, raw `bm25` keyed by `memory_id`
/// — MORE-NEGATIVE = BETTER) with the SAME recency-decay [`rank_recall`] uses, over the SAME
/// owner-scoped candidate `rows`. Caps at `top_k`, redacts PII identically.
///
/// This is a SIBLING of [`rank_recall`], not a replacement: the flag-OFF path still calls
/// `rank_recall` unchanged (byte-identical). The blend NEVER widens the candidate set — it only
/// re-orders `rows` (already owner-scoped + Confirmed + content-bearing by the SQL), so
/// owner-isolation is INHERITED from the caller's query; a `keyword_scores` entry for a row that
/// is not in `rows` is simply ignored (it can never inject).
///
/// Blend (all per-candidate, in `[0, 1]`):
/// - `recency` = `0.5^(age / half_life)` — identical to `rank_recall`.
/// - `keyword` = the candidate's `bm25` NEGATED (so larger = better) then MIN-MAX normalized
///   over the candidate set's matched scores to `[0, 1]`; a candidate with NO `bm25` entry (no
///   keyword match) gets `keyword = 0.0`. If only one candidate matched (or all matched scores
///   are equal), every matched candidate gets `keyword = 1.0` (min==max ⇒ no spread to scale).
/// - `score` = `fts_weight * keyword + (1 - fts_weight) * recency`.
///
/// `fts_weight` is clamped to `[0, 1]`. With `fts_weight = 0.0` the score is exactly the
/// recency term and the ordering matches `rank_recall` (the OFF-equivalent, useful as a test
/// oracle). The deterministic tie-break is the SAME as `rank_recall` (recency `confirmed_at`
/// desc, then `memory_id`), so equal blended scores order identically.
pub fn rank_recall_hybrid(
    rows: &[MemoryRow],
    keyword_scores: &std::collections::HashMap<String, f64>,
    now_ms: i64,
    top_k: usize,
    half_life_ms: i64,
    fts_weight: f64,
) -> Vec<RecalledMemory> {
    let hl = half_life_ms.max(1) as f64;
    let w = fts_weight.clamp(0.0, 1.0);

    // First pass: keep only durable, auto-usable, content-bearing rows (SAME filter as
    // `rank_recall`'s defense-in-depth) and compute each row's recency + raw (negated) bm25.
    struct Scored<'a> {
        row: &'a MemoryRow,
        recency: f64,
        // Negated bm25 (larger = better) for matched rows; `None` ⇒ no keyword match.
        kw_raw: Option<f64>,
    }
    let mut scored: Vec<Scored> = rows
        .iter()
        .filter(|r| r.state.is_durable() && r.confidence.auto_usable())
        .filter(|r| r.content.as_deref().is_some_and(|c| !c.is_empty()))
        .map(|r| {
            let anchor = r.confirmed_at.unwrap_or(r.created_at);
            let age = (now_ms - anchor).max(0) as f64;
            let recency = 0.5_f64.powf(age / hl);
            // bm25 is more-negative-better; negate so larger = better.
            let kw_raw = keyword_scores.get(&r.memory_id).map(|bm25| -bm25);
            Scored {
                row: r,
                recency,
                kw_raw,
            }
        })
        .collect();

    // Min-max normalize the MATCHED keyword scores over the candidate set to `[0, 1]`.
    let matched: Vec<f64> = scored.iter().filter_map(|s| s.kw_raw).collect();
    let kw_min = matched.iter().cloned().fold(f64::INFINITY, f64::min);
    let kw_max = matched.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let spread = kw_max - kw_min;
    let normalize_kw = |kw_raw: Option<f64>| -> f64 {
        match kw_raw {
            // No keyword match ⇒ 0 keyword relevance (degrades to recency * (1 - w)).
            None => 0.0,
            Some(v) => {
                if spread > 0.0 {
                    (v - kw_min) / spread
                } else {
                    // Single match, or all matched scores equal: full keyword relevance.
                    1.0
                }
            }
        }
    };

    let mut blended: Vec<(f64, &MemoryRow)> = scored
        .iter_mut()
        .map(|s| {
            let keyword = normalize_kw(s.kw_raw);
            let score = w * keyword + (1.0 - w) * s.recency;
            (score, s.row)
        })
        .collect();

    // Highest blended score first; SAME deterministic tie-break as `rank_recall`.
    blended.sort_by(|a, b| {
        b.0.total_cmp(&a.0)
            .then(b.1.confirmed_at.cmp(&a.1.confirmed_at))
            .then(a.1.memory_id.cmp(&b.1.memory_id))
    });
    blended
        .into_iter()
        .take(top_k)
        .map(|(score, r)| {
            let (content, kinds) = redact_pii(r.content.as_deref().unwrap_or(""));
            RecalledMemory {
                memory_id: r.memory_id.clone(),
                content,
                score,
                sensitive: r.sensitive,
                redacted: !kinds.is_empty(),
            }
        })
        .collect()
}

/// Outcome of gating a recall set for injection — a hash-chainable receipt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecallReceipt {
    /// Memories that passed cognition (ranked + redacted) and were CONSIDERED.
    pub recalled: usize,
    /// Of those, the count that cleared the Context Passport gate and were injected.
    pub injected: usize,
    /// Dropped by the gate (a `sensitive` memory with no transfer approval).
    pub gated_sensitive: usize,
    /// The `memory_id`s actually injected (the receipt's payload).
    pub injected_ids: Vec<String>,
}

/// Build the recall preamble by applying the Context Passport gate PER ITEM — the
/// REAL runtime control (`07` §10), not a pre-filter or a `debug_assert`. A recalled
/// memory is injected ONLY if [`friday_core::gate_transfer`] clears it: the secret-KIND
/// hard block AND the sensitive-needs-approval rule both run. In v1 `approved_sensitive`
/// is `false` (no sensitive-transfer approval is wired — deny-all), so a `sensitive`
/// memory drops itself while the rest still inject (no all-or-nothing). The injected
/// `content` is already PII-redacted by [`rank_recall`]. Returns the preamble (empty
/// if nothing injects) + a [`RecallReceipt`].
pub fn gate_and_render_recall(
    ranked: &[RecalledMemory],
    approved_sensitive: bool,
) -> (String, RecallReceipt) {
    let mut lines: Vec<String> = Vec::new();
    let mut injected_ids: Vec<String> = Vec::new();
    let mut gated_sensitive = 0usize;
    for m in ranked {
        // A MemorySnippet is never a secret-KIND, so the gate fires only on the
        // sensitive rule here — but routing through the real gate means a future
        // secret-bearing kind is blocked by construction, not by this call site.
        let item = PassportItem {
            kind: PassportItemKind::MemorySnippet,
            label: m.content.clone(),
            included: true,
            sensitive: m.sensitive,
        };
        if gate_transfer(std::slice::from_ref(&item), approved_sensitive).is_ok() {
            lines.push(format!("- {}", m.content));
            injected_ids.push(m.memory_id.clone());
        } else {
            gated_sensitive += 1;
        }
    }
    let preamble = if lines.is_empty() {
        String::new()
    } else {
        format!(
            "Relevant confirmed memory for this user (use only if helpful; do not repeat verbatim):\n{}\n\n",
            lines.join("\n")
        )
    };
    (
        preamble,
        RecallReceipt {
            recalled: ranked.len(),
            injected: injected_ids.len(),
            gated_sensitive,
            injected_ids,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{Confidence, MemoryScope, MemoryState};

    fn row(id: &str, content: Option<&str>, confirmed_at: Option<i64>) -> MemoryRow {
        MemoryRow {
            memory_id: id.to_string(),
            scope: MemoryScope::Global,
            content_ref: None,
            content: content.map(|c| c.to_string()),
            principal_id: Some("alice".to_string()),
            sensitive: false,
            confidence: Confidence::Confirmed,
            state: MemoryState::Confirmed,
            created_at: 0,
            confirmed_at,
        }
    }

    // --- PII redaction --------------------------------------------------------

    #[test]
    fn redacts_each_pii_kind_and_leaves_no_original_value() {
        let cases = [
            (
                "email me at alice@example.com please",
                PiiKind::Email,
                "alice@example.com",
            ),
            ("ssn 123-45-6789 on file", PiiKind::Ssn, "123-45-6789"),
            ("call 212-555-0143 today", PiiKind::Phone, "212-555-0143"),
            // 4111 1111 1111 1111 is a Luhn-valid test card.
            (
                "card 4111 1111 1111 1111 charged",
                PiiKind::CreditCard,
                "4111 1111 1111 1111",
            ),
        ];
        for (input, kind, raw) in cases {
            let (out, kinds) = redact_pii(input);
            assert!(kinds.contains(&kind), "{input:?} should detect {kind:?}");
            assert!(
                out.contains(kind.tag()),
                "{input:?} should contain {}",
                kind.tag()
            );
            assert!(
                !out.contains(raw),
                "the raw PII {raw:?} must not survive in {out:?}"
            );
        }
    }

    #[test]
    fn invalid_luhn_digit_run_is_not_redacted_as_a_card() {
        // 16 digits but Luhn-INVALID (last digit wrong) — must NOT be redacted.
        let (out, kinds) = redact_pii("ref 4111 1111 1111 1112 here");
        assert!(
            !kinds.contains(&PiiKind::CreditCard),
            "a Luhn-invalid digit run must not be treated as a card: {kinds:?}"
        );
        assert!(out.contains("4111 1111 1111 1112"));
    }

    #[test]
    fn luhn_accepts_valid_rejects_invalid() {
        assert!(luhn_valid("4111111111111111"));
        assert!(luhn_valid("5500005555555559"));
        assert!(!luhn_valid("4111111111111112"));
        assert!(!luhn_valid("1234567812345678"));
        assert!(!luhn_valid("411111")); // too short
    }

    #[test]
    fn no_pii_is_unchanged() {
        let (out, kinds) = redact_pii("prefers rust for new services");
        assert_eq!(out, "prefers rust for new services");
        assert!(kinds.is_empty());
    }

    #[test]
    fn cjk_adjacent_pii_is_redacted_not_leaked() {
        // Idiomatic Chinese writes no space between a label and the value. With a
        // Unicode `\b` these would LEAK (CJK + ASCII are both word chars → no
        // boundary fires); the ASCII `(?-u:\b)` boundary redacts them.
        let cases = [
            (
                "邮箱alice@example.com是我的",
                "alice@example.com",
                PiiKind::Email,
            ),
            ("电话212-555-0143打来", "212-555-0143", PiiKind::Phone),
            ("社保123-45-6789记录", "123-45-6789", PiiKind::Ssn),
        ];
        for (input, raw, kind) in cases {
            let (out, kinds) = redact_pii(input);
            assert!(
                kinds.contains(&kind),
                "{input:?} should detect {kind:?}, got {kinds:?}"
            );
            assert!(
                !out.contains(raw),
                "CJK-adjacent PII leaked: {raw:?} survived in {out:?}"
            );
        }
    }

    #[test]
    fn multibyte_prefix_does_not_corrupt_or_panic() {
        // A 4-byte emoji + 3-byte CJK before the match — byte offsets must stay on
        // char boundaries (replace_range would panic otherwise).
        let (out, kinds) = redact_pii("😀你好 alice@example.com 123-45-6789");
        assert!(kinds.contains(&PiiKind::Email) && kinds.contains(&PiiKind::Ssn));
        assert!(out.starts_with("😀你好 "));
        assert!(!out.contains("alice@example.com") && !out.contains("123-45-6789"));
    }

    #[test]
    fn multi_separator_credit_card_is_caught() {
        // " - " between groups (multiple separators) — `[ -]*` matches the oracle.
        let (out, kinds) = redact_pii("card 4111 - 1111 - 1111 - 1111 ok");
        assert!(
            kinds.contains(&PiiKind::CreditCard),
            "multi-sep card missed: {kinds:?}"
        );
        assert!(!out.contains("4111 - 1111 - 1111 - 1111"));
    }

    #[test]
    fn multiple_pii_in_one_string_all_redacted() {
        let (out, kinds) = redact_pii("alice@example.com / ssn 123-45-6789");
        assert!(kinds.contains(&PiiKind::Email) && kinds.contains(&PiiKind::Ssn));
        assert!(!out.contains("alice@example.com") && !out.contains("123-45-6789"));
        assert!(out.contains("[EMAIL]") && out.contains("[SSN]"));
    }

    #[test]
    fn card_followed_by_separator_joined_digits_is_still_redacted() {
        // Regression: the greedy card candidate annexes a trailing separator-joined
        // group, so the whole span fails Luhn. The real PAN must STILL be redacted (the
        // longest Luhn-valid sub-window), not dropped. 4012888888881881 is a Luhn-valid
        // Visa test number.
        for (input, leak) in [
            ("card 4012888888881881 000-00-0000", "4012888888881881"),
            ("4242424242424242 111 22 3333", "4242424242424242"),
            ("4111 1111 1111 1111 123-45-6789", "4111 1111 1111 1111"),
        ] {
            let (out, kinds) = redact_pii(input);
            assert!(
                kinds.contains(&PiiKind::CreditCard),
                "{input:?} must report a card, got {kinds:?}"
            );
            assert!(
                !out.contains(leak),
                "PAN {leak:?} leaked through in {out:?}"
            );
        }
    }

    #[test]
    fn pii_glued_to_a_trailing_ascii_char_is_still_redacted() {
        // The trailing-boundary under-match: a sender glues a digit/word char right
        // after the value to evade redaction. The value must still be stripped.
        let (out, kinds) = redact_pii("mail alice@example.com123 end");
        assert!(kinds.contains(&PiiKind::Email));
        assert!(!out.contains("alice@example.com"), "email leaked: {out:?}");

        let (out, kinds) = redact_pii("ssn 123-45-67890 ok");
        assert!(kinds.contains(&PiiKind::Ssn));
        assert!(!out.contains("123-45-6789"), "ssn leaked: {out:?}");
    }

    // --- ranking --------------------------------------------------------------

    #[test]
    fn rank_orders_by_recency_and_caps_at_top_k() {
        let now = 1_000_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        let rows = vec![
            row("old", Some("old fact"), Some(now - 90 * day)),
            row("recent", Some("recent fact"), Some(now - day)),
            row("mid", Some("mid fact"), Some(now - 30 * day)),
        ];
        let ranked = rank_recall(&rows, now, 2, DEFAULT_HALF_LIFE_MS);
        // top_k=2: the two most-recent, recency-ordered; "old" is dropped.
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].memory_id, "recent");
        assert_eq!(ranked[1].memory_id, "mid");
        // scores strictly decrease with age and stay in (0, 1].
        assert!(ranked[0].score > ranked[1].score);
        assert!(ranked[0].score <= 1.0 && ranked[1].score > 0.0);
    }

    #[test]
    fn rank_drops_non_auto_usable_defense_in_depth() {
        let now = 1_000_000;
        // A row that (anomalously) reached this layer as a Candidate — must be dropped
        // (a candidate is never recalled as a fact, `07` §9), even though SQL filters it.
        let mut candidate = row("cand", Some("unconfirmed"), Some(now));
        candidate.state = MemoryState::Candidate;
        candidate.confidence = Confidence::Candidate;
        let confirmed = row("ok", Some("real"), Some(now));
        let ranked = rank_recall(&[candidate, confirmed], now, 10, DEFAULT_HALF_LIFE_MS);
        let ids: Vec<&str> = ranked.iter().map(|r| r.memory_id.as_str()).collect();
        assert_eq!(ids, vec!["ok"]);
    }

    #[test]
    fn rank_drops_empty_and_missing_content() {
        let now = 1_000_000;
        let ranked = rank_recall(
            &[
                row("none", None, Some(now)),
                row("empty", Some(""), Some(now)),
                row("ok", Some("real"), Some(now)),
            ],
            now,
            10,
            DEFAULT_HALF_LIFE_MS,
        );
        assert_eq!(ranked.len(), 1);
        assert_eq!(ranked[0].memory_id, "ok");
    }

    #[test]
    fn rank_redacts_pii_and_carries_sensitive_flag() {
        let now = 1_000_000;
        let mut r = row("pii", Some("reach me at alice@example.com"), Some(now));
        r.sensitive = true;
        let ranked = rank_recall(&[r], now, 10, DEFAULT_HALF_LIFE_MS);
        assert_eq!(ranked.len(), 1);
        assert!(ranked[0].redacted);
        assert!(ranked[0].sensitive);
        assert!(ranked[0].content.contains("[EMAIL]"));
        assert!(!ranked[0].content.contains("alice@example.com"));
    }

    // --- Passport-gated render ------------------------------------------------

    fn recalled(id: &str, content: &str, sensitive: bool) -> RecalledMemory {
        RecalledMemory {
            memory_id: id.to_string(),
            content: content.to_string(),
            score: 1.0,
            sensitive,
            redacted: false,
        }
    }

    #[test]
    fn gate_injects_nonsensitive_and_drops_sensitive_under_deny_all() {
        let ranked = vec![
            recalled("a", "alice likes rust", false),
            recalled("s", "alice home address", true), // sensitive
            recalled("b", "alice ships fridays", false),
        ];
        // v1 deny-all: no sensitive-transfer approval.
        let (preamble, receipt) = gate_and_render_recall(&ranked, false);
        assert_eq!(receipt.recalled, 3);
        assert_eq!(receipt.injected, 2);
        assert_eq!(receipt.gated_sensitive, 1);
        assert_eq!(receipt.injected_ids, vec!["a".to_string(), "b".to_string()]);
        // the non-sensitive content is in the preamble; the sensitive content is NOT.
        assert!(preamble.contains("alice likes rust") && preamble.contains("alice ships fridays"));
        assert!(
            !preamble.contains("alice home address"),
            "a sensitive memory must NOT be injected under deny-all: {preamble:?}"
        );
    }

    #[test]
    fn gate_injects_sensitive_only_when_transfer_approved() {
        let ranked = vec![recalled("s", "sensitive note", true)];
        // approved → injected
        let (yes, ry) = gate_and_render_recall(&ranked, true);
        assert_eq!(ry.injected, 1);
        assert!(yes.contains("sensitive note"));
        // not approved → gated out, empty preamble
        let (no, rn) = gate_and_render_recall(&ranked, false);
        assert_eq!(rn.injected, 0);
        assert_eq!(rn.gated_sensitive, 1);
        assert!(no.is_empty());
    }

    #[test]
    fn gate_empty_recall_is_empty_preamble() {
        let (preamble, receipt) = gate_and_render_recall(&[], false);
        assert!(preamble.is_empty());
        assert_eq!(receipt.recalled, 0);
        assert_eq!(receipt.injected, 0);
    }

    #[test]
    fn rank_future_dated_row_score_capped_at_one_and_top_k_zero_is_empty() {
        let now = 1_000_000;
        // confirmed_at in the FUTURE (clock skew): age clamps to 0 → score == 1.0.
        let future = row("future", Some("x"), Some(now + 999));
        let ranked = rank_recall(std::slice::from_ref(&future), now, 10, DEFAULT_HALF_LIFE_MS);
        assert_eq!(ranked.len(), 1);
        assert!((ranked[0].score - 1.0).abs() < 1e-9);
        // top_k == 0 recalls nothing.
        assert!(rank_recall(&[future], now, 0, DEFAULT_HALF_LIFE_MS).is_empty());
    }

    // --- hybrid recall: FTS MATCH-query builder -------------------------------

    #[test]
    fn fts_match_query_tokenizes_quotes_and_ors() {
        // Plain words → each quoted, joined by OR.
        assert_eq!(
            build_fts_match_query("rust async runtime").as_deref(),
            Some("\"rust\" OR \"async\" OR \"runtime\"")
        );
    }

    #[test]
    fn fts_match_query_neutralizes_syntax_and_keywords() {
        // Punctuation / quotes / bare `*` / the AND·OR·NOT keywords would all throw
        // `fts5: syntax error` raw; quoting each token makes them literal strings.
        let q = build_fts_match_query("alice AND NOT (bob) \"x\" *").unwrap();
        // Every token is a quoted string literal — no bareword operator survives.
        assert_eq!(q, "\"alice\" OR \"AND\" OR \"NOT\" OR \"bob\" OR \"x\"");
        // The embedded-quote token would be escaped (doubled) — exercise it directly.
        let q2 = build_fts_match_query("say\"hi").unwrap();
        // split on non-alphanumeric splits the `"` so we get two tokens here; the point is
        // no token can break out of its quoting.
        assert!(q2.starts_with('"') && q2.ends_with('"'));
        assert!(!q2.contains("\"hi\" OR") || q2.contains("\"say\""));
    }

    #[test]
    fn fts_match_query_empty_or_punctuation_only_is_none() {
        // No usable token ⇒ None ⇒ caller falls back to recency-only (byte-identical OFF path).
        assert_eq!(build_fts_match_query(""), None);
        assert_eq!(build_fts_match_query("   "), None);
        assert_eq!(build_fts_match_query("!@#$ %^&*()"), None);
    }

    #[test]
    fn fts_match_query_keeps_cjk_tokens() {
        // CJK runs are alphanumeric to `char::is_alphanumeric`, so they survive as tokens.
        let q = build_fts_match_query("喜欢 rust").unwrap();
        assert_eq!(q, "\"喜欢\" OR \"rust\"");
    }

    // --- hybrid recall: the blend ranking -------------------------------------

    /// THE CORE PROOF: a keyword-relevant but OLDER memory surfaces into top_k under the
    /// hybrid blend, where recency-only would drop it for newer-but-irrelevant memories.
    #[test]
    fn hybrid_surfaces_keyword_relevant_older_item_recency_only_would_miss() {
        let now = 1_000_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        // "old_relevant" is the keyword match but 90 days old; two recent-but-irrelevant rows.
        let rows = vec![
            row("recent_a", Some("today's grocery list"), Some(now - day)),
            row("recent_b", Some("weather is sunny"), Some(now - 2 * day)),
            row(
                "old_relevant",
                Some("prefers the rust async runtime tokio"),
                Some(now - 90 * day),
            ),
        ];

        // Recency-only, top_k=2: the OLD relevant item is dropped (the bug hybrid fixes).
        let recency = rank_recall(&rows, now, 2, DEFAULT_HALF_LIFE_MS);
        let recency_ids: Vec<&str> = recency.iter().map(|r| r.memory_id.as_str()).collect();
        assert_eq!(recency_ids, vec!["recent_a", "recent_b"]);
        assert!(
            !recency_ids.contains(&"old_relevant"),
            "recency-only must drop the old item — that is the gap hybrid closes"
        );

        // Hybrid, top_k=2: a strong keyword match on "old_relevant" (very negative bm25 =
        // strong) and no match on the others ⇒ it surfaces into the top.
        let mut scores = std::collections::HashMap::new();
        scores.insert("old_relevant".to_string(), -5.0_f64); // strong keyword match
                                                             // the recent rows have NO keyword match (absent from the map ⇒ keyword=0).
        let hybrid = rank_recall_hybrid(
            &rows,
            &scores,
            now,
            2,
            DEFAULT_HALF_LIFE_MS,
            DEFAULT_FTS_WEIGHT,
        );
        let hybrid_ids: Vec<&str> = hybrid.iter().map(|r| r.memory_id.as_str()).collect();
        assert!(
            hybrid_ids.contains(&"old_relevant"),
            "hybrid must surface the keyword-relevant older item: got {hybrid_ids:?}"
        );
        // It should rank FIRST (full keyword weight 0.6 > any pure-recency row's 0.4*recency).
        assert_eq!(hybrid_ids[0], "old_relevant");
    }

    #[test]
    fn hybrid_weight_zero_matches_recency_only_ordering() {
        // fts_weight = 0 ⇒ the blend is pure recency; ordering must equal rank_recall.
        let now = 1_000_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        let rows = vec![
            row("r1", Some("alpha"), Some(now - day)),
            row("r2", Some("beta"), Some(now - 10 * day)),
            row("r3", Some("gamma"), Some(now - 100 * day)),
        ];
        // Even with a keyword score present, weight 0 ignores it.
        let mut scores = std::collections::HashMap::new();
        scores.insert("r3".to_string(), -9.0_f64);
        let recency = rank_recall(&rows, now, 10, DEFAULT_HALF_LIFE_MS);
        let hybrid0 = rank_recall_hybrid(&rows, &scores, now, 10, DEFAULT_HALF_LIFE_MS, 0.0);
        let r_ids: Vec<&str> = recency.iter().map(|r| r.memory_id.as_str()).collect();
        let h_ids: Vec<&str> = hybrid0.iter().map(|r| r.memory_id.as_str()).collect();
        assert_eq!(
            r_ids, h_ids,
            "weight=0 must reproduce recency-only ordering"
        );
    }

    #[test]
    fn hybrid_inherits_filter_and_redaction_and_top_k() {
        let now = 1_000_000;
        // A non-confirmed row leaked into the candidate set must STILL be dropped (same
        // defense-in-depth as rank_recall), and PII still redacted.
        let mut candidate = row("cand", Some("unconfirmed"), Some(now));
        candidate.state = MemoryState::Candidate;
        candidate.confidence = Confidence::Candidate;
        let pii = row("pii", Some("email alice@example.com"), Some(now));
        let mut scores = std::collections::HashMap::new();
        scores.insert("cand".to_string(), -8.0_f64); // strong match — must STILL be dropped
        scores.insert("pii".to_string(), -3.0_f64);
        let ranked = rank_recall_hybrid(
            &[candidate, pii],
            &scores,
            now,
            10,
            DEFAULT_HALF_LIFE_MS,
            DEFAULT_FTS_WEIGHT,
        );
        let ids: Vec<&str> = ranked.iter().map(|r| r.memory_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["pii"],
            "a non-confirmed candidate is never recalled"
        );
        assert!(ranked[0].redacted);
        assert!(ranked[0].content.contains("[EMAIL]"));
        assert!(!ranked[0].content.contains("alice@example.com"));
    }

    #[test]
    fn hybrid_no_keyword_match_falls_back_to_recency_ordering() {
        // Empty score map ⇒ every keyword term = 0 ⇒ score = (1-w)*recency ⇒ recency ordering.
        let now = 1_000_000_000_000;
        let day = 24 * 60 * 60 * 1000;
        let rows = vec![
            row("new", Some("a"), Some(now - day)),
            row("old", Some("b"), Some(now - 50 * day)),
        ];
        let empty = std::collections::HashMap::new();
        let hybrid = rank_recall_hybrid(
            &rows,
            &empty,
            now,
            10,
            DEFAULT_HALF_LIFE_MS,
            DEFAULT_FTS_WEIGHT,
        );
        let ids: Vec<&str> = hybrid.iter().map(|r| r.memory_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["new", "old"],
            "no match ⇒ recency ordering preserved"
        );
    }
}
