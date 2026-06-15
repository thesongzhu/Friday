//! SSRF guard — blocks requests to private/internal/metadata network addresses.
//!
//! Ported from the TS oracle `src/agent/security/friday-agent-ssrf-guard.ts`. This is the
//! load-bearing egress safety check for the L2 `web_fetch` capability tool (and any future
//! external-content tool): an agent-supplied URL is EXTERNAL-content-inward — an unguarded
//! fetch is a Server-Side-Request-Forgery hole (the Hub would happily fetch
//! `http://169.254.169.254/...` cloud-metadata, `http://10.x` internal services, or
//! `http://localhost` admin endpoints on the agent's word). The guard refuses ALL of:
//!   - loopback / localhost (`127.0.0.0/8`, `::1`, `0.0.0.0/8`, `localhost`, `*.localhost`);
//!   - RFC-1918 private (`10/8`, `172.16/12`, `192.168/16`) and IPv6 ULA (`fc00::/7`);
//!   - link-local (`169.254/16` — the cloud-metadata range — and `fe80::/10`);
//!   - deprecated site-local (`fec0::/10`), CGNAT (`100.64/10`), benchmark (`198.18/15`),
//!     IETF protocol (`192.0.0/24`), current-network (`0/8`), and reserved class-E (`240/4`);
//!   - cloud-metadata hostnames (`metadata.google.internal`, `instance-data`);
//!   - internal-suffix hostnames (`.local`, `.internal`, `.localhost`).
//!
//! ## Two checks, BOTH fail-closed (mirrors the TS `validate` + `validateWithDns`)
//! 1. [`validate_url`] — pure, synchronous: parses the URL, enforces http/https-only, applies
//!    the optional [`SsrfPolicy`] hostname allowlist, and rejects a hostname that is itself a
//!    blocked name/suffix OR a literal private IP (v4 or v6, incl. IPv4-mapped IPv6 like
//!    `::ffff:127.0.0.1`). No I/O — unit-testable over every range.
//! 2. [`validate_resolved_addrs`] — the DNS-resolved check: given the IPs a host resolved to,
//!    reject if ANY is private (a hostname that resolves to `10.0.0.1` is blocked even though
//!    the NAME looked benign — closes the DNS-rebinding/indirection hole). The CALLER does the
//!    resolution (so the guard stays pure + testable with NO network in CI) and passes the
//!    addresses here; `web_fetch` resolves via `std::net` and PINS the validated addresses into
//!    the ureq connection so the request can only reach an IP this guard approved.
//!
//! ## Fail-closed posture
//! An unparseable URL, a non-http(s) protocol, an empty hostname, a hostname not in a
//! configured allowlist, OR an EMPTY resolved-address set (resolution failed / returned
//! nothing) all REJECT. A guard error is never a silent allow.
//!
//! ## Policy
//! [`SsrfPolicy::default`] is the production posture: `allow_private_network = false`, no
//! allowlist. `allow_private_network = true` exists ONLY for the in-process mock-HTTP-server
//! e2e tests (which must reach `127.0.0.1`); it is NEVER set on a production fetch. An
//! optional `hostname_allowlist` (supports `*.example.com` wildcards) lets a future RunPolicy
//! restrict fetches to named hosts (a TIGHTENING — when set, a host NOT matching is rejected
//! even if it is public).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// Why the SSRF guard refused a URL. Messages are terse + log-safe (host/kind only; never a
/// secret — a `web_fetch` URL carries no credential, but keep the discipline).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SsrfError {
    /// The URL did not parse, or was not absolute http/https.
    InvalidUrl(String),
    /// A non-http(s) scheme (file:, gopher:, ftp:, data:, ...).
    BlockedProtocol(String),
    /// The hostname is empty.
    EmptyHost,
    /// The hostname is a blocked name or internal suffix (localhost / *.internal / metadata).
    BlockedHostname(String),
    /// The hostname is (or DNS-resolved to) a private/internal/metadata IP.
    BlockedPrivateIp(String),
    /// A configured hostname allowlist did not match this host.
    NotInAllowlist(String),
    /// Resolution returned NO addresses (fail-closed: cannot prove the target is public).
    Unresolvable(String),
}

