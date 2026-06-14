//! target_id — the `sessionId` / `sessionId:tabId` / profile target resolver, ported from
//! the TS `friday-browser-target-id`.
//!
//! A target id is `"sessionId"` or `"sessionId:tabId"`. Parsing splits on the FIRST colon
//! (so a session id may not itself contain a colon, matching `indexOf(":")`; everything
//! after the first colon is the tab id, which MAY contain colons). The resolution
//! priority (explicit sessionId/tabId > parsed targetId > profile lookup) is enforced at
//! the hub/handler layer where a live session table exists; this crate ships the pure
//! parse/format primitives + the parsed shape.

/// A target id parsed into its components. `tab_id` is `None` when only a session was
/// given (the active tab is then used by the resolver at dispatch time).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ParsedTargetId {
    /// The session id (the part before the first colon).
    pub session_id: String,
    /// The tab id (everything after the first colon), if present.
    pub tab_id: Option<String>,
}

/// Parse a `targetId` string into session + (optional) tab components, splitting on the
/// FIRST colon (the oracle's `indexOf(":")`).
#[must_use]
pub fn parse_browser_target_id(target_id: &str) -> ParsedTargetId {
    match target_id.find(':') {
        None => ParsedTargetId {
            session_id: target_id.to_string(),
            tab_id: None,
        },
        Some(colon) => ParsedTargetId {
            session_id: target_id[..colon].to_string(),
            tab_id: Some(target_id[colon + 1..].to_string()),
        },
    }
}

/// Format a session/tab pair into a `targetId` string (the inverse of
/// [`parse_browser_target_id`]). A `None`/empty tab id yields the bare session id.
#[must_use]
pub fn format_browser_target_id(session_id: &str, tab_id: Option<&str>) -> String {
    match tab_id {
        Some(t) if !t.is_empty() => format!("{session_id}:{t}"),
        _ => session_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_only_has_no_tab() {
        let p = parse_browser_target_id("s1");
        assert_eq!(p.session_id, "s1");
        assert_eq!(p.tab_id, None);
    }

    #[test]
    fn session_and_tab_split_on_first_colon() {
        let p = parse_browser_target_id("s1:tab-1");
        assert_eq!(p.session_id, "s1");
        assert_eq!(p.tab_id.as_deref(), Some("tab-1"));
    }

    #[test]
    fn only_the_first_colon_splits_the_rest_stays_in_tab() {
        // Everything after the first colon is the tab id (matches slice(colon+1)).
        let p = parse_browser_target_id("s1:tab:weird:id");
        assert_eq!(p.session_id, "s1");
        assert_eq!(p.tab_id.as_deref(), Some("tab:weird:id"));
    }

    #[test]
    fn empty_tab_after_trailing_colon() {
        let p = parse_browser_target_id("s1:");
        assert_eq!(p.session_id, "s1");
        assert_eq!(p.tab_id.as_deref(), Some(""));
    }

    #[test]
    fn format_roundtrips_parse() {
        assert_eq!(format_browser_target_id("s1", Some("tab-1")), "s1:tab-1");
        assert_eq!(format_browser_target_id("s1", None), "s1");
        // Empty tab id formats to the bare session id (not "s1:").
        assert_eq!(format_browser_target_id("s1", Some("")), "s1");

        let p = parse_browser_target_id("s1:tab-1");
        assert_eq!(
            format_browser_target_id(&p.session_id, p.tab_id.as_deref()),
            "s1:tab-1"
        );
    }
}
