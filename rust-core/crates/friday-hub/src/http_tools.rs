//! L2-1 `web_fetch` capability tool — SSRF-guarded outbound HTTP.
//!
//! Ported from the TS oracle `src/agent/tools/friday-agent-web-fetch-tool.ts` +
//! `src/agent/security/friday-agent-fetch-guard.ts`. This is the FIRST L2 capability tool: it
//! lets the agent pull EXTERNAL web content into its context. External content is
//! prompt-injection-inward AND an SSRF egress risk, so the tool is built with the egress
//! guard wired in, not bolted on:
//!   - it ALWAYS validates the URL through [`crate::ssrf_guard`] BEFORE every fetch (and
//!     re-validates EVERY redirect hop) — there is no code path from a `web_fetch` call to a
//!     socket that skips the guard;
//!   - it RESOLVES the host itself, validates EVERY resolved IP (the DNS-resolved /
//!     anti-rebinding check), and PINS exactly those validated addresses into the ureq
//!     connection via a custom resolver — so the request can only reach an IP the guard
//!     approved (no TOCTOU window between validation and connect);
//!   - it DISABLES ureq's automatic redirects (`redirects(0)`) and follows them MANUALLY,
//!     re-running the full guard (incl. resolve+pin) on each hop, capped at 3 hops with loop
//!     detection — a redirect to `http://169.254.169.254/` is blocked at the hop.
//!
//! ## Limits (parity with the TS oracle)
//!   - read cap: [`WEB_FETCH_READ_MAX_BYTES`] = 512 KiB read off the socket (the body is read
//!     through a `take()`-bounded reader so a hostile server cannot stream unbounded bytes);
//!   - model-facing truncation: [`WEB_FETCH_MODEL_MAX_BYTES`] = 100 KiB (the `ToolReceipt`
//!     content fed back to the model is truncated to this on a UTF-8 boundary);
//!   - timeout: default 30 s (`timeoutMs` param can shorten/lengthen; clamped to >= 1 ms);
//!   - browser User-Agent + Accept headers, overridable by caller `headers`.
//!
//! ## Wiring
//! The tool is REGISTERED in [`crate::ToolRegistry::default`] (`mutating:false,
//! Risk::ReadOnly`), but the gate-dispatch chokepoint REFUSES it unless
//! `FRIDAY_WEB_FETCH_ENABLED` is exactly `"1"` (see `lib.rs`
//! `gate_dispatch_with_policy_enforced`). So with the flag OFF (the prod default — this is
//! DARK, flipping it live is operator-gated egress capability) `web_fetch` is unavailable
//! and behavior is byte-identical to today. [`CompositeToolExecutor`] delegates `web_fetch`
//! here and every other action to the inner [`crate::FsToolExecutor`], so the existing
//! fs/shell tools are untouched.

use crate::ssrf_guard::{self, SsrfError, SsrfPolicy};
use crate::{ExecError, ToolExecutor, ToolReceipt};
use std::io::Read;
use std::net::{SocketAddr, ToSocketAddrs};
use std::time::Duration;

/// Max bytes read off the socket for a `web_fetch` body (512 KiB). A bounded read so a
/// hostile/huge response cannot exhaust memory; mirrors the TS oracle's read cap.
pub const WEB_FETCH_READ_MAX_BYTES: usize = 512 * 1024;

/// Max bytes of `web_fetch` body surfaced to the model (100 KiB). The read body (<=512 KiB)
/// is truncated to this on a UTF-8 boundary before becoming the `ToolReceipt` content.
pub const WEB_FETCH_MODEL_MAX_BYTES: usize = 100 * 1024;

/// Default request timeout (30 s) — matches the TS oracle.
const WEB_FETCH_DEFAULT_TIMEOUT_MS: u64 = 30_000;

/// Max redirect hops followed (matches the TS fetch-guard default).
const WEB_FETCH_MAX_REDIRECTS: u32 = 3;

/// Marker appended when the model-facing body was truncated to [`WEB_FETCH_MODEL_MAX_BYTES`].
const TRUNCATION_MARKER: &str = "\n…[web_fetch content truncated]";

const REDIRECT_STATUSES: &[u16] = &[301, 302, 303, 307, 308];

const VALID_METHODS: &[&str] = &["GET", "POST", "PUT", "DELETE"];