impl std::fmt::Display for SsrfError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SsrfError::InvalidUrl(u) => write!(f, "ssrf_invalid_url:{u}"),
            SsrfError::BlockedProtocol(p) => write!(f, "ssrf_blocked_protocol:{p}"),
            SsrfError::EmptyHost => write!(f, "ssrf_empty_host"),
            SsrfError::BlockedHostname(h) => write!(f, "ssrf_blocked_hostname:{h}"),
            SsrfError::BlockedPrivateIp(h) => write!(f, "ssrf_blocked_private_ip:{h}"),
            SsrfError::NotInAllowlist(h) => write!(f, "ssrf_not_in_allowlist:{h}"),
            SsrfError::Unresolvable(h) => write!(f, "ssrf_unresolvable:{h}"),
        }
    }
}

impl std::error::Error for SsrfError {}

/// SSRF policy. [`Default`] = the production posture (block all private; no allowlist).
#[derive(Clone, Debug, Default)]
pub struct SsrfPolicy {
    /// Allow requests to private/internal addresses. PRODUCTION: always `false`. `true` ONLY
    /// for the in-process mock-server e2e tests (which must reach loopback). NEVER set live.
    pub allow_private_network: bool,
    /// Restrict requests to ONLY these hostnames (supports `*.example.com`). Empty ⇒ no
    /// allowlist restriction (any public host allowed). A TIGHTENING when set.
    pub hostname_allowlist: Vec<String>,
}

// ─── Blocked hostnames + suffixes (parity with the TS oracle) ───

const BLOCKED_HOSTNAMES: &[&str] = &[
    "localhost",
    "0.0.0.0",
    "::1",
    "::0",
    "0000::1",
    // Cloud-metadata endpoints.
    "metadata.google.internal",
    "instance-data",
];

const BLOCKED_SUFFIXES: &[&str] = &[".local", ".internal", ".localhost"];

/// Normalize a hostname the way the TS oracle does: trim, lowercase, drop a single trailing
/// dot (FQDN root), and strip surrounding `[...]` IPv6 brackets.
fn normalize_hostname(hostname: &str) -> String {
    let mut h = hostname.trim().to_lowercase();
    if let Some(stripped) = h.strip_suffix('.') {
        h = stripped.to_string();
    }
    if h.starts_with('[') && h.ends_with(']') && h.len() >= 2 {
        h = h[1..h.len() - 1].to_string();
    }
    h
}

fn is_blocked_hostname(hostname: &str) -> bool {
    if BLOCKED_HOSTNAMES.contains(&hostname) {
        return true;
    }
    BLOCKED_SUFFIXES.iter().any(|s| hostname.ends_with(s))
}

// ─── Allowlist (supports `*.example.com` wildcards) ───

