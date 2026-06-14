//! url_guard — the `browser` navigation security guard: protocol allow + origin-allowlist
//! (`validateUrl` / `matchesOrigin` ported faithfully from the TS `friday-browser-manager`).
//!
//! This is the highest-value dark security unit. Every navigation flows through
//! [`validate_url`] BEFORE any backend call:
//!
//! 1. The URL must parse and use `http:`/`https:` only (no `file:`/`data:`/`javascript:`…).
//! 2. Its origin (scheme + lowercased host + non-default port) must match the
//!    operator-curated `allowed_origins` list, with the oracle's DEFAULT-DENY semantics:
//!    - empty list → DENY everything (the misconfiguration-trap fix);
//!    - the single sentinel [`FRIDAY_BROWSER_ALLOW_ANY_ORIGIN`] (`"*"`) → allow any;
//!    - exact origin match, OR a single-label wildcard subdomain (`https://*.example.com`)
//!      whose `*` matches exactly ONE DNS label (no embedded dots → no
//!      `evil.com.example.com` subdomain-confusion).
//!
//! There is intentionally NO private-IP/metadata-range blocker here: the oracle's guard is
//! protocol + origin-allowlist, not IP-range SSRF, and adding one would diverge from the
//! oracle's tested behavior. The allowlist IS the SSRF boundary (an operator who allows
//! only their trusted origins cannot be steered to `169.254.169.254`).
//!
//! No `url` crate dependency: origin extraction is hand-rolled to exactly the precision
//! the allowlist needs (scheme + host + port), pinned to the oracle's `new URL().origin`
//! behavior by the test vectors below. Pure computation — no I/O.

use thiserror::Error;

/// The explicit opt-in sentinel that permits ANY origin (the oracle's `"*"`). Use only
/// when the deployment cannot enumerate a trusted-origin allowlist; prefer an explicit
/// list in production.
pub const FRIDAY_BROWSER_ALLOW_ANY_ORIGIN: &str = "*";

/// A navigation rejected by the guard. Coarse, payload-bounded messages mirroring the
/// oracle's returned strings (kept stable so the hub/handlers can surface them verbatim).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum UrlGuardError {
    /// The URL did not parse into scheme + host.
    #[error("Invalid URL: {0}")]
    InvalidUrl(String),
    /// The scheme is not `http:`/`https:`.
    #[error("Protocol \"{0}:\" is not allowed. Only http: and https: are permitted.")]
    DisallowedProtocol(String),
    /// The origin is not in the allowlist (or the list is empty → default-deny).
    #[error("Origin \"{0}\" is not in the allowed origins list.")]
    OriginNotAllowed(String),
}

/// A minimally-parsed URL: scheme + origin, mirroring the subset of `new URL()` the guard
/// reads. Hand-rolled (no `url` crate).
struct ParsedUrl {
    /// Lowercased scheme, WITHOUT the trailing colon (e.g. `"https"`).
    scheme: String,
    /// The origin string, exactly as the oracle's `URL.origin` would render it:
    /// `scheme://host[:port]`, host lowercased, the scheme's DEFAULT port omitted.
    origin: String,
}

/// Default ports the oracle's `URL.origin` omits.
fn default_port_for(scheme: &str) -> Option<&'static str> {
    match scheme {
        "http" => Some("80"),
        "https" => Some("443"),
        _ => None,
    }
}

/// Parse `url` far enough to read scheme + origin. Returns `None` for anything that does
/// not look like an absolute `scheme://authority…` URL (the cases `new URL()` would throw
/// on for our purposes — relative URLs, missing authority).
fn parse_url(url: &str) -> Option<ParsedUrl> {
    // Split scheme from the rest at the first "://" (we only handle authority-based
    // http/https URLs; that is all the guard needs and all the oracle navigates).
    let scheme_end = url.find("://")?;
    let scheme = url[..scheme_end].to_ascii_lowercase();
    if scheme.is_empty()
        || !scheme
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'-' || b == b'.')
    {
        return None;
    }
    let after_scheme = &url[scheme_end + 3..];

    // The authority ends at the first '/', '?' or '#'.
    let authority_end = after_scheme
        .find(['/', '?', '#'])
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..authority_end];

    // Strip optional userinfo ("user:pass@host") — the oracle's origin excludes it.
    let host_port = match authority.rfind('@') {
        Some(at) => &authority[at + 1..],
        None => authority,
    };
    if host_port.is_empty() {
        return None;
    }

    // Split host and port. IPv6 literals are bracketed: "[::1]:8080".
    let (host_raw, port) = if let Some(rest) = host_port.strip_prefix('[') {
        // "[ipv6]" or "[ipv6]:port"
        let close = rest.find(']')?;
        let host = &rest[..close];
        let after = &rest[close + 1..];
        let port = after.strip_prefix(':').filter(|p| !p.is_empty());
        (format!("[{host}]"), port)
    } else {
        match host_port.rfind(':') {
            Some(colon) => {
                let p = &host_port[colon + 1..];
                // Treat a trailing ":" or a non-numeric tail as no port (defensive).
                if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) {
                    (host_port[..colon].to_string(), Some(p))
                } else {
                    (host_port.to_string(), None)
                }
            }
            None => (host_port.to_string(), None),
        }
    };

    let host = host_raw.to_ascii_lowercase();
    if host.is_empty() || host == "[]" {
        return None;
    }

    // Render origin like URL.origin: omit the scheme's default port.
    let origin = match port {
        Some(p) if Some(p) != default_port_for(&scheme) => format!("{scheme}://{host}:{p}"),
        _ => format!("{scheme}://{host}"),
    };

    Some(ParsedUrl { scheme, origin })
}