const BROWSER_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 \
                          (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

/// Executes the `web_fetch` action. Constructed with an [`SsrfPolicy`] (production = the
/// deny-private default; tests inject `allow_private_network` to reach a loopback mock
/// server). Implements [`ToolExecutor`] for ONLY the `web_fetch` action — every other action
/// is `ExecError::Unsupported` (the [`CompositeToolExecutor`] routes the rest to fs).
pub struct WebFetchExecutor {
    policy: SsrfPolicy,
}

impl WebFetchExecutor {
    /// Production constructor: the deny-all-private SSRF posture.
    pub fn new() -> Self {
        Self {
            policy: SsrfPolicy::default(),
        }
    }

    /// Construct with an explicit policy. Used by the e2e tests to set
    /// `allow_private_network = true` so a 127.0.0.1 mock server is reachable; NEVER used
    /// with private-allowed in production.
    pub fn with_policy(policy: SsrfPolicy) -> Self {
        Self { policy }
    }

    fn param<'a>(params: &'a [(String, String)], key: &str) -> Option<&'a str> {
        params
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    /// The core fetch: validate → resolve+pin → request (no auto-redirect) → manual,
    /// re-validated redirect loop → bounded read → truncate. Fail-closed on EVERY guard step.
    fn fetch(&self, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        let url = Self::param(params, "url")
            .ok_or_else(|| ExecError::MissingParam("url".to_string()))?
            .to_string();
        let method = Self::param(params, "method")
            .unwrap_or("GET")
            .to_uppercase();
        if !VALID_METHODS.contains(&method.as_str()) {
            return Err(ExecError::Unsupported(format!("web_fetch_method:{method}")));
        }
        let body = Self::param(params, "body");
        let timeout_ms = Self::param(params, "timeoutMs")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(WEB_FETCH_DEFAULT_TIMEOUT_MS)
            .max(1);
        // parseHtml defaults to true (HTML → readable-ish text); "false"/"0" ⇒ raw.
        let parse_html = match Self::param(params, "parseHtml") {
            Some(v) => !matches!(v.trim().to_lowercase().as_str(), "false" | "0"),
            None => true,
        };
        // Optional caller headers, encoded as a single param "k1:v1\nk2:v2" (the dev bridge
        // flattens the TS `headers` object this way). Browser defaults applied first; caller
        // headers win on conflict.
        let extra_headers = Self::param(params, "headers")
            .map(parse_headers_param)
            .unwrap_or_default();

        let timeout = Duration::from_millis(timeout_ms);

        // ── Manual, re-validated redirect loop (mirrors the TS fetch-guard) ──
        let mut current = url.clone();
        let mut seen: Vec<String> = Vec::new();
        let mut hop: u32 = 0;
        loop {
            if seen.iter().any(|u| u == &current) {
                return Err(ExecError::WebFetch(WebFetchError::RedirectLoop(current)));
            }
            seen.push(current.clone());

            // (1) SYNC SSRF check (protocol / literal-IP / blocked-name / allowlist).
            ssrf_guard::validate_url(&current, &self.policy)
                .map_err(|e| ExecError::WebFetch(WebFetchError::Ssrf(e)))?;

            // (2) RESOLVE the host ourselves + validate EVERY resolved IP (anti-rebinding),
            //     then PIN exactly those validated SocketAddrs into the ureq connection.
            let pinned = self.resolve_and_pin(&current)?;

            let agent = ureq::AgentBuilder::new()
                .redirects(0) // we follow redirects manually + re-validate each hop
                .timeout(timeout)
                .resolver(pinned.resolver())
                .build();

            let req = agent
                .request(&method, &current)
                .set("User-Agent", BROWSER_UA)
                .set(
                    "Accept",
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
                )
                .set("Accept-Language", "en-US,en;q=0.9");
            let req = extra_headers.iter().fold(req, |r, (k, v)| r.set(k, v));

            // GET/DELETE carry no body; POST/PUT send the optional body string.
            let send_result = if method == "GET" || method == "DELETE" {
                req.call()
            } else {
                req.send_string(body.unwrap_or(""))
            };

            // ureq returns Err(Status(code, resp)) for 4xx/5xx (a real HTTP response we still
            // want to surface), and Err(Transport(..)) for connect/timeout/TLS failures.
            let resp = match send_result {
                Ok(resp) => resp,
                Err(ureq::Error::Status(_code, resp)) => resp,
                Err(ureq::Error::Transport(t)) => {
                    let kind = format!("{:?}", t.kind());
                    return Err(ExecError::WebFetch(WebFetchError::Transport(kind)));
                }
            };

            let status = resp.status();
            // ── Redirect handling (re-validated next hop) ──
            if REDIRECT_STATUSES.contains(&status) {
                if let Some(location) = resp.header("Location").map(str::to_string) {
                    // Resolve a (possibly relative) Location against the current URL.
                    let next = url::Url::parse(&current)
                        .ok()
                        .and_then(|base| base.join(&location).ok())
                        .map(|u| u.to_string())
                        .ok_or_else(|| {
                            ExecError::WebFetch(WebFetchError::BadRedirect(location.clone()))
                        })?;
                    if hop + 1 > WEB_FETCH_MAX_REDIRECTS {
                        return Err(ExecError::WebFetch(WebFetchError::TooManyRedirects));
                    }
                    hop += 1;
                    current = next;
                    continue; // re-validate the next hop at the top of the loop
                }
                // 3xx with no Location ⇒ treat as the terminal response (parity with TS).
            }

            // ── Terminal response: bounded read + truncation ──
            let status_text = resp.status_text().to_string();
            let content_type = resp.content_type().to_string();
            let body_text = read_bounded(resp.into_reader(), WEB_FETCH_READ_MAX_BYTES);

            let is_html = content_type.contains("html")
                || (content_type.is_empty() && body_text.trim_start().starts_with('<'));
            let processed = if parse_html && is_html {
                html_to_text(&body_text)
            } else {
                body_text
            };
            let (model_body, truncated) =
                truncate_on_char_boundary(&processed, WEB_FETCH_MODEL_MAX_BYTES);

            let mut content = format!("HTTP {status} {status_text}");
            if !content_type.is_empty() {
                content.push_str(&format!("\nContent-Type: {content_type}"));
            }
            if parse_html && is_html {
                content.push_str("\n(HTML parsed to plain text)");
            }
            content.push('\n');
            content.push('\n');
            content.push_str(model_body);
            if truncated {
                content.push_str(TRUNCATION_MARKER);
            }

            // summary (REFS-ONLY → the hash-chained audit ledger): method + final host +
            // status + byte count ONLY. NEVER the body (external content may be hostile /
            // injection), NEVER any header. Mirrors run_command keeping output off the ledger.
            let final_host = url::Url::parse(&current)
                .ok()
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_default();
            let summary = format!(
                "web_fetch {method} {final_host}: HTTP {status}, {} bytes{}",
                processed.len(),
                if truncated { " (truncated)" } else { "" }
            );

            return Ok(ToolReceipt {
                action: "web_fetch".to_string(),
                summary,
                content: Some(content),
            });
        }
    }

    /// Resolve `url`'s host:port to socket addresses, validate EVERY resolved IP through the
    /// SSRF guard (fail-closed on a private IP or an empty/failed resolution), and return a
    /// [`PinnedTarget`] whose resolver yields ONLY these validated addresses to ureq.
    fn resolve_and_pin(&self, url: &str) -> Result<PinnedTarget, ExecError> {
        let parsed = url::Url::parse(url).map_err(|_| {
            ExecError::WebFetch(WebFetchError::Ssrf(SsrfError::InvalidUrl(url.to_string())))
        })?;
        let host = parsed
            .host_str()
            .ok_or(ExecError::WebFetch(WebFetchError::Ssrf(
                SsrfError::EmptyHost,
            )))?
            .to_string();
        let port = parsed
            .port_or_known_default()
            .unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });

        // ureq calls the resolver with the netloc "host:port" — strip IPv6 brackets for our
        // std resolution but key the pin map on the EXACT netloc ureq will pass.
        let host_for_resolve = host.trim_start_matches('[').trim_end_matches(']');
        let netloc = format!("{host}:{port}");

        let socket_addrs: Vec<SocketAddr> = (host_for_resolve, port)
            .to_socket_addrs()
            .map(|it| it.collect())
            .unwrap_or_default();
        let ips: Vec<std::net::IpAddr> = socket_addrs.iter().map(|sa| sa.ip()).collect();

        // DNS-resolved (anti-rebinding) check — fail-closed on empty / any private IP.
        ssrf_guard::validate_resolved_addrs(&host, &ips, &self.policy)
            .map_err(|e| ExecError::WebFetch(WebFetchError::Ssrf(e)))?;

        Ok(PinnedTarget {
            netloc,
            addrs: socket_addrs,
        })
    }
}