fn normalize_allowlist(values: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for v in values {
        let n = normalize_hostname(v);
        if n.is_empty() || n == "*" || n == "*." {
            continue;
        }
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

fn host_matches_pattern(hostname: &str, pattern: &str) -> bool {
    if let Some(suffix) = pattern.strip_prefix("*.") {
        if suffix.is_empty() || hostname == suffix {
            return false;
        }
        return hostname.ends_with(&format!(".{suffix}"));
    }
    hostname == pattern
}

fn matches_allowlist(hostname: &str, allowlist: &[String]) -> bool {
    if allowlist.is_empty() {
        return true;
    }
    allowlist.iter().any(|p| host_matches_pattern(hostname, p))
}

// ─── IPv4 / IPv6 private-range classification (parity with the TS oracle) ───

/// True if an IPv4 address is in a private / reserved / metadata range.
/// Covers RFC-1918, loopback, link-local (incl. `169.254` cloud-metadata), current-network,
/// CGNAT shared space, IETF/benchmark assignments, and reserved class-E.
pub fn is_private_ipv4(ip: &Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();
    // 127.0.0.0/8 — loopback.
    if a == 127 {
        return true;
    }
    // 10.0.0.0/8 — private.
    if a == 10 {
        return true;
    }
    // 172.16.0.0/12 — private.
    if a == 172 && (16..=31).contains(&b) {
        return true;
    }
    // 192.168.0.0/16 — private.
    if a == 192 && b == 168 {
        return true;
    }
    // 169.254.0.0/16 — link-local (THE cloud-metadata range, e.g. 169.254.169.254).
    if a == 169 && b == 254 {
        return true;
    }
    // 0.0.0.0/8 — current network ("this host").
    if a == 0 {
        return true;
    }
    // 100.64.0.0/10 — CGNAT shared address space (RFC 6598).
    if a == 100 && (64..=127).contains(&b) {
        return true;
    }
    // 192.0.0.0/24 — IETF protocol assignments.
    if a == 192 && b == 0 && c == 0 {
        return true;
    }
    // 198.18.0.0/15 — benchmark testing.
    if a == 198 && (b == 18 || b == 19) {
        return true;
    }
    // 240.0.0.0/4 — reserved (class E), incl. 255.255.255.255 broadcast.
    if a >= 240 {
        return true;
    }
    false
}

/// Extract the IPv4 address that an IPv6 *transition-mechanism* prefix embeds/encodes, if `ip`
/// belongs to one of the well-known transition prefixes whose tail (or encoding) carries a v4
/// address that Rust's [`Ipv6Addr::to_ipv4`] does NOT recognize:
///   - **NAT64** (`64:ff9b::/96`, RFC 6052 well-known prefix): the embedded v4 is the LAST 32 bits.
///     (Network-specific NAT64 prefixes are operator-chosen and not detectable from the address
///     alone, so only the well-known prefix is covered — an honest, documented gap.)
///   - **6to4** (`2002::/16`, RFC 3056): the embedded v4 is segments `[1]` (high 16 bits) and
///     `[2]` (low 16 bits), i.e. `2002:AABB:CCDD::` ⇒ `AA.BB.CC.DD`.
///   - **Teredo** (`2001:0000::/32`, RFC 4380): the embedded (client) v4 is the LAST 32 bits XORed
///     with `0xffff_ffff` (obfuscated). Teredo is `2001:0000::/32` — segment `[0]==0x2001` AND
///     `[1]==0x0000`; gating on `[0]` alone would wrongly catch global `2001:db8::`/`2001:4860::`
///     production IPv6.
///
/// Returns `None` when `ip` is not in any of these prefixes (the caller then falls through to the
/// scope-bit checks). This MIRRORS the existing `to_ipv4()` reclassification — it only ADDS
/// detection of v4 embedded in prefixes `to_ipv4()` returns `None` for; it never unblocks anything.
fn embedded_transition_ipv4(ip: &Ipv6Addr) -> Option<Ipv4Addr> {
    let s = ip.segments();
    // NAT64 well-known prefix 64:ff9b::/96 ⇒ embedded v4 = last 32 bits (segments [6],[7]).
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2] == 0 && s[3] == 0 && s[4] == 0 && s[5] == 0 {
        return Some(Ipv4Addr::new(
            (s[6] >> 8) as u8,
            (s[6] & 0xff) as u8,
            (s[7] >> 8) as u8,
            (s[7] & 0xff) as u8,
        ));
    }
    // 6to4 2002::/16 ⇒ embedded v4 = segments [1] (AA.BB) + [2] (CC.DD).
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(
            (s[1] >> 8) as u8,
            (s[1] & 0xff) as u8,
            (s[2] >> 8) as u8,
            (s[2] & 0xff) as u8,
        ));
    }
    // Teredo 2001:0000::/32 ⇒ embedded (client) v4 = last 32 bits XOR 0xffff_ffff.
    if s[0] == 0x2001 && s[1] == 0x0000 {
        let obfuscated = ((s[6] as u32) << 16) | (s[7] as u32);
        return Some(Ipv4Addr::from(obfuscated ^ 0xffff_ffff));
    }
    None
}

