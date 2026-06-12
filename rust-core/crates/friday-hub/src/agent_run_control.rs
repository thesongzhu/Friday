//! A1 — the Rust agent-run RUN-CONTROL plane (DARK).
//!
//! The on-wire control protocol for the live agent-run: PAUSE-surfacing, RESUME
//! (operator-signed), CANCEL, and REJECT. This module is the pure, testable LOGIC behind the
//! `friday-protocol` v13 control variants (`AgentRunPaused` / `AgentRunResume` /
//! `AgentRunCancel` / `AgentRunReject` / `AgentRunControlResult`). The sealed-WS server bin
//! ([`crate::bin::hub_agent_run_server`]) does the per-connection session AUTH (decode the
//! `auth_proof`, [`crate::hub_server::AuthedPrincipal::authenticate_forwarded`]) and then calls
//! into THIS module with the already-authenticated principal — so the control ops are unit
//! testable against a `&Connection` without standing up a live session.
//!
//! ## What it builds (and what it deliberately does NOT)
//! * **PAUSE-surfacing** ([`detect_pause`]). When a mutating tool Pauses, the live loop already
//!   persists a `pending_approval_request` (CSPRNG nonce + the exact tool call + the digest)
//!   BEFORE returning — but the server only sees an [`crate::hub_server::AuthedAnswer::NoAnswer`]
//!   and today emits `AgentRunResult{status:"no_answer"}` (the "NoAnswer black hole"). This reads
//!   the persisted pending row back so the server can emit a truth-labeled `AgentRunPaused`
//!   instead. It is REFS-ONLY: nonce + digest + the action verb summary, never the tool body/args.
//! * **CANCEL** ([`cancel`]). Owner-authed terminal stop: write the out-of-vocab terminal
//!   `agent_run.state='cancelled'` (free-form TEXT — NO migration; see
//!   [`friday_storage::agent_run::cancel_run`]), idempotent, refusing to clobber a run that
//!   already produced a terminal `run_result`. It does NOT interrupt a synchronous in-flight loop
//!   mid-turn — that is cooperative cancellation in the loop body (lib.rs), a DEFERRED sub-AC.
//! * **REJECT** ([`reject`]). Owner-authed refusal of ONE pending tool-approval: mark
//!   `pending_approval_request.status='rejected'` (reuses the existing m0014 status column — NO
//!   migration).
//! * **RESUME** ([`resume`]). Delegates VERBATIM to the S6 [`crate::resume::resume_with_approval`]
//!   spine (decode the courier's `signed_blob` → `CanonicalApproval`, verify Ed25519 under the
//!   OPERATOR's key, consume the nonce single-use, execute the ONE approved mutation, record the
//!   owner). It does NOT re-implement verification/execution.
//!
//! ## The wire-run binding + reject/cancel ↔ resume coupling (REAL holes this module closes locally)
//! [`resume_with_approval`] takes NO `run_id`: it looks the pending row up by the blob's nonce and
//! executes whatever run that pending row names (`pending.run_id`). It also never reads
//! `pending_approval_request.status` or `agent_run.state` (the spine's single-use guarantee is the
//! gate's `consumed_approval` nonce store ALONE). So [`resume`] must enforce three things against
//! the WIRE `run_id` before delegating, all fail-closed:
//!   1. **Wire-run binding (security).** `pending.run_id == run_id`, else `run_mismatch`. The TS
//!      resume route owner-gates the run named by the wire `run_id`; without this the owner-gated
//!      run and the executed (nonce-selected) run could differ — an attacker owning run A could
//!      resume A on the wire while carrying a nonce belonging to victim run B, executing B's
//!      mutation past A's owner gate. Mirrors [`reject`]'s existing `run_mismatch` binding.
//!   2. **Cancel coupling.** Refuse if the run is cancelled (`state='cancelled'`) — else a
//!      correctly-signed resume would still execute a cancelled run's mutation.
//!   3. **Reject coupling.** Refuse if the pending row is rejected (`status='rejected'`).
//! Binding (1) also makes the cancel pre-check (2) CONSISTENT: every path that proceeds has
//! `run_id == pending.run_id`, so `is_cancelled(run_id)` keys on the SAME run the spine executes.
//! A more robust spine-level fix (burn the nonce in `consumed_approval` on reject/cancel) needs a
//! consumed-store insert API that does not exist yet, and the SAME pre-checks are also absent from
//! the existing `hub_resume_approval` dev bridge — both are surfaced as concerns.
//!
//! ## Auth model (HONEST)
//! RESUME is self-authenticating: the AUTHORITY is the operator's Ed25519 signature over the
//! nonce+digest (the Hub holds only a verify key — it can never mint it). CANCEL and REJECT carry
//! NO operator signature, so they are OWNER-authed: the server authenticates the forwarded
//! principal against the sealed session, and THIS module then requires that authenticated principal
//! to equal the run's bound owner (resolved from the pending row's `principal_id` for a paused run,
//! else the `run_result.owner_principal` for a finished one). A non-owner / ownerless-run control
//! op fails closed. **OPEN QUESTION (surfaced):** whether trusted-peer + owner-match is sufficient,
//! or whether cancel/reject should ALSO require an operator signature like resume.
//!
//! ## Truth label
//! `rust_wired` at best. DARK + DEPLOY-GO-gated: the server emits/handles these ONLY behind the
//! NEW default-off `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` flag; with the flag off the server emits
//! exactly the pre-A1 bytes (a Paused run ⇒ `AgentRunResult{status:"no_answer"}`), so deploying a
//! v13 binary changes NO live behavior. NOT `executeRun`-replaced; NOT v1 GO.