/// Whether `origin` matches a single allowlist `pattern`. Exact match, or a single-label
/// wildcard subdomain (`https://*.example.com`) where `*` matches exactly ONE DNS label
/// (NO embedded dots — so `*.example.com` cannot match `evil.com.example.com`).
fn origin_matches_pattern(origin: &str, pattern: &str) -> bool {
    if pattern == FRIDAY_BROWSER_ALLOW_ANY_ORIGIN {
        return true;
    }
    if !pattern.contains('*') {
        return origin == pattern;
    }
    // Wildcard: the `*` stands for exactly one DNS label = [A-Za-z0-9-]+ (no dots). Split
    // the pattern on the single `*` and require the origin to start/end with the literal
    // parts and have a non-empty single-label middle.
    let star = match pattern.find('*') {
        Some(i) => i,
        None => return false,
    };
    let prefix = &pattern[..star];
    let suffix = &pattern[star + 1..];
    // A second `*` is not a shape the oracle's regex produces a single-label match for;
    // be conservative and reject (the oracle builds one regex per pattern, but a 2nd `*`
    // would also become a single-label class — keeping to one `*` is the documented form).
    if suffix.contains('*') {
        return false;
    }
    if !origin.starts_with(prefix) || !origin.ends_with(suffix) {
        return false;
    }
    if origin.len() < prefix.len() + suffix.len() {
        return false;
    }
    let label = &origin[prefix.len()..origin.len() - suffix.len()];
    !label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Whether `url`'s origin is permitted by `allowed_origins` (the oracle's `matchesOrigin`).
/// DEFAULT-DENY: empty list → `false`; the sole `"*"` sentinel → `true`; otherwise an
/// exact-origin or single-label-wildcard match.
#[must_use]
pub fn matches_origin(url: &str, allowed_origins: &[String]) -> bool {
    // Empty → deny (the misconfiguration-trap fix). A lone "*" → allow any.
    if allowed_origins.is_empty() {
        return false;
    }
    if allowed_origins.len() == 1 && allowed_origins[0] == FRIDAY_BROWSER_ALLOW_ANY_ORIGIN {
        return true;
    }
    let parsed = match parse_url(url) {
        Some(p) => p,
        None => return false,
    };
    allowed_origins
        .iter()
        .any(|pattern| origin_matches_pattern(&parsed.origin, pattern))
}

