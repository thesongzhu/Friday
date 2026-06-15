//! L2-2 `web_search` capability tool — multi-provider web search returning snippets.
//!
//! Ported from the TS oracle `src/agent/tools/friday-agent-web-search-tool.ts`. This is the
//! SECOND L2 capability tool (after L2-1 `web_fetch`): it lets the agent look up information on
//! the web and pulls the result snippets (title + URL + snippet) into its context. Like
//! `web_fetch` the returned content is EXTERNAL — prompt-injection-inward — but the UNW-001 gate
//! evaluates every SUBSEQUENT tool call (the backstop). Unlike `web_fetch`, `web_search` does
//! NOT fetch the result URLs: it returns the provider's snippets ONLY, so the egress surface is
//! a single request to ONE of four FIXED public provider endpoints (the host is a compile-time
//! constant; the agent's query never reaches the host position). We STILL validate the provider
//! endpoint through [`crate::ssrf_guard`] fail-closed before the request (defensive — the public
//! hosts always pass, but a guard error is never a silent allow), but the resolve+pin / redirect
//! machinery `web_fetch` needs (its URL is agent-supplied) is unnecessary here.
//!
//! ## Providers (parity with the TS oracle)
//!   - `serper` (Google results via serper.dev) — requires `FRIDAY_SERPER_API_KEY`;
//!   - `tavily` (tavily.com) — requires `FRIDAY_TAVILY_API_KEY`;
//!   - `duckduckgo` (HTML lite endpoint) — NO key;
//!   - `google_news_rss` (public dated RSS feed) — NO key.
//!
//! ## Provider selection — NO silent premium→keyless fallback (the load-bearing parity)
//! The configured provider defaults to `auto`. The router mirrors the TS oracle EXACTLY:
//!   - `auto` + a time-sensitive query (freshness set, or a "latest/news/最新/快讯…" query) ⇒
//!     `google_news_rss`; `auto` otherwise ⇒ `duckduckgo`. So with NO premium keys configured
//!     (the prod default) `auto` only ever reaches the two KEYLESS providers — that is the
//!     "fall back to keyless when premium keys are absent" behavior, and it is the ONLY fallback.
//!   - Explicitly-configured `serper`/`tavily` with a MISSING key does NOT silently degrade to
//!     DuckDuckGo (the TS warning literally says "refusing to silently fall back…"). It instead
//!     returns a result whose content carries the fail-closed WARNING (never a silent change of
//!     behavior, never an error that hides the warning from the model).
//!   - Explicitly-configured `serper`/`tavily` WITH a key ⇒ that provider.
//!
//! ## Wiring
//! The tool is REGISTERED in [`crate::ToolRegistry::default`] (`mutating:false, Risk::ReadOnly`),
//! but the gate-dispatch chokepoint REFUSES it unless `FRIDAY_WEB_SEARCH_ENABLED` is exactly
//! `"1"` (see `lib.rs` `gate_dispatch_with_policy_enforced`), AND it is HIDDEN from the
//! model-facing tool menu when the flag is OFF — so with the flag OFF (the prod default — DARK,
//! flipping it live needs operator-provisioned Serper/Tavily keys) `web_search` is unavailable
//! and behavior is byte-identical to today. [`crate::http_tools::CompositeToolExecutor`] routes
//! `web_search` here, `web_fetch` to the [`crate::http_tools::WebFetchExecutor`], and everything
//! else to the inner [`crate::FsToolExecutor`].

use crate::ssrf_guard::{self, SsrfError, SsrfPolicy};
use crate::{ExecError, ToolExecutor, ToolReceipt};
use std::io::Read;
use std::time::Duration;

/// Default result count when `numResults` is absent (matches the TS oracle).
const DEFAULT_NUM_RESULTS: usize = 5;
/// Max result count (the `numResults` param is clamped to `[1, 20]`).
const MAX_NUM_RESULTS: usize = 20;
/// Search request timeout (15 s) — matches the TS oracle.
const SEARCH_TIMEOUT_MS: u64 = 15_000;
/// Max bytes read off a provider response before parsing (bounded so a hostile/huge provider
/// response cannot exhaust memory). 2 MiB comfortably holds 20 results of any provider.
const SEARCH_READ_MAX_BYTES: usize = 2 * 1024 * 1024;

// Provider endpoints (FIXED public hosts — the agent query never reaches the host position).
const SERPER_ENDPOINT: &str = "https://google.serper.dev/search";
const TAVILY_ENDPOINT: &str = "https://api.tavily.com/search";
const DUCKDUCKGO_ENDPOINT: &str = "https://html.duckduckgo.com/html/";
const GOOGLE_NEWS_RSS_ENDPOINT: &str = "https://news.google.com/rss/search";

const SEARCH_UA: &str = "Mozilla/5.0 (compatible; FridayAgent/1.0)";

// Warning strings — ported verbatim from the TS oracle so the model-visible text matches.
const DUCKDUCKGO_TIMELINESS_WARNING: &str =
    "DuckDuckGo HTML search does not provide verified recency filtering or stable publication \
     dates; latest-ness is unverified.";
const SERPER_KEY_MISSING_WARNING: &str =
    "web_search provider \"serper\" requires FRIDAY_SERPER_API_KEY; refusing to silently fall \
     back to DuckDuckGo for time-sensitive lookups.";
const TAVILY_KEY_MISSING_WARNING: &str =
    "web_search provider \"tavily\" requires FRIDAY_TAVILY_API_KEY; refusing to silently fall \
     back to DuckDuckGo for time-sensitive lookups.";
const NO_DATES_WARNING: &str =
    "Search results did not include verifiable publication dates; latest-ness remains unverified.";

/// The configured provider (mirrors the TS `provider` option). `Auto` routes per query.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfiguredProvider {
    Auto,
    Serper,
    Tavily,
    DuckDuckGo,
    GoogleNewsRss,
}

impl ConfiguredProvider {
    /// Parse the `provider` option the way the TS `normalizeProvider` does (trim+lowercase;
    /// unknown ⇒ `Auto`). Unused by the production env path today (prod = `Auto`), but kept so a
    /// future RunPolicy/option can pin a provider; covered by a unit test.
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_lowercase().as_str() {
            "serper" => Self::Serper,
            "tavily" => Self::Tavily,
            "duckduckgo" => Self::DuckDuckGo,
            "google_news_rss" => Self::GoogleNewsRss,
            _ => Self::Auto,
        }
    }
}

/// The provider that actually served a query (after `Auto` routing).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ResolvedProvider {
    Serper,
    Tavily,
    DuckDuckGo,
    GoogleNewsRss,
}

impl ResolvedProvider {
    fn label(self) -> &'static str {
        match self {
            Self::Serper => "serper",
            Self::Tavily => "tavily",
            Self::DuckDuckGo => "duckduckgo",
            Self::GoogleNewsRss => "google_news_rss",
        }
    }
}

/// One search hit (parity with the TS `WebSearchResult`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// Publication date string when the provider reports one (RSS pubDate / serper/tavily date).
    pub date: Option<String>,
}

