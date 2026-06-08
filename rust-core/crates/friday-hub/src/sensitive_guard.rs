//! Sensitive-learning guard — ported from the TS oracle
//! `src/learning/services/friday-sensitive-learning-guard.ts`.
//!
//! A learned/extracted memory item is a SENSITIVE candidate if its text matches the
//! high-risk pattern (passwords, credentials, tokens, SSN/credit-card/bank words,
//! identity documents, medical/financial/political/religious traits — plus the
//! Chinese-language equivalents). The session-memory extraction engine DROPS a
//! matched item (never stores it), exactly as the TS `processInline` does — so no
//! sensitive raw content is persisted (`07` §6/§7, `02` §7).
//!
//! ## Port fidelity (honest deviations from the TS regex)
//! The TS pattern is one alternation:
//!   `\b(password|...|political)\b | 密码|口令|...|政治`  (flags `iu`).
//! The English half is `\b`-bounded; the CJK half is bare (no `\b`).
//! - **English boundary** uses the ASCII word boundary `(?-u:\b)`, NOT a plain `\b`.
//!   The Rust `regex` crate's `\b` is Unicode-aware (a CJK char is a word char), so a
//!   plain `\b` would NOT fire between a CJK char and an adjacent ASCII keyword
//!   (`密码password`) and would MISS it. `(?-u:\b)` restores the oracle's ASCII-`\b`
//!   semantics (CJK acts as a boundary) — the SAME precedent `cognition::redact_pii`
//!   sets and for the same operator-language reason.
//! - **CJK terms stay bare substrings** (no boundary), matching the TS exactly.
//! - The pattern is look-around-free, so it compiles in the Rust engine unchanged
//!   in structure.

use regex::Regex;
use std::sync::OnceLock;

/// The compiled sensitive-learning pattern (ported from `SENSITIVE_LEARNING_PATTERN`).
/// Case-insensitive (`(?i)`). English keywords are `(?-u:\b)`-bounded; the Chinese
/// terms are bare substrings.
fn sensitive_pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(password|passcode|secret|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|token|credential|private[\s_-]*key|ssn|social[\s_]+security|credit[\s_]+card|bank[\s_]+account|routing[\s_]+number|passport|(?:driver'?s|driver[\s_]+s)[\s_]+license|medical|medication|diagnosis|diabetes|cancer|hiv|financial|religion|political)(?-u:\b)|密码|口令|密钥|令牌|身份证|护照|银行卡|信用卡|病历|诊断|宗教|政治",
        )
        .expect("sensitive-learning pattern is a valid regex")
    })
}

/// Whether the joined text of `values` is a sensitive-learning candidate (ported
/// from `isFridaySensitiveLearningCandidate`). The TS variadic joins all values
/// (content + tags + source texts) with a space and tests the pattern; this takes
/// the already-collected string slices and does the same.
pub fn is_sensitive_learning_candidate(values: &[&str]) -> bool {
    let joined = values
        .iter()
        .filter(|v| !v.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join(" ");
    sensitive_pattern().is_match(&joined)
}

/// The TS rejection message constant, ported verbatim
/// (`FRIDAY_SENSITIVE_LEARNING_REJECTION`).
pub const SENSITIVE_LEARNING_REJECTION: &str = "Sensitive or high-risk preferences are not persisted automatically. Keep them out of learned facts and use an explicit review or user-approved secret surface where one is available.";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_english_keywords() {
        for s in [
            "my password is on file",
            "the API key rotation policy",
            "an access token was issued",
            "store the credential safely",
            "his SSN is recorded",
            "her credit card on file",
            "a medical diagnosis was noted",
            "political affiliation",
        ] {
            assert!(
                is_sensitive_learning_candidate(&[s]),
                "should match sensitive keyword in: {s:?}"
            );
        }
    }

    #[test]
    fn matches_chinese_terms() {
        for s in ["这是我的密码", "银行卡号码", "宗教信仰", "我的护照"] {
            assert!(
                is_sensitive_learning_candidate(&[s]),
                "should match CJK sensitive term in: {s:?}"
            );
        }
    }

    #[test]
    fn cjk_adjacent_english_keyword_is_matched_not_leaked() {
        // Idiomatic Chinese writes no space before an ASCII keyword. With a Unicode
        // `\b` this would MISS (CJK + ASCII both word chars → no boundary). The
        // ASCII `(?-u:\b)` boundary matches it.
        assert!(is_sensitive_learning_candidate(&["我的password在这里"]));
    }

    #[test]
    fn benign_text_does_not_match() {
        for s in [
            "User prefers Rust for new services.",
            "The project codename is Falcon.",
            "Ship release notes every Friday.",
            "reach me at alice@example.com", // PII but no sensitive KEYWORD
        ] {
            assert!(
                !is_sensitive_learning_candidate(&[s]),
                "benign text matched the sensitive pattern: {s:?}"
            );
        }
    }

    #[test]
    fn joins_all_values_like_the_ts_variadic() {
        // The keyword may appear in any of the joined values (content/tag/source).
        assert!(is_sensitive_learning_candidate(&[
            "benign content",
            "tag:credential",
            "src text"
        ]));
        assert!(is_sensitive_learning_candidate(&[
            "benign",
            "tag",
            "the user shared a passport number"
        ]));
        assert!(!is_sensitive_learning_candidate(&[
            "benign",
            "tag",
            "ordinary source text"
        ]));
    }

    #[test]
    fn word_boundary_avoids_substring_false_positives() {
        // `(?-u:\b)` bounds the English keywords so a benign word merely CONTAINING a
        // keyword as a substring does not match (e.g. "tokenize" ≠ "token",
        // "secretary" ≠ "secret").
        assert!(!is_sensitive_learning_candidate(&["tokenize the input"]));
        assert!(!is_sensitive_learning_candidate(&[
            "the secretary scheduled it"
        ]));
    }
}
