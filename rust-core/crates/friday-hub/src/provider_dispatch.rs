//! Provider Workspace dispatch adapter SEAM (PWS-004).
//!
//! PWS-003 ([`crate::provider_workspace::guard_action_request`]) DECIDES
//! accepted/routed/blocker but never dispatches. This seam wires an
//! ACCEPTED + ROUTED action to a provider adapter and returns the
//! `dispatch_ref` / `truth_label` / `blocker`.
//!
//! Invariants (file 60 §6, file 81 PWS-004, file 83):
//! - GATE FIRST. The guard runs before the adapter is ever consulted. A blocked /
//!   unknown / mismatched / non-routed request is returned VERBATIM with no adapter
//!   call — so there is no hidden provider/model call on a non-accepted request.
//! - NO TRUTH UPGRADE. The result's `truth_label` is the capability's (from the guard).
//!   The adapter CANNOT relabel it (no `provider_native_synced` from a local dispatch);
//!   [`DispatchOutcome`] deliberately carries no truth label.
//! - SECRETS STAY HUB-SIDE. The adapter may run a provider CLI/app-server (in
//!   CODEX-LIVE-001 / CLAUDE-MIRROR-001), but the [`DispatchOutcome`] / [`DispatchError`]
//!   surfaced here must never include provider credentials, raw account ids, or raw
//!   provider output.
//! - NO FALLBACK. A failed dispatch returns an exact blocker; it never silently reroutes
//!   to another provider.
//!
//! Sync by design — the core is blocking (ureq, no tokio). PWS-004 defines the trait +
//! the gate-then-dispatch flow and is proven with an injected fake adapter (no real
//! process / network in tests). The real Codex app-server and Claude mirror adapters
//! land in CODEX-LIVE-001 / CLAUDE-MIRROR-001 as `ProviderDispatchAdapter` impls.

use friday_protocol::{ProviderWorkspaceActionRequestWire, ProviderWorkspaceActionResultWire};
use friday_providers::unified::ProviderSession;
use thiserror::Error;

use crate::provider_workspace::{guard_action_request, ProviderWorkspaceCatalog};

/// What the adapter is given for an action the guard has ALREADY accepted + routed.
/// `provider`/`action`/`capability_id` are the guard-validated strings; `truth_label` is
/// informational only (the adapter must not change it).
pub struct DispatchContext<'a> {
    pub session: &'a ProviderSession,
    pub provider: &'a str,
    pub action: &'a str,
    pub capability_id: &'a str,
    pub dispatch_ref: &'a str,
    pub truth_label: &'a str,
    pub payload_ref: Option<&'a str>,
}

/// Coarse dispatch lifecycle. `Errored` is represented as `Err(DispatchError)`, not a
/// status, so a failure can never be mistaken for a completion.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DispatchStatus {
    Queued,
    Running,
    Completed,
}

fn dispatch_status_str(status: DispatchStatus) -> &'static str {
    match status {
        DispatchStatus::Queued => "dispatched_queued",
        DispatchStatus::Running => "dispatched_running",
        DispatchStatus::Completed => "dispatched_completed",
    }
}

/// The result of a successful adapter dispatch. Carries NO truth label (the capability's
/// is authoritative) and NO raw provider output/secret — only opaque refs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchOutcome {
    pub status: DispatchStatus,
    pub provider_event_id: Option<String>,
    pub audit_receipt_ref: Option<String>,
}

/// Why a dispatch failed. Messages are coarse and operator-safe — never include provider
/// stderr, credentials, account ids, or URLs.
#[derive(Clone, Debug, Error, PartialEq, Eq)]
pub enum DispatchError {
    #[error("provider adapter not ready: {0}")]
    AdapterNotReady(String),
    #[error("provider dispatch failed: {0}")]
    ExecutionFailed(String),
}