/// Endpoints + keys + provider for a [`WebSearchExecutor`]. Production = `Auto` provider + keys
/// read from env + the real endpoints; the e2e tests inject loopback `endpoints` + an
/// allow-private SSRF policy so they reach an in-process mock with NO real network.
#[derive(Clone, Debug)]
pub struct WebSearchConfig {
    pub provider: ConfiguredProvider,
    pub serper_api_key: Option<String>,
    pub tavily_api_key: Option<String>,
    /// SSRF posture for the (defensive) endpoint check. PRODUCTION = deny-private default;
    /// `allow_private_network = true` ONLY for the loopback-mock e2e tests.
    pub ssrf_policy: SsrfPolicy,
    /// Provider endpoint URLs. Default = the real public endpoints; the tests override these to
    /// a 127.0.0.1 mock so "no real network" holds.
    pub endpoints: Endpoints,
}

/// The four provider endpoint URLs. [`Default`] = the real public endpoints.
#[derive(Clone, Debug)]
pub struct Endpoints {
    pub serper: String,
    pub tavily: String,
    pub duckduckgo: String,
    pub google_news_rss: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            serper: SERPER_ENDPOINT.to_string(),
            tavily: TAVILY_ENDPOINT.to_string(),
            duckduckgo: DUCKDUCKGO_ENDPOINT.to_string(),
            google_news_rss: GOOGLE_NEWS_RSS_ENDPOINT.to_string(),
        }
    }
}

impl Default for WebSearchConfig {
    /// Production config: `Auto` provider, NO keys, deny-private SSRF, real endpoints. With no
    /// keys, `Auto` only ever reaches the keyless providers (the prod-dark default).
    fn default() -> Self {
        Self {
            provider: ConfiguredProvider::Auto,
            serper_api_key: None,
            tavily_api_key: None,
            ssrf_policy: SsrfPolicy::default(),
            endpoints: Endpoints::default(),
        }
    }
}

/// Executes the `web_search` action. Constructed from a [`WebSearchConfig`]. Implements
/// [`ToolExecutor`] for ONLY the `web_search` action — every other action is
/// `ExecError::Unsupported` (the [`crate::http_tools::CompositeToolExecutor`] routes the rest).
pub struct WebSearchExecutor {
    config: WebSearchConfig,
}

impl WebSearchExecutor {
    /// Production constructor: provider = `Auto`, keys read from `FRIDAY_SERPER_API_KEY` /
    /// `FRIDAY_TAVILY_API_KEY` (absent ⇒ keyless providers only), deny-private SSRF, real
    /// endpoints. Reads env ONCE at construction.
    pub fn new() -> Self {
        Self {
            config: WebSearchConfig {
                serper_api_key: non_empty_env("FRIDAY_SERPER_API_KEY"),
                tavily_api_key: non_empty_env("FRIDAY_TAVILY_API_KEY"),
                ..Default::default()
            },
        }
    }

    /// Construct from an explicit config — used by the e2e tests (loopback endpoints +
    /// allow-private policy) and to pin a provider/key. NEVER used with private-allowed in prod.
    pub fn with_config(config: WebSearchConfig) -> Self {
        Self { config }
    }

    fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The core search: parse params → route to a provider → fetch+parse → freshness filter →
    /// build the model-facing content (warning folded in, parity with the TS formatting).
    fn search(&self, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        let query = Self::param(params, "query")
            .map(str::to_string)
            .ok_or_else(|| ExecError::MissingParam("query".to_string()))?;
        // numResults clamped to [1, 20], default 5 (parity with the TS Math.min/Math.max).
        let num_results = Self::param(params, "numResults")
            .and_then(|s| s.trim().parse::<i64>().ok())
            .map(|n| n.clamp(1, MAX_NUM_RESULTS as i64) as usize)
            .unwrap_or(DEFAULT_NUM_RESULTS);
        // freshness: only "day"/"week"/"month" are meaningful; anything else is treated as
        // present-but-unrecognized by the TS oracle (it still counts as "requested" for the
        // time-sensitive routing + the ddg warning), so keep it as an opaque Option<String>.
        let freshness = Self::param(params, "freshness")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        // ── Provider routing (NO silent premium→keyless fallback — see module docs) ──
        let resolved: ResolvedProvider;
        let mut warning: Option<String> = None;
        let mut freshness_applied = false;

        match self.config.provider {
            ConfiguredProvider::Serper => {
                let Some(key) = self.config.serper_api_key.as_deref() else {
                    // Fail-closed: return a result CARRYING the warning (never a silent ddg
                    // fallback, never an ExecError that would hide the warning from the model).
                    return Ok(missing_key_receipt(SERPER_KEY_MISSING_WARNING));
                };
                let results = self.fetch_serper(&query, num_results, freshness.as_deref(), key)?;
                freshness_applied = freshness.is_some();
                resolved = ResolvedProvider::Serper;
                return Ok(self.build_receipt(resolved, results, freshness_applied, warning));
            }
            ConfiguredProvider::Tavily => {
                let Some(key) = self.config.tavily_api_key.as_deref() else {
                    return Ok(missing_key_receipt(TAVILY_KEY_MISSING_WARNING));
                };
                let results = self.fetch_tavily(&query, num_results, freshness.as_deref(), key)?;
                freshness_applied = freshness.is_some();
                resolved = ResolvedProvider::Tavily;
                return Ok(self.build_receipt(resolved, results, freshness_applied, warning));
            }
            ConfiguredProvider::GoogleNewsRss => {
                resolved = ResolvedProvider::GoogleNewsRss;
            }
            ConfiguredProvider::DuckDuckGo => {
                resolved = ResolvedProvider::DuckDuckGo;
            }
            ConfiguredProvider::Auto => {
                // Auto: time-sensitive ⇒ google_news_rss; else duckduckgo. Auto NEVER selects a
                // premium provider — so with no keys (prod default) it stays keyless.
                if is_time_sensitive_news_query(&query, freshness.as_deref()) {
                    resolved = ResolvedProvider::GoogleNewsRss;
                } else {
                    resolved = ResolvedProvider::DuckDuckGo;
                }
            }
        }

        let results = match resolved {
            ResolvedProvider::GoogleNewsRss => {
                let r = self.fetch_google_news_rss(&query, num_results, freshness.as_deref())?;
                freshness_applied = freshness.is_some();
                r
            }
            ResolvedProvider::DuckDuckGo => {
                let r = self.fetch_duckduckgo(&query, num_results)?;
                // DDG cannot apply freshness; warn ONLY when freshness was requested.
                if freshness.is_some() {
                    warning = Some(DUCKDUCKGO_TIMELINESS_WARNING.to_string());
                }
                r
            }
            // Serper/Tavily handled (and returned) above.
            ResolvedProvider::Serper | ResolvedProvider::Tavily => unreachable!(),
        };

        Ok(self.build_receipt(resolved, results, freshness_applied, warning))
    }