use friday_core::gate::{ApprovalDecision, CanonicalApproval, CANONICAL_GATE_ISSUER};
use friday_crypto::OperatorVerifyingKey;
use friday_storage::{
    agent_run::{self, CancelOutcome},
    audit, get_pending_request, get_run_result, set_pending_status, StorageError,
};
use rusqlite::Connection;

use friday_protocol::AgentRunConstraintsWire;

use crate::resume::{resume_with_approval, ResumeError};
use crate::{RunPolicy, ToolExecutor};

/// Map a run's bound owner + the wire-asserted per-run [`AgentRunConstraintsWire`] onto an
/// effective [`RunPolicy`] for THIS run — the policy the loop's gate consults (read-only /
/// disabled-tool set / max-turns). A constraint can only ever TIGHTEN a run (a restriction, never
/// a grant): `read_only` and the `disabled_tools` set are taken VERBATIM (both are restrictions),
/// and `max_turns` is the caller's concern of the runtime ceiling — applied by the caller as
/// `min(runtime_default, asserted)` (this fn returns the asserted cap; the caller floors it).
///
/// `constraints: None` ⇒ the UNCONSTRAINED policy for `owner_principal` (read-only off, no
/// per-run disabled tools) — i.e. the run uses the runtime's normal gate discipline. So an absent
/// constraints block maps to exactly the pre-A1 (no per-run-override) behavior.
///
/// **WIRED-SHAPE, application DEFERRED on the live dispatch.** This mapping is REAL and tested,
/// but APPLYING it requires the runtime to accept a per-run policy OVERRIDE on its dispatch entry
/// (today `HubRuntime::run_task` builds the gate request from its OWN constructed `self.policy`).
/// Threading a per-run policy through the live run-START path touches the just-fixed real-call
/// path, so it is a DEFERRED sub-AC (see the PR body / concerns) — this fn is the prerequisite
/// logic, not a half-wired live path.
pub fn effective_run_policy(
    owner_principal: Option<&str>,
    constraints: Option<&AgentRunConstraintsWire>,
) -> RunPolicy {
    let owner = owner_principal.map(|p| p.to_string());
    match constraints {
        None => RunPolicy::new(owner, Vec::<String>::new(), false),
        Some(c) => RunPolicy::new(owner, c.disabled_tools.clone(), c.read_only),
    }
}

/// (A1 — APPLICATION) Compose a per-run [`AgentRunConstraintsWire`] ONTO an existing boot
/// [`RunPolicy`], returning the effective per-run policy the loop's gate must consult. Unlike
/// [`effective_run_policy`] (which REBUILDS a policy from owner+constraints and is correct only
/// when the boot policy is unconstrained), this COMPOSES via [`RunPolicy::tightened_by`] so the
/// only-tighten invariant holds UNCONDITIONALLY — a boot-configured `read_only`/`disabled_tools`
/// can NEVER be loosened by a constraint that omits it (defense-in-depth against any future
/// non-unconstrained boot config). `constraints: None` ⇒ a CLONE of the boot policy unchanged
/// (the absent-constraint case = byte-identical pre-A1 behavior). This is the live-dispatch entry
/// the runtime threads as a per-run override.
pub fn effective_run_policy_over(
    boot: &RunPolicy,
    constraints: Option<&AgentRunConstraintsWire>,
) -> RunPolicy {
    match constraints {
        None => boot.clone(),
        Some(c) => boot.tightened_by(c.read_only, &c.disabled_tools),
    }
}