/// True if an IPv6 address is private / reserved / internal.
/// Covers `::` (unspecified), `::1` (loopback), IPv4-mapped/embedded (`::ffff:a.b.c.d`,
/// reclassified through the v4 table), the transition-mechanism embedded-v4 prefixes (NAT64
/// `64:ff9b::/96`, 6to4 `2002::/16`, Teredo `2001:0000::/32` — see [`embedded_transition_ipv4`]),
/// `fe80::/10` (link-local), `fec0::/10` (deprecated site-local), and `fc00::/7` (unique-local).
pub fn is_private_ipv6(ip: &Ipv6Addr) -> bool {
    // Unspecified (all zeros).
    if ip.is_unspecified() {
        return true;
    }
    // Loopback (::1).
    if ip.is_loopback() {
        return true;
    }
    // IPv4-mapped / IPv4-compatible: reclassify the embedded v4 (catches ::ffff:127.0.0.1,
    // ::ffff:10.0.0.1, ::169.254.169.254, ...). `to_ipv4()` returns the embedded v4 for both
    // ::a.b.c.d (compat) and ::ffff:a.b.c.d (mapped).
    if let Some(v4) = ip.to_ipv4() {
        // Exclude the genuinely-global tiny tail (only ::/96 and ::ffff:/96 embed v4; any
        // other prefix is NOT an embedded-v4 address). `to_ipv4()` already restricts to those.
        return is_private_ipv4(&v4);
    }
    // IPv6 transition mechanisms (NAT64 / 6to4 / Teredo) ENCODE an IPv4 address that `to_ipv4()`
    // does NOT recognize. On an IPv6-only / NAT64-DNS64 egress (carrier-grade / IPv6 VPC) a host
    // like `http://[64:ff9b::a00:1]/` (embeds 10.0.0.1) would otherwise classify PUBLIC and get
    // pinned — an SSRF bypass. Extract the embedded v4 and run it through the v4 private table.
    // This runs AFTER `to_ipv4()` (those prefixes return `None` from it, so there is no overlap)
    // and only ADDS blocks: a transition prefix wrapping a PUBLIC v4 still classifies public.
    if let Some(v4) = embedded_transition_ipv4(ip) {
        return is_private_ipv4(&v4);
    }
    let first = ip.segments()[0];
    // fe80::/10 — link-local.
    if (first & 0xffc0) == 0xfe80 {
        return true;
    }
    // fec0::/10 — deprecated site-local.
    if (first & 0xffc0) == 0xfec0 {
        return true;
    }
    // fc00::/7 — unique local.
    if (first & 0xfe00) == 0xfc00 {
        return true;
    }
    false
}

/// True if the IP (v4 or v6) is private/internal/metadata.
pub fn is_private_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_ipv4(v4),
        IpAddr::V6(v6) => is_private_ipv6(v6),
    }
}

/// Parse a hostname string that MAY be a literal IP (v4 or v6, with or without `[...]`).
/// Returns `Some(IpAddr)` when it is a literal IP, `None` when it is a DNS name.
fn parse_literal_ip(hostname: &str) -> Option<IpAddr> {
    // Already bracket-stripped + lowercased by normalize_hostname before we get here, but be
    // defensive: handle a stray `[...]` too.
    let h = hostname
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(hostname);
    h.parse::<IpAddr>().ok()
}

/// Validate a URL synchronously (protocol + literal-IP + hostname checks). Fail-closed: an
/// unparseable URL, a non-http(s) scheme, an empty host, a blocked name/suffix, a literal
/// private IP, or a host outside a configured allowlist all reject. Returns the normalized
/// hostname on success (the caller resolves it for the DNS-resolved check).
///
/// This is the PURE check `web_fetch` runs BEFORE every fetch (and re-runs on every redirect
/// hop). It does NO DNS — the DNS-resolved check is [`validate_resolved_addrs`].
pub fn validate_url(url: &str, policy: &SsrfPolicy) -> Result<String, SsrfError> {
    let parsed = url::Url::parse(url).map_err(|_| SsrfError::InvalidUrl(url.to_string()))?;

    // http/https only — block file:/ftp:/gopher:/data:/etc.
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(SsrfError::BlockedProtocol(scheme.to_string()));
    }

    let raw_host = parsed.host_str().unwrap_or("");
    let hostname = normalize_hostname(raw_host);
    if hostname.is_empty() {
        return Err(SsrfError::EmptyHost);
    }

    // Allowlist (when configured) is checked BEFORE the allow-private short-circuit so a
    // configured allowlist always tightens.
    let allowlist = normalize_allowlist(&policy.hostname_allowlist);
    if !matches_allowlist(&hostname, &allowlist) {
        return Err(SsrfError::NotInAllowlist(hostname));
    }

    if policy.allow_private_network {
        return Ok(hostname);
    }

    // Blocked names / internal suffixes.
    if is_blocked_hostname(&hostname) {
        return Err(SsrfError::BlockedHostname(hostname));
    }

    // Literal IP in the host position ⇒ classify directly (no DNS needed).
    if let Some(ip) = parse_literal_ip(&hostname) {
        if is_private_ip(&ip) {
            return Err(SsrfError::BlockedPrivateIp(hostname));
        }
    }

    Ok(hostname)
}

