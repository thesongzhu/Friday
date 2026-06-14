//! stub — [`StubBrowserBackend`], the ONLY default-constructible [`BrowserBackend`].
//!
//! A deterministic, in-memory page/tab/session model. No network, no Chromium, no host
//! effect — the os-actuation `UnavailableBackend` analogue, except this stub models real
//! state so the handler logic (B2a-d) is fully testable WITHOUT a live browser. It NEVER
//! reaches the network: a `navigate` records the URL it was handed (already guard-checked
//! by the handler), a `screenshot` returns fixed deterministic bytes, an `evaluate`
//! returns a fixed echo. Because this is the only constructible backend in the default
//! build, the dark slice cannot move a real browser by construction.
//!
//! Interior mutability (`RefCell`) lets the `&self` trait methods mutate the in-memory
//! session table — the live CDP backend will likewise present a `&self` interface over an
//! interior connection.

use std::cell::RefCell;
use std::collections::BTreeMap;

use crate::backend::{
    BackendError, BrowserBackend, CaptureOutput, ProfileSummary, SessionHandle, SessionSummary,
};
use crate::dom_lite::{
    ConsoleEntry, ConsoleLevel, DomNode, PageInfo, PresentationMode, SnapshotResult, TabInfo,
};

/// Deterministic PNG-ish bytes a stub screenshot returns (a fixed marker, NOT a real
/// image — enough for the handler to exercise path/base64 persistence deterministically).
const STUB_SCREENSHOT_BYTES: &[u8] = b"FRIDAY-STUB-SCREENSHOT";
/// Deterministic PDF-ish bytes a stub `print_pdf` returns.
const STUB_PDF_BYTES: &[u8] = b"FRIDAY-STUB-PDF";
/// Default profile name reported for sessions launched without an explicit profile.
const DEFAULT_PROFILE_LABEL: &str = "(default)";

#[derive(Clone, Debug)]
struct StubTab {
    tab_id: String,
    page: PageInfo,
}

#[derive(Clone, Debug)]
struct StubSession {
    profile: Option<String>,
    presentation: PresentationMode,
    /// Insertion-ordered tabs (BTreeMap by a monotonic key would over-engineer; we keep a
    /// Vec for order + the active index).
    tabs: Vec<StubTab>,
    active_tab: String,
    console: Vec<ConsoleEntry>,
}

impl StubSession {
    fn active_page_mut(&mut self, tab_id: &str) -> Option<&mut StubTab> {
        self.tabs.iter_mut().find(|t| t.tab_id == tab_id)
    }
    fn has_tab(&self, tab_id: &str) -> bool {
        self.tabs.iter().any(|t| t.tab_id == tab_id)
    }
}

#[derive(Debug, Default)]
struct State {
    engine_running: bool,
    /// session_id → session. BTreeMap so iteration order (e.g. status) is deterministic.
    sessions: BTreeMap<String, StubSession>,
    /// Monotonic counters so generated ids are deterministic within a process run.
    next_session: u64,
    next_tab: u64,
}

/// The deterministic in-memory browser backend. Default-constructible; the only backend
/// the default build can link.
#[derive(Debug, Default)]
pub struct StubBrowserBackend {
    state: RefCell<State>,
}

impl StubBrowserBackend {
    /// A fresh stub with no engine running and no sessions.
    #[must_use]
    pub fn new() -> Self {
        StubBrowserBackend {
            state: RefCell::new(State::default()),
        }
    }

    fn gen_session_id(state: &mut State) -> String {
        state.next_session += 1;
        format!("stub-session-{}", state.next_session)
    }
    fn gen_tab_id(state: &mut State) -> String {
        state.next_tab += 1;
        format!("stub-tab-{}", state.next_tab)
    }

    fn require_session<'a>(
        sessions: &'a mut BTreeMap<String, StubSession>,
        session_id: &str,
    ) -> Result<&'a mut StubSession, BackendError> {
        sessions
            .get_mut(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))
    }
}

impl BrowserBackend for StubBrowserBackend {
    fn start_engine(&self) -> Result<(), BackendError> {
        self.state.borrow_mut().engine_running = true;
        Ok(())
    }

    fn stop_engine(&self) -> Result<usize, BackendError> {
        let mut st = self.state.borrow_mut();
        let n = st.sessions.len();
        st.sessions.clear();
        st.engine_running = false;
        Ok(n)
    }

