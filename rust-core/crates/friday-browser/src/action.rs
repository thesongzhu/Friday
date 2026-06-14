//! The `browser` tool action/param schema — a faithful, strongly-typed port of the TS
//! `friday-agent-browser-tool` parameter schema.
//!
//! The TS tool takes a single flat `params` object with an `action` discriminator (one of
//! 16 actions) plus action-specific fields. This module parses that flat
//! `serde_json::Value` into a [`BrowserAction`] enum so every handler (B2a-d) matches on a
//! validated, typed value instead of re-reading raw params. The set of actions, `act`
//! sub-kinds, `tabsAction` sub-kinds, and `screenshotMode` values are kept byte-identical
//! to the oracle's `enum` lists.
//!
//! Pure parsing/validation only — no I/O, no backend call.

use serde_json::Value;
use thiserror::Error;

/// Parse/validation failures for a `browser` tool param object. Coarse + payload-free
/// (mirrors the provider-crate error discipline): a message names the offending field,
/// never echoes a secret-bearing value.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BrowserActionError {
    /// The required `action` field is missing or not a string.
    #[error("browser: required string param `action` is missing")]
    MissingAction,
    /// `action` was a string but not one of the 16 valid actions.
    #[error("browser: invalid action `{0}`")]
    InvalidAction(String),
    /// `act` was a string but not one of the valid act sub-kinds.
    #[error("browser: invalid act sub-action `{0}`")]
    InvalidAct(String),
    /// The `act` action requires an `act` sub-kind, which was missing.
    #[error("browser: action `act` requires an `act` sub-action")]
    MissingAct,
    /// `tabsAction` was a string but not one of the valid tabs sub-kinds.
    #[error("browser: invalid tabsAction `{0}`")]
    InvalidTabsAction(String),
    /// `screenshotMode` was a string but not `path` | `base64`.
    #[error("browser: invalid screenshotMode `{0}`")]
    InvalidScreenshotMode(String),
    /// A field was present but had the wrong JSON type.
    #[error("browser: param `{field}` has the wrong type (expected {expected})")]
    WrongType {
        /// The offending field name.
        field: &'static str,
        /// The expected JSON type.
        expected: &'static str,
    },
    /// An action requires a field that was absent.
    #[error("browser: action `{action}` requires param `{field}`")]
    MissingField {
        /// The action that needs the field.
        action: &'static str,
        /// The missing field name.
        field: &'static str,
    },
}

/// Screenshot output mode (oracle `screenshotMode` enum: `["path", "base64"]`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ScreenshotMode {
    /// Write the PNG to a workspace artifact path and return the path (the default).
    #[default]
    Path,
    /// Return the PNG inline as base64.
    Base64,
}

impl ScreenshotMode {
    fn parse(s: &str) -> Result<Self, BrowserActionError> {
        match s {
            "path" => Ok(ScreenshotMode::Path),
            "base64" => Ok(ScreenshotMode::Base64),
            other => Err(BrowserActionError::InvalidScreenshotMode(other.to_string())),
        }
    }
}

/// The `tabs` sub-action (oracle `tabsAction` enum: `["list", "new", "switch", "close"]`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TabsAction {
    List,
    New,
    Switch,
    Close,
}

impl TabsAction {
    fn parse(s: &str) -> Result<Self, BrowserActionError> {
        match s {
            "list" => Ok(TabsAction::List),
            "new" => Ok(TabsAction::New),
            "switch" => Ok(TabsAction::Switch),
            "close" => Ok(TabsAction::Close),
            other => Err(BrowserActionError::InvalidTabsAction(other.to_string())),
        }
    }
}