/// The effective per-run `max_turns`: a wire-asserted cap can only ever LOWER the runtime ceiling
/// (never raise it). `None`/absent ⇒ the runtime default unchanged.
pub fn effective_max_turns(
    runtime_default: u64,
    constraints: Option<&AgentRunConstraintsWire>,
) -> u64 {
    match constraints.and_then(|c| c.max_turns) {
        Some(cap) => runtime_default.min(cap),
        None => runtime_default,
    }
}

/// The pending-approval status string a [`reject`] writes (reuses the m0014 status column).
pub const PENDING_STATUS_REJECTED: &str = "rejected";

/// REFS-ONLY pause info read back from a persisted `pending_approval_request` so the server can
/// emit an [`friday_protocol::Message::AgentRunPaused`]. Carries the single-use nonce + the action
/// digest + a coarse action-verb summary — NEVER the tool body/args/params.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PauseInfo {
    /// The single-use approval nonce the operator signs over (= `pending_approval_request.approval_id`).
    pub nonce: String,
    /// Hex SHA-256 of the paused action's `canonical_action_bytes` (binds principal/scope/params).
    pub action_digest: String,
    /// A coarse, body-free summary of WHAT paused (the action verb). Never the args/params.
    pub summary: String,
}

/// Detect whether `run_id` is PAUSED on a pending operator approval, returning REFS-ONLY
/// [`PauseInfo`] when it is. This is how the server discriminates the NoAnswer black hole:
/// `NoAnswer` + a pending row for this run ⇒ the run PAUSED (emit `AgentRunPaused`); `NoAnswer`
/// + no pending row ⇒ a genuine no-answer (emit today's `AgentRunResult{no_answer}`).
///
/// Picks the OLDEST `pending` request for the run (the one the loop just paused on). A row whose
/// status is no longer `pending` (already consumed/rejected) is NOT a live pause and is skipped.
/// Returns `None` if the run is not paused (no pending row), so the server falls through to the
/// unchanged no-answer path.
pub fn detect_pause(conn: &Connection, run_id: &str) -> Result<Option<PauseInfo>, StorageError> {
    let pendings = friday_storage::list_pending_requests_for_run(conn, run_id)?;
    // Oldest-first (the storage list is ordered by created_at); the first still-`pending` row is
    // the live pause. A `consumed`/`rejected` row is a resolved approval, not a live pause.
    for p in pendings {
        if p.status == "pending" {
            return Ok(Some(PauseInfo {
                nonce: p.approval_id,
                action_digest: p.action_digest,
                summary: format!("paused on {}", p.action),
            }));
        }
    }
    Ok(None)
}

/// The coarse, body-free outcome of a control op — the data the server projects into an
/// [`friday_protocol::Message::AgentRunControlResult`]. `accepted=false` means the op was refused
/// fail-closed; `status` says why at a coarse grain. Never a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlOutcome {
    /// The control op (`resume` / `cancel` / `reject`).
    pub op: &'static str,
    /// Whether the op was accepted (`true`) or refused fail-closed (`false`).
    pub accepted: bool,
    /// Coarse, body-free outcome label (closed-vocab; see the per-op fns).
    pub status: String,
    /// Soft link to the hash-chained audit receipt, when one was written.
    pub audit_ref: Option<String>,
}

impl ControlOutcome {
    fn refused(op: &'static str, status: impl Into<String>) -> Self {
        ControlOutcome {
            op,
            accepted: false,
            status: status.into(),
            audit_ref: None,
        }
    }
}

/// Resolve a run's bound OWNER principal for an owner-authed control op:
///   1. a PAUSED run's owner is the pending row's `principal_id` (set from the gate request actor);
///   2. a FINISHED run's owner is `run_result.owner_principal`;
///   3. otherwise (no pending row, no result, or an empty/ownerless principal) ⇒ `None`
///      (fail-closed: an ownerless run cannot be owner-authed and every control op refuses).
///
/// Returns the FIRST non-empty owner found. An empty/whitespace stored principal is treated as no
/// owner (never matched), mirroring the body-read fail-closed discipline.
pub fn resolve_run_owner(conn: &Connection, run_id: &str) -> Result<Option<String>, StorageError> {
    for p in friday_storage::list_pending_requests_for_run(conn, run_id)? {
        if let Some(pid) = p.principal_id.as_deref() {
            if !pid.trim().is_empty() {
                return Ok(Some(pid.to_string()));
            }
        }
    }
    if let Some(result) = get_run_result(conn, run_id)? {
        if let Some(owner) = result.owner_principal.as_deref() {
            if !owner.trim().is_empty() {
                return Ok(Some(owner.to_string()));
            }
        }
    }
    Ok(None)
}