    /// Build the model-facing `ToolReceipt` from the results + the freshness/warning state,
    /// matching the TS formatting (the no-dates warning, the "No results found." path, and the
    /// numbered list with URL/Date/snippet).
    fn build_receipt(
        &self,
        provider: ResolvedProvider,
        results: Vec<SearchResult>,
        freshness_applied: bool,
        mut warning: Option<String>,
    ) -> ToolReceipt {
        let has_dates = results.iter().any(|r| {
            r.date
                .as_deref()
                .map(|d| !d.trim().is_empty())
                .unwrap_or(false)
        });

        // The no-dates warning: only for dated providers, only when freshness was applied, only
        // when no dates came back, and only when no prior warning was set (TS condition).
        if warning.is_none()
            && matches!(
                provider,
                ResolvedProvider::Serper
                    | ResolvedProvider::Tavily
                    | ResolvedProvider::GoogleNewsRss
            )
            && freshness_applied
            && !has_dates
        {
            warning = Some(NO_DATES_WARNING.to_string());
        }

        let content = format_results(&results, warning.as_deref());

        let summary = format!(
            "web_search [{}]: {} result(s){}",
            provider.label(),
            results.len(),
            match warning.as_deref() {
                Some(_) => " (warning)",
                None => "",
            }
        );

        ToolReceipt {
            action: "web_search".to_string(),
            summary,
            content: Some(content),
        }
    }

    // ── Providers ──

    fn fetch_serper(
        &self,
        query: &str,
        num_results: usize,
        freshness: Option<&str>,
        api_key: &str,
    ) -> Result<Vec<SearchResult>, ExecError> {
        let mut body = serde_json::json!({ "q": query, "num": num_results });
        if let Some(tbs) = serper_tbs(freshness) {
            body["tbs"] = serde_json::Value::String(tbs.to_string());
        }
        let raw = self.post_json(
            &self.config.endpoints.serper,
            &[("X-API-KEY", api_key)],
            &body,
        )?;
        Ok(parse_serper_json(&raw, num_results))
    }

    fn fetch_tavily(
        &self,
        query: &str,
        num_results: usize,
        freshness: Option<&str>,
        api_key: &str,
    ) -> Result<Vec<SearchResult>, ExecError> {
        // Tavily takes the key in the BODY (not a header), matching the TS oracle.
        let mut body = serde_json::json!({
            "api_key": api_key,
            "query": query,
            "max_results": num_results,
            "search_depth": "basic",
        });
        if let Some(days) = tavily_days(freshness) {
            body["days"] = serde_json::Value::from(days);
        }
        let raw = self.post_json(&self.config.endpoints.tavily, &[], &body)?;
        Ok(parse_tavily_json(&raw, num_results))
    }

    fn fetch_duckduckgo(
        &self,
        query: &str,
        num_results: usize,
    ) -> Result<Vec<SearchResult>, ExecError> {
        let mut url = url::Url::parse(&self.config.endpoints.duckduckgo)
            .map_err(|_| invalid_endpoint(&self.config.endpoints.duckduckgo))?;
        url.query_pairs_mut().append_pair("q", query);
        let raw = self.get_text(url.as_str())?;
        Ok(parse_duckduckgo_html(&raw, num_results))
    }

    fn fetch_google_news_rss(
        &self,
        query: &str,
        num_results: usize,
        freshness: Option<&str>,
    ) -> Result<Vec<SearchResult>, ExecError> {
        let mut url = url::Url::parse(&self.config.endpoints.google_news_rss)
            .map_err(|_| invalid_endpoint(&self.config.endpoints.google_news_rss))?;
        url.query_pairs_mut()
            .append_pair("q", query)
            .append_pair("hl", "en-US")
            .append_pair("gl", "US")
            .append_pair("ceid", "US:en");
        let raw = self.get_text(url.as_str())?;
        let parsed = parse_google_news_rss(&raw);
        let filtered = apply_freshness_filter(parsed, freshness, now_unix_ms());
        Ok(filtered.into_iter().take(num_results).collect())
    }

    // ── HTTP (ureq, blocking) ──

    /// POST a JSON body to a provider endpoint, returning the bounded response text. Validates
    /// the endpoint through the SSRF guard fail-closed first (defensive). A non-2xx HTTP status
    /// surfaces as a transport-style error (parity with the TS `!response.ok` throw).
    fn post_json(
        &self,
        endpoint: &str,
        headers: &[(&str, &str)],
        body: &serde_json::Value,
    ) -> Result<String, ExecError> {
        self.guard_endpoint(endpoint)?;
        let agent = self.agent();
        let mut req = agent
            .post(endpoint)
            .set("Content-Type", "application/json")
            .set("User-Agent", SEARCH_UA);
        for (k, v) in headers {
            req = req.set(k, v);
        }
        let resp = req
            .send_string(&serde_json::to_string(body).unwrap_or_default())
            .map_err(map_ureq_err)?;
        Ok(read_bounded(resp.into_reader(), SEARCH_READ_MAX_BYTES))
    }

    /// GET an endpoint, returning the bounded response text. SSRF-guarded fail-closed first.
    fn get_text(&self, endpoint: &str) -> Result<String, ExecError> {
        self.guard_endpoint(endpoint)?;
        let agent = self.agent();
        let resp = agent
            .get(endpoint)
            .set("User-Agent", SEARCH_UA)
            .call()
            .map_err(map_ureq_err)?;
        Ok(read_bounded(resp.into_reader(), SEARCH_READ_MAX_BYTES))
    }

    /// Defensive SSRF check on a provider endpoint. The provider hosts are FIXED public hosts so
    /// this always passes in production — but a guard error is never a silent allow, and a future
    /// allowlist/test-injected endpoint is validated the same way. We do NOT resolve+pin (the
    /// host is not agent-supplied and we never fetch result URLs), so a single `validate_url` is
    /// the guard surface here.
    fn guard_endpoint(&self, endpoint: &str) -> Result<(), ExecError> {
        ssrf_guard::validate_url(endpoint, &self.config.ssrf_policy)
            .map(|_| ())
            .map_err(|e| ExecError::WebSearch(WebSearchError::Ssrf(e)))
    }

    fn agent(&self) -> ureq::Agent {
        ureq::AgentBuilder::new()
            .timeout(Duration::from_millis(SEARCH_TIMEOUT_MS))
            .build()
    }
}

impl Default for WebSearchExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolExecutor for WebSearchExecutor {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        match action {
            "web_search" => self.search(params),
            other => Err(ExecError::Unsupported(other.to_string())),
        }
    }
}

/// Why a `web_search` failed at the tool level (distinct from "no results", which is a normal
/// `ToolReceipt`). An SSRF refusal of the provider endpoint, or a transport/HTTP-status failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebSearchError {
    /// The SSRF guard refused the provider endpoint (defensive — should never fire for the
    /// fixed public hosts).
    Ssrf(SsrfError),
    /// A connect/TLS/timeout transport failure, or a non-2xx provider HTTP status (kind only —
    /// never a secret).
    Transport(String),
}

impl std::fmt::Display for WebSearchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WebSearchError::Ssrf(e) => write!(f, "{e}"),
            WebSearchError::Transport(k) => write!(f, "web_search_transport:{k}"),
        }
    }
}

// ─── free helpers (pure where possible — directly unit-tested) ───

