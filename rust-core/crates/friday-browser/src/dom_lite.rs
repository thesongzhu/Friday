//! dom-lite — the lightweight, serializable page/AX/console types the [`BrowserBackend`]
//! trait returns and the handlers consume.
//!
//! These mirror the TS browser-manager's snapshot/console/page shapes at a "lite" level:
//! enough structure for the agent to reason about a page (accessibility tree nodes,
//! console log lines, page metadata, tab listing) without the full live `Page` object.
//! Pure data — no I/O, no network.
//!
//! [`BrowserBackend`]: crate::backend::BrowserBackend

use serde::{Deserialize, Serialize};

/// How a session is presented to the user — headless (no window) vs a visible host
/// Chrome desktop window. Mirrors the TS presentation-mode metadata (the manager
/// relaunches a headless session when a visible desktop session is requested).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PresentationMode {
    /// No visible window (the default automation mode).
    #[default]
    Headless,
    /// A visible host-Chrome desktop window.
    HostChromeVisible,
}

/// Page metadata (the "lite" view of a live page): the current URL + title.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageInfo {
    /// The page's current URL (post-redirect, as the engine reports it).
    pub url: String,
    /// The page title (`document.title` equivalent), if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// A tab within a session.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TabInfo {
    /// The tab id (the second component of a `sessionId:tabId` target id).
    pub tab_id: String,
    /// The tab's current page.
    pub page: PageInfo,
    /// Whether this is the session's active tab.
    pub active: bool,
}

/// A node in the dom-lite accessibility tree (the snapshot result). One node per
/// addressable element; `element_id` is the stable handle the [`ElementCache`] keys on so
/// a later `act` can target an element discovered by a prior `snapshot`.
///
/// [`ElementCache`]: crate::element_cache::ElementCache
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomNode {
    /// The stable element id assigned by the snapshot (cached for later `act` targeting).
    pub element_id: String,
    /// The accessibility role (e.g. `"button"`, `"link"`, `"textbox"`).
    pub role: String,
    /// The accessible name / label, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A CSS selector that addresses this node, if the engine can supply one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
}

/// The result of a `snapshot`: the AX-tree nodes (each with a freshly-assigned element id)
/// plus the page they were captured from.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SnapshotResult {
    /// The page the snapshot was taken from.
    pub page: PageInfo,
    /// The accessibility-tree nodes, each carrying a stable `element_id`.
    pub nodes: Vec<DomNode>,
}

/// A console message log level.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsoleLevel {
    #[default]
    Log,
    Info,
    Warn,
    Error,
    Debug,
}

/// A single console log line read from the page.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConsoleEntry {
    /// The message level.
    pub level: ConsoleLevel,
    /// The message text.
    pub text: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_mode_defaults_headless() {
        assert_eq!(PresentationMode::default(), PresentationMode::Headless);
    }

    #[test]
    fn console_level_defaults_log() {
        assert_eq!(ConsoleLevel::default(), ConsoleLevel::Log);
    }

    #[test]
    fn snapshot_roundtrips_through_serde_json() {
        let snap = SnapshotResult {
            page: PageInfo {
                url: "https://example.com/".to_string(),
                title: Some("Example".to_string()),
            },
            nodes: vec![DomNode {
                element_id: "el-1".to_string(),
                role: "button".to_string(),
                name: Some("Submit".to_string()),
                selector: Some("#submit".to_string()),
            }],
        };
        let json = serde_json::to_string(&snap).expect("serialize");
        let back: SnapshotResult = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(snap, back);
    }

    #[test]
    fn optional_fields_are_omitted_when_none() {
        let page = PageInfo {
            url: "https://example.com/".to_string(),
            title: None,
        };
        let json = serde_json::to_string(&page).expect("serialize");
        assert!(
            !json.contains("title"),
            "None title must be skipped: {json}"
        );
    }
}
