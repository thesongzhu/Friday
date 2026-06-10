//! R4 — the Rust-owned SYSTEM-INTENT execution DOMAIN layer (DARK).
//!
//! The Rust home for the TS `friday-system-service.executeIntent`
//! (`src/system/engine/friday-system-service.ts`), whose live runtime is already
//! fenced fail-closed: the TS `executeIntent` throws
//! `TS_RUNTIME_SYSTEM_INTENT_RETIRED` (HTTP 503, classification `fail_closed`)
//! for every non-test caller, declaring its replacement to be
//! `rust_owned_system_intent_execution_entrypoint_required`. This module IS that
//! entrypoint's domain layer; it orchestrates [`friday_storage::system_intent`]
//! (the m0026 substrate) and [`friday_core::gate`] (the canonical mutating-action
//! gate) into a faithful, fail-closed intent dispatch.
//!
//! ## Mirrored TS semantics (READ from the source, not invented)
//! * The 23 [`friday_storage::system_intent::IntentAction`] vocabulary
//!   (`FRIDAY_SYSTEM_INTENT_ACTIONS`).
//! * The MUTATING set (TS `MUTATING_INTENTS`) — a mutating intent auto-acquires a
//!   control lease for its actor and is gated by the canonical gate.
//! * The HIGH-RISK set (TS `HIGH_RISK_INTENTS` = close_app / clipboard_read /
//!   notification_act) and `resolveRiskLevel` (close_app/notification_act/
//!   clipboard_read = high; clipboard_write/launch_app = medium; else low).
//! * The control-lease lifecycle (`request_control` / `release_control` +
//!   `ensureControlLease` auto-acquire), with owner-exclusivity (the TS
//!   `SYSTEM_CONTROL_BUSY` / 409) and TTL expiry-revoke.
//! * Emission of intent REQUEST + RESULT records (refs-only) per dispatch.
//!
//! ## Fail-closed posture (the security core)
//! * Mutating control intents are APPROVAL-GATED through [`friday_core::gate::evaluate`],
//!   which by construction has NO Allow-for-a-mutating-action path — a mutating /
//!   `risk >= High` action resolves only to `RequiresApproval` or `Deny`. So a
//!   mutating intent here ALWAYS resolves to a `blocked` result (the verified
//!   approval→Allow upgrade is a DEFERRED seam — see below) — it is NEVER executed
//!   without a canonical approval, and the gate's decision is persisted as an
//!   approval-record (the durable evidence the action fail-closed).
//! * `approve` / `deny` by an `Agent` or `Channel` actor is a HARD `Deny` (the
//!   gate's reserved-approval-action rule) — an untrusted actor can NEVER
//!   self-approve. This is the "never self-approve" invariant.
//! * The flag is fail-closed: dispatch is refused unless the entrypoint was built
//!   with the explicit opt-in, mirroring the TS `allowTestOnlySystemIntentExecution`
//!   exactly-`true` opt-in.
//!
//! ## DARK + no route flip (the boundary)
//! This registers NO production route, NO runtime caller, NO companion/desktop
//! wiring. It exposes a pub [`SystemIntentEntrypoint`] with no caller (mirrors
//! `workflow_catalog`). The live TS system-intent path stays fail-closed; this is
//! ADDITIVE substrate, not a product cutover. NOT v1 GO.
//!
//! ## DEFERRED / UNIMPLEMENTED seams (explicitly NOT faked green)
//! * **The actual OS effect** of every "do something to the desktop" action
//!   (launch_app/open_url/close_app/focus/clipboard*/notification*/handoff*/
//!   arrange_windows/snapshot) — i.e. the TS `executeIntentInternal` switch
//!   bodies that call `execCommand` / `companionBridge` / `desktopSessionManager`.
//!   Here those route to the [`SystemActionExecutor`] trait, whose only provided
//!   impl is [`UnavailableExecutor`] (the precedent is the TS
//!   `createFridaySystemUnavailableCompanionBridge`). A deferred action records a
//!   `unavailable` result with the coarse marker
//!   [`UNIMPLEMENTED_EXECUTION_MARKER`] — it NEVER records `completed` for an
//!   effect it did not perform.
//! * **The verified canonical approval → Allow → EXECUTE happy path** for a
//!   mutating intent. `friday_core::gate::evaluate` cannot grant a mutating action;
//!   the upgrade lives in `friday-storage::authorize_mutating_action` (PR-3b). This
//!   module wires only the fail-closed BLOCK path (which is what "fail-closed"
//!   requires); composing the verified-approval execute path is a documented
//!   follow-on seam (an Allow would, today, hit the unavailable executor anyway).

