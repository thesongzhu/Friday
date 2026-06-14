//! friday-browser — the Friday net-new `browser` capability ENGINE crate (Hub-only,
//! heavy-binary, DARK).
//!
//! This crate is the F11 browser foundation. It mirrors the os-actuation dark spine
//! (`friday-hub::system_intent`): the only default-constructible backend is the
//! [`StubBrowserBackend`] (a deterministic in-memory page/tab/session model — no
//! network, no Chromium, no host effect), and the real Chrome-DevTools-Protocol backend
//! is reachable ONLY through a deliberate, reviewable RECOMPILED cutover behind the
//! DEFAULT-OFF `browser-live-deploy-go` cargo feature, whose feature-ON arm is an
//! explicit `compile_error!` until B4-LIVE supplies the impl. So the default build cannot
//! even LINK a real browser actuator — by construction, this dark slice can never move a
//! real browser.
//!
//! # Scope (B1)
//!
//! - [`BrowserBackend`] — the dependency-injection trait every handler dispatches against
//!   (the seam that B4-LIVE's CDP backend and the test stub both implement). It carries NO
//!   `friday-hub` dependency: per the verified hub↔crate boundary (`friday-deepseek`/
//!   `friday-anthropic`), the `impl friday_hub::ToolExecutor` wrapper is a HUB module
//!   (B3-EXEC), never part of this crate — that would force a dependency cycle.
//! - [`StubBrowserBackend`] — the only default-constructible backend.
//! - [`action`] — the [`BrowserAction`] enum + `act` sub-kinds + the parsed param schema.
//! - [`url_guard`] — the SSRF/allowed-origins `validate_url` guard (protocol + origin
//!   allowlist), a faithful port of the TS `friday-browser-manager` guard.
//! - [`target_id`] — the `sessionId` / `sessionId:tabId` / profile target-id resolver.
//! - [`element_cache`] — the snapshot-derived element-id cache.
//! - [`dom_lite`] — the dom-lite AX/console/page types.
//! - [`artifact`] — the workspace-relative artifact-path helper (pure path-string logic;
//!   the actual byte writes are done in the handler PRs via the friday-fs containment
//!   primitives, never here).
//!
//! # Flags (consts only — the gate is enforced at the hub, NOT in this crate)
//!
//! The runtime dispatch flag [`ENV_ROUTE_ENABLED`] (`FRIDAY_BROWSER_ENABLED`) is declared
//! here as a DEFAULT-OFF const + a [`route_enabled`] reader mirroring the
//! `FRIDAY_CLAUDE_ROUTE_ENABLED` template (true iff the value is exactly `"1"`). This
//! crate carries NO gate logic of its own — the hub's WIRE composite arm reads the flag.
//!
//! # Cargo feature
//!
//! `browser-live-deploy-go` (DEFAULT-OFF): the only path to a real browser actuator. The
//! feature-ON arm is the `compile_error!` below until B4-LIVE; the default build links
//! only the stub.
//!
//! Trust boundary: heavy-binary / live-external-effecting → stays OUT of `friday-ffi`'s
//! (phone) dependency graph, the same boundary `friday-arch-tests` asserts for the
//! provider-secret crates.

// ── DEPLOY-GO compile-time gate on the real CDP backend ──────────────────────────────
//
// The DEFAULT build (feature OFF) ships ONLY `StubBrowserBackend`. Building with
// `--features browser-live-deploy-go` intentionally fails to compile until B4-LIVE wires
// the real chromiumoxide CDP backend (`src/live_cdp.rs`, owned by B4-LIVE — NOT created
// here) behind this feature. So a default binary can never link a real browser actuator
// by accident; flipping the feature is a deliberate, reviewable RECOMPILE. Exact mirror
// of the `os-actuation-deploy-go` precedent (friday-hub/src/system_intent.rs).
#[cfg(feature = "browser-live-deploy-go")]
compile_error!(
    "browser-live-deploy-go: no real CDP BrowserBackend is wired yet. The live Chrome-\
     DevTools-Protocol backend over chromiumoxide is a DEPLOY-GO cutover (deliberate, \
     reviewable recompile) — wire the real backend (src/live_cdp.rs) behind this arm in \
     B4-LIVE before building with this feature. The default build links only \
     StubBrowserBackend."
);

pub mod action;
pub mod artifact;
pub mod backend;
pub mod dom_lite;
pub mod element_cache;
pub mod stub;
pub mod target_id;
pub mod url_guard;

// ── Handler module spine (B2a-d FILL these; B1 pre-declares them so it compiles
// standalone — empty compiling stubs live in the per-module files). B2a-d add NO new
// `mod` line: they only fill the already-declared file, keeping each handler PR
// file-disjoint from the others and from this declaration list. ───────────────────────
mod interaction;
mod lifecycle;
mod nav_capture;
mod upload_dialog;

pub use action::{ActKind, BrowserAction, BrowserActionError, ScreenshotMode, TabsAction};
pub use artifact::{browser_artifact_dir, sanitize_artifact_path_segment, ArtifactPathError};
pub use backend::{BackendError, BrowserBackend};
pub use dom_lite::{
    ConsoleEntry, ConsoleLevel, DomNode, PageInfo, PresentationMode, SnapshotResult, TabInfo,
};
pub use element_cache::ElementCache;
pub use stub::StubBrowserBackend;
pub use target_id::{format_browser_target_id, parse_browser_target_id, ParsedTargetId};
pub use url_guard::{matches_origin, validate_url, UrlGuardError, FRIDAY_BROWSER_ALLOW_ANY_ORIGIN};

/// Hub-dispatch runtime flag (DEFAULT-OFF). The hub's WIRE composite arm reads this; the
/// crate itself enforces no gate. Value semantics mirror the `FRIDAY_CLAUDE_ROUTE_ENABLED`
/// template: enabled iff the env value is exactly `"1"`.
pub const ENV_ROUTE_ENABLED: &str = "FRIDAY_BROWSER_ENABLED";

/// Optional CDP attach endpoint env override (consumed only by the live B4-LIVE backend;
/// declared here for one canonical home). Mirrors the TS `connectOverCDP` split.
pub const ENV_WS_ENDPOINT: &str = "FRIDAY_BROWSER_WS_ENDPOINT";

/// True iff the runtime dispatch flag is set to exactly `"1"`. Pure reader; the hub owns
/// the actual gate decision — this is a convenience the hub may reuse.
#[must_use]
pub fn route_enabled() -> bool {
    std::env::var(ENV_ROUTE_ENABLED)
        .map(|v| v == "1")
        .unwrap_or(false)
}

#[cfg(test)]
mod lib_tests {
    use super::*;

    #[test]
    fn flag_const_homes_are_stable() {
        // The crate ships no live default: the dispatch flag lives here, DEFAULT-OFF,
        // and the hub (not this crate) enforces the gate. Pin the canonical names so a
        // rename can't silently desync the hub's WIRE arm.
        assert_eq!(ENV_ROUTE_ENABLED, "FRIDAY_BROWSER_ENABLED");
        assert_eq!(ENV_WS_ENDPOINT, "FRIDAY_BROWSER_WS_ENDPOINT");
    }

    #[test]
    fn stub_is_the_default_constructible_backend() {
        // The dark invariant: a default backend constructs and actuates nothing real.
        let _backend = StubBrowserBackend::new();
        let _backend_default = StubBrowserBackend::default();
    }
}