impl Default for WebFetchExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl ToolExecutor for WebFetchExecutor {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        match action {
            "web_fetch" => self.fetch(params),
            other => Err(ExecError::Unsupported(other.to_string())),
        }
    }
}

/// A host:port pinned to its SSRF-validated socket addresses. Its [`resolver`] is handed to
/// ureq so the connection can reach ONLY these validated IPs (no rebinding between our
/// validation and ureq's connect).
struct PinnedTarget {
    netloc: String,
    addrs: Vec<SocketAddr>,
}

impl PinnedTarget {
    fn resolver(&self) -> impl ureq::Resolver + 'static {
        let netloc = self.netloc.clone();
        let addrs = self.addrs.clone();
        move |requested: &str| -> std::io::Result<Vec<SocketAddr>> {
            // Pin ONLY the netloc we validated; anything else (which ureq should never ask,
            // since redirects are manual) fails closed.
            if requested == netloc {
                Ok(addrs.clone())
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "ssrf_pin_mismatch",
                ))
            }
        }
    }
}

/// SSRF-guarded, size-bounded BINARY GET of a URL — the shared egress primitive the vision
/// tool (L2-3) uses to fetch a remote image. SECURITY (no-degrade): this runs the SAME
/// fail-closed guard sequence web_fetch's terminal-hop fetch runs — `validate_url`
/// (protocol/literal-IP/blocked-name/allowlist) THEN resolve-the-host-ourselves +
/// `validate_resolved_addrs` (every resolved IP, anti-rebinding) + PIN exactly those validated
/// addresses into the ureq connection (no TOCTOU window between validation and connect). So
/// there is NO code path from this helper to a socket that skips the guard.
///
/// Unlike web_fetch this disables redirects entirely (`redirects(0)`): the caller is an image
/// fetch, not a page fetch, so a 3xx is surfaced as a transport error rather than followed —
/// the conservative posture (a CDN that 302s an image won't resolve, but no redirect-to-private
/// hop can ever be reached). Returns the bounded body bytes (read as raw `Vec<u8>`, NEVER
/// lossy-UTF-8 — image bytes must not be corrupted) + the response Content-Type (lowercased,
/// param-stripped) so the caller can derive/verify the media type. A non-2xx HTTP status is a
/// `SsrfError`-free transport error (the image simply isn't there).
pub(crate) fn ssrf_guarded_get_bytes(
    url: &str,
    policy: &SsrfPolicy,
    max_bytes: usize,
    timeout: Duration,
) -> Result<(Vec<u8>, String), ImageFetchError> {
    // (1) SYNC SSRF check (protocol / literal-IP / blocked-name / allowlist).
    ssrf_guard::validate_url(url, policy).map_err(ImageFetchError::Ssrf)?;
    // (2) RESOLVE the host ourselves + validate EVERY resolved IP (anti-rebinding), then PIN.
    let parsed = url::Url::parse(url)
        .map_err(|_| ImageFetchError::Ssrf(SsrfError::InvalidUrl(url.into())))?;
    let host = parsed
        .host_str()
        .ok_or(ImageFetchError::Ssrf(SsrfError::EmptyHost))?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .unwrap_or(if parsed.scheme() == "https" { 443 } else { 80 });
    let host_for_resolve = host.trim_start_matches('[').trim_end_matches(']');
    let netloc = format!("{host}:{port}");
    let socket_addrs: Vec<SocketAddr> = (host_for_resolve, port)
        .to_socket_addrs()
        .map(|it| it.collect())
        .unwrap_or_default();
    let ips: Vec<std::net::IpAddr> = socket_addrs.iter().map(|sa| sa.ip()).collect();
    ssrf_guard::validate_resolved_addrs(&host, &ips, policy).map_err(ImageFetchError::Ssrf)?;
    let pinned = PinnedTarget {
        netloc,
        addrs: socket_addrs,
    };

    let agent = ureq::AgentBuilder::new()
        .redirects(0) // image fetch: never follow redirects (no redirect-to-private hop reachable)
        .timeout(timeout)
        .resolver(pinned.resolver())
        .build();
    let resp = agent
        .get(url)
        .set("User-Agent", BROWSER_UA)
        .set("Accept", "image/*,*/*;q=0.8")
        .call()
        .map_err(|e| match e {
            // A 3xx (we disabled auto-follow) or 4xx/5xx is a transport-style failure for an
            // image fetch — there is no useful image body. Keep the kind only (never a secret).
            ureq::Error::Status(code, _resp) => ImageFetchError::Transport(format!("http_{code}")),
            ureq::Error::Transport(t) => ImageFetchError::Transport(format!("{:?}", t.kind())),
        })?;
    let content_type = resp
        .content_type()
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    // BINARY bounded read — `take(max)` so a hostile server cannot stream unbounded bytes, and
    // a raw `Vec<u8>` (NOT lossy-UTF-8) so the image bytes are preserved exactly.
    let mut buf: Vec<u8> = Vec::new();
    resp.into_reader()
        .take(max_bytes as u64)
        .read_to_end(&mut buf)
        .map_err(|e| ImageFetchError::Transport(format!("read:{}", e.kind())))?;
    Ok((buf, content_type))
}

