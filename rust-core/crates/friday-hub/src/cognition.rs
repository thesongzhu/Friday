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
//! **Honest scope:** there is NO semantic / embedding / FTS recall here. The
//! oracle's hybrid vector search (`friday-memory-hybrid.ts`) has no Rust
//! counterpart — that is greenfield / NO-GO and is NOT claimed. Relevance here is
//! recency-decay only; the SQL query already did the same-principal + Confirmed +
//! content-bearing filtering, so this layer adds bounded ranking, a
//! defense-in-depth trust re-check, and redaction.
//!
//! **PII-port fidelity (honest deviations from the oracle PII guard):**
//! - **SSN** drops the oracle's invalid-prefix look-aheads (the Rust engine is
//!   look-around-free) → matches the plain 3-2-4 shape (over-match, safe).
//! - **Boundaries** use `(?-u:\b)` (ASCII), matching the oracle's ASCII-`\b`, so
//!   CJK-adjacent PII redacts. A plain Unicode `\b` would LEAK it.
//! - **Phone** requires a full 10 digits; the oracle also matches bare 7-digit
//!   locals. This is a DELIBERATE under-match — a bare 7-digit pattern would
//!   over-redact benign numbers; disclosed, not a parity claim.
//! - **Glued ASCII tokens** (e.g. an email TLD immediately followed by a digit
//!   run, no separator) under-match — inherited from the oracle's `\b` (both
//!   ASCII and Unicode `\b` agree there is no boundary mid-token). Not introduced.
//!
//! Redaction is defense-in-depth; the Context Passport sensitive-flag gate is the
//! primary control and is NOT replaced by this.

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
            (
                PiiKind::Email,
                Regex::new(r"(?i)(?-u:\b)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}(?-u:\b)").unwrap(),
            ),
            // SSN: 3-2-4 nine-digit shape. (The oracle additionally excludes invalid
            // prefixes via look-ahead; the Rust `regex` crate is look-around-free, so
            // we match the plain shape. Over-matching a non-SSN 9-digit run is the
            // SAFE direction for a privacy-redaction boundary — under-matching, which
            // would leak a real SSN, is the dangerous one.)
            (
                PiiKind::Ssn,
                Regex::new(r"(?-u:\b)\d{3}[- ]?\d{2}[- ]?\d{4}(?-u:\b)").unwrap(),
            ),
            // Credit-card candidate: 13–19 digits with any space/dash separators
            // between them (`[ -]*`, matching the oracle, so a multi-separator card
            // like `4111 - 1111 - 1111 - 1111` is still caught). Luhn-validated in
            // `redact_pii` so arbitrary long digit runs are NOT redacted as cards.
            (
                PiiKind::CreditCard,
                Regex::new(r"(?-u:\b)(?:\d[ -]*){13,19}(?-u:\b)").unwrap(),
            ),
            // North-American phone (10 digits, optional +1 / grouping / separators).
            (
                PiiKind::Phone,
                Regex::new(
                    r"(?-u:\b)(?:\+1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?[2-9]\d{2}[-.\s]?\d{4}(?-u:\b)",
                )
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
            if *kind == PiiKind::CreditCard && !luhn_valid(m.as_str()) {
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
}