use friday_core::gate::{self, Actor, ActorKind, GateDecision, MutatingActionRequest};
use friday_core::Risk;
use friday_storage::system_intent::{
    acquire_control_lease, insert_approval_record, insert_intent_request, insert_intent_result,
    normalize_active_lease, revoke_active_lease, ApprovalRecord, DecisionLabel, IntentAction,
    IntentRequest, IntentResultRecord, IntentStatus, LeaseAcquireError, LeaseAcquireOutcome,
    NewControlLease, OwnerKind, RiskLabel,
};
use rusqlite::Connection;

/// The coarse marker a DEFERRED (unimplemented) OS-action execution records as its
/// result `message`. It is NEVER `completed` — a deferred action is honestly
/// `unavailable`. Adversarial review can grep for this to confirm no faked success.
pub const UNIMPLEMENTED_EXECUTION_MARKER: &str = "rust_system_action_execution_unimplemented";

/// The TS retirement guard's declared replacement id. The Rust entrypoint IS this
/// replacement; exported so the boundary is greppable across the two trees.
pub const RUST_ENTRYPOINT_REPLACEMENT_ID: &str =
    "rust_owned_system_intent_execution_entrypoint_required";

/// The default control-lease TTL (10 min), mirroring the TS `DEFAULT_LEASE_TTL_MS`.
pub const DEFAULT_LEASE_TTL_MS: i64 = 10 * 60 * 1000;

/// Fail-closed errors of the system-intent domain layer. Distinct from a
/// non-throwing intent RESULT (`blocked`/`unavailable`/`failed`): these are the
/// `throw`-class outcomes (the TS `FridayDomainError` cases that propagate rather
/// than becoming a result row), plus the retirement fail-closed guard.
#[derive(Debug, thiserror::Error)]
pub enum SystemIntentError {
    /// The entrypoint was built WITHOUT the explicit opt-in flag — dispatch is
    /// fail-closed (mirrors the TS `TS_RUNTIME_SYSTEM_INTENT_RETIRED` 503).
    #[error("system intent execution is fail-closed (flag not enabled); replacement = {RUST_ENTRYPOINT_REPLACEMENT_ID}")]
    FailClosed,
    /// Caller input failed a fail-closed validation (e.g. an empty required field)
    /// — never persisted, never executed.
    #[error("system intent input invalid: {0}")]
    Invalid(String),
    /// A storage-layer failure (surfaced fail-closed, never swallowed).
    #[error("storage error: {0}")]
    Storage(#[from] friday_storage::StorageError),
}

type Result<T> = std::result::Result<T, SystemIntentError>;

/// A system-intent dispatch INPUT (the subset of the TS `FridaySystemIntentInput`
/// this dark domain layer mirrors — refs-only, no raw bodies). The hub binds the
/// `intent_id` and `now_ms`; the caller supplies the action + actor + a coarse
/// target ref.
#[derive(Clone, Debug)]
pub struct IntentInput {
    pub intent_id: String,
    pub action: IntentAction,
    pub actor_id: String,
    pub actor_kind: OwnerKind,
    /// A coarse REF/id of the target (app bundle id, project-path ref, notification
    /// id, etc.) — NEVER a raw url/clipboard/notification body.
    pub target_ref: Option<String>,
    /// Optional explicit lease reason; defaults to `auto:<action>` / the explicit
    /// control reason, mirroring the TS.
    pub reason: Option<String>,
    /// Optional lease TTL override (ms); defaults to [`DEFAULT_LEASE_TTL_MS`].
    pub lease_ttl_ms: Option<i64>,
}

/// The (refs-only) outcome of a dispatch — the persisted [`IntentResultRecord`]
/// plus, for diagnostics, whether the OS effect was actually performed or DEFERRED
/// to the unimplemented seam.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DispatchOutcome {
    pub result: IntentResultRecord,
    /// `true` when the result reflects a DEFERRED (unimplemented) OS action — i.e.
    /// the executor is the [`UnavailableExecutor`] seam, not a real effect.
    pub execution_deferred: bool,
}

/// The boundary to the actual OS effect of a desktop-affecting action. The TS
/// equivalent is the `companionBridge` / `desktopSessionManager` / `execCommand`
/// surface. The ONLY provided impl is [`UnavailableExecutor`] (precedent: the TS
/// `createFridaySystemUnavailableCompanionBridge`); a real impl (companion/Swift
/// app / AppleScript) is out of scope for this dark slice.
pub trait SystemActionExecutor {
    /// Attempt to perform `action`'s OS effect on `target_ref`. Returns the coarse
    /// outcome the result row records. A real executor returns `Completed`; the
    /// unavailable seam returns `Unavailable` with the unimplemented marker. An
    /// executor MUST NOT return `Completed` for an effect it did not perform.
    fn execute(&self, action: IntentAction, target_ref: Option<&str>) -> ExecOutcome;
}