fn invalid_endpoint(endpoint: &str) -> ExecError {
    ExecError::WebSearch(WebSearchError::Ssrf(SsrfError::InvalidUrl(
        endpoint.to_string(),
    )))
}

/// Map a ureq error to a `web_search` transport error. A non-2xx HTTP status (ureq returns it as
/// `Error::Status`) is a provider failure — like the TS `!response.ok` throw, but a DELIBERATE
/// adaptation to the Rust gate model: the TS oracle catches that throw and folds it into
/// model-visible `errorResult` content, whereas here a provider failure surfaces as a tool
/// `ExecError` (`GateDispatch::ExecError`). (NOT mimicking the web_fetch sibling, which returns
/// 4xx/5xx bodies AS a `ToolReceipt` — wrong for a search API; a failed search has no useful
/// body.) A transport failure (connect/TLS/timeout) keeps its kind only — never a body, never a
/// secret.
fn map_ureq_err(err: ureq::Error) -> ExecError {
    let kind = match err {
        ureq::Error::Status(code, _resp) => format!("http_{code}"),
        ureq::Error::Transport(t) => format!("{:?}", t.kind()),
    };
    ExecError::WebSearch(WebSearchError::Transport(kind))
}

/// A missing-required-key result: the warning is the content (and there are no results), exactly
/// like the TS `errorResult(WARNING)` path — but surfaced as a normal `Ok(ToolReceipt)` so the
/// model SEES the warning (an ExecError would hide it = a silent behavior change).
fn missing_key_receipt(warning: &str) -> ToolReceipt {
    ToolReceipt {
        action: "web_search".to_string(),
        summary: format!("web_search: refused (missing key) — {warning}"),
        content: Some(warning.to_string()),
    }
}

/// Read an env var, returning `None` for unset OR empty/whitespace-only (an empty key is "no key"
/// — it must take the fail-closed missing-key path, not send an empty `X-API-KEY`).
fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// The serper `tbs` recency code for a freshness value (None for an unrecognized value).
fn serper_tbs(freshness: Option<&str>) -> Option<&'static str> {
    match freshness {
        Some("day") => Some("qdr:d"),
        Some("week") => Some("qdr:w"),
        Some("month") => Some("qdr:m"),
        _ => None,
    }
}

/// The tavily `days` window for a freshness value (None for an unrecognized value).
fn tavily_days(freshness: Option<&str>) -> Option<u32> {
    match freshness {
        Some("day") => Some(1),
        Some("week") => Some(7),
        Some("month") => Some(30),
        _ => None,
    }
}

