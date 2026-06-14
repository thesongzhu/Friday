//! backend — the [`BrowserBackend`] dependency-injection trait: the seam between the
//! action handlers (B2a-d) and the actual browser engine.
//!
//! This is the os-actuation `OsActuationBackend` analogue. The ONLY default-constructible
//! impl is [`crate::stub::StubBrowserBackend`] (deterministic, in-memory, no network, no
//! Chromium). The real Chrome-DevTools-Protocol impl is supplied by B4-LIVE behind the
//! DEFAULT-OFF `browser-live-deploy-go` cargo feature; until then the feature-ON build does
//! not compile (the `compile_error!` in `lib.rs`). So the default build cannot link a real
//! actuator — this dark slice can never move a real browser.
//!
//! The trait carries NO `friday-hub` dependency: per the verified hub↔crate boundary, the
//! `impl friday_hub::ToolExecutor` wrapper that calls these methods is a HUB module
//! (B3-EXEC), not part of this crate (that would force a dependency cycle). The trait is
//! synchronous and blocking, matching the provider-crate `Transport` seam — the hub adapts
//! to async at its edge if needed.

use thiserror::Error;

use crate::dom_lite::{ConsoleEntry, PageInfo, PresentationMode, SnapshotResult, TabInfo};

/// A backend operation failure. Coarse + payload-bounded (mirrors the provider-crate
/// error discipline): names the failure class, never echoes page content or a secret.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BackendError {
    /// The engine is not running / could not be started.
    #[error("browser engine unavailable: {0}")]
    EngineUnavailable(String),
    /// The named session does not exist.
    #[error("browser session not found: {0}")]
    SessionNotFound(String),
    /// The named tab does not exist in its session.
    #[error("browser tab not found: {0}")]
    TabNotFound(String),
    /// The requested element/selector could not be found on the page.
    #[error("browser element not found: {0}")]
    ElementNotFound(String),
    /// A navigation was rejected by the URL guard (carries the guard message). The handler
    /// runs the guard BEFORE calling the backend, so a real backend should never produce
    /// this — but it lets the stub model a rejected navigation in tests.
    #[error("browser navigation rejected: {0}")]
    NavigationRejected(String),
    /// The operation timed out (e.g. an `act:wait` / `act:evaluate` exceeded its budget).
    #[error("browser operation timed out: {0}")]
    Timeout(String),
    /// The operation is not supported by this backend (the honest "not wired" marker —
    /// the analogue of the os-actuation `Unavailable`).
    #[error("browser operation unsupported: {0}")]
    Unsupported(String),
    /// Any other engine-side failure, classified coarsely.
    #[error("browser engine error: {0}")]
    Engine(String),
}

/// A handle to an open session + active tab returned by open/start/navigate.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionHandle {
    /// The session id.
    pub session_id: String,
    /// The active tab id.
    pub tab_id: String,
    /// Whether an existing session was reused (vs newly launched).
    pub reused: bool,
    /// How the session is presented (headless vs visible host Chrome).
    pub presentation: PresentationMode,
}

/// A summary of one open session (for `status`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SessionSummary {
    /// The session id.
    pub session_id: String,
    /// The session's profile name, if any.
    pub profile: Option<String>,
    /// Number of open tabs.
    pub tab_count: usize,
    /// The active tab id.
    pub active_tab_id: String,
    /// Presentation mode.
    pub presentation: PresentationMode,
}

/// An active profile summary (for `profiles`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProfileSummary {
    /// The profile name (or `"(default)"` for sessions launched without a profile).
    pub name: String,
    /// Session ids using this profile.
    pub session_ids: Vec<String>,
}

/// The result of a screenshot/pdf capture: either a workspace-relative artifact path or
/// inline bytes (base64 mode for screenshots). The handler writes path-mode bytes via the
/// friday-fs containment primitives; this carries what the backend produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureOutput {
    /// Raw bytes the handler will persist (PNG/PDF) under the artifact dir, or return
    /// inline (base64 screenshot mode).
    Bytes(Vec<u8>),
}

/// The browser engine seam. Every method is fallible with a [`BackendError`]; a real
/// backend MUST NOT report success for an effect it did not perform (the os-actuation
/// "never report Completed for an unperformed effect" discipline).
///
/// Methods map to the 16 `browser` actions. `open`/`start` share `open_session`;
/// `stop` is `close_session(None)` semantics threaded by the lifecycle handler.
pub trait BrowserBackend {
    // ── Engine / session lifecycle ──────────────────────────────────────────────────

    /// Start the engine (idempotent; a no-op if already running). The lifecycle handler
    /// (B2b) calls this for `start`.
    fn start_engine(&self) -> Result<(), BackendError>;

    /// Stop the engine and close all sessions (the `stop` action). Returns the number of
    /// sessions closed.
    fn stop_engine(&self) -> Result<usize, BackendError>;

    /// Open (or reuse) a session for `profile`, optionally navigating to `url`. Backs both
    /// `open` and `start` (alias). The URL guard has already run at the handler layer for
    /// any `url`.
    fn open_session(
        &self,
        session_id: Option<&str>,
        profile: Option<&str>,
        url: Option<&str>,
    ) -> Result<SessionHandle, BackendError>;

    /// Close a session (the `close` action); `None` closes the most-recent/all per the
    /// handler's policy. Returns the number of sessions closed.
    fn close_session(&self, session_id: Option<&str>) -> Result<usize, BackendError>;