/// What a [`SystemActionExecutor`] reports back (a coarse, refs-only outcome).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecOutcome {
    pub status: IntentStatus,
    pub message: String,
}

/// The DEFAULT executor: every desktop-affecting action is reported `unavailable`
/// with the unimplemented marker. This is the honest dark-slice seam — it never
/// fakes a `completed` effect. Mirrors the TS unavailable companion bridge used in
/// the retirement-guard test.
#[derive(Clone, Copy, Debug, Default)]
pub struct UnavailableExecutor;

impl SystemActionExecutor for UnavailableExecutor {
    fn execute(&self, _action: IntentAction, _target_ref: Option<&str>) -> ExecOutcome {
        ExecOutcome {
            status: IntentStatus::Unavailable,
            message: UNIMPLEMENTED_EXECUTION_MARKER.to_string(),
        }
    }
}

/// The DARK system-intent entrypoint. Built with `enabled = false` by default
/// (fail-closed); only [`SystemIntentEntrypoint::with_execution_enabled`] opts in,
/// mirroring the TS exactly-`true` `allowTestOnlySystemIntentExecution` flag. The
/// `id_seq` makes the per-dispatch ids it mints (intent_id / lease_id / record_id)
/// deterministic for tests without a clock/uuid dep.
pub struct SystemIntentEntrypoint<E: SystemActionExecutor> {
    enabled: bool,
    executor: E,
}

impl SystemIntentEntrypoint<UnavailableExecutor> {
    /// A fail-closed entrypoint (dispatch refused) with the unavailable executor.
    /// This is the production-faithful default: nothing executes.
    pub fn fail_closed() -> Self {
        SystemIntentEntrypoint {
            enabled: false,
            executor: UnavailableExecutor,
        }
    }
}

impl<E: SystemActionExecutor> SystemIntentEntrypoint<E> {
    /// Build an entrypoint with execution opted IN (the test-oracle / future
    /// flagged path) and a given executor. NEVER call this on a production path
    /// with a real executor until the cutover gate is taken.
    pub fn with_execution_enabled(executor: E) -> Self {
        SystemIntentEntrypoint {
            enabled: true,
            executor,
        }
    }