/// Why an SSRF-guarded image GET ([`ssrf_guarded_get_bytes`]) failed: either the SSRF guard
/// refused the URL / a resolved IP (fail-closed egress block), or a transport/non-2xx failure
/// (kind only — never a secret, never a body). Surfaced by the L2-3 vision tool (it appears in
/// the `pub` `vision_tools::VisionToolError::ImageFetch` variant, so it is `pub` too).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageFetchError {
    /// The SSRF guard refused the image URL / a resolved IP (fail-closed egress block).
    Ssrf(SsrfError),
    /// A connect/TLS/timeout/non-2xx transport failure (kind only — never a secret/body).
    Transport(String),
}

impl std::fmt::Display for ImageFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ImageFetchError::Ssrf(e) => write!(f, "{e}"),
            ImageFetchError::Transport(k) => write!(f, "image_fetch_transport:{k}"),
        }
    }
}

/// Why a `web_fetch` failed (distinct from a normal HTTP error response, which is RETURNED as
/// a `ToolReceipt`, not an error). An SSRF block, a transport failure, or a redirect anomaly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebFetchError {
    /// The SSRF guard refused the URL / a redirect hop / the resolved IPs.
    Ssrf(SsrfError),
    /// A connect/TLS/timeout transport failure (kind only — never a secret).
    Transport(String),
    /// A redirect Location that did not resolve to a valid URL.
    BadRedirect(String),
    /// A redirect loop (a hop revisited an already-seen URL).
    RedirectLoop(String),
    /// More than the max redirect hops.
    TooManyRedirects,
}