/// Time-sensitive query detection (parity with the TS `isTimeSensitiveNewsQuery`): a non-empty
/// freshness ⇒ true; otherwise a query matching the latest/news English word-boundary set OR the
/// CJK alternation (on the RAW query — the CJK terms are case-insensitive already).
pub fn is_time_sensitive_news_query(query: &str, freshness: Option<&str>) -> bool {
    if freshness.map(|f| !f.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() {
        return false;
    }
    const EN_WORDS: &[&str] = &[
        "latest", "recent", "today", "current", "breaking", "headline", "news",
    ];
    if EN_WORDS.iter().any(|w| contains_word(&normalized, w)) {
        return true;
    }
    const CJK_TERMS: &[&str] = &[
        "最新", "最近", "今天", "当前", "新闻", "头条", "快讯", "报道",
    ];
    CJK_TERMS.iter().any(|t| query.contains(t))
}

/// Whole-word (ASCII word-boundary) containment, mirroring the TS `\b…\b` regex for the English
/// terms (so "newsletter" does NOT match "news"). A "word char" is `[A-Za-z0-9_]`.
fn contains_word(haystack: &str, word: &str) -> bool {
    let bytes = haystack.as_bytes();
    let wbytes = word.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(word) {
        let start = from + rel;
        let end = start + wbytes.len();
        let before_ok = start == 0 || !is_word_byte(bytes[start - 1]);
        let after_ok = end == bytes.len() || !is_word_byte(bytes[end]);
        if before_ok && after_ok {
            return true;
        }
        from = start + 1;
    }
    false
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Read at most `max` bytes off a reader into a lossy-UTF-8 String (bounded — the same primitive
/// `web_fetch` uses).
fn read_bounded(reader: impl Read, max: usize) -> String {
    let mut buf: Vec<u8> = Vec::new();
    let _ = reader.take(max as u64).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// Format the results into the model-facing content, matching the TS layout: an optional
/// `Warning: …` section, then either "No results found." or a numbered list with URL/Date/snippet.
fn format_results(results: &[SearchResult], warning: Option<&str>) -> String {
    if results.is_empty() {
        return match warning {
            Some(w) => format!("Warning: {w}\n\nNo results found."),
            None => "No results found.".to_string(),
        };
    }
    let formatted: Vec<String> = results
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let mut parts = vec![
                format!("{}. {}", i + 1, r.title),
                format!("   URL: {}", r.url),
            ];
            if let Some(d) = r.date.as_deref().filter(|d| !d.is_empty()) {
                parts.push(format!("   Date: {d}"));
            }
            parts.push(format!("   {}", r.snippet));
            parts.join("\n")
        })
        .collect();
    let body = formatted.join("\n\n");
    match warning {
        Some(w) => format!("Warning: {w}\n\n{body}"),
        None => body,
    }
}

// ── Provider response parsers (pure — directly unit-tested over sample bytes, no network) ──

/// Parse a serper.dev `/search` JSON response: `organic[]` → results (title/link/snippet/date).
pub fn parse_serper_json(raw: &str, num_results: usize) -> Vec<SearchResult> {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let organic = v.get("organic").and_then(|o| o.as_array());
    let Some(organic) = organic else {
        return Vec::new();
    };
    organic
        .iter()
        .take(num_results)
        .map(|item| SearchResult {
            title: str_field(item, "title"),
            url: str_field(item, "link"),
            snippet: str_field(item, "snippet"),
            date: opt_str_field(item, "date"),
        })
        .collect()
}

/// Parse a tavily `/search` JSON response: `results[]` → results (title/url/content/published).
pub fn parse_tavily_json(raw: &str, num_results: usize) -> Vec<SearchResult> {
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(results) = v.get("results").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .take(num_results)
        .map(|item| SearchResult {
            title: str_field(item, "title"),
            url: str_field(item, "url"),
            snippet: str_field(item, "content"),
            date: opt_str_field(item, "published_date"),
        })
        .collect()
}

fn str_field(v: &serde_json::Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

fn opt_str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parse the Google News RSS XML: each `<item>` → title/link/description/pubDate.
pub fn parse_google_news_rss(xml: &str) -> Vec<SearchResult> {
    let mut results = Vec::new();
    let lower = xml; // tags are lowercase in the feed; match case-sensitively on <item>
    let mut search_from = 0usize;
    while let Some(open_rel) = lower[search_from..].find("<item>") {
        let block_start = search_from + open_rel + "<item>".len();
        let Some(close_rel) = lower[block_start..].find("</item>") else {
            break;
        };
        let block = &xml[block_start..block_start + close_rel];
        search_from = block_start + close_rel + "</item>".len();

        let title = normalize_whitespace(&decode_html_entities(&read_xml_tag(block, "title")));
        let url = normalize_whitespace(&decode_html_entities(&read_xml_tag(block, "link")));
        let description = normalize_whitespace(&strip_html_tags(&decode_html_entities(
            &read_xml_tag(block, "description"),
        )));
        let date = normalize_whitespace(&decode_html_entities(&read_xml_tag(block, "pubDate")));

        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = if description.is_empty() {
            title.clone()
        } else {
            description
        };
        results.push(SearchResult {
            title,
            url,
            snippet,
            date: if date.is_empty() { None } else { Some(date) },
        });
    }
    results
}

/// Read the inner text of the first `<tag>…</tag>` in `block` (case-insensitive tag match),
/// stripping a `<![CDATA[ … ]]>` wrapper (parity with the TS `readXmlTag`).
fn read_xml_tag(block: &str, tag: &str) -> String {
    let lower = block.to_ascii_lowercase();
    // Match case-insensitively: the needles are lowercased to align with `lower` (the RSS
    // `pubDate` tag is mixed-case, so a case-sensitive needle would miss it).
    let open = format!("<{}>", tag.to_ascii_lowercase());
    let close = format!("</{}>", tag.to_ascii_lowercase());
    let Some(open_rel) = lower.find(&open) else {
        return String::new();
    };
    let inner_start = open_rel + open.len();
    let Some(close_rel) = lower[inner_start..].find(&close) else {
        return String::new();
    };
    let inner = &block[inner_start..inner_start + close_rel];
    inner
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
        .unwrap_or(inner)
        .to_string()
}

/// Freshness filter for dated results (parity with the TS `applyFreshnessFilter`): keep only
/// results whose `date` parses and is within the cutoff window. An unrecognized freshness ⇒ no
/// filter (return as-is). `now_ms` is injected so the filter is pure + testable.
pub fn apply_freshness_filter(
    results: Vec<SearchResult>,
    freshness: Option<&str>,
    now_ms: i64,
) -> Vec<SearchResult> {
    let cutoff_days: i64 = match freshness {
        Some("day") => 1,
        Some("week") => 7,
        Some("month") => 30,
        _ => return results, // null cutoff ⇒ no filter
    };
    let cutoff_ms = now_ms - cutoff_days * 24 * 60 * 60 * 1000;
    results
        .into_iter()
        .filter(|r| match r.date.as_deref() {
            Some(d) => parse_rfc822_to_unix_ms(d)
                .map(|published| published >= cutoff_ms)
                .unwrap_or(false),
            None => false, // no date ⇒ dropped (parity with TS)
        })
        .collect()
}

/// Parse the DuckDuckGo HTML-lite results (parity with the TS regex parser): `result__a` links +
/// `result__snippet` snippets, decoding the `uddg=` redirect wrapper.
pub fn parse_duckduckgo_html(html: &str, max_results: usize) -> Vec<SearchResult> {
    let links = extract_anchor_class(html, "result__a");
    let snippets = extract_anchor_class(html, "result__snippet");
    let mut out = Vec::new();
    for (i, (href_raw, title_html)) in links.iter().enumerate() {
        if out.len() >= max_results {
            break;
        }
        let mut href = href_raw.clone();
        if href.contains("uddg=") {
            if let Some(decoded) = extract_uddg(&href) {
                href = decoded;
            }
        }
        let title = normalize_whitespace(&strip_html_tags(title_html));
        let snippet = snippets
            .get(i)
            .map(|(_, s)| normalize_whitespace(&strip_html_tags(s)))
            .unwrap_or_default();
        if !title.is_empty() && !href.is_empty() {
            out.push(SearchResult {
                title,
                url: href,
                snippet,
                date: None,
            });
        }
    }
    out
}

/// Extract `(href, inner_html)` for every `<a … class="<class>" … href="…">…</a>` in `html`.
/// Tolerant of attribute order (matches whether `class` precedes or follows `href`), mirroring
/// the TS regex which keys on `class="…"` then captures `href`. Dependency-free scan.
fn extract_anchor_class(html: &str, class: &str) -> Vec<(String, String)> {
    let lower = html.to_ascii_lowercase();
    let needle = format!("class=\"{class}\"");
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(cls_rel) = lower[from..].find(&needle) {
        let cls_pos = from + cls_rel;
        // Find the enclosing `<a` start before the class attribute.
        let Some(a_rel) = lower[..cls_pos].rfind("<a") else {
            from = cls_pos + needle.len();
            continue;
        };
        // Find the end of the opening tag `>`.
        let Some(gt_rel) = lower[cls_pos..].find('>') else {
            break;
        };
        let tag_open = &html[a_rel..cls_pos + gt_rel + 1];
        // Find the matching `</a>`.
        let inner_start = cls_pos + gt_rel + 1;
        let Some(end_rel) = lower[inner_start..].find("</a>") else {
            from = inner_start;
            continue;
        };
        let inner = &html[inner_start..inner_start + end_rel];
        let href = read_attr(tag_open, "href").unwrap_or_default();
        out.push((href, inner.to_string()));
        from = inner_start + end_rel + "</a>".len();
    }
    out
}

/// Read an `attr="value"` value out of an opening tag (case-insensitive attr name).
fn read_attr(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let needle = format!("{attr}=\"");
    let pos = lower.find(&needle)? + needle.len();
    let rest = &tag[pos..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

/// Extract + percent-decode the `uddg=` target from a DuckDuckGo redirect href.
fn extract_uddg(href: &str) -> Option<String> {
    let pos = href.find("uddg=")? + "uddg=".len();
    let rest = &href[pos..];
    let end = rest.find('&').unwrap_or(rest.len());
    Some(percent_decode(&rest[..end]))
}

/// Minimal percent-decoder (`%XX` + `+`→space) — the `uddg` value is a percent-encoded URL.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h), Some(l)) = (hi, lo) {
                    out.push((h * 16 + l) as u8);
                    i += 3;
                    continue;
                }
                out.push(b'%');
                i += 1;
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn strip_html_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out
}

fn decode_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn normalize_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Current unix time in ms (the only impure call; the freshness filter takes `now_ms` injected
/// so it stays pure/testable). Used only by the live google_news_rss path.
fn now_unix_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Parse an RFC-822 / RFC-1123 date (the RSS `pubDate` format, e.g.
/// "Mon, 15 Jun 2026 14:30:00 GMT" or "+0000") to unix-epoch ms. Dependency-free (no chrono):
/// the RSS feed always uses this single format. Returns `None` on any malformed component so the
/// freshness filter drops an unparseable date (parity with the TS `Number.isFinite(Date.parse)`).
fn parse_rfc822_to_unix_ms(s: &str) -> Option<i64> {
    // "Wdy, DD Mon YYYY HH:MM:SS TZ"  (the leading "Wdy, " is optional in RFC-822).
    let s = s.trim();
    let after_comma = match s.find(',') {
        Some(i) => s[i + 1..].trim(),
        None => s,
    };
    let mut it = after_comma.split_whitespace();
    let day: i64 = it.next()?.parse().ok()?;
    let month = month_index(it.next()?)?;
    let year: i64 = it.next()?.parse().ok()?;
    let time = it.next()?;
    let tz = it.next().unwrap_or("GMT");

    let mut tp = time.split(':');
    let hour: i64 = tp.next()?.parse().ok()?;
    let min: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next().unwrap_or("0").parse().ok()?;

    if !(1..=31).contains(&day) || !(0..=23).contains(&hour) || !(0..=59).contains(&min) || sec > 60
    {
        return None;
    }

    // Days from the unix epoch to YYYY-MM-DD (proleptic Gregorian; civil-from-days algorithm).
    let days = days_from_civil(year, month, day)?;
    let mut epoch_secs = days * 86_400 + hour * 3600 + min * 60 + sec;
    epoch_secs -= tz_offset_secs(tz);
    Some(epoch_secs * 1000)
}

fn month_index(m: &str) -> Option<i64> {
    Some(match m {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    })
}

/// Days since the unix epoch for a civil date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
    if !(1..=12).contains(&m) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// Seconds to ADD to a local time to get UTC (i.e. the value to subtract from a wall-clock to get
/// UTC is the negation). We return the offset such that `utc = local - offset`. GMT/UT/Z = 0;
/// "+HHMM"/"-HHMM" numeric; the common single-letter US zones; unknown ⇒ 0 (treated as GMT).
fn tz_offset_secs(tz: &str) -> i64 {
    match tz {
        "GMT" | "UT" | "UTC" | "Z" => 0,
        "EST" => -5 * 3600,
        "EDT" => -4 * 3600,
        "CST" => -6 * 3600,
        "CDT" => -5 * 3600,
        "MST" => -7 * 3600,
        "MDT" => -6 * 3600,
        "PST" => -8 * 3600,
        "PDT" => -7 * 3600,
        _ => parse_numeric_tz(tz).unwrap_or(0),
    }
}

/// Parse a "+HHMM" / "-HHMM" numeric timezone to an offset in seconds.
fn parse_numeric_tz(tz: &str) -> Option<i64> {
    let (sign, rest) = match tz.as_bytes().first()? {
        b'+' => (1i64, &tz[1..]),
        b'-' => (-1i64, &tz[1..]),
        _ => return None,
    };
    if rest.len() != 4 || !rest.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let h: i64 = rest[..2].parse().ok()?;
    let m: i64 = rest[2..].parse().ok()?;
    Some(sign * (h * 3600 + m * 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Provider routing (the no-silent-fallback parity) ──

    #[test]
    fn auto_routes_keyless_when_no_premium_keys() {
        // Prod default: Auto + no keys ⇒ keyless providers only. A plain query ⇒ duckduckgo;
        // a time-sensitive query ⇒ google_news_rss. (Routing only — no network here.)
        assert!(!is_time_sensitive_news_query("rust ownership model", None));
        assert!(is_time_sensitive_news_query("latest rust release", None));
        assert!(is_time_sensitive_news_query("rust", Some("week")));
        // CJK time-sensitive terms on the raw query.
        assert!(is_time_sensitive_news_query("比特币最新新闻", None));
        // "newsletter" must NOT match the "news" word-boundary regex.
        assert!(!is_time_sensitive_news_query(
            "newsletter signup tips",
            None
        ));
        // empty query ⇒ not time-sensitive.
        assert!(!is_time_sensitive_news_query("   ", None));
    }

    #[test]
    fn configured_provider_parse_matches_ts_normalize() {
        assert_eq!(
            ConfiguredProvider::parse("serper"),
            ConfiguredProvider::Serper
        );
        assert_eq!(
            ConfiguredProvider::parse("  TAVILY "),
            ConfiguredProvider::Tavily
        );
        assert_eq!(
            ConfiguredProvider::parse("duckduckgo"),
            ConfiguredProvider::DuckDuckGo
        );
        assert_eq!(
            ConfiguredProvider::parse("google_news_rss"),
            ConfiguredProvider::GoogleNewsRss
        );
        // unknown / empty ⇒ Auto.
        assert_eq!(ConfiguredProvider::parse("bing"), ConfiguredProvider::Auto);
        assert_eq!(ConfiguredProvider::parse(""), ConfiguredProvider::Auto);
    }

    #[test]
    fn serper_missing_key_fails_closed_with_warning_no_fallback() {
        // EXPLICIT serper + NO key ⇒ a result CARRYING the warning (NOT a silent ddg fallback,
        // NOT an error that hides the warning). This is the load-bearing parity with the TS
        // SERPER_KEY_MISSING_WARNING ("refusing to silently fall back…").
        let exec = WebSearchExecutor::with_config(WebSearchConfig {
            provider: ConfiguredProvider::Serper,
            serper_api_key: None,
            ..Default::default()
        });
        let receipt = exec
            .execute("web_search", &[("query".into(), "anything".into())])
            .expect("missing key returns Ok(receipt), never an Err");
        let content = receipt.content.unwrap();
        assert!(
            content.contains("FRIDAY_SERPER_API_KEY"),
            "content: {content}"
        );
        assert!(
            content.contains("refusing to silently fall back"),
            "content: {content}"
        );
    }

    #[test]
    fn tavily_missing_key_fails_closed_with_warning_no_fallback() {
        let exec = WebSearchExecutor::with_config(WebSearchConfig {
            provider: ConfiguredProvider::Tavily,
            tavily_api_key: None,
            ..Default::default()
        });
        let receipt = exec
            .execute("web_search", &[("query".into(), "anything".into())])
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(
            content.contains("FRIDAY_TAVILY_API_KEY"),
            "content: {content}"
        );
        assert!(content.contains("refusing to silently fall back"));
    }

    #[test]
    fn missing_query_is_missing_param() {
        let exec = WebSearchExecutor::with_config(WebSearchConfig::default());
        let err = exec.execute("web_search", &[]).unwrap_err();
        assert!(matches!(err, ExecError::MissingParam(p) if p == "query"));
    }

    #[test]
    fn unsupported_action_on_web_search_executor() {
        let exec = WebSearchExecutor::with_config(WebSearchConfig::default());
        let err = exec
            .execute("read_file", &[("path".into(), "x".into())])
            .unwrap_err();
        assert!(matches!(err, ExecError::Unsupported(_)));
    }

    // ── Serper / Tavily JSON parsers ──

    #[test]
    fn parse_serper_json_extracts_organic() {
        let raw = r#"{
            "organic": [
                {"title":"A","link":"https://a.example/","snippet":"snip A","date":"2026-06-01"},
                {"title":"B","link":"https://b.example/","snippet":"snip B"}
            ]
        }"#;
        let r = parse_serper_json(raw, 5);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "A");
        assert_eq!(r[0].url, "https://a.example/");
        assert_eq!(r[0].snippet, "snip A");
        assert_eq!(r[0].date.as_deref(), Some("2026-06-01"));
        assert_eq!(r[1].date, None);
        // num_results clamps the list.
        assert_eq!(parse_serper_json(raw, 1).len(), 1);
        // missing organic ⇒ empty; malformed ⇒ empty.
        assert!(parse_serper_json("{}", 5).is_empty());
        assert!(parse_serper_json("not json", 5).is_empty());
    }

    #[test]
    fn parse_tavily_json_extracts_results() {
        let raw = r#"{
            "results": [
                {"title":"T1","url":"https://t1/","content":"body 1","published_date":"2026-05-30"},
                {"title":"T2","url":"https://t2/","content":"body 2"}
            ]
        }"#;
        let r = parse_tavily_json(raw, 5);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].title, "T1");
        assert_eq!(r[0].snippet, "body 1");
        assert_eq!(r[0].date.as_deref(), Some("2026-05-30"));
        assert_eq!(r[1].date, None);
        assert!(parse_tavily_json("{}", 5).is_empty());
    }

    // ── DuckDuckGo HTML parser ──

    #[test]
    fn parse_duckduckgo_html_extracts_links_and_snippets_and_decodes_uddg() {
        let html = r##"
          <div>
            <a rel="nofollow" class="result__a" href="https://example.com/page">Example &amp; Title</a>
            <a class="result__snippet" href="#">This is the <b>snippet</b> text</a>
          </div>
          <div>
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwiki.example%2Fx&rut=abc">Wiki Result</a>
            <a class="result__snippet">Second snippet</a>
          </div>
        "##;
        let r = parse_duckduckgo_html(html, 10);
        assert_eq!(r.len(), 2, "results: {r:?}");
        assert_eq!(r[0].url, "https://example.com/page");
        // Parity with the TS oracle: DDG titles/snippets go through stripHtmlTags ONLY (no
        // entity decode), so `&amp;` stays encoded (the TS parser does the same).
        assert_eq!(r[0].title, "Example &amp; Title");
        assert!(r[0].snippet.contains("snippet"));
        assert!(
            !r[0].snippet.contains('<'),
            "tags must be stripped: {}",
            r[0].snippet
        );
        // uddg= redirect is decoded to the real URL.
        assert_eq!(r[1].url, "https://wiki.example/x");
        assert_eq!(r[1].title, "Wiki Result");
        assert!(r[1].date.is_none());
        // max_results clamps.
        assert_eq!(parse_duckduckgo_html(html, 1).len(), 1);
    }

    // ── Google News RSS parser + freshness ──

    const RSS_SAMPLE: &str = r#"<?xml version="1.0"?>
      <rss><channel>
        <item>
          <title>Fresh Headline</title>
          <link>https://news.example/fresh</link>
          <description>A &lt;b&gt;recent&lt;/b&gt; story</description>
          <pubDate>Sun, 14 Jun 2026 12:00:00 GMT</pubDate>
        </item>
        <item>
          <title>Old Headline</title>
          <link>https://news.example/old</link>
          <description>An old story</description>
          <pubDate>Tue, 01 Jan 2019 00:00:00 GMT</pubDate>
        </item>
        <item>
          <title></title>
          <link>https://news.example/notitle</link>
          <description>dropped — no title</description>
          <pubDate>Sun, 14 Jun 2026 12:00:00 GMT</pubDate>
        </item>
      </channel></rss>"#;

    #[test]
    fn parse_google_news_rss_extracts_items_and_drops_titleless() {
        let r = parse_google_news_rss(RSS_SAMPLE);
        assert_eq!(r.len(), 2, "the empty-title item must be dropped: {r:?}");
        assert_eq!(r[0].title, "Fresh Headline");
        assert_eq!(r[0].url, "https://news.example/fresh");
        // description HTML entities decoded + tags stripped.
        assert!(r[0].snippet.contains("recent"));
        assert!(!r[0].snippet.contains("<b>"));
        assert_eq!(r[0].date.as_deref(), Some("Sun, 14 Jun 2026 12:00:00 GMT"));
    }

    #[test]
    fn freshness_filter_keeps_recent_drops_old_and_undated() {
        let parsed = parse_google_news_rss(RSS_SAMPLE);
        // "now" = 15 Jun 2026 12:00:00 GMT.
        let now_ms = parse_rfc822_to_unix_ms("Mon, 15 Jun 2026 12:00:00 GMT").unwrap();
        // week window keeps the 14-Jun item, drops the 2019 one.
        let filtered = apply_freshness_filter(parsed.clone(), Some("week"), now_ms);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].title, "Fresh Headline");
        // No freshness ⇒ unfiltered.
        assert_eq!(
            apply_freshness_filter(parsed.clone(), None, now_ms).len(),
            2
        );
        // A result with no date is dropped when a window is applied.
        let mut undated = parsed.clone();
        undated.push(SearchResult {
            title: "No Date".into(),
            url: "https://news.example/nd".into(),
            snippet: "x".into(),
            date: None,
        });
        let filtered2 = apply_freshness_filter(undated, Some("week"), now_ms);
        assert_eq!(
            filtered2.len(),
            1,
            "undated result must be dropped under a window"
        );
    }

    #[test]
    fn rfc822_date_parsing_roundtrips_and_handles_tz() {
        // Known epoch: 1 Jan 1970 00:00:00 GMT = 0.
        assert_eq!(
            parse_rfc822_to_unix_ms("Thu, 01 Jan 1970 00:00:00 GMT"),
            Some(0)
        );
        // 1 Jan 1970 01:00:00 GMT = 3_600_000 ms.
        assert_eq!(
            parse_rfc822_to_unix_ms("Thu, 01 Jan 1970 01:00:00 GMT"),
            Some(3_600_000)
        );
        // Numeric +0100 offset ⇒ UTC is one hour EARLIER ⇒ epoch 0.
        assert_eq!(
            parse_rfc822_to_unix_ms("Thu, 01 Jan 1970 01:00:00 +0100"),
            Some(0)
        );
        // No weekday prefix (bare RFC-822) still parses.
        assert_eq!(parse_rfc822_to_unix_ms("01 Jan 1970 00:00:00 GMT"), Some(0));
        // Malformed ⇒ None (so the freshness filter drops it).
        assert_eq!(parse_rfc822_to_unix_ms("not a date"), None);
        assert_eq!(
            parse_rfc822_to_unix_ms("Mon, 99 Foo 2020 12:00:00 GMT"),
            None
        );
    }

    // ── No-dates warning + formatting parity ──

    #[test]
    fn build_receipt_emits_no_dates_warning_for_dated_provider() {
        let exec = WebSearchExecutor::with_config(WebSearchConfig::default());
        // gnews + freshness applied + results with NO dates ⇒ the no-dates warning.
        let results = vec![SearchResult {
            title: "X".into(),
            url: "https://x/".into(),
            snippet: "s".into(),
            date: None,
        }];
        let receipt = exec.build_receipt(ResolvedProvider::GoogleNewsRss, results, true, None);
        let content = receipt.content.unwrap();
        assert!(content.contains(NO_DATES_WARNING), "content: {content}");
    }

    #[test]
    fn build_receipt_ddg_freshness_warning_takes_precedence_over_no_dates() {
        let exec = WebSearchExecutor::with_config(WebSearchConfig::default());
        // ddg + a prior (timeliness) warning ⇒ the no-dates warning is NOT added (prior wins),
        // and ddg is not a dated provider anyway.
        let results = vec![SearchResult {
            title: "X".into(),
            url: "https://x/".into(),
            snippet: "s".into(),
            date: None,
        }];
        let receipt = exec.build_receipt(
            ResolvedProvider::DuckDuckGo,
            results,
            false,
            Some(DUCKDUCKGO_TIMELINESS_WARNING.to_string()),
        );
        let content = receipt.content.unwrap();
        assert!(
            content.contains("does not provide verified recency"),
            "content: {content}"
        );
        assert!(
            !content.contains(NO_DATES_WARNING),
            "no-dates must not be added: {content}"
        );
    }

    #[test]
    fn format_results_no_results_and_warning_paths() {
        // No results, no warning.
        assert_eq!(format_results(&[], None), "No results found.");
        // No results, with warning.
        assert_eq!(
            format_results(&[], Some("careful")),
            "Warning: careful\n\nNo results found."
        );
        // Results with a date render a Date line; warning prefixes.
        let results = vec![SearchResult {
            title: "Title".into(),
            url: "https://u/".into(),
            snippet: "the snippet".into(),
            date: Some("2026-06-01".into()),
        }];
        let out = format_results(&results, Some("w"));
        assert!(out.starts_with("Warning: w\n\n"));
        assert!(out.contains("1. Title"));
        assert!(out.contains("   URL: https://u/"));
        assert!(out.contains("   Date: 2026-06-01"));
        assert!(out.contains("   the snippet"));
    }

    #[test]
    fn num_results_clamped_to_1_20() {
        // Drive clamp through the missing-key path's param parse is awkward; assert the clamp
        // arithmetic the executor uses directly.
        let clamp = |n: i64| n.clamp(1, MAX_NUM_RESULTS as i64) as usize;
        assert_eq!(clamp(0), 1);
        assert_eq!(clamp(-5), 1);
        assert_eq!(clamp(7), 7);
        assert_eq!(clamp(100), 20);
    }

    // ── Mock-server e2e (NO real network — in-process 127.0.0.1, allow-private SSRF) ──

    use std::io::Write as _;
    use std::net::TcpListener;
    use std::thread;

    /// One-shot in-process mock HTTP server on 127.0.0.1. Returns its base URL + a join handle.
    /// Drains the FULL request (headers + any Content-Length body) before replying — a POST body
    /// (serper/tavily) can split across TCP segments, and replying+closing on a half-read socket
    /// can reset the client mid-write (surfacing as a transport `Io`). Read until the declared
    /// body is in hand, bounded by a short read-timeout. Mirrors the L2-1 web_fetch mock.
    fn spawn_mock(
        body: &'static str,
        content_type: &'static str,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 2048];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            let text = String::from_utf8_lossy(&buf);
                            if let Some(hdr_end) = text.find("\r\n\r\n") {
                                let content_len = text
                                    .get(..hdr_end)
                                    .and_then(|h| {
                                        h.lines()
                                            .find(|l| {
                                                l.to_lowercase().starts_with("content-length:")
                                            })
                                            .and_then(|l| l.split(':').nth(1))
                                            .and_then(|v| v.trim().parse::<usize>().ok())
                                    })
                                    .unwrap_or(0);
                                if buf.len() - (hdr_end + 4) >= content_len {
                                    break;
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}/"), handle)
    }

    /// An executor whose endpoints all point at `base` (the loopback mock) + allow-private SSRF.
    fn mock_executor(
        base: &str,
        provider: ConfiguredProvider,
        serper_key: Option<&str>,
    ) -> WebSearchExecutor {
        WebSearchExecutor::with_config(WebSearchConfig {
            provider,
            serper_api_key: serper_key.map(str::to_string),
            tavily_api_key: None,
            ssrf_policy: SsrfPolicy {
                allow_private_network: true,
                ..Default::default()
            },
            endpoints: Endpoints {
                serper: base.to_string(),
                tavily: base.to_string(),
                duckduckgo: base.to_string(),
                google_news_rss: base.to_string(),
            },
        })
    }

    #[test]
    fn e2e_serper_through_executor_with_key() {
        let (base, h) = spawn_mock(
            r#"{"organic":[{"title":"Result One","link":"https://r1/","snippet":"snip one","date":"2026-06-10"}]}"#,
            "application/json",
        );
        let exec = mock_executor(&base, ConfiguredProvider::Serper, Some("test-serper-key"));
        let receipt = exec
            .execute(
                "web_search",
                &[
                    ("query".into(), "rust".into()),
                    ("numResults".into(), "5".into()),
                ],
            )
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(content.contains("1. Result One"), "content: {content}");
        assert!(content.contains("URL: https://r1/"));
        assert!(content.contains("snip one"));
        assert!(receipt.summary.contains("web_search [serper]"));
        h.join().unwrap();
    }

    #[test]
    fn e2e_duckduckgo_through_executor_keyless_auto() {
        let (base, h) = spawn_mock(
            r#"<a class="result__a" href="https://ddg.example/x">DDG Title</a><a class="result__snippet">ddg snippet body</a>"#,
            "text/html",
        );
        // Auto + non-time-sensitive query + no keys ⇒ duckduckgo.
        let exec = mock_executor(&base, ConfiguredProvider::Auto, None);
        let receipt = exec
            .execute("web_search", &[("query".into(), "rust ownership".into())])
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(content.contains("DDG Title"), "content: {content}");
        assert!(content.contains("ddg snippet body"));
        assert!(receipt.summary.contains("web_search [duckduckgo]"));
        h.join().unwrap();
    }

    #[test]
    fn e2e_auto_time_sensitive_routes_to_google_news_rss() {
        let (base, h) = spawn_mock(
            "<rss><channel><item><title>Breaking Item</title><link>https://n/1</link><description>desc</description><pubDate>Sun, 14 Jun 2026 12:00:00 GMT</pubDate></item></channel></rss>",
            "application/rss+xml",
        );
        // Auto + "latest" query ⇒ google_news_rss (keyless).
        let exec = mock_executor(&base, ConfiguredProvider::Auto, None);
        let receipt = exec
            .execute("web_search", &[("query".into(), "latest rust news".into())])
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(content.contains("Breaking Item"), "content: {content}");
        assert!(receipt.summary.contains("web_search [google_news_rss]"));
        h.join().unwrap();
    }

    #[test]
    fn e2e_duckduckgo_freshness_emits_timeliness_warning() {
        let (base, h) = spawn_mock(
            r#"<a class="result__a" href="https://ddg/x">T</a><a class="result__snippet">s</a>"#,
            "text/html",
        );
        // DDG explicitly + freshness requested ⇒ the timeliness warning is in the content.
        let exec = mock_executor(&base, ConfiguredProvider::DuckDuckGo, None);
        let receipt = exec
            .execute(
                "web_search",
                &[
                    ("query".into(), "x".into()),
                    ("freshness".into(), "day".into()),
                ],
            )
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(
            content.contains("does not provide verified recency"),
            "content: {content}"
        );
        h.join().unwrap();
    }
}