    /// True if the OS effect would actually be attempted (flag on). Diagnostics.
    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// Dispatch a system intent, fail-closed.
    ///
    /// 1. If the flag is not enabled → [`SystemIntentError::FailClosed`] BEFORE any
    ///    persistence/lease/gate side effect (mirrors the TS method guard).
    /// 2. Validate the input (fail-closed).
    /// 3. Persist the immutable REQUEST record.
    /// 4. For `approve`/`deny`/mutating actions: run the canonical gate
    ///    ([`friday_core::gate::evaluate`]); persist the gate decision as an
    ///    approval-record; a non-`Allow` decision becomes a `blocked` result and
    ///    NOTHING is executed (the gate cannot Allow a mutating action — the
    ///    verified-approval execute path is a deferred seam).
    /// 5. For lease intents (`request_control`/`release_control`): drive the lease
    ///    lifecycle (owner-exclusive acquire / release).
    /// 6. For a non-mutating, gate-clear action: auto-acquire the lease if mutating
    ///    (it is not, here) and run the OS effect through the executor (the
    ///    unavailable seam by default → `unavailable`, never faked `completed`).
    pub fn dispatch(
        &self,
        conn: &Connection,
        input: &IntentInput,
        now_ms: i64,
    ) -> Result<DispatchOutcome> {
        // (1) Flag fail-closed — BEFORE any side effect, mirroring the TS guard.
        if !self.enabled {
            return Err(SystemIntentError::FailClosed);
        }

        // (2) Validate (fail-closed). Actions that name a target require one.
        self.validate(input)?;

        let mutating = is_mutating(input.action);
        let risk = resolve_risk(input.action);

        // (3) Persist the immutable REQUEST record.
        let request = IntentRequest {
            intent_id: input.intent_id.clone(),
            action: input.action,
            actor_id: input.actor_id.clone(),
            actor_kind: input.actor_kind,
            target_ref: input.target_ref.clone(),
            mutating,
            risk: risk_label(risk),
            created_at: now_ms,
        };
        insert_intent_request(conn, &request)?;

        // (4) approve/deny + every mutating action go through the canonical gate.
        //     The gate runs FIRST for approve/deny so an Agent/Channel/remote
        //     reserved action hard-Denies before any lease mutation or execution.
        //     Because `friday_core::gate::evaluate` has NO Allow-for-a-mutating-action
        //     path, EVERY mutating intent (incl. recover_ui) resolves to a `blocked`
        //     result here and returns — it never reaches the lease/execute body
        //     below. The gate can only CLEAR (return None) for a NON-mutating
        //     approve/deny by an Owner/Api actor (the reserved-action rule does not
        //     bind them and the action is not classified mutating); such an
        //     approve/deny then proceeds to the dispatch body. The verified
        //     approval→Allow→execute upgrade for a mutating intent is a DEFERRED seam
        //     (see the module-level note); recover_ui's TS lease-revoke side effect is
        //     part of that deferred execute path, not performed on the block path.
        if matches!(input.action, IntentAction::Approve | IntentAction::Deny) || mutating {
            if let Some(outcome) = self.gate_and_maybe_block(conn, input, mutating, risk, now_ms)? {
                return Ok(outcome);
            }
        }

        // (5) Lease lifecycle intents (NOT in the TS MUTATING_INTENTS set, so they are
        //     not gate-blocked — they are owner-exclusivity-gated by the lease itself).
        match input.action {
            IntentAction::RequestControl => {
                return self.handle_request_control(conn, input, now_ms);
            }
            IntentAction::ReleaseControl => {
                return self.handle_release_control(conn, input, now_ms);
            }
            _ => {}
        }

        // (6) Auto-acquire the control lease for a mutating action. (Unreachable for
        //     a mutating action today — they all blocked at the gate in step (4) —
        //     but kept faithful to the TS `ensureControlLease` ordering so a future
        //     verified-approval execute path slots in here unchanged.)
        let lease_id = if mutating {
            match self.ensure_lease(conn, input, now_ms) {
                Ok(id) => id,
                Err(LeaseAcquireError::Busy {
                    owner_kind,
                    owner_id,
                }) => {
                    return self.persist_blocked(
                        conn,
                        input,
                        format!(
                            "control lease is currently held by {}:{}",
                            owner_kind.as_str(),
                            owner_id
                        ),
                        Some("system_control_busy".to_string()),
                        now_ms,
                    );
                }
                Err(LeaseAcquireError::Storage(e)) => return Err(SystemIntentError::Storage(e)),
            }
        } else {
            // A read-only/non-mutating action still observes the active lease.
            normalize_active_lease(conn, now_ms)?.map(|l| l.lease_id)
        };

        // Run the OS effect through the executor (the unavailable seam by default).
        let exec = self
            .executor
            .execute(input.action, input.target_ref.as_deref());
        let execution_deferred = exec.status == IntentStatus::Unavailable
            && exec.message == UNIMPLEMENTED_EXECUTION_MARKER;
        let result = IntentResultRecord {
            intent_id: input.intent_id.clone(),
            action: input.action,
            status: exec.status,
            message: exec.message,
            control_lease_id: lease_id,
            gate_reason: None,
            created_at: now_ms,
        };
        insert_intent_result(conn, &result)?;
        Ok(DispatchOutcome {
            result,
            execution_deferred,
        })
    }

    // ─── internals ────────────────────────────────────────────────────────────

    fn validate(&self, input: &IntentInput) -> Result<()> {
        if input.intent_id.trim().is_empty() {
            return Err(SystemIntentError::Invalid("intent_id is required".into()));
        }
        if input.actor_id.trim().is_empty() {
            return Err(SystemIntentError::Invalid("actor_id is required".into()));
        }
        // Actions that operate on a named target require a (coarse) target ref. This
        // mirrors the TS `requireNonEmpty(...)` for the corresponding fields.
        let needs_target = matches!(
            input.action,
            IntentAction::LaunchApp
                | IntentAction::CloseApp
                | IntentAction::OpenUrl
                | IntentAction::OpenProject
                | IntentAction::SearchFile
                | IntentAction::ReadNotification
                | IntentAction::NotificationAct
                | IntentAction::ClipboardWrite
                | IntentAction::ResumeTask
                | IntentAction::Approve
                | IntentAction::Deny
        );
        if needs_target
            && input
                .target_ref
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
        {
            return Err(SystemIntentError::Invalid(format!(
                "{} requires a target_ref",
                input.action.as_str()
            )));
        }
        Ok(())
    }