/// The `act` sub-kind (oracle `act` enum). Each carries the action-specific fields the
/// oracle reads for that sub-kind. These are the MUTATING, external-effecting sub-actions
/// — REGISTER's coarse `mutating=true/High` default gates the whole `browser` tool so
/// none of these can fail-open.
#[derive(Clone, Debug, PartialEq)]
pub enum ActKind {
    /// Click an element (by `elementId` from a snapshot or by `selector`).
    Click,
    /// Type text into the focused/targeted element (`text`).
    Type { text: String },
    /// Press a key (`key`, e.g. `"Enter"`, `"Tab"`).
    Press { key: String },
    /// Hover over an element.
    Hover,
    /// Drag from the targeted element to `endSelector` (drop target).
    Drag { end_selector: Option<String> },
    /// Select option values in a `<select>` (`values`).
    Select { values: Vec<String> },
    /// Fill an input with `text` (clears then types).
    Fill { text: String },
    /// Resize the viewport to `width` x `height`.
    Resize {
        width: Option<f64>,
        height: Option<f64>,
    },
    /// Wait `time_ms` milliseconds.
    Wait { time_ms: Option<f64> },
    /// Evaluate JS (`text` is the script). Carries the oracle's 10s evaluate timeout.
    Evaluate { script: String },
    /// Close the targeted element/tab context.
    Close,
}

/// The oracle's `act:evaluate` carries a fixed 10-second timeout.
pub const ACT_EVALUATE_TIMEOUT_MS: u64 = 10_000;

impl ActKind {
    fn parse(sub: &str, p: &Params<'_>) -> Result<Self, BrowserActionError> {
        match sub {
            "click" => Ok(ActKind::Click),
            "type" => Ok(ActKind::Type {
                text: p.require_str("act:type", "text")?.to_string(),
            }),
            "press" => Ok(ActKind::Press {
                key: p.require_str("act:press", "key")?.to_string(),
            }),
            "hover" => Ok(ActKind::Hover),
            "drag" => Ok(ActKind::Drag {
                end_selector: p.opt_str("endSelector")?.map(str::to_string),
            }),
            "select" => Ok(ActKind::Select {
                values: p.opt_str_array("values")?,
            }),
            "fill" => Ok(ActKind::Fill {
                text: p.require_str("act:fill", "text")?.to_string(),
            }),
            "resize" => Ok(ActKind::Resize {
                width: p.opt_f64("width")?,
                height: p.opt_f64("height")?,
            }),
            "wait" => Ok(ActKind::Wait {
                time_ms: p.opt_f64("timeMs")?,
            }),
            // `text` holds the JS for evaluate (oracle: "or JS for act:evaluate").
            "evaluate" => Ok(ActKind::Evaluate {
                script: p.require_str("act:evaluate", "text")?.to_string(),
            }),
            "close" => Ok(ActKind::Close),
            other => Err(BrowserActionError::InvalidAct(other.to_string())),
        }
    }
}

/// Common target-addressing fields shared by most actions (the oracle threads these
/// through every action that touches a page).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TargetRef {
    /// Explicit session id.
    pub session_id: Option<String>,
    /// `"sessionId"` or `"sessionId:tabId"` target id.
    pub target_id: Option<String>,
    /// Explicit tab id.
    pub tab_id: Option<String>,
    /// Profile name (for profile-based session disambiguation).
    pub profile: Option<String>,
    /// CSS selector (act target).
    pub selector: Option<String>,
    /// Cached element id from a prior snapshot (act target).
    pub element_id: Option<String>,
}