    fn open_session(
        &self,
        session_id: Option<&str>,
        profile: Option<&str>,
        url: Option<&str>,
    ) -> Result<SessionHandle, BackendError> {
        let mut st = self.state.borrow_mut();
        st.engine_running = true;

        // Reuse an existing session if a known id was supplied.
        if let Some(id) = session_id {
            if let Some(existing) = st.sessions.get(id) {
                let tab_id = existing.active_tab.clone();
                let presentation = existing.presentation;
                // Apply navigation to the active tab if requested.
                if let Some(u) = url {
                    if let Some(sess) = st.sessions.get_mut(id) {
                        if let Some(tab) = sess.active_page_mut(&tab_id) {
                            tab.page = PageInfo {
                                url: u.to_string(),
                                title: None,
                            };
                        }
                    }
                }
                return Ok(SessionHandle {
                    session_id: id.to_string(),
                    tab_id,
                    reused: true,
                    presentation,
                });
            }
        }

        let new_session_id = match session_id {
            Some(id) => id.to_string(),
            None => Self::gen_session_id(&mut st),
        };
        let new_tab_id = Self::gen_tab_id(&mut st);
        let page = PageInfo {
            url: url.unwrap_or("about:blank").to_string(),
            title: None,
        };
        let session = StubSession {
            profile: profile.map(str::to_string),
            presentation: PresentationMode::Headless,
            tabs: vec![StubTab {
                tab_id: new_tab_id.clone(),
                page,
            }],
            active_tab: new_tab_id.clone(),
            console: Vec::new(),
        };
        st.sessions.insert(new_session_id.clone(), session);
        Ok(SessionHandle {
            session_id: new_session_id,
            tab_id: new_tab_id,
            reused: false,
            presentation: PresentationMode::Headless,
        })
    }

    fn close_session(&self, session_id: Option<&str>) -> Result<usize, BackendError> {
        let mut st = self.state.borrow_mut();
        match session_id {
            Some(id) => {
                if st.sessions.remove(id).is_some() {
                    Ok(1)
                } else {
                    Err(BackendError::SessionNotFound(id.to_string()))
                }
            }
            None => {
                let n = st.sessions.len();
                st.sessions.clear();
                Ok(n)
            }
        }
    }

    fn close_sessions_by_profile(&self, profile: &str) -> Result<usize, BackendError> {
        let mut st = self.state.borrow_mut();
        let to_remove: Vec<String> = st
            .sessions
            .iter()
            .filter(|(_, s)| s.profile.as_deref() == Some(profile))
            .map(|(id, _)| id.clone())
            .collect();
        let n = to_remove.len();
        for id in to_remove {
            st.sessions.remove(&id);
        }
        Ok(n)
    }

    fn status(&self, profile: Option<&str>) -> Result<Vec<SessionSummary>, BackendError> {
        let st = self.state.borrow();
        Ok(st
            .sessions
            .iter()
            .filter(|(_, s)| match profile {
                Some(p) => s.profile.as_deref() == Some(p),
                None => true,
            })
            .map(|(id, s)| SessionSummary {
                session_id: id.clone(),
                profile: s.profile.clone(),
                tab_count: s.tabs.len(),
                active_tab_id: s.active_tab.clone(),
                presentation: s.presentation,
            })
            .collect())
    }

    fn profiles(&self) -> Result<Vec<ProfileSummary>, BackendError> {
        let st = self.state.borrow();
        let mut by_profile: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (id, s) in &st.sessions {
            let name = s
                .profile
                .clone()
                .unwrap_or_else(|| DEFAULT_PROFILE_LABEL.to_string());
            by_profile.entry(name).or_default().push(id.clone());
        }
        Ok(by_profile
            .into_iter()
            .map(|(name, session_ids)| ProfileSummary { name, session_ids })
            .collect())
    }

