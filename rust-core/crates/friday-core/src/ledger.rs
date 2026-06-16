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

/// (a#4 cost-table) Published list price for one model, in **USD per 1,000,000 tokens**,
/// split into the input (prompt) and output (completion) rates. This is the Rust spine's
/// FIRST pricing table — the split-brain note (the real cost router lives in the TS stack;
/// the Rust hub had ZERO pricing data, so every `token_ledger.cost_estimate` was NULL). It
/// is pure ATTRIBUTION data: a USD estimate stamped onto each billed row. It changes NO
/// gating, ceiling, or routing decision (those remain DEFERRED / operator-gated); it only
/// stops the cost column from being silently NULL so future cost-ordered escalation has a
/// number to order by.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelPrice {
    /// USD per 1,000,000 INPUT (prompt) tokens.
    pub input_per_1m_usd: f64,
    /// USD per 1,000,000 OUTPUT (completion) tokens.
    pub output_per_1m_usd: f64,
}

/// The per-`(provider, model)` price table. Keyed on the RESPONSE-reported model id (the
/// SAME id ledgered), so a row's cost is computed from the exact model that answered. An
/// UNKNOWN `(provider, model)` returns `None` from [`estimate_cost_usd`] (the cost stays
/// `None`/NULL — the honest "no published price on file" value, never a fabricated 0.0).
///
/// HONEST scope: these are published list prices captured for attribution, NOT a live
/// billing feed — a provider price change is a manual table edit. The pro/flash SPREAD is
/// the load-bearing relationship (pro costs strictly more than flash), which is what makes
/// the dark cheap→escalate tiering a real cost trade-off; the absolute values are
/// approximate list prices.
const MODEL_PRICES: &[(ProviderKind, &str, ModelPrice)] = &[
    // DeepSeek — flash (Small, the live default) is the cheapest; pro (Large) costs more,
    // which is the cost flip the dark `FRIDAY_DEEPSEEK_PRO_ROUTE_ENABLED` route opts into.
    (
        ProviderKind::DeepSeek,
        "deepseek-v4-flash",
        ModelPrice {
            input_per_1m_usd: 0.07,
            output_per_1m_usd: 1.10,
        },
    ),
    (
        ProviderKind::DeepSeek,
        "deepseek-v4-pro",
        ModelPrice {
            input_per_1m_usd: 0.55,
            output_per_1m_usd: 2.19,
        },
    ),
    // Anthropic — the dark Claude failover/route target.
    (
        ProviderKind::Anthropic,
        "claude-opus-4-8",
        ModelPrice {
            input_per_1m_usd: 5.00,
            output_per_1m_usd: 25.00,
        },
    ),
    // Codex — the dark local-app-server route. The app-server bills no per-token list price
    // to Friday (it runs under the operator's own Codex plan), so its cost stays UNKNOWN
    // (None) rather than a fabricated number — deliberately absent from this table.
];

/// (a#4 cost-table) Estimate the USD cost of one billed model call from its provider, the
/// RESPONSE-reported `model`, and the prompt/completion token counts. PURE + deterministic
/// (no clock, no I/O): `(prompt/1e6)*input_rate + (completion/1e6)*output_rate`.
///
/// Returns `None` (⇒ the ledger row's `cost_estimate` stays NULL, exactly as today) when:
///   - the `(provider, model)` pair has no published price on file (e.g. Codex, or an
///     unrecognized/renamed model) — an honest "unknown", never a fabricated `0.0`;
///   - either token count is negative (a malformed/hostile usage — the [`LedgerEntry`] ctor
///     rejects those separately; here we simply decline to price it).
///
/// This NEVER changes a gating/ceiling/routing decision — it only populates the attribution
/// column. A `Some` cost is always `>= 0.0` and finite for non-negative token counts.
pub fn estimate_cost_usd(
    provider: ProviderKind,
    model: &str,
    prompt_tokens: i64,
    completion_tokens: i64,
) -> Option<f64> {
    if prompt_tokens < 0 || completion_tokens < 0 {
        return None;
    }
    let price = MODEL_PRICES
        .iter()
        .find(|(p, m, _)| *p == provider && *m == model)
        .map(|(_, _, price)| *price)?;
    let input = (prompt_tokens as f64 / 1_000_000.0) * price.input_per_1m_usd;
    let output = (completion_tokens as f64 / 1_000_000.0) * price.output_per_1m_usd;
    Some(input + output)
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
        // The CTOR passes through whatever cost the caller supplies (here None); the
        // POPULATION of cost from the pricing table is the biller's job (a#4), proven
        // separately by `estimate_cost_usd_*` below + the hub's billing test.
        assert_eq!(e.cost_estimate, None);
    }

    // ---- (a#4) cost table -----------------------------------------------------

    #[test]
    fn estimate_cost_usd_computes_from_per_1m_rates() {
        // flash @ 0.07/1M in, 1.10/1M out, for 1,000,000 prompt + 1,000,000 completion
        // tokens = exactly the per-1M rates summed.
        let c = estimate_cost_usd(
            ProviderKind::DeepSeek,
            "deepseek-v4-flash",
            1_000_000,
            1_000_000,
        )
        .unwrap();
        assert!((c - (0.07 + 1.10)).abs() < 1e-9, "got {c}");

        // A small realistic call (11 prompt / 8 completion) is a tiny positive cost.
        let small = estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v4-flash", 11, 8).unwrap();
        assert!(small > 0.0 && small < 0.001, "got {small}");
    }

    #[test]
    fn estimate_cost_usd_pro_costs_strictly_more_than_flash() {
        // The load-bearing relationship for the dark cheap→escalate tiering: the SAME token
        // counts cost STRICTLY MORE on pro than on flash (so escalating is a real cost flip,
        // and a future cost-ordered escalator has a number to order by).
        let flash =
            estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v4-flash", 1000, 1000).unwrap();
        let pro = estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v4-pro", 1000, 1000).unwrap();
        assert!(
            pro > flash,
            "pro ({pro}) must cost more than flash ({flash})"
        );
    }

    #[test]
    fn estimate_cost_usd_unknown_pair_is_none_never_fabricated_zero() {
        // An unknown model, a wrong-provider pairing, and the deliberately-unpriced Codex
        // local-app-server route all return None (the honest "no published price" value) —
        // NEVER a fabricated 0.0 that would understate cost.
        assert_eq!(
            estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v9-imaginary", 10, 10),
            None
        );
        // Right model string but WRONG provider kind ⇒ no match ⇒ None.
        assert_eq!(
            estimate_cost_usd(ProviderKind::Anthropic, "deepseek-v4-flash", 10, 10),
            None
        );
        // Codex is intentionally absent from the table (the operator's own plan pays it).
        assert_eq!(
            estimate_cost_usd(ProviderKind::Codex, "gpt-5-codex", 10, 10),
            None
        );
    }

    #[test]
    fn estimate_cost_usd_negative_tokens_decline_to_price() {
        assert_eq!(
            estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v4-flash", -1, 8),
            None
        );
        assert_eq!(
            estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v4-flash", 8, -1),
            None
        );
    }

    #[test]
    fn estimate_cost_usd_zero_tokens_is_zero_not_none_for_known_model() {
        // A known model with zero tokens is a real, priced (free) call: Some(0.0), not None
        // (None is reserved for "no price on file").
        assert_eq!(
            estimate_cost_usd(ProviderKind::DeepSeek, "deepseek-v4-flash", 0, 0),
            Some(0.0)
        );
    }
}