/// The DNS-resolved check: given the addresses `hostname` resolved to, reject if ANY is
/// private/internal/metadata. Fail-closed on an EMPTY set (resolution failed / returned
/// nothing — we cannot prove the target is public). When `allow_private_network` is set
/// (tests only) this is a no-op success. A literal-IP host (already classified by
/// [`validate_url`]) still passes its single address through here harmlessly.
///
/// The caller (`web_fetch`) resolves the host with `std::net` and passes EVERY resolved
/// address here, then PINS exactly these (already-validated) addresses into the connection —
/// so the actual request can only reach an IP this function approved (no rebinding window).
pub fn validate_resolved_addrs(
    hostname: &str,
    addrs: &[IpAddr],
    policy: &SsrfPolicy,
) -> Result<(), SsrfError> {
    if policy.allow_private_network {
        return Ok(());
    }
    if addrs.is_empty() {
        return Err(SsrfError::Unresolvable(hostname.to_string()));
    }
    for ip in addrs {
        if is_private_ip(ip) {
            return Err(SsrfError::BlockedPrivateIp(format!("{hostname} -> {ip}")));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deny() -> SsrfPolicy {
        SsrfPolicy::default()
    }

    // ── IPv4 range table — every blocked range + a public sanity row ──
    #[test]
    fn ipv4_private_range_table() {
        let blocked = [
            "127.0.0.1",       // loopback
            "127.255.255.254", // loopback edge
            "10.0.0.1",        // RFC1918 /8
            "10.255.255.255",
            "172.16.0.1", // RFC1918 /12 low edge
            "172.31.255.255",
            "172.20.10.5",
            "192.168.0.1", // RFC1918 /16
            "192.168.255.255",
            "169.254.0.1",     // link-local
            "169.254.169.254", // AWS/GCP/Azure metadata IP
            "0.0.0.0",         // current network
            "0.1.2.3",         //
            "100.64.0.1",      // CGNAT
            "100.127.255.255", // CGNAT edge
            "192.0.0.1",       // IETF protocol
            "198.18.0.1",      // benchmark
            "198.19.255.255",  //
            "240.0.0.1",       // class E
            "255.255.255.255", // broadcast (class E)
        ];
        for ip in blocked {
            let v4: Ipv4Addr = ip.parse().unwrap();
            assert!(is_private_ipv4(&v4), "{ip} must be classified private");
        }
        // Boundary-NOT-blocked: 172.15 and 172.32 are public (outside the /12).
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1",
            "172.32.0.1",
            "100.63.255.255",
            "100.128.0.0",
            "198.20.0.1",
            "239.0.0.1",
        ] {
            let v4: Ipv4Addr = ip.parse().unwrap();
            assert!(!is_private_ipv4(&v4), "{ip} must be classified public");
        }
    }

    // ── IPv6 range table ──
    #[test]
    fn ipv6_private_range_table() {
        let blocked = [
            "::1",                    // loopback
            "::",                     // unspecified
            "fc00::1",                // ULA fc00::/7
            "fd00::1",                // ULA fd
            "fdff:ffff::1",           //
            "fe80::1",                // link-local
            "febf:ffff::1",           // link-local edge
            "fec0::1",                // deprecated site-local
            "::ffff:127.0.0.1",       // IPv4-mapped loopback
            "::ffff:10.0.0.1",        // IPv4-mapped RFC1918
            "::ffff:169.254.169.254", // IPv4-mapped metadata
            // ── IPv6 transition mechanisms embedding/encoding a PRIVATE v4 (the BUG-5 fix) ──
            "64:ff9b::a00:1",           // NAT64 well-known prefix ⇒ 10.0.0.1
            "64:ff9b::a9fe:a9fe",       // NAT64 ⇒ 169.254.169.254 (metadata)
            "2002:0a00:0001::",         // 6to4 ⇒ 10.0.0.1
            "2002:a9fe:a9fe::",         // 6to4 ⇒ 169.254.169.254 (metadata)
            "2001:0:0:0:0:0:f5ff:fffe", // Teredo (2001:0000::/32) ⇒ last32 XOR ffffffff = 10.0.0.1
        ];
        for ip in blocked {
            let v6: Ipv6Addr = ip.parse().unwrap();
            assert!(is_private_ipv6(&v6), "{ip} must be classified private");
        }
        // Public IPv6 (e.g. a Google DNS) is NOT blocked. CRITICAL regression guard for Teredo:
        // 2001:4860:4860::8888 has segment[0]==0x2001 but segment[1]!=0x0000, so it is NOT Teredo
        // and must stay PUBLIC — gating Teredo on segment[0] alone would wrongly block it.
        for ip in [
            "2001:4860:4860::8888", // Google public DNS (2001:: but NOT Teredo)
            "2606:4700:4700::1111", // Cloudflare public DNS
            "2002:5db8:d822::",     // 6to4 wrapping a PUBLIC v4 (93.184.216.34) ⇒ still public
        ] {
            let v6: Ipv6Addr = ip.parse().unwrap();
            assert!(!is_private_ipv6(&v6), "{ip} must be classified public");
        }
        // IPv4-mapped PUBLIC is not blocked.
        let mapped_public: Ipv6Addr = "::ffff:8.8.8.8".parse().unwrap();
        assert!(!is_private_ipv6(&mapped_public));
    }

    // ── validate_url: the full SSRF block table (literal forms) ──
    #[test]
    fn validate_url_blocks_every_private_form() {
        let cases = [
            "http://127.0.0.1/",
            "http://127.0.0.1:8080/admin",
            "https://localhost/",
            "http://localhost:3000/",
            "http://10.0.0.5/",
            "http://10.255.255.255/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://169.254.0.1/",
            "http://169.254.169.254/latest/meta-data/", // AWS metadata
            "http://[::1]/",
            "http://[::]/",
            "http://[fc00::1]/",
            "http://[fd12:3456::1]/",
            "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/", // IPv4-mapped loopback
            "http://0.0.0.0/",
            "http://metadata.google.internal/", // GCP metadata host
            "http://instance-data/",
            "http://foo.local/",
            "http://service.internal/",
            "http://app.localhost/",
            "http://100.64.1.1/", // CGNAT
            // ── BUG-5: IPv6 transition mechanisms encoding a PRIVATE v4, reachable on an
            //    IPv6-only / NAT64-DNS64 egress. Each embeds 10.0.0.1 or the metadata IP. ──
            "http://[64:ff9b::a00:1]/",     // NAT64 well-known ⇒ 10.0.0.1
            "http://[64:ff9b::a9fe:a9fe]/", // NAT64 ⇒ 169.254.169.254 metadata
            "http://[2002:0a00:0001::]/",   // 6to4 ⇒ 10.0.0.1
            "http://[2001:0:0:0:0:0:f5ff:fffe]/", // Teredo ⇒ 10.0.0.1
        ];
        for u in cases {
            let err = validate_url(u, &deny()).unwrap_err();
            assert!(
                matches!(
                    err,
                    SsrfError::BlockedHostname(_) | SsrfError::BlockedPrivateIp(_)
                ),
                "{u} must be SSRF-blocked, got {err:?}"
            );
        }
    }

    // ── BUG-5 regression: octal/hex/decimal IPv4 literals. The task asks to assert these are
    //    "handled today" — i.e. the `url` crate's host parser normalizes the encoded form to a
    //    canonical IPv4 (e.g. `2130706433` ⇒ 127.0.0.1, `0x7f000001` ⇒ 127.0.0.1) so our literal-IP
    //    classifier still blocks them. This pins that behavior so a future `url` upgrade that
    //    stopped normalizing (re-opening the bypass) goes RED. We assert the OBSERVED contract:
    //    forms the parser canonicalizes to a private IP are BlockedPrivateIp; forms it rejects
    //    outright are an error (also fail-closed) — either way NEVER an Ok(public).
    #[test]
    fn validate_url_blocks_encoded_ipv4_literals_or_fails_closed() {
        for u in [
            "http://2130706433/",   // decimal 127.0.0.1
            "http://0x7f000001/",   // hex 0x7f000001 = 127.0.0.1
            "http://0x7f.0.0.1/",   // dotted-hex 127.0.0.1
            "http://017700000001/", // octal 127.0.0.1
            "http://0xa000001/",    // hex 10.0.0.1
        ] {
            // Must NOT be an Ok(public) — either blocked as a private IP, or rejected as
            // unparseable/blocked. Fail-closed in every branch.
            match validate_url(u, &deny()) {
                Ok(host) => panic!("{u} normalized to a passable host {host:?} — SSRF bypass!"),
                Err(SsrfError::BlockedPrivateIp(_))
                | Err(SsrfError::BlockedHostname(_))
                | Err(SsrfError::InvalidUrl(_))
                | Err(SsrfError::EmptyHost) => {} // all fail-closed
                Err(other) => panic!("{u} unexpected error {other:?}"),
            }
        }
    }

    #[test]
    fn validate_url_blocks_non_http_protocols() {
        for u in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "gopher://example.com/",
            "data:text/plain,hi",
        ] {
            let err = validate_url(u, &deny()).unwrap_err();
            assert!(
                matches!(
                    err,
                    SsrfError::BlockedProtocol(_) | SsrfError::InvalidUrl(_)
                ),
                "{u} must be protocol-blocked, got {err:?}"
            );
        }
    }

    #[test]
    fn validate_url_rejects_unparseable() {
        for u in ["not a url", "://missing-scheme", "http://"] {
            assert!(validate_url(u, &deny()).is_err(), "{u} must fail closed");
        }
    }

    #[test]
    fn validate_url_allows_public_hosts() {
        for u in [
            "https://example.com/",
            "http://93.184.216.34/",
            "https://api.github.com/repos",
        ] {
            assert!(validate_url(u, &deny()).is_ok(), "{u} must be allowed");
        }
    }

    #[test]
    fn allow_private_network_permits_loopback_for_tests_only() {
        let allow = SsrfPolicy {
            allow_private_network: true,
            ..Default::default()
        };
        assert!(validate_url("http://127.0.0.1:8080/", &allow).is_ok());
        // Even under allow_private_network, a non-http protocol is still blocked.
        assert!(validate_url("file:///etc/passwd", &allow).is_err());
    }

    #[test]
    fn hostname_allowlist_tightens() {
        let policy = SsrfPolicy {
            allow_private_network: false,
            hostname_allowlist: vec!["example.com".to_string(), "*.trusted.org".to_string()],
        };
        assert!(validate_url("https://example.com/", &policy).is_ok());
        assert!(validate_url("https://api.trusted.org/", &policy).is_ok());
        // A public host NOT in the allowlist is rejected.
        let err = validate_url("https://evil.com/", &policy).unwrap_err();
        assert!(matches!(err, SsrfError::NotInAllowlist(_)), "got {err:?}");
        // The bare apex does NOT match a `*.` wildcard.
        let err2 = validate_url("https://trusted.org/", &policy).unwrap_err();
        assert!(matches!(err2, SsrfError::NotInAllowlist(_)), "got {err2:?}");
    }

    // ── validate_resolved_addrs: the DNS-resolved (rebinding) check ──
    #[test]
    fn dns_resolved_private_ip_is_blocked() {
        // A benign-looking name that resolves to a private IP is blocked at the resolved step.
        let addrs = vec!["10.0.0.7".parse::<IpAddr>().unwrap()];
        let err = validate_resolved_addrs("rebind.example.com", &addrs, &deny()).unwrap_err();
        assert!(matches!(err, SsrfError::BlockedPrivateIp(_)), "got {err:?}");

        // Mixed: ANY private address in the set blocks the whole resolution.
        let mixed = vec![
            "93.184.216.34".parse::<IpAddr>().unwrap(),
            "169.254.169.254".parse::<IpAddr>().unwrap(),
        ];
        assert!(validate_resolved_addrs("mixed.example.com", &mixed, &deny()).is_err());
    }

    #[test]
    fn dns_resolved_all_public_passes() {
        let addrs = vec![
            "93.184.216.34".parse::<IpAddr>().unwrap(),
            "2606:4700:4700::1111".parse::<IpAddr>().unwrap(),
        ];
        assert!(validate_resolved_addrs("example.com", &addrs, &deny()).is_ok());
    }

    #[test]
    fn dns_resolved_empty_set_fails_closed() {
        let err = validate_resolved_addrs("nxdomain.example", &[], &deny()).unwrap_err();
        assert!(matches!(err, SsrfError::Unresolvable(_)), "got {err:?}");
    }

    #[test]
    fn dns_resolved_allow_private_is_noop() {
        let allow = SsrfPolicy {
            allow_private_network: true,
            ..Default::default()
        };
        // Even an empty set and a private IP pass when private is allowed (tests only).
        assert!(validate_resolved_addrs("x", &[], &allow).is_ok());
        let addrs = vec!["127.0.0.1".parse::<IpAddr>().unwrap()];
        assert!(validate_resolved_addrs("x", &addrs, &allow).is_ok());
    }
}