/// The provider-specific dispatch seam. Implemented by the real Codex app-server / Claude
/// mirror adapters (CODEX-LIVE-001 / CLAUDE-MIRROR-001) and by a fake adapter in tests.
///
/// `execute_action` is called ONLY for an action the guard already accepted + routed.
pub trait ProviderDispatchAdapter {
    fn execute_action(&self, ctx: &DispatchContext<'_>) -> Result<DispatchOutcome, DispatchError>;
}

/// Gate, then dispatch. The single entrypoint that wires an accepted Provider Workspace
/// action to a provider adapter. See the module invariants.
pub fn dispatch_provider_action(
    catalog: &ProviderWorkspaceCatalog,
    adapter: &dyn ProviderDispatchAdapter,
    session: &ProviderSession,
    request: ProviderWorkspaceActionRequestWire,
) -> ProviderWorkspaceActionResultWire {
    // Capture what the adapter needs before the guard consumes the request.
    let payload_ref = request.payload_ref.clone();

    // GATE FIRST — any refusal returns verbatim, adapter untouched.
    let guard = guard_action_request(catalog, session, request);
    if !guard.accepted || !guard.routed {
        return guard;
    }

    // An accepted + routed guard result always carries a dispatch_ref; fail closed
    // (no dispatch) if it somehow does not.
    let dispatch_ref = match guard.dispatch_ref.as_deref() {
        Some(r) => r.to_string(),
        None => {
            return ProviderWorkspaceActionResultWire {
                status: "dispatch_ref_missing".to_string(),
                blocker: Some("internal: accepted action missing dispatch_ref".to_string()),
                dispatch_ref: None,
                ..guard
            };
        }
    };

    // Dispatch. Scope the borrow of `guard` so the struct-update below can move it.
    let outcome = {
        let ctx = DispatchContext {
            session,
            provider: &guard.provider,
            action: &guard.action,
            capability_id: &guard.capability_id,
            dispatch_ref: &dispatch_ref,
            truth_label: &guard.truth_label,
            payload_ref: payload_ref.as_deref(),
        };
        adapter.execute_action(&ctx)
    };

    match outcome {
        Ok(outcome) => ProviderWorkspaceActionResultWire {
            status: dispatch_status_str(outcome.status).to_string(),
            blocker: None,
            // Echo the deterministic guard dispatch_ref — the adapter cannot mint a new
            // identity for the action.
            dispatch_ref: Some(dispatch_ref),
            // request_id/session/provider/action/capability_id/accepted/routed/
            // truth_label/proof_ref are carried unchanged from the guard.
            ..guard
        },
        Err(err) => ProviderWorkspaceActionResultWire {
            status: "dispatch_failed".to_string(),
            // STRUCTURAL no-leak: surface a FIXED operator-safe blocker per variant — the
            // adapter's free-text detail (`{0}`, which could contain stderr / a credential
            // / a raw url) is NEVER put on the wire. The detail stays in the `DispatchError`
            // value for Hub-side logging/audit by the caller, not in the projection.
            blocker: Some(wire_blocker(&err).to_string()),
            dispatch_ref: None,
            ..guard
        },
    }
}

/// The fixed, operator-safe wire blocker for a dispatch failure. Deliberately coarse and
/// free of any adapter-supplied text so a provider secret / raw output can never reach a
/// projected surface (file 60 §6, file 83 channel-redaction discipline).
fn wire_blocker(err: &DispatchError) -> &'static str {
    match err {
        DispatchError::AdapterNotReady(_) => "provider adapter not ready",
        DispatchError::ExecutionFailed(_) => "provider dispatch failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_providers::unified::{
        CapabilityStatus, FallbackStatus, PlatformProvider, ProviderCapability,
        ProviderNativeAction, ProviderSyncMode, SessionStatus,
    };
    use std::cell::Cell;

    fn session(provider: PlatformProvider) -> ProviderSession {
        ProviderSession {
            friday_session_id: format!("friday-{}", provider.as_str()),
            provider,
            workspace_id: "workspace-1".to_string(),
            sync_mode: ProviderSyncMode::ProviderAppServerLocal,
            status: SessionStatus::Idle,
            capability_snapshot: Vec::new(),
            active_turn_id: None,
            last_event_seq: 0,
            truth_label: "provider dispatch test".to_string(),
            fallback_status: FallbackStatus::NoFallback,
        }
    }

    fn req(
        provider: &str,
        friday_session_id: &str,
        action: &str,
        capability_id: &str,
    ) -> ProviderWorkspaceActionRequestWire {
        ProviderWorkspaceActionRequestWire {
            request_id: "request-1".to_string(),
            friday_session_id: friday_session_id.to_string(),
            provider: provider.to_string(),
            action: action.to_string(),
            capability_id: capability_id.to_string(),
            payload_ref: Some("friday://body/request/1".to_string()),
        }
    }

