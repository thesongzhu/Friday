//! Token/model ledger entry shape (gate 21 §2.1 `token_ledger` / §6).
//!
//! Every model call writes exactly one ledger row. For the first slice the only
//! provider is DeepSeek and the Friday route must record `fallback = false`
//! (no silent substitute provider — 15 §4, 02 §13). `LedgerEntry::friday_route`
//! constructs an entry with `fallback` hard-wired to `false` so a caller cannot
//! accidentally ledger a hidden fallback as a Friday-route call.

use crate::error::CoreError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProviderKind {
    DeepSeek,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::DeepSeek => "deepseek",
        }
    }
}

/// One token/model ledger row (read projection + Hub authoritative write).
#[derive(Clone, Debug, PartialEq)]
pub struct LedgerEntry {
    pub ledger_id: String,
    pub session_id: String,
    pub activity_id: String,
    pub provider_kind: ProviderKind,
    pub model: String,
    pub base_url_host: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cost_estimate: Option<f64>,
    /// Whether a fallback provider was used. The Friday route requires `false`.
    pub fallback: bool,
    pub result_link: Option<String>,
    pub created_at: i64,
}

impl LedgerEntry {
    /// Build a ledger entry, computing `total_tokens` and validating inputs.
    ///
    /// `total_tokens` is always `prompt + completion` (never caller-supplied),
    /// so it cannot disagree with the parts. Negative counts are rejected.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        ledger_id: impl Into<String>,
        session_id: impl Into<String>,
        activity_id: impl Into<String>,
        provider_kind: ProviderKind,
        model: impl Into<String>,
        base_url_host: impl Into<String>,
        prompt_tokens: i64,
        completion_tokens: i64,
        cost_estimate: Option<f64>,
        fallback: bool,
        result_link: Option<String>,
        created_at: i64,
    ) -> Result<LedgerEntry, CoreError> {
        if prompt_tokens < 0 || completion_tokens < 0 {
            return Err(CoreError::InvalidLedger(format!(
                "token counts must be non-negative (prompt={prompt_tokens}, completion={completion_tokens})"
            )));
        }
        let total_tokens = prompt_tokens
            .checked_add(completion_tokens)
            .ok_or_else(|| CoreError::InvalidLedger("token total overflow".into()))?;
        Ok(LedgerEntry {
            ledger_id: ledger_id.into(),
            session_id: session_id.into(),
            activity_id: activity_id.into(),
            provider_kind,
            model: model.into(),
            base_url_host: base_url_host.into(),
            prompt_tokens,
            completion_tokens,
            total_tokens,
            cost_estimate,
            fallback,
            result_link,
            created_at,
        })
    }

    /// A DeepSeek Friday-route entry. `fallback` is hard-wired to `false`.
    #[allow(clippy::too_many_arguments)]
    pub fn friday_route(
        ledger_id: impl Into<String>,
        session_id: impl Into<String>,
        activity_id: impl Into<String>,
        model: impl Into<String>,
        prompt_tokens: i64,
        completion_tokens: i64,
        cost_estimate: Option<f64>,
        result_link: Option<String>,
        created_at: i64,
    ) -> Result<LedgerEntry, CoreError> {
        LedgerEntry::new(
            ledger_id,
            session_id,
            activity_id,
            ProviderKind::DeepSeek,
            model,
            "api.deepseek.com",
            prompt_tokens,
            completion_tokens,
            cost_estimate,
            false, // fallback: never true on the Friday route
            result_link,
            created_at,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn total_is_always_sum_of_parts() {
        let e = LedgerEntry::new(
            "l1",
            "s1",
            "a1",
            ProviderKind::DeepSeek,
            "deepseek-v4-flash",
            "api.deepseek.com",
            11,
            8,
            None,
            false,
            None,
            1000,
        )
        .unwrap();
        assert_eq!(e.total_tokens, 19);
        assert_eq!(e.provider_kind.as_str(), "deepseek");
    }

    #[test]
    fn negative_tokens_rejected() {
        let err = LedgerEntry::new(
            "l1",
            "s1",
            "a1",
            ProviderKind::DeepSeek,
            "m",
            "h",
            -1,
            8,
            None,
            false,
            None,
            0,
        )
        .unwrap_err();
        assert!(matches!(err, CoreError::InvalidLedger(_)));
    }

    #[test]
    fn friday_route_is_never_fallback() {
        let e = LedgerEntry::friday_route(
            "l2",
            "s1",
            "a1",
            "deepseek-v4-flash",
            100,
            50,
            Some(0.0003),
            None,
            2000,
        )
        .unwrap();
        assert!(!e.fallback);
        assert_eq!(e.base_url_host, "api.deepseek.com");
        assert_eq!(e.total_tokens, 150);
    }
}