    fn focus(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError> {
        let mut st = self.state.borrow_mut();
        let session = Self::require_session(&mut st.sessions, session_id)?;
        if !session.has_tab(tab_id) {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        session.active_tab = tab_id.to_string();
        Ok(())
    }

    fn list_tabs(&self, session_id: &str) -> Result<Vec<TabInfo>, BackendError> {
        let st = self.state.borrow();
        let session = st
            .sessions
            .get(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))?;
        Ok(session
            .tabs
            .iter()
            .map(|t| TabInfo {
                tab_id: t.tab_id.clone(),
                page: t.page.clone(),
                active: t.tab_id == session.active_tab,
            })
            .collect())
    }

    fn new_tab(&self, session_id: &str, url: Option<&str>) -> Result<String, BackendError> {
        let mut st = self.state.borrow_mut();
        let new_tab_id = Self::gen_tab_id(&mut st);
        let session = Self::require_session(&mut st.sessions, session_id)?;
        session.tabs.push(StubTab {
            tab_id: new_tab_id.clone(),
            page: PageInfo {
                url: url.unwrap_or("about:blank").to_string(),
                title: None,
            },
        });
        Ok(new_tab_id)
    }

    fn switch_tab(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError> {
        self.focus(session_id, tab_id)
    }

    fn close_tab(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError> {
        let mut st = self.state.borrow_mut();
        let session = Self::require_session(&mut st.sessions, session_id)?;
        let before = session.tabs.len();
        session.tabs.retain(|t| t.tab_id != tab_id);
        if session.tabs.len() == before {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        // Re-point the active tab if we closed it.
        if session.active_tab == tab_id {
            session.active_tab = session
                .tabs
                .first()
                .map(|t| t.tab_id.clone())
                .unwrap_or_default();
        }
        Ok(())
    }

    fn navigate(
        &self,
        session_id: &str,
        tab_id: &str,
        url: &str,
    ) -> Result<PageInfo, BackendError> {
        let mut st = self.state.borrow_mut();
        let session = Self::require_session(&mut st.sessions, session_id)?;
        let tab = session
            .active_page_mut(tab_id)
            .ok_or_else(|| BackendError::TabNotFound(tab_id.to_string()))?;
        tab.page = PageInfo {
            url: url.to_string(),
            title: Some("Stub Page".to_string()),
        };
        Ok(tab.page.clone())
    }

    fn screenshot(
        &self,
        session_id: &str,
        tab_id: &str,
        _full_page: bool,
    ) -> Result<CaptureOutput, BackendError> {
        let st = self.state.borrow();
        let session = st
            .sessions
            .get(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))?;
        if !session.has_tab(tab_id) {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        Ok(CaptureOutput::Bytes(STUB_SCREENSHOT_BYTES.to_vec()))
    }

    fn snapshot(&self, session_id: &str, tab_id: &str) -> Result<SnapshotResult, BackendError> {
        let st = self.state.borrow();
        let session = st
            .sessions
            .get(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))?;
        let tab = session
            .tabs
            .iter()
            .find(|t| t.tab_id == tab_id)
            .ok_or_else(|| BackendError::TabNotFound(tab_id.to_string()))?;
        // Deterministic two-node AX tree so the element cache + act-by-elementId path is
        // exercisable without a real DOM.
        Ok(SnapshotResult {
            page: tab.page.clone(),
            nodes: vec![
                DomNode {
                    element_id: "stub-el-1".to_string(),
                    role: "link".to_string(),
                    name: Some("Home".to_string()),
                    selector: Some("a#home".to_string()),
                },
                DomNode {
                    element_id: "stub-el-2".to_string(),
                    role: "button".to_string(),
                    name: Some("Submit".to_string()),
                    selector: Some("button#submit".to_string()),
                },
            ],
        })
    }

    fn console(&self, session_id: &str, tab_id: &str) -> Result<Vec<ConsoleEntry>, BackendError> {
        let st = self.state.borrow();
        let session = st
            .sessions
            .get(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))?;
        if !session.has_tab(tab_id) {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        Ok(session.console.clone())
    }

    fn evaluate(
        &self,
        session_id: &str,
        tab_id: &str,
        script: &str,
        _timeout_ms: u64,
    ) -> Result<String, BackendError> {
        let mut st = self.state.borrow_mut();
        let session = Self::require_session(&mut st.sessions, session_id)?;
        if !session.has_tab(tab_id) {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        // Record the evaluation as a console line + return a deterministic echo (NEVER
        // executes anything — the stub cannot run JS).
        session.console.push(ConsoleEntry {
            level: ConsoleLevel::Log,
            text: format!("eval: {script}"),
        });
        Ok(format!("stub-eval-result: {script}"))
    }

    fn print_pdf(&self, session_id: &str, tab_id: &str) -> Result<CaptureOutput, BackendError> {
        let st = self.state.borrow();
        let session = st
            .sessions
            .get(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))?;
        if !session.has_tab(tab_id) {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        Ok(CaptureOutput::Bytes(STUB_PDF_BYTES.to_vec()))
    }

    fn click(&self, session_id: &str, tab_id: &str, _selector: &str) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn type_text(
        &self,
        session_id: &str,
        tab_id: &str,
        _selector: Option<&str>,
        _text: &str,
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn press_key(&self, session_id: &str, tab_id: &str, _key: &str) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn hover(&self, session_id: &str, tab_id: &str, _selector: &str) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn drag(
        &self,
        session_id: &str,
        tab_id: &str,
        _selector: &str,
        _end_selector: &str,
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn select(
        &self,
        session_id: &str,
        tab_id: &str,
        _selector: &str,
        _values: &[String],
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn fill(
        &self,
        session_id: &str,
        tab_id: &str,
        _selector: &str,
        _text: &str,
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn resize(
        &self,
        session_id: &str,
        tab_id: &str,
        _width: u32,
        _height: u32,
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn wait(&self, session_id: &str, tab_id: &str, _time_ms: u64) -> Result<(), BackendError> {
        // The stub does NOT actually sleep — it only validates the target (determinism +
        // no real wall-clock dependence in tests).
        self.assert_tab(session_id, tab_id)
    }

    fn upload(
        &self,
        session_id: &str,
        tab_id: &str,
        _selector: Option<&str>,
        _file_paths: &[String],
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }

    fn dialog(
        &self,
        session_id: &str,
        tab_id: &str,
        _accept: bool,
        _prompt_text: Option<&str>,
    ) -> Result<(), BackendError> {
        self.assert_tab(session_id, tab_id)
    }
}

impl StubBrowserBackend {
    /// Shared guard for the interaction methods: the session + tab must exist.
    fn assert_tab(&self, session_id: &str, tab_id: &str) -> Result<(), BackendError> {
        let st = self.state.borrow();
        let session = st
            .sessions
            .get(session_id)
            .ok_or_else(|| BackendError::SessionNotFound(session_id.to_string()))?;
        if !session.has_tab(tab_id) {
            return Err(BackendError::TabNotFound(tab_id.to_string()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open(stub: &StubBrowserBackend, profile: Option<&str>) -> SessionHandle {
        stub.open_session(None, profile, None).expect("open")
    }

    #[test]
    fn open_creates_a_session_with_one_active_tab() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, Some("chrome"));
        assert!(!h.reused);
        assert_eq!(h.presentation, PresentationMode::Headless);
        let tabs = stub.list_tabs(&h.session_id).expect("tabs");
        assert_eq!(tabs.len(), 1);
        assert!(tabs[0].active);
    }

    #[test]
    fn open_with_known_id_reuses() {
        let stub = StubBrowserBackend::new();
        let h = stub.open_session(Some("s1"), None, None).expect("open");
        assert!(!h.reused);
        let again = stub.open_session(Some("s1"), None, None).expect("reopen");
        assert!(again.reused);
        assert_eq!(again.session_id, "s1");
    }

    #[test]
    fn status_lists_and_filters_by_profile() {
        let stub = StubBrowserBackend::new();
        stub.open_session(Some("a"), Some("chrome"), None).unwrap();
        stub.open_session(Some("b"), Some("openclaw"), None)
            .unwrap();
        assert_eq!(stub.status(None).unwrap().len(), 2);
        let only_chrome = stub.status(Some("chrome")).unwrap();
        assert_eq!(only_chrome.len(), 1);
        assert_eq!(only_chrome[0].session_id, "a");
    }

    #[test]
    fn profiles_groups_sessions_and_labels_default() {
        let stub = StubBrowserBackend::new();
        stub.open_session(Some("a"), Some("chrome"), None).unwrap();
        stub.open_session(Some("b"), Some("chrome"), None).unwrap();
        stub.open_session(Some("c"), None, None).unwrap();
        let profiles = stub.profiles().unwrap();
        // BTreeMap order: "(default)" < "chrome".
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].name, "(default)");
        assert_eq!(profiles[0].session_ids, vec!["c".to_string()]);
        assert_eq!(profiles[1].name, "chrome");
        assert_eq!(profiles[1].session_ids.len(), 2);
    }

    #[test]
    fn stop_closes_all_sessions() {
        let stub = StubBrowserBackend::new();
        stub.open_session(Some("a"), None, None).unwrap();
        stub.open_session(Some("b"), None, None).unwrap();
        assert_eq!(stub.stop_engine().unwrap(), 2);
        assert_eq!(stub.status(None).unwrap().len(), 0);
    }

    #[test]
    fn stop_by_profile_closes_only_matching() {
        let stub = StubBrowserBackend::new();
        stub.open_session(Some("a"), Some("chrome"), None).unwrap();
        stub.open_session(Some("b"), Some("other"), None).unwrap();
        assert_eq!(stub.close_sessions_by_profile("chrome").unwrap(), 1);
        assert_eq!(stub.status(None).unwrap().len(), 1);
    }

    #[test]
    fn navigate_records_the_url() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, None);
        let page = stub
            .navigate(&h.session_id, &h.tab_id, "https://example.com/")
            .expect("navigate");
        assert_eq!(page.url, "https://example.com/");
    }

    #[test]
    fn navigate_unknown_session_fails_closed() {
        let stub = StubBrowserBackend::new();
        let err = stub
            .navigate("nope", "tab", "https://example.com/")
            .unwrap_err();
        assert_eq!(err, BackendError::SessionNotFound("nope".to_string()));
    }

    #[test]
    fn tabs_lifecycle() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, None);
        let t2 = stub.new_tab(&h.session_id, None).expect("new tab");
        assert_eq!(stub.list_tabs(&h.session_id).unwrap().len(), 2);
        stub.switch_tab(&h.session_id, &t2).expect("switch");
        let tabs = stub.list_tabs(&h.session_id).unwrap();
        assert!(tabs.iter().find(|t| t.tab_id == t2).unwrap().active);
        stub.close_tab(&h.session_id, &t2).expect("close tab");
        assert_eq!(stub.list_tabs(&h.session_id).unwrap().len(), 1);
        // Closing a missing tab fails closed.
        assert_eq!(
            stub.close_tab(&h.session_id, "ghost").unwrap_err(),
            BackendError::TabNotFound("ghost".to_string())
        );
    }

    #[test]
    fn screenshot_and_pdf_return_deterministic_bytes() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, None);
        let CaptureOutput::Bytes(png) = stub.screenshot(&h.session_id, &h.tab_id, true).unwrap();
        assert_eq!(png, STUB_SCREENSHOT_BYTES);
        let CaptureOutput::Bytes(pdf) = stub.print_pdf(&h.session_id, &h.tab_id).unwrap();
        assert_eq!(pdf, STUB_PDF_BYTES);
    }

    #[test]
    fn snapshot_returns_stable_element_ids() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, None);
        let snap = stub.snapshot(&h.session_id, &h.tab_id).unwrap();
        assert_eq!(snap.nodes.len(), 2);
        assert_eq!(snap.nodes[0].element_id, "stub-el-1");
    }

    #[test]
    fn evaluate_echoes_and_logs_without_executing() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, None);
        let out = stub
            .evaluate(&h.session_id, &h.tab_id, "1+1", 10_000)
            .unwrap();
        assert_eq!(out, "stub-eval-result: 1+1");
        let console = stub.console(&h.session_id, &h.tab_id).unwrap();
        assert_eq!(console.len(), 1);
        assert_eq!(console[0].text, "eval: 1+1");
    }

    #[test]
    fn act_family_validates_target_and_succeeds_on_the_stub() {
        let stub = StubBrowserBackend::new();
        let h = open(&stub, None);
        assert!(stub.click(&h.session_id, &h.tab_id, "#x").is_ok());
        assert!(stub
            .type_text(&h.session_id, &h.tab_id, Some("#x"), "hi")
            .is_ok());
        assert!(stub.press_key(&h.session_id, &h.tab_id, "Enter").is_ok());
        assert!(stub.hover(&h.session_id, &h.tab_id, "#x").is_ok());
        assert!(stub.drag(&h.session_id, &h.tab_id, "#a", "#b").is_ok());
        assert!(stub
            .select(&h.session_id, &h.tab_id, "#s", &["one".to_string()])
            .is_ok());
        assert!(stub.fill(&h.session_id, &h.tab_id, "#x", "v").is_ok());
        assert!(stub.resize(&h.session_id, &h.tab_id, 800, 600).is_ok());
        assert!(stub.wait(&h.session_id, &h.tab_id, 5).is_ok());
        assert!(stub
            .upload(
                &h.session_id,
                &h.tab_id,
                Some("#f"),
                &["/ws/a.txt".to_string()]
            )
            .is_ok());
        assert!(stub.dialog(&h.session_id, &h.tab_id, true, None).is_ok());
        // Every act against an unknown session fails closed.
        assert_eq!(
            stub.click("nope", "tab", "#x").unwrap_err(),
            BackendError::SessionNotFound("nope".to_string())
        );
    }
}