/// A fully parsed, validated `browser` tool invocation. The 16 oracle actions, typed.
#[derive(Clone, Debug, PartialEq)]
pub enum BrowserAction {
    /// Open a (new) session, optionally navigating to `url`, with an optional `profile`.
    Open {
        target: TargetRef,
        url: Option<String>,
    },
    /// Navigate the targeted tab to `url`.
    Navigate {
        target: TargetRef,
        url: Option<String>,
    },
    /// Screenshot the targeted page (`mode` = path|base64, `full_page`).
    Screenshot {
        target: TargetRef,
        mode: ScreenshotMode,
        full_page: bool,
    },
    /// AX-tree snapshot of the targeted page (populates the element-id cache).
    Snapshot { target: TargetRef },
    /// An interaction sub-action against the targeted element.
    Act { target: TargetRef, kind: ActKind },
    /// Tab operations on a session.
    Tabs {
        target: TargetRef,
        sub: TabsAction,
        tab_id: Option<String>,
        url: Option<String>,
    },
    /// Close a session (or the targeted tab context).
    Close { target: TargetRef },
    /// Read engine/session status (no mutation).
    Status { profile: Option<String> },
    /// Start the engine / open a session (oracle: `start` is an alias for `open`).
    Start {
        target: TargetRef,
        url: Option<String>,
    },
    /// Stop the engine / close sessions (optionally by `profile`).
    Stop { profile: Option<String> },
    /// List active profiles (read).
    Profiles,
    /// Focus the targeted tab and bring it to front.
    Focus { target: TargetRef },
    /// Read console output, or evaluate `text` as an expression when provided.
    Console {
        target: TargetRef,
        text: Option<String>,
    },
    /// Render the targeted page to a PDF artifact.
    Pdf { target: TargetRef },
    /// Set files on the targeted file input (`file_paths`).
    Upload {
        target: TargetRef,
        file_paths: Vec<String>,
    },
    /// Respond to a JS dialog (`accept` + optional `prompt_text`).
    Dialog {
        target: TargetRef,
        accept: bool,
        prompt_text: Option<String>,
    },
}

/// All 16 valid `action` strings, in the oracle's declared order. Public so the hub /
/// REGISTER reconciliation can cross-check the surface without re-deriving it.
pub const VALID_ACTIONS: [&str; 16] = [
    "open",
    "navigate",
    "screenshot",
    "snapshot",
    "act",
    "tabs",
    "close",
    "status",
    "start",
    "stop",
    "profiles",
    "focus",
    "console",
    "pdf",
    "upload",
    "dialog",
];

/// A thin typed reader over the flat oracle param object.
struct Params<'a> {
    obj: &'a serde_json::Map<String, Value>,
}

impl<'a> Params<'a> {
    fn opt_str(&self, field: &'static str) -> Result<Option<&'a str>, BrowserActionError> {
        match self.obj.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.as_str())),
            Some(_) => Err(BrowserActionError::WrongType {
                field,
                expected: "string",
            }),
        }
    }

    fn require_str(
        &self,
        action: &'static str,
        field: &'static str,
    ) -> Result<&'a str, BrowserActionError> {
        self.opt_str(field)?
            .ok_or(BrowserActionError::MissingField { action, field })
    }

    fn opt_bool(&self, field: &'static str) -> Result<Option<bool>, BrowserActionError> {
        match self.obj.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(BrowserActionError::WrongType {
                field,
                expected: "boolean",
            }),
        }
    }

    fn opt_f64(&self, field: &'static str) -> Result<Option<f64>, BrowserActionError> {
        match self.obj.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::Number(n)) => n.as_f64().map(Some).ok_or(BrowserActionError::WrongType {
                field,
                expected: "number",
            }),
            Some(_) => Err(BrowserActionError::WrongType {
                field,
                expected: "number",
            }),
        }
    }

    fn opt_str_array(&self, field: &'static str) -> Result<Vec<String>, BrowserActionError> {
        match self.obj.get(field) {
            None | Some(Value::Null) => Ok(Vec::new()),
            Some(Value::Array(items)) => items
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_string)
                        .ok_or(BrowserActionError::WrongType {
                            field,
                            expected: "array of strings",
                        })
                })
                .collect(),
            Some(_) => Err(BrowserActionError::WrongType {
                field,
                expected: "array of strings",
            }),
        }
    }

    fn target(&self) -> Result<TargetRef, BrowserActionError> {
        Ok(TargetRef {
            session_id: self.opt_str("sessionId")?.map(str::to_string),
            target_id: self.opt_str("targetId")?.map(str::to_string),
            tab_id: self.opt_str("tabId")?.map(str::to_string),
            profile: self.opt_str("profile")?.map(str::to_string),
            selector: self.opt_str("selector")?.map(str::to_string),
            element_id: self.opt_str("elementId")?.map(str::to_string),
        })
    }
}