impl std::fmt::Display for WebFetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WebFetchError::Ssrf(e) => write!(f, "{e}"),
            WebFetchError::Transport(k) => write!(f, "web_fetch_transport:{k}"),
            WebFetchError::BadRedirect(l) => write!(f, "web_fetch_bad_redirect:{l}"),
            WebFetchError::RedirectLoop(u) => write!(f, "web_fetch_redirect_loop:{u}"),
            WebFetchError::TooManyRedirects => write!(f, "web_fetch_too_many_redirects"),
        }
    }
}

/// A tool executor that routes `web_fetch` to a [`WebFetchExecutor`], `web_search` to a
/// [`crate::web_search::WebSearchExecutor`], `image_analysis` to a
/// [`crate::vision_tools::VisionExecutor`], and EVERY other action to an inner fs executor
/// (typically [`crate::FsToolExecutor`]). The composition keeps the fs/shell executor
/// untouched — the L2 capability tools are purely additive. The gate chokepoint still runs
/// before EVERY dispatch (the executor is reached only on `Allow`), and the per-capability
/// flag-gates (`FRIDAY_WEB_FETCH_ENABLED` / `FRIDAY_WEB_SEARCH_ENABLED` / `FRIDAY_VISION_ENABLED`)
/// refuse the respective tool when off, so this composite is behavior-neutral until a flag is
/// flipped.
pub struct CompositeToolExecutor<F: ToolExecutor> {
    fs: F,
    web: WebFetchExecutor,
    search: crate::web_search::WebSearchExecutor,
    vision: crate::vision_tools::VisionExecutor,
}

impl<F: ToolExecutor> CompositeToolExecutor<F> {
    pub fn new(
        fs: F,
        web: WebFetchExecutor,
        search: crate::web_search::WebSearchExecutor,
        vision: crate::vision_tools::VisionExecutor,
    ) -> Self {
        Self {
            fs,
            web,
            search,
            vision,
        }
    }
}

impl<F: ToolExecutor> ToolExecutor for CompositeToolExecutor<F> {
    fn execute(&self, action: &str, params: &[(String, String)]) -> Result<ToolReceipt, ExecError> {
        match action {
            "web_fetch" => self.web.execute(action, params),
            "web_search" => self.search.execute(action, params),
            "image_analysis" => self.vision.execute(action, params),
            _ => self.fs.execute(action, params),
        }
    }
}

// ─── helpers ───

/// Parse a flattened `"k1:v1\nk2:v2"` headers param into pairs. Empty / malformed lines are
/// dropped. Header names are passed through as-is (ureq lowercases on the wire).
fn parse_headers_param(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .filter_map(|line| {
            let idx = line.find(':')?;
            let k = line[..idx].trim();
            let v = line[idx + 1..].trim();
            if k.is_empty() {
                None
            } else {
                Some((k.to_string(), v.to_string()))
            }
        })
        .collect()
}