    /// Close all sessions matching `profile` (the `stop`-by-profile path). Returns the
    /// count closed.
    fn close_sessions_by_profile(&self, profile: &str) -> Result<usize, BackendError>;

    /// Read engine status: the open sessions (optionally filtered by `profile`). A READ.
    fn status(&self, profile: Option<&str>) -> Result<Vec<SessionSummary>, BackendError>;

    /// List active profiles (the `profiles` action). A READ.
    fn profiles(&self) -> Result<Vec<ProfileSummary>, BackendError>;

    /// Focus a tab and bring it to front (the `focus` action).
    fn focus(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError>;

    // ── Tabs ──────────────────────────────────────────────────────────────────────

    /// List the tabs of a session (`tabs:list`). A READ.
    fn list_tabs(&self, session_id: &str) -> Result<Vec<TabInfo>, BackendError>;

    /// Open a new tab (`tabs:new`), optionally navigating to `url`. Returns the new tab id.
    fn new_tab(&self, session_id: &str, url: Option<&str>) -> Result<String, BackendError>;

    /// Switch the active tab (`tabs:switch`).
    fn switch_tab(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError>;

    /// Close a tab (`tabs:close`).
    fn close_tab(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError>;

    // ── Navigation / capture ────────────────────────────────────────────────────────

    /// Navigate the targeted tab to `url` (the `navigate` action). The handler has ALREADY
    /// validated `url` through the SSRF/origin guard before this is called.
    fn navigate(&self, session_id: &str, tab_id: &str, url: &str)
        -> Result<PageInfo, BackendError>;

    /// Screenshot the targeted tab (`screenshot`). `full_page` requests a full-page
    /// capture. Returns raw PNG bytes; the handler chooses path vs base64 presentation.
    fn screenshot(
        &self,
        session_id: &str,
        tab_id: &str,
        full_page: bool,
    ) -> Result<CaptureOutput, BackendError>;

    /// AX-tree snapshot of the targeted tab (`snapshot`), assigning stable element ids the
    /// handler caches. A READ.
    fn snapshot(&self, session_id: &str, tab_id: &str) -> Result<SnapshotResult, BackendError>;

    /// Read the targeted tab's console log lines (`console`, no expression). A READ.
    fn console(&self, session_id: &str, tab_id: &str) -> Result<Vec<ConsoleEntry>, BackendError>;

    /// Evaluate a JS expression in the targeted tab and return its stringified result
    /// (`console` with text, and `act:evaluate`). Carries the caller-supplied
    /// `timeout_ms` (the handler passes the oracle's 10s for act:evaluate).
    fn evaluate(
        &self,
        session_id: &str,
        tab_id: &str,
        script: &str,
        timeout_ms: u64,
    ) -> Result<String, BackendError>;

    /// Render the targeted tab to PDF (`pdf`). Returns raw PDF bytes.
    fn print_pdf(&self, session_id: &str, tab_id: &str) -> Result<CaptureOutput, BackendError>;

    // ── Interaction (the `act` family) ────────────────────────────────────────────

    /// Click an element resolved by `selector` (the handler resolves a cached `elementId`
    /// to a selector before calling).
    fn click(&self, session_id: &str, tab_id: &str, selector: &str) -> Result<(), BackendError>;

    /// Type `text` into the targeted element.
    fn type_text(
        &self,
        session_id: &str,
        tab_id: &str,
        selector: Option<&str>,
        text: &str,
    ) -> Result<(), BackendError>;

    /// Press a key in the targeted tab.
    fn press_key(&self, session_id: &str, tab_id: &str, key: &str) -> Result<(), BackendError>;

    /// Hover over an element.
    fn hover(&self, session_id: &str, tab_id: &str, selector: &str) -> Result<(), BackendError>;

    /// Drag from `selector` to `end_selector`.
    fn drag(
        &self,
        session_id: &str,
        tab_id: &str,
        selector: &str,
        end_selector: &str,
    ) -> Result<(), BackendError>;

    /// Select option `values` in a `<select>` addressed by `selector`.
    fn select(
        &self,
        session_id: &str,
        tab_id: &str,
        selector: &str,
        values: &[String],
    ) -> Result<(), BackendError>;

    /// Fill an input (clear + type) addressed by `selector` with `text`.
    fn fill(
        &self,
        session_id: &str,
        tab_id: &str,
        selector: &str,
        text: &str,
    ) -> Result<(), BackendError>;

    /// Resize the viewport.
    fn resize(
        &self,
        session_id: &str,
        tab_id: &str,
        width: u32,
        height: u32,
    ) -> Result<(), BackendError>;

    /// Wait `time_ms` milliseconds (the `act:wait` sub-action).
    fn wait(&self, session_id: &str, tab_id: &str, time_ms: u64) -> Result<(), BackendError>;

    // ── Upload / dialog ─────────────────────────────────────────────────────────────

    /// Set `file_paths` on the targeted file input (the `upload` action). The handler has
    /// already confined the paths to the workspace/tmp via friday-fs realpath containment.
    fn upload(
        &self,
        session_id: &str,
        tab_id: &str,
        selector: Option<&str>,
        file_paths: &[String],
    ) -> Result<(), BackendError>;

    /// Respond to a pending JS dialog (`dialog`): accept/dismiss with optional prompt text.
    fn dialog(
        &self,
        session_id: &str,
        tab_id: &str,
        accept: bool,
        prompt_text: Option<&str>,
    ) -> Result<(), BackendError>;
}