    /// Build the gate request, evaluate it, persist the decision as an
    /// approval-record, and (for any non-`Allow` decision) persist a `blocked`
    /// result and return it — NOTHING is executed. Returns `Ok(None)` only when the
    /// gate cleared (`Allow`), which for a mutating action is impossible by the
    /// gate's construction, so the caller may proceed only for a non-mutating
    /// approve/deny by an unbound actor.
    fn gate_and_maybe_block(
        &self,
        conn: &Connection,
        input: &IntentInput,
        mutating: bool,
        risk: Risk,
        now_ms: i64,
    ) -> Result<Option<DispatchOutcome>> {
        let request = build_gate_request(input, mutating, risk);
        let evidence = gate::evaluate(&request);

        // Persist the gate decision as durable approval-record evidence (refs-only).
        insert_approval_record(
            conn,
            &ApprovalRecord {
                record_id: format!("{}::gate", input.intent_id),
                intent_id: input.intent_id.clone(),
                action: input.action,
                decision: decision_label(evidence.decision),
                reason: evidence.reason.clone(),
                risk: risk_label(evidence.risk),
                approval_required: evidence.approval_required,
                created_at: now_ms,
            },
        )?;

        match evidence.decision {
            GateDecision::Allow => Ok(None),
            GateDecision::Deny | GateDecision::RequiresApproval => {
                let message = match evidence.decision {
                    GateDecision::Deny => format!(
                        "Canonical gate denied {}: {}",
                        input.action.as_str(),
                        evidence.reason
                    ),
                    _ => format!("Canonical approval required for {}", input.action.as_str()),
                };
                Ok(Some(self.persist_blocked(
                    conn,
                    input,
                    message,
                    Some(evidence.reason),
                    now_ms,
                )?))
            }
        }
    }

    fn handle_request_control(
        &self,
        conn: &Connection,
        input: &IntentInput,
        now_ms: i64,
    ) -> Result<DispatchOutcome> {
        match self.ensure_lease(conn, input, now_ms) {
            Ok(lease_id) => self.persist_result(
                conn,
                input,
                IntentStatus::Completed,
                "Control lease acquired".to_string(),
                lease_id,
                None,
                now_ms,
            ),
            Err(LeaseAcquireError::Busy {
                owner_kind,
                owner_id,
            }) => self.persist_blocked(
                conn,
                input,
                format!(
                    "control lease is currently held by {}:{}",
                    owner_kind.as_str(),
                    owner_id
                ),
                Some("system_control_busy".to_string()),
                now_ms,
            ),
            Err(LeaseAcquireError::Storage(e)) => Err(SystemIntentError::Storage(e)),
        }
    }

    fn handle_release_control(
        &self,
        conn: &Connection,
        input: &IntentInput,
        now_ms: i64,
    ) -> Result<DispatchOutcome> {
        let revoked = revoke_active_lease(
            conn,
            now_ms,
            input.reason.as_deref().unwrap_or("released_by_request"),
        )?;
        let (message, lease_id) = match revoked {
            Some(lease) => ("Control lease released".to_string(), Some(lease.lease_id)),
            None => ("No active control lease".to_string(), None),
        };
        self.persist_result(
            conn,
            input,
            IntentStatus::Completed,
            message,
            lease_id,
            None,
            now_ms,
        )
    }

    fn ensure_lease(
        &self,
        conn: &Connection,
        input: &IntentInput,
        now_ms: i64,
    ) -> std::result::Result<Option<String>, LeaseAcquireError> {
        let new_lease = NewControlLease {
            lease_id: format!("{}::lease", input.intent_id),
            owner_id: input.actor_id.clone(),
            owner_kind: input.actor_kind,
            reason: Some(
                input
                    .reason
                    .clone()
                    .unwrap_or_else(|| format!("auto:{}", input.action.as_str())),
            ),
            ttl_ms: Some(input.lease_ttl_ms.unwrap_or(DEFAULT_LEASE_TTL_MS)),
        };
        match acquire_control_lease(conn, &new_lease, now_ms)? {
            LeaseAcquireOutcome::Acquired(l) | LeaseAcquireOutcome::Reused(l) => {
                Ok(Some(l.lease_id))
            }
        }
    }