/// True iff `authed_principal` (an already session-authenticated principal) is the run's bound
/// owner. Fail-closed: an ownerless run, or a mismatch, returns `false`. An empty authed principal
/// is never an owner.
fn is_run_owner(
    conn: &Connection,
    run_id: &str,
    authed_principal: &str,
) -> Result<bool, StorageError> {
    let authed = authed_principal.trim();
    if authed.is_empty() {
        return Ok(false);
    }
    Ok(resolve_run_owner(conn, run_id)?.as_deref() == Some(authed))
}

/// CANCEL a run: owner-authed terminal stop.
///
/// `authed_principal` MUST be a principal the server already authenticated against the sealed
/// session (this module does NOT re-do session auth — it does the OWNER-match on top). Fail-closed
/// outcomes (`accepted=false`):
///   - `not_owner` — the authed principal is not the run's bound owner (or the run is ownerless);
///   - `unknown_run` — no `agent_run` row exists;
///   - `already_completed` — the run already produced a terminal `run_result`; cancel refuses to
///     touch a completed run (mirrors the resume.rs refusal-to-clobber discipline).
///
/// Accepted outcomes (`accepted=true`): `cancelled` (state written) / `already_cancelled`
/// (idempotent no-op). An accepted cancel writes a hash-chained audit receipt.
pub fn cancel(
    conn: &Connection,
    run_id: &str,
    authed_principal: &str,
    reason: Option<&str>,
    now_ms: i64,
) -> Result<ControlOutcome, StorageError> {
    // (1) Owner gate FIRST (before any read of completion state leaks run existence to a
    //     non-owner): a non-owner / ownerless run is refused with no state change.
    if !is_run_owner(conn, run_id, authed_principal)? {
        return Ok(ControlOutcome::refused("cancel", "not_owner"));
    }
    // (2) Refuse to cancel a COMPLETED run — its terminal result stands; cancel must not relabel
    //     it. (A paused/live run has no result yet.)
    if get_run_result(conn, run_id)?.is_some() {
        return Ok(ControlOutcome::refused("cancel", "already_completed"));
    }
    // (3) Write the terminal cancelled state (idempotent; fail-closed on an unknown run, though
    //     the owner gate above already implies the row exists for a non-ownerless run).
    match agent_run::cancel_run(conn, run_id, now_ms)? {
        CancelOutcome::UnknownRun => Ok(ControlOutcome::refused("cancel", "unknown_run")),
        CancelOutcome::AlreadyCancelled => Ok(ControlOutcome {
            op: "cancel",
            accepted: true,
            status: "already_cancelled".to_string(),
            audit_ref: None,
        }),
        CancelOutcome::Cancelled => {
            let summary = match reason {
                Some(r) if !r.trim().is_empty() => format!("agent_run.cancelled:{}", r.trim()),
                _ => "agent_run.cancelled".to_string(),
            };
            let audit_ref = write_control_receipt(conn, run_id, "cancel", &summary, now_ms)?;
            Ok(ControlOutcome {
                op: "cancel",
                accepted: true,
                status: "cancelled".to_string(),
                audit_ref: Some(audit_ref),
            })
        }
    }
}