impl BrowserAction {
    /// Parse a flat `params` object (the oracle tool's single argument) into a typed,
    /// validated [`BrowserAction`]. Mirrors the oracle's `readStringParam("action",
    /// {required:true})` + `VALID_ACTIONS` membership check, then reads the
    /// action-specific fields.
    pub fn parse(params: &Value) -> Result<Self, BrowserActionError> {
        let obj = params
            .as_object()
            .ok_or(BrowserActionError::MissingAction)?;
        let p = Params { obj };

        let action = match obj.get("action") {
            Some(Value::String(s)) => s.as_str(),
            _ => return Err(BrowserActionError::MissingAction),
        };

        match action {
            "open" => Ok(BrowserAction::Open {
                target: p.target()?,
                url: p.opt_str("url")?.map(str::to_string),
            }),
            "navigate" => Ok(BrowserAction::Navigate {
                target: p.target()?,
                url: p.opt_str("url")?.map(str::to_string),
            }),
            "screenshot" => Ok(BrowserAction::Screenshot {
                target: p.target()?,
                mode: match p.opt_str("screenshotMode")? {
                    Some(s) => ScreenshotMode::parse(s)?,
                    None => ScreenshotMode::default(),
                },
                full_page: p.opt_bool("fullPage")?.unwrap_or(false),
            }),
            "snapshot" => Ok(BrowserAction::Snapshot {
                target: p.target()?,
            }),
            "act" => {
                let sub = p.opt_str("act")?.ok_or(BrowserActionError::MissingAct)?;
                Ok(BrowserAction::Act {
                    target: p.target()?,
                    kind: ActKind::parse(sub, &p)?,
                })
            }
            "tabs" => {
                let sub = match p.opt_str("tabsAction")? {
                    Some(s) => TabsAction::parse(s)?,
                    // The oracle defaults a tabs call with no sub to `list` (read).
                    None => TabsAction::List,
                };
                Ok(BrowserAction::Tabs {
                    target: p.target()?,
                    sub,
                    tab_id: p.opt_str("tabId")?.map(str::to_string),
                    url: p.opt_str("url")?.map(str::to_string),
                })
            }
            "close" => Ok(BrowserAction::Close {
                target: p.target()?,
            }),
            "status" => Ok(BrowserAction::Status {
                profile: p.opt_str("profile")?.map(str::to_string),
            }),
            "start" => Ok(BrowserAction::Start {
                target: p.target()?,
                url: p.opt_str("url")?.map(str::to_string),
            }),
            "stop" => Ok(BrowserAction::Stop {
                profile: p.opt_str("profile")?.map(str::to_string),
            }),
            "profiles" => Ok(BrowserAction::Profiles),
            "focus" => Ok(BrowserAction::Focus {
                target: p.target()?,
            }),
            "console" => Ok(BrowserAction::Console {
                target: p.target()?,
                text: p.opt_str("text")?.map(str::to_string),
            }),
            "pdf" => Ok(BrowserAction::Pdf {
                target: p.target()?,
            }),
            "upload" => {
                let file_paths = p.opt_str_array("filePaths")?;
                if file_paths.is_empty() {
                    return Err(BrowserActionError::MissingField {
                        action: "upload",
                        field: "filePaths",
                    });
                }
                Ok(BrowserAction::Upload {
                    target: p.target()?,
                    file_paths,
                })
            }
            "dialog" => Ok(BrowserAction::Dialog {
                target: p.target()?,
                accept: p.opt_bool("accept")?.unwrap_or(false),
                prompt_text: p.opt_str("promptText")?.map(str::to_string),
            }),
            other => Err(BrowserActionError::InvalidAction(other.to_string())),
        }
    }