/// Read at most `max` bytes off a reader into a lossy-UTF-8 String. Bounded so a hostile
/// server cannot stream unbounded bytes — uses `take(max)` so reading stops at the cap.
fn read_bounded(reader: impl Read, max: usize) -> String {
    let mut buf: Vec<u8> = Vec::new();
    // +0: take EXACTLY max bytes; anything beyond is dropped (the body is "truncated at read").
    let _ = reader.take(max as u64).read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

/// The largest UTF-8 prefix of `s` whose byte length is `<= max`, plus whether bytes dropped.
/// Never splits a multi-byte char.
fn truncate_on_char_boundary(s: &str, max: usize) -> (&str, bool) {
    if s.len() <= max {
        return (s, false);
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    (&s[..end], true)
}

/// Minimal HTML → readable text: drop `<script>`/`<style>` blocks, strip tags, collapse
/// whitespace, decode a few common entities. NOT a full parser (the TS oracle delegates to a
/// heavier summarizer); this is a deterministic, dependency-free best-effort so the model
/// sees text rather than markup. Raw HTML is still available via `parseHtml=false`.
fn html_to_text(html: &str) -> String {
    // Remove <script>...</script> then <style>...</style> blocks (each pass recomputes the
    // lowercase corpus so case-insensitive matching tracks the shrinking source).
    //
    // MUST be `to_ascii_lowercase` (NOT `to_lowercase`): `remove_block` indexes the ORIGINAL
    // `src` using byte offsets found in the lowercase copy, so the two MUST stay byte-aligned.
    // `to_lowercase` is Unicode-aware and NOT length-preserving (e.g. `İ` U+0130, 2 bytes →
    // `i̇`, 3 bytes), which would desync the offsets and slice at a non-char-boundary → PANIC
    // on hostile external HTML. HTML tag names are ASCII, so ASCII-folding matches `script`/
    // `style` correctly AND is 1:1 byte-length-preserving — safe on arbitrary response bodies.
    let no_script = remove_block(html, &html.to_ascii_lowercase(), "script");
    let stripped = remove_block(&no_script, &no_script.to_ascii_lowercase(), "style");
    // Strip remaining tags.
    let mut out = String::with_capacity(stripped.len());
    let mut in_tag = false;
    for ch in stripped.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    // Decode a few common entities + collapse whitespace runs.
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Remove `<tag ...>...</tag>` blocks (case-insensitive) from `src`, using a precomputed
/// lowercase copy `src_lower` for matching. Returns the source with those blocks removed.
fn remove_block(src: &str, src_lower: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    while i < src.len() {
        if let Some(rel) = src_lower[i..].find(&open) {
            let start = i + rel;
            out.push_str(&src[i..start]);
            // Find the closing tag after the open.
            if let Some(crel) = src_lower[start..].find(&close) {
                i = start + crel + close.len();
            } else {
                // No close — drop the rest.
                i = src.len();
            }
        } else {
            out.push_str(&src[i..]);
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::thread;

    /// Spawn a one-shot in-process mock HTTP server on 127.0.0.1. Returns its base URL and a
    /// join handle. NO real network — pure loopback. The closure produces the raw HTTP
    /// response bytes given the received request bytes.
    fn spawn_mock(
        handler: impl Fn(&str) -> Vec<u8> + Send + 'static,
        accepts: usize,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            for _ in 0..accepts {
                let (mut stream, _) = match listener.accept() {
                    Ok(s) => s,
                    Err(_) => break,
                };
                // Read the FULL request: headers + (any) body. A single read() can split the
                // request line/headers from the body across TCP segments (the source of a
                // POST-body flake), so drain until we have the header terminator AND the
                // Content-Length body — with a short read-timeout so we never block forever.
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
                                // Have full headers; check for a declared body length.
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
                                let body_have = buf.len() - (hdr_end + 4);
                                if body_have >= content_len {
                                    break; // full request received
                                }
                            }
                        }
                        Err(_) => break, // read-timeout (no more bytes coming)
                    }
                }
                let req_str = String::from_utf8_lossy(&buf).into_owned();
                let response = handler(&req_str);
                let _ = stream.write_all(&response);
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), handle)
    }

    fn http_response(status: u16, reason: &str, content_type: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    /// Tests must reach 127.0.0.1, which the production SSRF policy blocks — so the e2e tests
    /// (and ONLY them) use an allow-private policy. The BLOCKING behavior is proven by the
    /// table-driven ssrf_guard tests + the dispatch-level tests, not weakened here.
    fn test_executor() -> WebFetchExecutor {
        WebFetchExecutor::with_policy(SsrfPolicy {
            allow_private_network: true,
            ..Default::default()
        })
    }

    #[test]
    fn get_returns_body_and_status() {
        let (base, h) = spawn_mock(
            |_req| http_response(200, "OK", "application/json", r#"{"ok":true}"#),
            1,
        );
        let exec = test_executor();
        let receipt = exec
            .execute(
                "web_fetch",
                &[
                    ("url".into(), base.clone()),
                    ("parseHtml".into(), "false".into()),
                ],
            )
            .unwrap();
        let content = receipt.content.unwrap();
        assert!(content.contains("HTTP 200"), "content: {content}");
        assert!(content.contains(r#"{"ok":true}"#), "content: {content}");
        assert!(receipt.summary.contains("web_fetch GET"));
        assert!(receipt.summary.contains("HTTP 200"));
        h.join().unwrap();
    }

    #[test]
    fn post_sends_body() {
        let (base, h) = spawn_mock(
            |req| {
                // Echo whether the request carried the body.
                let saw_body = req.contains("hello-post-body");
                http_response(
                    200,
                    "OK",
                    "text/plain",
                    if saw_body { "got-body" } else { "no-body" },
                )
            },
            1,
        );
        let exec = test_executor();
        let receipt = exec
            .execute(
                "web_fetch",
                &[
                    ("url".into(), base),
                    ("method".into(), "POST".into()),
                    ("body".into(), "hello-post-body".into()),
                    ("parseHtml".into(), "false".into()),
                ],
            )
            .unwrap();
        assert!(receipt.content.unwrap().contains("got-body"));
        h.join().unwrap();
    }

    #[test]
    fn read_cap_512kb_is_enforced() {
        // Server streams a body LARGER than the 512KB read cap; we must read at most the cap.
        let big = "a".repeat(WEB_FETCH_READ_MAX_BYTES + 100_000);
        let (base, h) = spawn_mock(move |_req| http_response(200, "OK", "text/plain", &big), 1);
        let exec = test_executor();
        let receipt = exec
            .execute(
                "web_fetch",
                &[("url".into(), base), ("parseHtml".into(), "false".into())],
            )
            .unwrap();
        let content = receipt.content.unwrap();
        // The model-facing content is capped at the 100KB model max (well under the 512KB
        // read cap), and is truncated.
        assert!(
            content.len() <= WEB_FETCH_MODEL_MAX_BYTES + 256,
            "model-facing content {} exceeds 100KB cap",
            content.len()
        );
        assert!(content.contains("truncated"), "expected truncation marker");
        h.join().unwrap();
    }

    #[test]
    fn model_facing_truncation_100kb() {
        // Body between 100KB and 512KB: fully READ but truncated to 100KB for the model.
        let body = "b".repeat(200 * 1024);
        let (base, h) = spawn_mock(move |_req| http_response(200, "OK", "text/plain", &body), 1);
        let exec = test_executor();
        let receipt = exec
            .execute(
                "web_fetch",
                &[("url".into(), base), ("parseHtml".into(), "false".into())],
            )
            .unwrap();
        let receipt_summary = receipt.summary.clone();
        let content = receipt.content.unwrap();
        assert!(content.contains("truncated"));
        // The summary reports the FULL read byte count (200KB), proving the body was read past
        // the 100KB model cap but truncated only for the model.
        assert!(
            receipt_summary.contains(&format!("{} bytes", 200 * 1024)),
            "summary: {receipt_summary}"
        );
        h.join().unwrap();
    }

    #[test]
    fn html_is_parsed_to_text_by_default() {
        let (base, h) = spawn_mock(
            |_req| {
                http_response(
                    200,
                    "OK",
                    "text/html",
                    "<html><head><style>.x{color:red}</style><script>alert(1)</script></head>\
                     <body><h1>Title</h1><p>Hello &amp; welcome</p></body></html>",
                )
            },
            1,
        );
        let exec = test_executor();
        let receipt = exec.execute("web_fetch", &[("url".into(), base)]).unwrap();
        let content = receipt.content.unwrap();
        assert!(
            content.contains("(HTML parsed to plain text)"),
            "content: {content}"
        );
        assert!(content.contains("Title"));
        assert!(content.contains("Hello & welcome"));
        // script/style contents are stripped.
        assert!(
            !content.contains("alert(1)"),
            "script content leaked: {content}"
        );
        assert!(
            !content.contains("color:red"),
            "style content leaked: {content}"
        );
        h.join().unwrap();
    }

    #[test]
    fn html_to_text_does_not_panic_on_non_ascii_before_script_block() {
        // REGRESSION: `remove_block` indexes the original HTML using offsets from a lowercase
        // copy. A non-ASCII char whose Unicode lowercase changes byte length (`İ` U+0130, 2
        // bytes → 3 bytes under to_lowercase) appearing BEFORE a <script> block would desync
        // the offsets and panic on a non-char-boundary slice if we used to_lowercase. With
        // to_ascii_lowercase the offsets stay aligned. Drive it through the real executor +
        // mock server (parseHtml defaults true) so the whole path is exercised.
        // `İ` (U+0130, 2 bytes) before the script block + a multibyte char (`é`) AFTER it: under
        // `to_lowercase`, `İ`→`i̇` adds a byte, shifting every later offset so the slice lands
        // mid-`é` → panic. Verified to panic with to_lowercase + pass with to_ascii_lowercase.
        let (base, h) = spawn_mock(
            |_req| http_response(200, "OK", "text/html", "İ<script>evil()</script>é"),
            1,
        );
        let exec = test_executor();
        let receipt = exec.execute("web_fetch", &[("url".into(), base)]).unwrap(); // must NOT panic
        let content = receipt.content.unwrap();
        assert!(content.contains('İ'), "content: {content}");
        assert!(content.contains('é'), "content: {content}");
        // The script block is stripped even though `İ` precedes it.
        assert!(
            !content.contains("evil()"),
            "script content leaked: {content}"
        );
        h.join().unwrap();
    }

    #[test]
    fn redirect_is_followed_and_revalidated() {
        // First hop 302 -> /final ; second hop 200. Both on the same loopback server.
        let (base, h) = spawn_mock(
            |req| {
                if req.starts_with("GET /final") {
                    http_response(200, "OK", "text/plain", "final-destination")
                } else {
                    // 302 to a relative /final
                    b"HTTP/1.1 302 Found\r\nLocation: /final\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
                }
            },
            2,
        );
        let exec = test_executor();
        let receipt = exec
            .execute(
                "web_fetch",
                &[("url".into(), base), ("parseHtml".into(), "false".into())],
            )
            .unwrap();
        assert!(receipt.content.unwrap().contains("final-destination"));
        h.join().unwrap();
    }

    #[test]
    fn invalid_method_is_rejected() {
        let exec = test_executor();
        let err = exec
            .execute(
                "web_fetch",
                &[
                    ("url".into(), "http://127.0.0.1:1/".into()),
                    ("method".into(), "PATCH".into()),
                ],
            )
            .unwrap_err();
        assert!(matches!(err, ExecError::Unsupported(_)), "got {err:?}");
    }

    #[test]
    fn missing_url_is_missing_param() {
        let exec = test_executor();
        let err = exec.execute("web_fetch", &[]).unwrap_err();
        assert!(matches!(err, ExecError::MissingParam(p) if p == "url"));
    }

    #[test]
    fn production_policy_blocks_loopback_ssrf() {
        // The DEFAULT (production) executor refuses a loopback URL fail-closed — proving the
        // executor calls the SSRF guard before any socket (no allow-private here).
        let exec = WebFetchExecutor::new();
        let err = exec
            .execute(
                "web_fetch",
                &[("url".into(), "http://127.0.0.1:80/".into())],
            )
            .unwrap_err();
        assert!(
            matches!(err, ExecError::WebFetch(WebFetchError::Ssrf(_))),
            "loopback must be SSRF-blocked under the prod policy, got {err:?}"
        );
    }

    #[test]
    fn production_policy_blocks_metadata_ssrf() {
        let exec = WebFetchExecutor::new();
        let err = exec
            .execute(
                "web_fetch",
                &[(
                    "url".into(),
                    "http://169.254.169.254/latest/meta-data/".into(),
                )],
            )
            .unwrap_err();
        assert!(
            matches!(err, ExecError::WebFetch(WebFetchError::Ssrf(_))),
            "got {err:?}"
        );
    }

    #[test]
    fn unsupported_action_on_web_executor() {
        let exec = test_executor();
        let err = exec
            .execute("read_file", &[("path".into(), "x".into())])
            .unwrap_err();
        assert!(matches!(err, ExecError::Unsupported(_)));
    }

    #[test]
    fn timeout_is_enforced() {
        // Server accepts then never replies; a short timeout must surface a transport error.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                // Hold the connection open without responding until the client times out.
                thread::sleep(Duration::from_millis(800));
                drop(stream);
            }
        });
        let exec = test_executor();
        let err = exec
            .execute(
                "web_fetch",
                &[
                    ("url".into(), format!("http://{addr}/")),
                    ("timeoutMs".into(), "150".into()),
                ],
            )
            .unwrap_err();
        assert!(
            matches!(err, ExecError::WebFetch(WebFetchError::Transport(_))),
            "expected a transport/timeout error, got {err:?}"
        );
        h.join().unwrap();
    }
}