/// Validate a navigation URL against the protocol + origin-allowlist guard. Returns `Ok`
/// to proceed, or the specific [`UrlGuardError`] to reject (the oracle's `validateUrl`,
/// which returns `undefined` to allow or an error string to reject — here `Result`).
pub fn validate_url(url: &str, allowed_origins: &[String]) -> Result<(), UrlGuardError> {
    let parsed = parse_url(url).ok_or_else(|| UrlGuardError::InvalidUrl(url.to_string()))?;

    if parsed.scheme != "http" && parsed.scheme != "https" {
        return Err(UrlGuardError::DisallowedProtocol(parsed.scheme));
    }

    if !matches_origin(url, allowed_origins) {
        return Err(UrlGuardError::OriginNotAllowed(parsed.origin));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn empty_allowlist_denies_everything() {
        // The default-deny misconfiguration-trap fix: empty list → reject any URL.
        assert_eq!(
            validate_url("https://example.com/", &[]),
            Err(UrlGuardError::OriginNotAllowed(
                "https://example.com".to_string()
            ))
        );
        assert!(!matches_origin("https://example.com/", &[]));
    }

    #[test]
    fn allow_any_sentinel_permits_any_origin() {
        let any = list(&["*"]);
        assert!(matches_origin("https://example.com/", &any));
        assert!(matches_origin("http://other.test:8080/path", &any));
        assert_eq!(validate_url("https://anything.example/", &any), Ok(()));
    }

    #[test]
    fn non_http_protocol_is_rejected_even_with_allow_any() {
        // Protocol is checked before/independent of the allowlist.
        assert_eq!(
            validate_url("file:///etc/passwd", &list(&["*"])),
            Err(UrlGuardError::InvalidUrl("file:///etc/passwd".to_string()))
        );
        // A scheme with an authority but disallowed protocol → DisallowedProtocol.
        assert_eq!(
            validate_url("ftp://example.com/", &list(&["*"])),
            Err(UrlGuardError::DisallowedProtocol("ftp".to_string()))
        );
    }

    #[test]
    fn invalid_url_is_rejected() {
        assert_eq!(
            validate_url("not a url", &list(&["*"])),
            Err(UrlGuardError::InvalidUrl("not a url".to_string()))
        );
        assert_eq!(
            validate_url("https://", &list(&["*"])),
            Err(UrlGuardError::InvalidUrl("https://".to_string()))
        );
    }

    #[test]
    fn exact_origin_match() {
        let allow = list(&["https://example.com"]);
        assert_eq!(validate_url("https://example.com/page?q=1", &allow), Ok(()));
        // Different host → denied.
        assert_eq!(
            validate_url("https://evil.com/", &allow),
            Err(UrlGuardError::OriginNotAllowed(
                "https://evil.com".to_string()
            ))
        );
        // Different scheme is a different origin → denied.
        assert_eq!(
            validate_url("http://example.com/", &allow),
            Err(UrlGuardError::OriginNotAllowed(
                "http://example.com".to_string()
            ))
        );
    }

    #[test]
    fn default_ports_are_normalized_out_of_the_origin() {
        let allow = list(&["https://example.com", "http://example.com"]);
        // :443 on https and :80 on http are the defaults → origin omits them → match.
        assert_eq!(validate_url("https://example.com:443/", &allow), Ok(()));
        assert_eq!(validate_url("http://example.com:80/", &allow), Ok(()));
    }

    #[test]
    fn non_default_port_is_part_of_the_origin() {
        let allow = list(&["https://example.com:8443"]);
        assert_eq!(validate_url("https://example.com:8443/x", &allow), Ok(()));
        // Without the port it is a different origin → denied.
        assert_eq!(
            validate_url("https://example.com/x", &allow),
            Err(UrlGuardError::OriginNotAllowed(
                "https://example.com".to_string()
            ))
        );
    }

    #[test]
    fn host_is_lowercased() {
        let allow = list(&["https://example.com"]);
        assert_eq!(validate_url("https://EXAMPLE.com/", &allow), Ok(()));
    }

    #[test]
    fn single_label_wildcard_subdomain_matches_one_label_only() {
        let allow = list(&["https://*.example.com"]);
        // One label → match.
        assert!(matches_origin("https://api.example.com/", &allow));
        assert!(matches_origin("https://www.example.com/path", &allow));
        // Embedded dot in the wildcard region → NO match (subdomain-confusion guard).
        assert!(!matches_origin("https://evil.com.example.com/", &allow));
        // Different scheme → no match (origin includes scheme).
        assert!(!matches_origin("http://api.example.com/", &allow));
        // The bare apex (no label) → no match (label must be non-empty).
        assert!(!matches_origin("https://.example.com/", &allow));
    }

    #[test]
    fn userinfo_is_stripped_from_the_origin() {
        let allow = list(&["https://example.com"]);
        // "user:pass@host" — origin excludes userinfo, so this still matches the host.
        assert_eq!(
            validate_url("https://user:pass@example.com/", &allow),
            Ok(())
        );
        // And a spoof attempt like "https://example.com@evil.com" resolves to evil.com.
        assert_eq!(
            validate_url("https://example.com@evil.com/", &allow),
            Err(UrlGuardError::OriginNotAllowed(
                "https://evil.com".to_string()
            ))
        );
    }

    #[test]
    fn ipv6_literal_origin_is_handled() {
        let allow = list(&["http://[::1]:8080"]);
        assert!(matches_origin("http://[::1]:8080/json", &allow));
        // Default-port omission still applies for bracketed hosts.
        let allow_default = list(&["http://[::1]"]);
        assert!(matches_origin("http://[::1]:80/", &allow_default));
    }

    #[test]
    fn one_allowed_among_a_list() {
        let allow = list(&["https://a.test", "https://b.test", "https://*.c.test"]);
        assert!(matches_origin("https://b.test/x", &allow));
        assert!(matches_origin("https://sub.c.test/", &allow));
        assert!(!matches_origin("https://d.test/", &allow));
    }
}