/// REJECT one pending tool-approval on a run: owner-authed refusal.
///
/// `approval_id` identifies WHICH pending mutation to refuse (= the `AgentRunPaused::nonce`). Like
/// [`cancel`], `authed_principal` is already session-authenticated; this does the owner-match.
/// Fail-closed outcomes: `unknown_approval` (no pending row for this approval_id), `run_mismatch`
/// (the pending row belongs to a different run than `run_id`), `not_owner`. Accepted outcome:
/// `rejected` (status written + audit receipt). Idempotent: re-rejecting an already-rejected row
/// is an accepted no-op (`already_rejected`).
pub fn reject(
    conn: &Connection,
    run_id: &str,
    approval_id: &str,
    authed_principal: &str,
    now_ms: i64,
) -> Result<ControlOutcome, StorageError> {
    let Some(pending) = get_pending_request(conn, approval_id)? else {
        return Ok(ControlOutcome::refused("reject", "unknown_approval"));
    };
    // The pending row must belong to the run named in the message (a proof cannot be steered to a
    // different run's approval).
    if pending.run_id != run_id {
        return Ok(ControlOutcome::refused("reject", "run_mismatch"));
    }
    // Owner gate: the authed principal must be the pending row's bound owner.
    let owner_ok = matches!(
        pending.principal_id.as_deref().map(str::trim),
        Some(p) if !p.is_empty() && p == authed_principal.trim()
    );
    if !owner_ok {
        return Ok(ControlOutcome::refused("reject", "not_owner"));
    }
    if pending.status == PENDING_STATUS_REJECTED {
        return Ok(ControlOutcome {
            op: "reject",
            accepted: true,
            status: "already_rejected".to_string(),
            audit_ref: None,
        });
    }
    // A consumed/resolved pending row cannot be rejected (the mutation already happened / the
    // approval already resolved) — fail-closed rather than relabel a terminal row.
    if pending.status != "pending" {
        return Ok(ControlOutcome::refused("reject", "not_pending"));
    }
    set_pending_status(conn, approval_id, PENDING_STATUS_REJECTED)?;
    let audit_ref = write_control_receipt(
        conn,
        run_id,
        "reject",
        &format!("pending_approval.rejected:{}", pending.action),
        now_ms,
    )?;
    Ok(ControlOutcome {
        op: "reject",
        accepted: true,
        status: "rejected".to_string(),
        audit_ref: Some(audit_ref),
    })
}

/// The operator-signed approval JSON the S6c CLI emits, carried as the courier's `signed_blob`.
/// Mirrors `hub_resume_approval::SignedApprovalIn` (the existing dev-bridge decode) so the wire
/// blob and the CLI output are the same shape. Unknown fields tolerated.
#[derive(Debug, serde::Deserialize)]
struct SignedApprovalIn {
    decision: String,
    approval_id: String,
    action_digest: String,
    expires_at: i64,
    #[serde(default)]
    issuer: Option<String>,
    signature: String,
}

fn parse_decision(s: &str) -> Option<ApprovalDecision> {
    match s {
        "approved" => Some(ApprovalDecision::Approved),
        "denied" => Some(ApprovalDecision::Denied),
        _ => None,
    }
}

