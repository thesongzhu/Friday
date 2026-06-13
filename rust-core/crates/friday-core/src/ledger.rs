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
    /// (C2) The Claude/Anthropic route. Recorded so a Claude model call is NEVER
    /// mis-attributed as DeepSeek; reachable only through the gated, dark Claude
    /// path (the DeepSeek route is unchanged).
    Anthropic,
    /// (C1) The Codex app-server route. Recorded so a routed Codex model turn is
    /// NEVER mis-attributed as DeepSeek/Anthropic. The Codex turn runs through the
    /// LOCAL app-server (`provider_app_server_local`), not a remote API — see
    /// [`LedgerEntry::codex_route`] for the local host label. Identity only in C1-1
    /// (no routing wired yet); not produced by any existing path.
    Codex,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::DeepSeek => "deepseek",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Codex => "codex",
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

    /// (C2) A Claude/Anthropic route entry, mirroring [`LedgerEntry::friday_route`]
    /// but with [`ProviderKind::Anthropic`] + host `api.anthropic.com`. `fallback` is
    /// hard-wired to `false` (the Claude route is a no-fallback route, like DeepSeek).
    /// This is what keeps a Claude model call from being recorded as DeepSeek.
    #[allow(clippy::too_many_arguments)]
    pub fn anthropic_route(
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
            ProviderKind::Anthropic,
            model,
            "api.anthropic.com",
            prompt_tokens,
            completion_tokens,
            cost_estimate,
            false, // fallback: never true on the Claude route either
            result_link,
            created_at,
        )
    }

    /// (C1) A Codex app-server route entry, mirroring [`LedgerEntry::anthropic_route`]
    /// but with [`ProviderKind::Codex`]. The routed Codex turn runs through Friday's
    /// LOCAL app-server (the `provider_app_server_local` sync mode), so the host label is
    /// the local-app-server label `"provider_app_server_local"` — NOT `api.openai.com`:
    /// recording a remote API host that the routed path never calls would be a FAKE.
    /// `fallback` is hard-wired to `false` (the Codex route is a no-fallback route, like
    /// DeepSeek/Claude). This is what keeps a Codex model turn from being recorded as
    /// DeepSeek or Anthropic.
    #[allow(clippy::too_many_arguments)]
    pub fn codex_route(
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
            ProviderKind::Codex,
            model,
            // LOCAL app-server label (`friday_core::SyncMode::ProviderAppServerLocal`
            // mints this same string); the routed Codex path is the local app-server,
            // so a remote-API host here would be a fake.
            "provider_app_server_local",
            prompt_tokens,
            completion_tokens,
            cost_estimate,
            false, // fallback: never true on the Codex route either
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

    #[test]
    fn anthropic_route_ledger_entry_shape() {
        // (C2) The Claude route entry records the Anthropic provider kind + host, never
        // fallback, with the total computed from the parts.
        let e = LedgerEntry::anthropic_route(
            "l3",
            "s1",
            "a1",
            "claude-opus-4-8",
            11,
            8,
            None,
            None,
            3000,
        )
        .unwrap();
        assert_eq!(e.provider_kind, ProviderKind::Anthropic);
        assert_eq!(e.provider_kind.as_str(), "anthropic");
        assert_eq!(e.base_url_host, "api.anthropic.com");
        assert!(!e.fallback);
        assert_eq!(e.total_tokens, 19);
        assert_eq!(e.cost_estimate, None);
    }

    #[test]
    fn codex_route_ledger_entry_shape() {
        // (C1) The Codex route entry records the Codex provider kind + the LOCAL
        // app-server host label (NOT a remote API), never fallback, with the total
        // computed from the parts.
        let e = LedgerEntry::codex_route("l4", "s1", "a1", "gpt-5-codex", 11, 8, None, None, 4000)
            .unwrap();
        assert_eq!(e.provider_kind, ProviderKind::Codex);
        assert_eq!(e.provider_kind.as_str(), "codex");
        // LOCAL app-server label, never a remote API the routed path never calls.
        assert_eq!(e.base_url_host, "provider_app_server_local");
        assert_ne!(e.base_url_host, "api.openai.com");
        assert!(!e.fallback);
        assert_eq!(e.total_tokens, 19);
        assert_eq!(e.cost_estimate, None);
    }
}
