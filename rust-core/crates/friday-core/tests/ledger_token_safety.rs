//! Token-safety regression locks for `LedgerEntry` construction
//! (goal `07` token-trust, `10` §4, `02` §13).
//!
//! These tests pin the invariant that token totals are computed from the parts
//! by `LedgerEntry::new` (never trusted from a caller) and that out-of-range
//! inputs are rejected rather than silently truncated/wrapped. The inline
//! `src/ledger.rs` tests already cover the happy sum, a prompt-negative reject,
//! and the `friday_route` fallback-false hard-wire; these close the remaining
//! adverse-input cases (completion-negative, both-negative, i64 overflow) via
//! the PUBLIC crate API only.

use friday_core::{CoreError, LedgerEntry, ProviderKind};

/// Construct a non-Friday-route entry through the public `new`, varying only the
/// token counts so each test isolates the validation it exercises.
fn entry(prompt: i64, completion: i64) -> Result<LedgerEntry, CoreError> {
    LedgerEntry::new(
        "l1",
        "s1",
        "a1",
        ProviderKind::DeepSeek,
        "deepseek-v4-flash",
        "api.deepseek.com",
        prompt,
        completion,
        None,
        false,
        None,
        1000,
    )
}

#[test]
fn total_tokens_is_recomputed_not_caller_supplied() {
    // `new` takes no `total_tokens` argument; the only way to get a total is the
    // computed `prompt + completion`, so a caller cannot inject a total that
    // disagrees with the parts (token-trust: the ledger total is authoritative).
    let e = entry(123, 456).unwrap();
    assert_eq!(e.total_tokens, 579);
    assert_eq!(e.total_tokens, e.prompt_tokens + e.completion_tokens);
}

#[test]
fn negative_completion_tokens_rejected() {
    // The inline module covers a negative PROMPT; this covers the other arm so
    // neither field can smuggle a negative count into the ledger.
    let err = entry(8, -1).unwrap_err();
    assert!(matches!(err, CoreError::InvalidLedger(_)));
}

#[test]
fn both_negative_tokens_rejected() {
    let err = entry(-5, -7).unwrap_err();
    assert!(matches!(err, CoreError::InvalidLedger(_)));
}

#[test]
fn token_total_overflow_is_rejected_not_wrapped() {
    // prompt + completion would overflow i64. A checked add must surface an
    // error rather than wrap to a negative/garbage total (which would corrupt
    // every downstream cost/usage projection).
    let err = entry(i64::MAX, 1).unwrap_err();
    assert!(matches!(err, CoreError::InvalidLedger(_)));

    // The boundary itself (sum == i64::MAX) is valid and computes exactly.
    let ok = entry(i64::MAX - 1, 1).unwrap();
    assert_eq!(ok.total_tokens, i64::MAX);
}

#[test]
fn friday_route_also_recomputes_total_and_rejects_overflow() {
    // The Friday-route convenience constructor delegates to `new`, so it inherits
    // the same recompute + overflow guard (and never accepts a caller total).
    let ok = LedgerEntry::friday_route(
        "l2",
        "s1",
        "a1",
        "deepseek-v4-flash",
        100,
        50,
        None,
        None,
        1,
    )
    .unwrap();
    assert_eq!(ok.total_tokens, 150);
    assert!(!ok.fallback);

    let err = LedgerEntry::friday_route(
        "l3",
        "s1",
        "a1",
        "deepseek-v4-flash",
        i64::MAX,
        1,
        None,
        None,
        1,
    )
    .unwrap_err();
    assert!(matches!(err, CoreError::InvalidLedger(_)));
}