    fn persist_blocked(
        &self,
        conn: &Connection,
        input: &IntentInput,
        message: String,
        gate_reason: Option<String>,
        now_ms: i64,
    ) -> Result<DispatchOutcome> {
        self.persist_result(
            conn,
            input,
            IntentStatus::Blocked,
            message,
            None,
            gate_reason,
            now_ms,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_result(
        &self,
        conn: &Connection,
        input: &IntentInput,
        status: IntentStatus,
        message: String,
        control_lease_id: Option<String>,
        gate_reason: Option<String>,
        now_ms: i64,
    ) -> Result<DispatchOutcome> {
        let result = IntentResultRecord {
            intent_id: input.intent_id.clone(),
            action: input.action,
            status,
            message,
            control_lease_id,
            gate_reason,
            created_at: now_ms,
        };
        insert_intent_result(conn, &result)?;
        Ok(DispatchOutcome {
            result,
            execution_deferred: false,
        })
    }
}

// ─── TS-mirrored classification (port of the TS const sets + resolveRiskLevel) ─

/// The TS `MUTATING_INTENTS` set — actions that mutate state, auto-acquire a lease,
/// and go through the canonical gate.
fn is_mutating(action: IntentAction) -> bool {
    matches!(
        action,
        IntentAction::Open
            | IntentAction::Focus
            | IntentAction::ArrangeWindows
            | IntentAction::LaunchApp
            | IntentAction::CloseApp
            | IntentAction::OpenUrl
            | IntentAction::OpenProject
            | IntentAction::HandoffToBrowser
            | IntentAction::HandoffToTerminal
            | IntentAction::NotificationAct
            | IntentAction::ResumeTask
            | IntentAction::RecoverUi
            | IntentAction::ClipboardRead
            | IntentAction::ClipboardWrite
            | IntentAction::Approve
            | IntentAction::Deny
    )
}

/// The TS `resolveRiskLevel`: close_app/notification_act/clipboard_read = high;
/// clipboard_write/launch_app = medium; everything else = low.
fn resolve_risk(action: IntentAction) -> Risk {
    match action {
        IntentAction::CloseApp | IntentAction::NotificationAct | IntentAction::ClipboardRead => {
            Risk::High
        }
        IntentAction::ClipboardWrite | IntentAction::LaunchApp => Risk::Medium,
        _ => Risk::Low,
    }
}

fn risk_label(risk: Risk) -> RiskLabel {
    match risk {
        Risk::ReadOnly => RiskLabel::ReadOnly,
        Risk::Low => RiskLabel::Low,
        Risk::Medium => RiskLabel::Medium,
        Risk::High => RiskLabel::High,
        Risk::Critical => RiskLabel::Critical,
    }
}

fn decision_label(decision: GateDecision) -> DecisionLabel {
    match decision {
        GateDecision::Allow => DecisionLabel::Allow,
        GateDecision::Deny => DecisionLabel::Deny,
        GateDecision::RequiresApproval => DecisionLabel::RequiresApproval,
    }
}

fn gate_actor_kind(kind: OwnerKind) -> ActorKind {
    match kind {
        // The untrusted-origin agent maps to the gate's bound `Agent` (reserved-action
        // hard-deny applies). `remote` is an external/untrusted origin → treat as
        // `Agent` so a remote actor can NEVER self-approve either (fail-safe: this only
        // ever ADDS the reserved-action deny, never removes it).
        OwnerKind::Agent | OwnerKind::Remote => ActorKind::Agent,
        OwnerKind::Api => ActorKind::Api,
        OwnerKind::System => ActorKind::Api,
        OwnerKind::Owner => ActorKind::Owner,
    }
}

/// Build the canonical-gate request for an intent. `approve`/`deny` carry the TS
/// reserved-action verb so an Agent/Channel/remote actor hard-denies; mutating
/// actions are classified `mutating = true` (so the gate requires approval). The
/// action string passed to the gate is the intent action verb (so `approve`/`deny`
/// hit the reserved-action set).
fn build_gate_request(input: &IntentInput, mutating: bool, risk: Risk) -> MutatingActionRequest {
    let actor = Actor {
        kind: gate_actor_kind(input.actor_kind),
        id: input.actor_id.clone(),
        principal_id: Some(input.actor_id.clone()),
    };
    // The classification is sealed (built via `classify`), so the gate-decision trio
    // can only come from here — no struct-literal can assert `mutating: false` for a
    // mutating action. We pass no params (the target is a coarse ref, not a path the
    // classifier escalates on); the base risk carries the TS-resolved risk.
    let classification = gate::classify(mutating, risk, input.action.as_str(), &[]);
    MutatingActionRequest::from_classification(
        classification,
        input.action.as_str().to_string(),
        actor,
        "system".to_string(),
        Vec::new(),
        None,
        None,
        None,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_storage::system_intent::{get_intent_result, list_approval_records};
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-hub-system-intent-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn input(intent_id: &str, action: IntentAction, actor: &str, kind: OwnerKind) -> IntentInput {
        IntentInput {
            intent_id: intent_id.to_string(),
            action,
            actor_id: actor.to_string(),
            actor_kind: kind,
            target_ref: None,
            reason: None,
            lease_ttl_ms: None,
        }
    }

    #[test]
    fn fail_closed_by_default_refuses_dispatch_with_no_side_effect() {
        let db = Db::open_hub(&tmp("failclosed")).unwrap();
        let ep = SystemIntentEntrypoint::fail_closed();
        let mut inp = input("i1", IntentAction::LaunchApp, "agent-1", OwnerKind::Agent);
        inp.target_ref = Some("Safari".to_string());
        let err = ep.dispatch(db.conn(), &inp, 100);
        assert!(matches!(err, Err(SystemIntentError::FailClosed)));
        // No request row, no result, no lease, no approval-record was written.
        assert_eq!(db.count("system_intent_request").unwrap(), 0);
        assert_eq!(db.count("system_intent_result").unwrap(), 0);
        assert_eq!(db.count("system_control_lease").unwrap(), 0);
        assert_eq!(db.count("system_intent_approval_record").unwrap(), 0);
    }

    #[test]
    fn agent_cannot_self_approve_reserved_action_hard_deny() {
        // The "never self-approve" invariant: an Agent actor doing approve/deny is a
        // HARD gate deny, becomes a `blocked` result, and NOTHING is executed.
        let db = Db::open_hub(&tmp("self-approve")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);
        for action in [IntentAction::Approve, IntentAction::Deny] {
            let id = format!("i-{}", action.as_str());
            let mut inp = input(&id, action, "agent-1", OwnerKind::Agent);
            inp.target_ref = Some("close_app".to_string());
            let outcome = ep.dispatch(db.conn(), &inp, 100).unwrap();
            assert_eq!(
                outcome.result.status,
                IntentStatus::Blocked,
                "{action:?} must block"
            );
            assert!(!outcome.execution_deferred);
            // The persisted approval-record proves the gate hard-denied with the
            // reserved-action reason (the bound-principal rule).
            let trail = list_approval_records(db.conn(), &id).unwrap();
            assert_eq!(trail.len(), 1);
            assert_eq!(trail[0].decision, DecisionLabel::Deny);
            assert_eq!(
                trail[0].reason,
                "agent_cannot_execute_reserved_approval_action"
            );
            // No success event / completed result.
            assert_eq!(
                get_intent_result(db.conn(), &id).unwrap().unwrap().status,
                IntentStatus::Blocked
            );
        }
    }

    #[test]
    fn remote_actor_also_cannot_self_approve() {
        // A `remote` actor maps to the gate's bound Agent → reserved-action hard-deny.
        let db = Db::open_hub(&tmp("remote-approve")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);
        let mut inp = input("i-r", IntentAction::Approve, "remote-7", OwnerKind::Remote);
        inp.target_ref = Some("close_app".to_string());
        let outcome = ep.dispatch(db.conn(), &inp, 100).unwrap();
        assert_eq!(outcome.result.status, IntentStatus::Blocked);
    }

    #[test]
    fn mutating_action_is_gate_blocked_never_executed() {
        // A mutating action (launch_app) goes through the gate, which CANNOT allow a
        // mutating action -> RequiresApproval -> blocked. The executor is NEVER reached,
        // so no `unavailable`/`completed` execution result is produced.
        let db = Db::open_hub(&tmp("mutating-block")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);
        let mut inp = input("i-launch", IntentAction::LaunchApp, "api-1", OwnerKind::Api);
        inp.target_ref = Some("com.apple.Safari".to_string());
        let outcome = ep.dispatch(db.conn(), &inp, 100).unwrap();
        assert_eq!(outcome.result.status, IntentStatus::Blocked);
        assert!(
            !outcome.execution_deferred,
            "the executor must not be reached"
        );
        let trail = list_approval_records(db.conn(), "i-launch").unwrap();
        assert_eq!(trail.len(), 1);
        assert_eq!(trail[0].decision, DecisionLabel::RequiresApproval);
        assert!(trail[0].approval_required);
        assert_eq!(trail[0].risk, RiskLabel::Medium);
        // No lease was minted (the gate blocked before the auto-acquire).
        assert_eq!(db.count("system_control_lease").unwrap(), 0);
    }

    #[test]
    fn snapshot_is_non_mutating_and_routes_to_unavailable_executor_not_faked_complete() {
        // `snapshot` is NOT mutating -> no gate block. Its OS effect is deferred, so the
        // result is honestly `unavailable` with the unimplemented marker — NEVER `completed`.
        let db = Db::open_hub(&tmp("snapshot")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);
        let inp = input("i-snap", IntentAction::Snapshot, "api-1", OwnerKind::Api);
        let outcome = ep.dispatch(db.conn(), &inp, 100).unwrap();
        assert_eq!(outcome.result.status, IntentStatus::Unavailable);
        assert_eq!(outcome.result.message, UNIMPLEMENTED_EXECUTION_MARKER);
        assert!(outcome.execution_deferred);
        assert_ne!(outcome.result.status, IntentStatus::Completed);
    }

    #[test]
    fn request_then_release_control_lifecycle() {
        // request_control / release_control are NOT mutating (not in MUTATING_INTENTS),
        // so they are lease-lifecycle ops, not gate-blocked. request_control acquires;
        // a foreign owner is refused Busy; release_control revokes.
        let db = Db::open_hub(&tmp("lease-lifecycle")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);

        // Agent acquires.
        let acq = ep
            .dispatch(
                db.conn(),
                &input(
                    "i-req",
                    IntentAction::RequestControl,
                    "agent-1",
                    OwnerKind::Agent,
                ),
                100,
            )
            .unwrap();
        assert_eq!(acq.result.status, IntentStatus::Completed);
        assert_eq!(acq.result.message, "Control lease acquired");
        assert!(acq.result.control_lease_id.is_some());

        // A DIFFERENT owner requesting control is refused Busy -> blocked.
        let busy = ep
            .dispatch(
                db.conn(),
                &input(
                    "i-req2",
                    IntentAction::RequestControl,
                    "api-9",
                    OwnerKind::Api,
                ),
                150,
            )
            .unwrap();
        assert_eq!(busy.result.status, IntentStatus::Blocked);
        assert_eq!(
            busy.result.gate_reason.as_deref(),
            Some("system_control_busy")
        );

        // The original owner releases.
        let rel = ep
            .dispatch(
                db.conn(),
                &input(
                    "i-rel",
                    IntentAction::ReleaseControl,
                    "agent-1",
                    OwnerKind::Agent,
                ),
                200,
            )
            .unwrap();
        assert_eq!(rel.result.status, IntentStatus::Completed);
        assert_eq!(rel.result.message, "Control lease released");

        // After release a fresh owner CAN now acquire.
        let acq2 = ep
            .dispatch(
                db.conn(),
                &input(
                    "i-req3",
                    IntentAction::RequestControl,
                    "api-9",
                    OwnerKind::Api,
                ),
                250,
            )
            .unwrap();
        assert_eq!(acq2.result.status, IntentStatus::Completed);
    }

    #[test]
    fn release_control_with_no_active_lease_is_completed_noop() {
        let db = Db::open_hub(&tmp("release-noop")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);
        let rel = ep
            .dispatch(
                db.conn(),
                &input(
                    "i-rel",
                    IntentAction::ReleaseControl,
                    "agent-1",
                    OwnerKind::Agent,
                ),
                100,
            )
            .unwrap();
        assert_eq!(rel.result.status, IntentStatus::Completed);
        assert_eq!(rel.result.message, "No active control lease");
    }

    #[test]
    fn validation_fails_closed_for_missing_target() {
        let db = Db::open_hub(&tmp("validate")).unwrap();
        let ep = SystemIntentEntrypoint::with_execution_enabled(UnavailableExecutor);
        // launch_app needs a target_ref.
        let inp = input("i-bad", IntentAction::LaunchApp, "api-1", OwnerKind::Api);
        assert!(matches!(
            ep.dispatch(db.conn(), &inp, 100),
            Err(SystemIntentError::Invalid(_))
        ));
        // ...and nothing was persisted (validation runs before the request insert).
        assert_eq!(db.count("system_intent_request").unwrap(), 0);
    }

    #[test]
    fn classification_mirrors_ts_high_risk_and_mutating_sets() {
        // resolveRiskLevel parity.
        assert_eq!(resolve_risk(IntentAction::CloseApp), Risk::High);
        assert_eq!(resolve_risk(IntentAction::ClipboardRead), Risk::High);
        assert_eq!(resolve_risk(IntentAction::NotificationAct), Risk::High);
        assert_eq!(resolve_risk(IntentAction::ClipboardWrite), Risk::Medium);
        assert_eq!(resolve_risk(IntentAction::LaunchApp), Risk::Medium);
        assert_eq!(resolve_risk(IntentAction::Snapshot), Risk::Low);
        // MUTATING_INTENTS parity (a representative subset; snapshot/search/list NOT mutating).
        assert!(is_mutating(IntentAction::LaunchApp));
        assert!(is_mutating(IntentAction::ClipboardRead));
        assert!(is_mutating(IntentAction::Approve));
        assert!(!is_mutating(IntentAction::Snapshot));
        assert!(!is_mutating(IntentAction::SearchFile));
        assert!(!is_mutating(IntentAction::NotificationList));
        assert!(!is_mutating(IntentAction::RequestControl));
        assert!(!is_mutating(IntentAction::ReleaseControl));
    }
}