/// RESUME a paused run from the operator's out-of-band signed approval (the courier's `signed_blob`).
///
/// The server decodes nothing; THIS fn decodes the blob → `CanonicalApproval` and delegates to the
/// S6 [`resume_with_approval`] spine (verify Ed25519 under `operator_vk`, consume the nonce
/// single-use, execute the ONE approved mutation, record the owner). It NEVER re-implements
/// verification/execution.
///
/// **The wire-run binding (security MUST-FIX) + reject/cancel coupling (REAL, not cosmetic).**
/// BEFORE delegating, this PRE-CHECKS, against the WIRE `run_id`: (a) that the nonce's pending row
/// belongs to the SAME run as the wire `run_id` (`pending.run_id == run_id`) — the spine selects
/// the run to execute SOLELY from the nonce, so without this the route's owner gate (keyed on the
/// wire `run_id`) and the executed run could differ (`run_mismatch`); (b) that the run is not
/// cancelled; and (c) that the targeted pending row is not rejected. (b)/(c) are needed because the
/// spine's single-use guard is the `consumed_approval` store, not `agent_run.state`/`pending.status`,
/// so without them a correctly-signed resume would still execute a rejected/cancelled run's
/// mutation. The (a) binding ALSO makes the (b) `is_cancelled` pre-check consistent (it keys on the
/// same run the spine executes). Fail-closed outcomes: `malformed_blob`, `run_mismatch`,
/// `run_cancelled`, `approval_rejected`, and the bounded resume-error tokens. Accepted maps the gate
/// decision: `mutation_completed` (executed) / `mutation_exec_failed` / `approval_refused` (gate
/// Deny — replay/expired/bad-signature).
pub fn resume(
    conn: &Connection,
    executor: &dyn ToolExecutor,
    operator_vk: &OperatorVerifyingKey,
    run_id: &str,
    signed_blob: &[u8],
    now_ms: i64,
) -> Result<ControlOutcome, StorageError> {
    // (1) Decode the courier blob (JSON of a SignedApproval). Malformed ⇒ fail-closed.
    let signed: SignedApprovalIn = match std::str::from_utf8(signed_blob)
        .ok()
        .and_then(|s| serde_json::from_str(s.trim()).ok())
    {
        Some(s) => s,
        None => return Ok(ControlOutcome::refused("resume", "malformed_blob")),
    };
    let Some(decision) = parse_decision(&signed.decision) else {
        return Ok(ControlOutcome::refused("resume", "malformed_blob"));
    };
    let approval = CanonicalApproval {
        decision,
        approval_id: signed.approval_id.clone(),
        action_digest: signed.action_digest.clone(),
        expires_at: Some(signed.expires_at),
        issuer: Some(
            signed
                .issuer
                .clone()
                .unwrap_or_else(|| CANONICAL_GATE_ISSUER.to_string()),
        ),
        signature: Some(signed.signature.clone()),
    };

    // (2) THE REJECT/CANCEL COUPLING. The spine does not read run/pending state, so enforce it
    //     here: a cancelled run, or a rejected pending row, refuses the resume BEFORE the spine can
    //     consume the nonce + execute. Fail-closed.
    if agent_run::is_cancelled(conn, run_id)? {
        return Ok(ControlOutcome::refused("resume", "run_cancelled"));
    }
    if let Some(pending) = get_pending_request(conn, &approval.approval_id)? {
        // (2a) WIRE-RUN ↔ EXECUTED-RUN BINDING (security MUST-FIX). The TS resume route owner-gates
        //      the run named by the WIRE `run_id` (it 403s unless the authed caller owns THAT run),
        //      but the spine selects the run to execute SOLELY from the blob's nonce
        //      (`pending.run_id`) and takes no `run_id`. Without this check the owner-gated run and
        //      the executed run could DIFFER: an attacker who owns run A could resume A on the wire
        //      while carrying a nonce whose pending row belongs to victim run B, executing B's
        //      mutation past A's owner gate. Refuse fail-closed unless the wire run is the SAME run
        //      the nonce will execute (mirrors `reject`'s `run_mismatch` binding — same wire vocab,
        //      no protocol change). This ALSO makes the `is_cancelled(conn, run_id)` pre-check above
        //      consistent: every path that proceeds now has `run_id == pending.run_id`, so the
        //      cancel pre-check keys on the SAME run the spine will execute (the latent coupling the
        //      review flagged is closed by this one binding).
        if pending.run_id != run_id {
            return Ok(ControlOutcome::refused("resume", "run_mismatch"));
        }
        if pending.status == PENDING_STATUS_REJECTED {
            return Ok(ControlOutcome::refused("resume", "approval_rejected"));
        }
    }

    // (3) Delegate VERBATIM to the S6 spine.
    match resume_with_approval(conn, executor, operator_vk, &approval, now_ms) {
        Ok(outcome) => Ok(ControlOutcome {
            op: "resume",
            // The spine PROCESSED it; `executed` reflects whether the mutation ran. A gate Deny
            // (replay/expired/bad-signature) is a PROCESSED refusal — accepted=false at the wire
            // (the control op did not effect a mutation), with the spine's coarse status.
            accepted: outcome.executed,
            status: outcome.result_status,
            audit_ref: outcome.audit_ref,
        }),
        Err(e) => Ok(ControlOutcome::refused("resume", resume_error_kind(&e))),
    }
}

/// Map a [`ResumeError`] to ONE bounded, refs-only category token (never embeds detail).
fn resume_error_kind(err: &ResumeError) -> &'static str {
    match err {
        ResumeError::UnknownNonce => "unknown_nonce",
        ResumeError::NoToolCall => "no_tool_call",
        ResumeError::Unregistered(_) => "unregistered_tool",
        ResumeError::DigestMismatch => "digest_mismatch",
        ResumeError::Storage(_) => "storage_failed",
    }
}

/// Write the event-log line + the hash-chained audit receipt for a control op in ONE transaction
/// (the event log can never get ahead of the ledger on a partial commit) — mirrors
/// [`crate::resume`]'s `write_receipt`. Returns the receipt id (the soft audit ref). A per-op
/// CSPRNG tag keys the ids so repeated ops on the same run never PK-collide.
fn write_control_receipt(
    conn: &Connection,
    run_id: &str,
    op: &str,
    summary: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let tag = friday_crypto::generate_approval_nonce();
    let event_id = format!("{run_id}:control:{op}:{tag}:event");
    let receipt_id = format!("{run_id}:control:{op}:{tag}:receipt");
    let tx = conn.unchecked_transaction()?;
    agent_run::record_event(&tx, &event_id, run_id, summary, now_ms)?;
    audit::append_audit(
        &tx,
        &receipt_id,
        "agent-run-control",
        summary,
        Some(run_id),
        now_ms,
    )?;
    tx.commit()?;
    Ok(receipt_id)
}