    const VERIFIED_TRUTH: &str = "verified app-server list";

    fn verified_catalog() -> ProviderWorkspaceCatalog {
        let mut catalog = ProviderWorkspaceCatalog::new();
        catalog
            .register(
                crate::provider_workspace::ProviderWorkspaceAction::ListSessions,
                ProviderCapability {
                    capability_id: "provider.codex.list_sessions".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::Verified,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: VERIFIED_TRUTH.to_string(),
                    blocker: None,
                    proof_ref: Some("proof-1".to_string()),
                    native_action: Some(ProviderNativeAction::CodexAppServer {
                        method: friday_providers::unified::CodexAppServerMethod::ThreadList,
                        schema_ref: "schema".to_string(),
                    }),
                },
            )
            .unwrap();
        catalog
    }

    fn unproven_catalog() -> ProviderWorkspaceCatalog {
        let mut catalog = ProviderWorkspaceCatalog::new();
        catalog
            .register(
                crate::provider_workspace::ProviderWorkspaceAction::ListSessions,
                ProviderCapability {
                    capability_id: "provider.codex.list_sessions".to_string(),
                    provider: PlatformProvider::Codex,
                    status: CapabilityStatus::ImplementedUnproven,
                    sync_mode: ProviderSyncMode::ProviderAppServerLocal,
                    truth_label: "codex list unproven".to_string(),
                    blocker: Some("app-server list not yet live-proven".to_string()),
                    proof_ref: None,
                    native_action: None,
                },
            )
            .unwrap();
        catalog
    }

    /// A fake adapter that records calls and never spawns a real process / network.
    enum Behavior {
        Ok(DispatchStatus),
        Fail(DispatchError),
    }
    struct FakeAdapter {
        calls: Cell<usize>,
        behavior: Behavior,
    }
    impl FakeAdapter {
        fn with(behavior: Behavior) -> Self {
            Self {
                calls: Cell::new(0),
                behavior,
            }
        }
        fn ok() -> Self {
            Self::with(Behavior::Ok(DispatchStatus::Queued))
        }
        fn ok_status(status: DispatchStatus) -> Self {
            Self::with(Behavior::Ok(status))
        }
        fn failing() -> Self {
            Self::with(Behavior::Fail(DispatchError::ExecutionFailed(
                "adapter offline".to_string(),
            )))
        }
        /// A failing adapter whose error string carries secret-shaped material — used to
        /// prove the seam REDACTS it from the wire blocker (no longer a vacuous test).
        fn failing_leaky() -> Self {
            Self::with(Behavior::Fail(DispatchError::ExecutionFailed(
                "token=sk-shouldNeverHappen account=acct_12345".to_string(),
            )))
        }
        fn count(&self) -> usize {
            self.calls.get()
        }
    }
    impl ProviderDispatchAdapter for FakeAdapter {
        fn execute_action(
            &self,
            ctx: &DispatchContext<'_>,
        ) -> Result<DispatchOutcome, DispatchError> {
            self.calls.set(self.calls.get() + 1);
            // The seam must pass the deterministic guard dispatch_ref through.
            assert!(ctx.dispatch_ref.starts_with("friday://provider-dispatch/"));
            match &self.behavior {
                Behavior::Ok(status) => Ok(DispatchOutcome {
                    status: *status,
                    provider_event_id: Some("provider-event-1".to_string()),
                    audit_receipt_ref: Some("audit-1".to_string()),
                }),
                Behavior::Fail(err) => Err(err.clone()),
            }
        }
    }