    /// Whether this action mutates browser/page state (vs a pure read). The hub's REGISTER
    /// step gates the WHOLE `browser` tool coarsely (mutating=true/High) because the
    /// single tool name mixes read + mutating sub-actions; this finer per-action bit is a
    /// convenience for handler-level ledger hygiene (read sub-actions set `content`,
    /// mutating sub-actions set refs-only summaries).
    #[must_use]
    pub fn is_mutating(&self) -> bool {
        match self {
            BrowserAction::Status { .. }
            | BrowserAction::Profiles
            | BrowserAction::Snapshot { .. } => false,
            // `console` is a read UNLESS it carries an expression to evaluate.
            BrowserAction::Console { text, .. } => text.is_some(),
            // Everything else opens/navigates/acts/captures/closes/uploads → mutating.
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_action_is_rejected() {
        assert_eq!(
            BrowserAction::parse(&json!({})),
            Err(BrowserActionError::MissingAction)
        );
        assert_eq!(
            BrowserAction::parse(&json!({"action": 5})),
            Err(BrowserActionError::MissingAction)
        );
        assert_eq!(
            BrowserAction::parse(&json!("not an object")),
            Err(BrowserActionError::MissingAction)
        );
    }

    #[test]
    fn invalid_action_is_rejected_with_the_name() {
        assert_eq!(
            BrowserAction::parse(&json!({"action": "teleport"})),
            Err(BrowserActionError::InvalidAction("teleport".to_string()))
        );
    }

    #[test]
    fn all_sixteen_valid_actions_parse() {
        // Drive each action with the minimal fields it needs so VALID_ACTIONS membership
        // matches the parser arms exactly (no action silently unparseable).
        for action in VALID_ACTIONS {
            let mut obj = serde_json::Map::new();
            obj.insert("action".to_string(), json!(action));
            obj.insert("sessionId".to_string(), json!("s1"));
            if action == "act" {
                obj.insert("act".to_string(), json!("click"));
            }
            if action == "upload" {
                obj.insert("filePaths".to_string(), json!(["/ws/a.txt"]));
            }
            if action == "navigate" || action == "open" || action == "start" {
                obj.insert("url".to_string(), json!("https://example.com"));
            }
            let parsed = BrowserAction::parse(&Value::Object(obj));
            assert!(
                parsed.is_ok(),
                "action {action} failed to parse: {parsed:?}"
            );
        }
    }

    #[test]
    fn navigate_carries_target_and_url() {
        let parsed = BrowserAction::parse(&json!({
            "action": "navigate",
            "targetId": "s1:tab-1",
            "url": "https://example.com"
        }))
        .expect("parse");
        match parsed {
            BrowserAction::Navigate { target, url } => {
                assert_eq!(target.target_id.as_deref(), Some("s1:tab-1"));
                assert_eq!(url.as_deref(), Some("https://example.com"));
            }
            other => panic!("expected Navigate, got {other:?}"),
        }
    }

    #[test]
    fn act_requires_a_sub_kind() {
        assert_eq!(
            BrowserAction::parse(&json!({"action": "act", "sessionId": "s1"})),
            Err(BrowserActionError::MissingAct)
        );
        assert_eq!(
            BrowserAction::parse(&json!({"action": "act", "act": "fly"})),
            Err(BrowserActionError::InvalidAct("fly".to_string()))
        );
    }

    #[test]
    fn act_type_and_evaluate_read_the_text_field() {
        let typed = BrowserAction::parse(&json!({
            "action": "act", "act": "type", "text": "hello"
        }))
        .expect("parse type");
        match typed {
            BrowserAction::Act {
                kind: ActKind::Type { text },
                ..
            } => assert_eq!(text, "hello"),
            other => panic!("expected Act/Type, got {other:?}"),
        }

        let eval = BrowserAction::parse(&json!({
            "action": "act", "act": "evaluate", "text": "1 + 1"
        }))
        .expect("parse evaluate");
        match eval {
            BrowserAction::Act {
                kind: ActKind::Evaluate { script },
                ..
            } => {
                assert_eq!(script, "1 + 1");
            }
            other => panic!("expected Act/Evaluate, got {other:?}"),
        }
        // The oracle's act:evaluate timeout is a fixed 10s.
        assert_eq!(ACT_EVALUATE_TIMEOUT_MS, 10_000);
    }

    #[test]
    fn act_type_missing_text_is_a_missing_field() {
        assert_eq!(
            BrowserAction::parse(&json!({"action": "act", "act": "type"})),
            Err(BrowserActionError::MissingField {
                action: "act:type",
                field: "text"
            })
        );
    }

    #[test]
    fn screenshot_mode_defaults_to_path_and_rejects_unknown() {
        let def = BrowserAction::parse(&json!({"action": "screenshot", "sessionId": "s1"}))
            .expect("parse");
        match def {
            BrowserAction::Screenshot {
                mode, full_page, ..
            } => {
                assert_eq!(mode, ScreenshotMode::Path);
                assert!(!full_page);
            }
            other => panic!("expected Screenshot, got {other:?}"),
        }
        assert_eq!(
            BrowserAction::parse(&json!({"action": "screenshot", "screenshotMode": "gif"})),
            Err(BrowserActionError::InvalidScreenshotMode("gif".to_string()))
        );
    }

    #[test]
    fn tabs_defaults_to_list_and_rejects_unknown_sub() {
        let def =
            BrowserAction::parse(&json!({"action": "tabs", "sessionId": "s1"})).expect("parse");
        match def {
            BrowserAction::Tabs { sub, .. } => assert_eq!(sub, TabsAction::List),
            other => panic!("expected Tabs, got {other:?}"),
        }
        assert_eq!(
            BrowserAction::parse(&json!({"action": "tabs", "tabsAction": "merge"})),
            Err(BrowserActionError::InvalidTabsAction("merge".to_string()))
        );
    }

    #[test]
    fn upload_requires_non_empty_file_paths() {
        assert_eq!(
            BrowserAction::parse(&json!({"action": "upload", "sessionId": "s1"})),
            Err(BrowserActionError::MissingField {
                action: "upload",
                field: "filePaths"
            })
        );
        let ok = BrowserAction::parse(&json!({
            "action": "upload", "filePaths": ["/ws/a.txt", "/ws/b.txt"]
        }))
        .expect("parse");
        match ok {
            BrowserAction::Upload { file_paths, .. } => assert_eq!(file_paths.len(), 2),
            other => panic!("expected Upload, got {other:?}"),
        }
    }

    #[test]
    fn dialog_accept_defaults_false() {
        let parsed =
            BrowserAction::parse(&json!({"action": "dialog", "sessionId": "s1"})).expect("parse");
        match parsed {
            BrowserAction::Dialog {
                accept,
                prompt_text,
                ..
            } => {
                assert!(!accept);
                assert!(prompt_text.is_none());
            }
            other => panic!("expected Dialog, got {other:?}"),
        }
    }

    #[test]
    fn wrong_typed_field_is_rejected() {
        assert_eq!(
            BrowserAction::parse(&json!({"action": "navigate", "url": 42})),
            Err(BrowserActionError::WrongType {
                field: "url",
                expected: "string"
            })
        );
    }

    #[test]
    fn mutation_classification_matches_read_vs_write_sub_actions() {
        let read = BrowserAction::parse(&json!({"action": "status"})).unwrap();
        assert!(!read.is_mutating());
        let snapshot = BrowserAction::parse(&json!({"action": "snapshot"})).unwrap();
        assert!(!snapshot.is_mutating());
        let console_read = BrowserAction::parse(&json!({"action": "console"})).unwrap();
        assert!(!console_read.is_mutating());
        let console_eval =
            BrowserAction::parse(&json!({"action": "console", "text": "x"})).unwrap();
        assert!(console_eval.is_mutating());
        let nav =
            BrowserAction::parse(&json!({"action": "navigate", "url": "https://e.com"})).unwrap();
        assert!(nav.is_mutating());
        let click = BrowserAction::parse(&json!({"action": "act", "act": "click"})).unwrap();
        assert!(click.is_mutating());
    }
}