    #[test]
    fn unproven_action_is_not_dispatched() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &unproven_catalog(),
            &adapter,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert!(!result.routed);
        assert!(result.blocker.is_some());
        assert!(result.dispatch_ref.is_none());
        assert_eq!(
            adapter.count(),
            0,
            "a non-routed action must NOT reach the adapter"
        );
    }

    #[test]
    fn wrong_provider_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            req(
                "claude",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "provider_mismatch");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn wrong_session_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            req(
                "codex",
                "friday-other",
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "session_mismatch");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn unknown_action_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "teleport",
                "provider.codex.teleport",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "unknown");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn missing_capability_row_is_refused_before_dispatch() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &ProviderWorkspaceCatalog::new(), // empty
            &adapter,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!result.accepted);
        assert_eq!(result.status, "missing_capability");
        assert_eq!(adapter.count(), 0);
    }

    #[test]
    fn verified_action_is_dispatched_with_dispatch_ref_and_preserved_truth_label() {
        let adapter = FakeAdapter::ok();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatched_queued");
        assert!(result.blocker.is_none());
        let dr = result
            .dispatch_ref
            .expect("dispatch_ref present on dispatched action");
        assert_eq!(
            dr,
            "friday://provider-dispatch/codex/friday-codex/list_sessions"
        );
        // The truth label is the CAPABILITY's, not upgraded by the dispatch.
        assert_eq!(result.truth_label, VERIFIED_TRUTH);
        assert_eq!(adapter.count(), 1);
    }

    #[test]
    fn adapter_failure_is_an_exact_blocker_not_a_completion() {
        let adapter = FakeAdapter::failing();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        // Guard accepted it, but dispatch failed — never a completion.
        assert!(result.accepted);
        assert!(result.routed);
        assert_eq!(result.status, "dispatch_failed");
        assert!(result.dispatch_ref.is_none());
        // The wire blocker is the FIXED operator-safe string; the adapter's free-text
        // detail ("adapter offline") is NOT surfaced on the wire.
        assert_eq!(result.blocker.as_deref(), Some("provider dispatch failed"));
        assert_eq!(adapter.count(), 1);
    }

    #[test]
    fn dispatch_failure_redacts_adapter_supplied_secret_material() {
        // Non-vacuous secret-leak proof: the adapter returns a secret-shaped error
        // string; the seam must NOT surface any of it on the wire blocker.
        let adapter = FakeAdapter::failing_leaky();
        let s = session(PlatformProvider::Codex);
        let result = dispatch_provider_action(
            &verified_catalog(),
            &adapter,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        let blocker = result.blocker.expect("failure carries a blocker");
        assert_eq!(blocker, "provider dispatch failed");
        for leak in ["sk-", "token", "account", "acct_", "shouldNeverHappen"] {
            assert!(
                !blocker.contains(leak),
                "adapter error text {leak:?} leaked into the wire blocker: {blocker:?}"
            );
        }
    }

    #[test]
    fn dispatch_status_running_and_completed_map_to_distinct_strings() {
        let s = session(PlatformProvider::Codex);
        for (status, expected) in [
            (DispatchStatus::Running, "dispatched_running"),
            (DispatchStatus::Completed, "dispatched_completed"),
        ] {
            let adapter = FakeAdapter::ok_status(status);
            let result = dispatch_provider_action(
                &verified_catalog(),
                &adapter,
                &s,
                req(
                    "codex",
                    &s.friday_session_id,
                    "list_sessions",
                    "provider.codex.list_sessions",
                ),
            );
            assert!(result.accepted);
            assert_eq!(result.status, expected);
            assert!(result.dispatch_ref.is_some());
            assert_eq!(adapter.count(), 1);
        }
    }

    #[test]
    fn unknown_provider_and_capability_mismatch_are_refused_before_dispatch() {
        let s = session(PlatformProvider::Codex);
        // Unknown provider string.
        let a1 = FakeAdapter::ok();
        let r1 = dispatch_provider_action(
            &verified_catalog(),
            &a1,
            &s,
            req(
                "frobnicator",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.list_sessions",
            ),
        );
        assert!(!r1.accepted);
        assert_eq!(r1.status, "unknown");
        assert_eq!(a1.count(), 0);
        // Correct provider/action but a forged capability id.
        let a2 = FakeAdapter::ok();
        let r2 = dispatch_provider_action(
            &verified_catalog(),
            &a2,
            &s,
            req(
                "codex",
                &s.friday_session_id,
                "list_sessions",
                "provider.codex.WRONG_ID",
            ),
        );
        assert!(!r2.accepted);
        assert_eq!(r2.status, "capability_mismatch");
        assert_eq!(a2.count(), 0);
    }
}
