//! **S-R2** — the run-readback projection, extracted to a CALLABLE library fn.
//!
//! The projection logic previously lived INLINE in `bin/hub_run_readback.rs::run()`. S-R2 extracts
//! the core into [`project_run_readback`] so that BOTH the existing one-shot CLI bin AND the new
//! DARK sealed-WS read-projection server (`bin/hub_read_projection_server.rs`) share ONE
//! implementation — no duplication, no drift. The bin keeps only its arg-parse / DB-open / coarse
//! error-kind vocabulary; everything refs-only lives here. This mirrors exactly what S-R1 did for
//! the Mission Workbench projection ([`crate::workbench_projection::project_workbench`]).
//!
//! ## Refs-only by construction
//! [`project_run_readback`] runs [`reject_forbidden_output`] INSIDE itself and returns `Err` if any
//! forbidden marker is present, so EVERY caller (the bin and the read server) inherits the refs-only
//! guarantee — the snapshot carries the run `state` label (NOT the run `task` body), a loop-status
//! label derived from the event log, turn/tool counts, the ordered event-`kind` list, the
//! `audit_chain_verified` bool, and DB-WIDE token totals. Never an inline body.
//!
//! ### Event-kind sensitivity (the `/etc` over-block lesson is preserved)
//! The event `kind` strings are safe labels (`plan.none`, `agent.finished`, `tool.blocked:...`) but
//! a `tool.executed:` kind CAN embed a RELATIVE filename. Relative names are accepted; only the
//! absolute-path / secret markers in the shared guard fail the projection closed. The guard's marker
//! set is the bin's exact pre-existing one (`"task"` body marker + the common set) — see
//! [`crate::refs_guard`] for why `/etc,/var,/tmp,/home` are intentionally NOT broadened markers.
//!
//! ### Token totals — DB-WIDE, NOT run-attributable (the known gap)
//! `db_wide_token_*` are summed over the WHOLE `token_ledger` via
//! [`friday_storage::agent_run_read::db_wide_token_totals`]. They are NOT this run's tokens — the
//! field names say `db_wide_` so they are never misread as run-scoped cost. (A run-attributable
//! `run_token_totals` exists, but faithful extraction keeps the bin's DB-wide contract per the slice
//! instruction: label them DB-wide, never as run cost.)
//!
//! ## No model call, no credential, read-only
//! This fn takes an ALREADY-OPENED [`Db`] (the bin and the server open it `open_hub_readonly`) and
//! does pure reads + JSON shaping. It never touches a provider credential or the model path.

use friday_storage::agent_run_read::{db_wide_token_totals, get_run_summary, list_event_kinds};
use friday_storage::agent_session::{
    link_state_for_owner, LINK_OFFLINE_AFTER_MS, LINK_STALE_AFTER_MS,
};
use friday_storage::audit::verify_audit_chain;
use friday_storage::Db;
use serde_json::{json, Value};

/// (M-3) OWNER-GATED refs-only run-readback projection for `run_id` from an already-opened
/// read-only hub [`Db`], scoped to `caller_principal`. `Ok(Some(snapshot))` ⇒ the caller IS the
/// run's bound owner and gets the refs-only snapshot; `Ok(None)` ⇒ the caller is NOT the run's
/// bound owner (or the run is owner-less / absent, or the caller is empty) — fail-closed, no
/// existence/state oracle for a non-owner.
///
/// ## M-3 owner gate — `resolve_run_owner` (the C2-9 owner axis)
/// `project_run_readback` previously took only `run_id` with NO principal, so any authenticated
/// caller could read back ANY run by guessing the id — a cross-principal existence/state ORACLE.
/// The gate now resolves the run's bound owner via [`crate::agent_run_control::resolve_run_owner`]
/// (the SAME owner resolution the owner-authed `reject`/`cancel` control ops and the C2-9
/// `project_activity_needs_me` projection use). `resolve_run_owner` returns an owner ONLY for a
/// PAUSED run (its pending-approval row's `principal_id`) or a FINISHED run that recorded a
/// `run_result.owner_principal`; it returns `None` for every OTHER state — an in-progress / errored
/// / bounded run with no `run_result` yet, and an owner-less finished run. An empty caller, an
/// owner-less/no-resolvable-owner run, an unknown run, or a mismatch ALL collapse to `Ok(None)`, so
/// a non-owner learns nothing (no body, no owner id, no run-existence/state oracle).
///
/// **Behavior change (honest scope):** because the gate requires a RESOLVABLE owner, even the legit
/// owner can no longer read back a run that has not yet produced a `run_result` and is not paused
/// (an in-progress / errored / bounded-without-result run, or an owner-less finished run) — those
/// now return `Ok(None)`. This is the intended M-3 tightening (no resolvable owner ⇒ no readback,
/// fail-closed — never an owner-less fallback, which would re-open the oracle). Pre-M-3 the
/// projection returned a snapshot for ANY run with an `agent_run` row regardless of state.
///
/// `caller_principal` MUST be a principal the server already AUTHENTICATED against the sealed
/// session (this fn does the OWNER-match on top; it never re-does session auth, and never trusts a
/// client-asserted wire string — the read-projection server threads the verified
/// `AuthedPrincipal::principal()` here).
///
/// Fail-closed: a read error or a forbidden-marker leak return `Err(String)` (the SAME coarse
/// error-kind strings the bin surfaced) — never a partial or a raw body. The forbidden-output guard
/// runs INSIDE this fn so both the bin and the read server inherit it.
pub fn project_run_readback(
    db: &Db,
    caller_principal: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let conn = db.conn();

    // OWNER GATE (fail-closed, M-3): the run's owner is resolved by `resolve_run_owner` (the
    // pending-row principal for a paused run, or `run_result.owner_principal` for a finished one;
    // `None` for any other state — see the fn docs). An empty caller, a run with no resolvable
    // owner (absent / in-progress-without-result / owner-less), or a mismatch all collapse to
    // `Ok(None)` — a non-owner gets no run-existence/state oracle (and never reaches the summary
    // read below). This MIRRORS the C2-9 `project_activity_needs_me` gate exactly.
    let caller = caller_principal.trim();
    if caller.is_empty() {
        return Ok(None);
    }
    let owner = crate::agent_run_control::resolve_run_owner(conn, run_id)
        .map_err(|_| "read_failed".to_string())?;
    if owner.as_deref() != Some(caller) {
        return Ok(None);
    }

    let summary = get_run_summary(conn, run_id)
        .map_err(|_| "read_failed".to_string())?
        .ok_or_else(|| "run_not_found".to_string())?;

    let event_kinds = list_event_kinds(conn, run_id).map_err(|_| "read_failed".to_string())?;

    let loop_status_derived = derive_loop_status(&event_kinds);
    let turn_count = event_kinds
        .iter()
        .filter(|kind| kind.starts_with("plan."))
        .count();
    let executed_tool_count = event_kinds
        .iter()
        .filter(|kind| kind.starts_with("tool.executed:"))
        .count();

    // Audit chain verification over the readback DB (a bool, never the rows).
    let audit_chain_verified = verify_audit_chain(conn).is_ok();

    // DB-WIDE token totals (NOT run-attributable — see module docs). Ints only.
    let totals = db_wide_token_totals(conn).map_err(|_| "read_failed".to_string())?;

    let snapshot = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": summary.run_id,
        "run_state": summary.state,
        "created_at_ms": summary.created_at,
        "updated_at_ms": summary.updated_at,
        "loop_status_derived": loop_status_derived,
        "turn_count": turn_count,
        "executed_tool_count": executed_tool_count,
        "event_count": event_kinds.len(),
        "event_kinds": event_kinds,
        "audit_chain_verified": audit_chain_verified,
        "db_wide_token_prompt_total": totals.prompt,
        "db_wide_token_completion_total": totals.completion,
        "db_wide_token_total": totals.total,
    });

    // Run the forbidden-output guard INSIDE the library fn so the bin AND the read server both
    // inherit refs-only. The guard renders to a string and rejects on any forbidden marker.
    let rendered = serde_json::to_string(&snapshot).map_err(|_| "serialize_failed".to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(Some(snapshot))
}

/// Derive a coarse, refs-only loop-status LABEL from the ordered event kinds.
///
/// The readback opens the DB read-only and does NOT re-run the loop, so the status is reconstructed
/// from terminal markers in the event log. Returns ONLY a fixed `&'static str` from a closed
/// vocabulary — never any slice of an event kind — so no event-embedded text can leak through this
/// label.
pub fn derive_loop_status(kinds: &[String]) -> &'static str {
    if kinds.iter().any(|kind| kind == "agent.finished") {
        "finished"
    } else if kinds.iter().any(|kind| kind.starts_with("agent.error:")) {
        "errored"
    } else if kinds.iter().any(|kind| kind == "agent.loop_bounded") {
        "bounded"
    } else if kinds.iter().any(|kind| kind.starts_with("tool.paused")) {
        "paused"
    } else if kinds.iter().any(|kind| kind.starts_with("tool.blocked")) {
        "blocked"
    } else if kinds.is_empty() {
        "no_events"
    } else {
        "in_progress"
    }
}

/// Refs-only output guard — the SAME shared guard the bin ran, with this projection's body marker.
/// `"task"` (the run task body) must never appear (only run_id/state/labels do). Relative filenames
/// inside a `tool.executed:` kind have no leading slash and remain permitted (including interior
/// `etc`/`var`/`tmp`/`home` dir segments — see [`crate::refs_guard`]). Returns `Err(marker)` on any
/// forbidden marker so both the bin and the read server fail closed identically.
pub fn reject_forbidden_output(rendered: &str) -> Result<(), String> {
    crate::refs_guard::reject_forbidden_output(rendered, &["\"task\""])
        .map_err(|marker| format!("forbidden marker in projection: {marker}"))
}

/// (C2-8) OWNER-GATED refs-only projection of a routed session's offline/stale LINK-STATE,
/// derived from the session's last-activity timestamp (`agent_session.updated_at`) vs the
/// injected `now_ms`. `Ok(None)` ⇒ the caller does not own the session (or it is absent /
/// owner-less) — fail-closed, no existence/state oracle for a non-owner (the SAME owner axis
/// as the C2-4 read API). `Ok(Some(snapshot))` ⇒ the owner's link-state label
/// (`fresh`/`stale`/`offline`) plus the thresholds it was derived against.
///
/// DARK / pure clock-driven compute: the state is DERIVED on read from `updated_at + now_ms`
/// — nothing is persisted, no model call, no ledger row, no mutation of the run path. The
/// timestamp keys off the REAL routed session's activity (the metered turn's folded
/// `append_session_message` bumps `updated_at`), NOT a `provider_session_link` claude_control
/// mirror heartbeat. `now_ms` is INJECTED (never a wall clock) so transitions are
/// deterministically testable.
///
/// Refs-only by construction: the snapshot carries only the session id, the closed-vocabulary
/// state label, the last-activity timestamp, and the static thresholds — never a message body
/// or the run `task`. The shared [`reject_forbidden_output`] guard runs INSIDE this fn, so it
/// inherits the same refs-only discipline as [`project_run_readback`].
pub fn project_session_link_state(
    db: &Db,
    user_id: &str,
    agent_session_id: &str,
    now_ms: i64,
) -> Result<Option<Value>, String> {
    let conn = db.conn();

    let state = match link_state_for_owner(conn, user_id, agent_session_id, now_ms)
        .map_err(|_| "read_failed".to_string())?
    {
        // Fail-closed: a non-owner / absent / owner-less session reads back None — never a
        // distinguishable error, so a non-owner gets no existence/state oracle.
        None => return Ok(None),
        Some(state) => state,
    };

    let snapshot = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "agent_session_id": agent_session_id,
        // Closed-vocabulary label only (never any session text): fresh | stale | offline.
        "link_state": state.as_str(),
        "now_ms": now_ms,
        // The static thresholds the state was derived against (so a UI can render the bands).
        "stale_after_ms": LINK_STALE_AFTER_MS,
        "offline_after_ms": LINK_OFFLINE_AFTER_MS,
    });

    // Inherit the refs-only guard (the payload is body-free, so it passes — but run it so this
    // projection matches the file's discipline and can never regress to carrying a body).
    let rendered = serde_json::to_string(&snapshot).map_err(|_| "serialize_failed".to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(Some(snapshot))
}

/// (C2-5) OWNER-GATED refs-only FILE-VIEW of the workspace files a run actually READ — the
/// file refs of the run's `read_file` tool receipts, keyed to `run_id`. `Ok(None)` ⇒ the caller
/// is NOT the run's bound owner (or the run has no stored result / no real owner) — fail-closed,
/// no existence/state oracle for a non-owner (the SAME owner axis as the C2-4 read API and the
/// in-file [`project_session_link_state`]). `Ok(Some(snapshot))` ⇒ the owner's file-view.
///
/// ## Anchored to the REAL read_file receipt of a metered turn (NOT a mirror)
/// `read_file` is a read-type tool the gate Allows directly inside the run loop, so a claude turn
/// that proposes it bills a REAL `anthropic` token-ledger row AND records a
/// `tool.executed:read {n} bytes from {path}` event in the SAME transaction as the hash-chained
/// `tool.executed:read_file` audit receipt. [`friday_storage::agent_run_read::list_read_file_refs`]
/// reads THOSE run-keyed receipt events, so the file-view is the co-committed witness of the
/// genuine metered turn's receipt — never a synthesized / mirror file event.
///
/// ## Owner gate — reuses the C2-4 / D1-Q1 axis, body-free
/// The gate is [`friday_storage::get_run_answer_for_principal`] (the proven fail-closed
/// `Granted` / `Denied` / `NotFound` ownership match on the run's bound `owner_principal` — the
/// SAME principal `run_session_loop` records). On a `Granted` the answer BODY is discarded (bound
/// to `_`); this projection NEVER carries the answer — only the file refs + run id. Every denying
/// outcome collapses to `Ok(None)` so a non-owner learns nothing (no body, no owner id, no
/// existence oracle). HONEST scope: the file-view is a readback of a COMPLETED run (the owner axis
/// is only recorded once the run persists its `run_result`, on `Finished`).
///
/// ## Class-2 read: no model call, no new ledger row, no mutation
/// Pure reads + JSON shaping over already-persisted events — it never touches a provider
/// credential, the model path, or any write. The shared [`reject_forbidden_output`] guard runs
/// INSIDE this fn so the file refs (relative workspace paths) inherit the refs-only discipline
/// (an absolute-path / secret marker would fail it closed).
pub fn project_run_file_view(
    db: &Db,
    caller_principal: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let conn = db.conn();

    // OWNER GATE (fail-closed): reuse the D1-Q1 / C2-4 ownership match. Any non-Granted outcome
    // (NotFound / NoOwnerPrincipal / AnonymousCaller / PrincipalMismatch) collapses to `Ok(None)`
    // — a non-owner gets no body, no owner id, and no existence/state oracle for the file-view.
    // The answer body in `Granted` is DISCARDED here (`_`); this projection never carries it.
    match friday_storage::get_run_answer_for_principal(conn, run_id, caller_principal)
        .map_err(|_| "read_failed".to_string())?
    {
        friday_storage::RunAnswerAccess::Granted(_) => {}
        friday_storage::RunAnswerAccess::Denied(_) | friday_storage::RunAnswerAccess::NotFound => {
            return Ok(None)
        }
    }

    // The owner is entitled: read the run's `read_file` receipt refs (run-keyed; the co-committed
    // witness of the real metered turn's receipt). This is a pure read — no new ledger row.
    let file_refs = friday_storage::agent_run_read::list_read_file_refs(conn, run_id)
        .map_err(|_| "read_failed".to_string())?;

    let snapshot = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": run_id,
        // The relative workspace paths the run's `read_file` receipts recorded, in receipt order.
        "file_refs": file_refs,
        "file_view_count": file_refs.len(),
    });

    // Inherit the refs-only guard: a relative path passes; an absolute-path / secret marker that
    // somehow reached a receipt summary fails the projection closed (never leaks).
    let rendered = serde_json::to_string(&snapshot).map_err(|_| "serialize_failed".to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(Some(snapshot))
}

/// (C2-9) OWNER-SCOPED Activity / Needs-Me projection for ONE paused, claude-pinned run: the
/// run's `AskReceipt` activity rows (one per metered turn) PLUS a single Needs-Me item surfacing
/// the pending operator approval the run Paused on. `Ok(None)` ⇒ the caller is NOT the run's bound
/// owner (or the run is not paused / owner-less / the caller is empty) — fail-closed, no
/// existence/state oracle for a non-owner. `Ok(Some(snapshot))` ⇒ the owner's Activity/Needs-Me
/// view.
///
/// ## Owner axis — `resolve_run_owner`, NOT the literal C2-4/C2-5 gate (deliberate, documented)
/// The C2-4/C2-5 read APIs gate on [`friday_storage::get_run_answer_for_principal`], which keys on
/// `run_result.owner_principal` — a row that only exists once a run is *Finished*. THIS run is
/// *Paused* (it has no `run_result` yet), so the literal gate would deny every caller. The SAME
/// owner concept for a paused run lives on the pending approval row's `principal_id`, which
/// [`crate::agent_run_control::resolve_run_owner`] returns (the SAME source the owner-authed
/// `reject`/`cancel` control ops gate on). So the owner axis here is `resolve_run_owner` —
/// fail-closed identically: an empty caller, an owner-less run, or a mismatch all read back `None`.
///
/// ## Built over the EXISTING substrate, refs-only (NOT a synthesized inbox)
/// * The Needs-Me item is anchored to a REAL pending approval via [`crate::agent_run_control::detect_pause`]
///   (`ref_id` = the live CSPRNG approval nonce; `kind` = Approval; `status` = AwaitingApproval) —
///   so it points at a run with a real `pending_approval_request`, never a fabricated entry. A run
///   that is not paused (no pending row) yields `needs_me: None`.
/// * The AskReceipt rows are read from [`friday_storage::Db::list_activity`] filtered to THIS run:
///   `kind == "ask_receipt"` AND `activity_id` carries the run prefix `"{run_id}:"` — matching the
///   `bill_model_call` scheme (`{run_id}:t{turn_index}:askreceipt`). Each row is the body-free
///   `"{n} tokens via {model}"` receipt of a real metered turn.
///
/// ## Actionable Needs-Me — the NS-7 / NS-8 producer rows the consumer used to ORPHAN (additive)
/// The producers write `approval_required` (NS-7, `insert_pending_approval_activity`) and
/// `memory_review` (NS-8, `memory_review_activity_row`) activity rows, but this consumer previously
/// read ONLY `ask_receipt` rows + the `detect_pause`-computed `needs_me` item — so those producer
/// rows had NO reader (the actionable Needs-Me surface was always empty). [`collect_actionable_needs_me`]
/// now ALSO surfaces them in the `actionable_needs_me` array (in addition to — never replacing —
/// `ask_receipts` + `needs_me`, the no-degrade guarantee). It stays STRICTLY OWNER-GATED:
/// `approval_required` rows are scoped to THIS run's still-pending approval nonces (inheriting the
/// run owner gate), and `memory_review` rows are owner-scoped by joining the parsed `memory_id`
/// back to `memory_item.principal_id == owner` (a missing / unowned / other-owner row is skipped).
///
/// ## Class-2 read: no model call, no new ledger row, no mutation
/// Pure reads over already-persisted activity + pending + memory rows — it never touches a provider
/// credential, the model path, or any write, and writes NO `token_ledger` row (it is not a metered
/// turn). It is INDEPENDENT of the ns-7 `FRIDAY_ACTIVITY_NEEDS_ME` persisted-activity flag: the
/// `needs_me` item is COMPUTED from `detect_pause` at read time, not read from a persisted row. The
/// shared [`reject_forbidden_output`] guard runs INSIDE this fn so the snapshot inherits the
/// refs-only discipline.
pub fn project_activity_needs_me(
    db: &Db,
    caller_principal: &str,
    run_id: &str,
) -> Result<Option<Value>, String> {
    let conn = db.conn();

    // OWNER GATE (fail-closed): the paused run's owner is the pending row's `principal_id`
    // (`resolve_run_owner`). An empty caller, an owner-less run, or a mismatch all collapse to
    // `Ok(None)` — a non-owner gets no existence/state oracle for the run's activity.
    let caller = caller_principal.trim();
    if caller.is_empty() {
        return Ok(None);
    }
    let owner = crate::agent_run_control::resolve_run_owner(conn, run_id)
        .map_err(|_| "read_failed".to_string())?;
    if owner.as_deref() != Some(caller) {
        return Ok(None);
    }

    // The run's AskReceipt activity rows: filter the DB-wide activity list to THIS run by the
    // `bill_model_call` id scheme (`{run_id}:t{turn_index}:askreceipt`). The trailing colon makes
    // the prefix unambiguous (`run-c2-9:` never matches `run-c2-90:`).
    let run_prefix = format!("{run_id}:");
    let ask_receipts: Vec<Value> = db
        .list_activity()
        .map_err(|_| "read_failed".to_string())?
        .into_iter()
        .filter(|row| row.kind == "ask_receipt" && row.activity_id.starts_with(&run_prefix))
        .map(|row| {
            json!({
                "activity_id": row.activity_id,
                "kind": row.kind,
                "state": row.state,
                // The metered-turn receipt summary ("{n} tokens via {model}") — body-free.
                "summary": row.summary,
                "created_at": row.created_at,
            })
        })
        .collect();

    // The Needs-Me item: anchored to the REAL pending approval the run paused on (`detect_pause`).
    // A run not paused yields `None` (no synthesized inbox entry). The run is claude-pinned, so the
    // provider is Claude; the sessionless run's `friday_session_id` is the run id.
    let needs_me = crate::agent_run_control::detect_pause(conn, run_id)
        .map_err(|_| "read_failed".to_string())?
        .map(|pause| {
            let approval_id = pause.nonce;
            let action_digest = pause.action_digest;
            let summary = pause.summary;
            json!({
                "item_id": format!("needs-me:{run_id}:{approval_id}"),
                "provider": "claude",
                "friday_session_id": run_id,
                "kind": "approval",
                "priority": "high",
                // The live approval nonce — the real `pending_approval_request.approval_id`.
                "ref_id": approval_id,
                "status": "awaiting_approval",
                // Refs-only signing material. This is enough for an operator signer to review/sign
                // the paused action, but still carries no tool body/args/key material.
                "action_digest": action_digest,
                "summary": summary,
                "signing_request": {
                    "run_id": run_id,
                    "approval_id": approval_id,
                    "action_digest": action_digest,
                    "summary": summary,
                },
            })
        });

    // ADDITIVE (no-degrade): the actionable activity rows the producers write but the
    // pre-existing consumer never read — `approval_required` (NS-7) and `memory_review` (NS-8).
    // These rows were written to a sink with NO reader (the producers' `FRIDAY_ACTIVITY_NEEDS_ME`
    // / `FRIDAY_MEMORY_REVIEW_NEEDS_ME` rows), so the actionable Needs-Me surface was always empty.
    // They are surfaced here as a SEPARATE array — `ask_receipts` + `needs_me` above stay
    // byte-identical (the no-degrade guarantee). Each is an owner-scoped, refs-only `json!` item
    // (`{kind, title, deep_link, ref_id, state, activity_id}`) a surface can render + act on.
    let actionable_needs_me =
        collect_actionable_needs_me(db, conn, run_id, owner.as_deref().unwrap_or(caller))
            .map_err(|_| "read_failed".to_string())?;

    let ask_receipt_count = ask_receipts.len();
    let actionable_count = actionable_needs_me.len();
    let snapshot = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": run_id,
        "ask_receipts": ask_receipts,
        "ask_receipt_count": ask_receipt_count,
        "needs_me": needs_me,
        "actionable_needs_me": actionable_needs_me,
        "actionable_needs_me_count": actionable_count,
    });

    // Inherit the refs-only guard (the AskReceipt summary + the nonce-only Needs-Me item are
    // body-free, so it passes — but run it so this projection matches the file's discipline).
    let rendered = serde_json::to_string(&snapshot).map_err(|_| "serialize_failed".to_string())?;
    reject_forbidden_output(&rendered)?;
    Ok(Some(snapshot))
}

/// The `activity_id` prefix the NS-7 approval producer keys its row under
/// (`approval-needs-me-{nonce}`) — see [`friday_storage::insert_pending_approval_activity`].
const APPROVAL_ACTIVITY_PREFIX: &str = "approval-needs-me-";
/// The `activity_id` prefix the NS-8 memory-review producer keys its row under
/// (`memory-review-needs-me-{memory_id}`) — see `memory_extraction::memory_review_activity_row`.
const MEMORY_REVIEW_ACTIVITY_PREFIX: &str = "memory-review-needs-me-";

/// (NS-7 / NS-8 closure) Read the ACTIONABLE activity rows the producers write but the
/// pre-existing `ask_receipt`/`detect_pause` consumer never read, and project each into an
/// owner-scoped, refs-only Needs-Me item. STRICTLY OWNER-GATED — the caller has already been
/// confirmed to be `run_id`'s bound owner (== `owner_principal` here), so:
///
/// * **`approval_required`** rows are run-linked (`session_id = run_id`, keyed under the run's
///   approval nonces). They are scoped to THIS run by `list_pending_requests_for_run`: a row is
///   surfaced ONLY if its `activity_id == "approval-needs-me-{nonce}"` for a STILL-`pending` nonce
///   of this run. Owner-scoping is inherited from the run owner gate (no other owner's nonces are
///   ever in this run's pending list). `ActivitySummary` does not carry `session_id`, so the
///   pending-nonce join is the run-scoping mechanism — no storage-layer change.
/// * **`memory_review`** rows are NOT run-linked (`session_id = None`, keyed on `memory_id`; the
///   owner lives on `memory_item.principal_id`). They are inherently OWNER-scoped: the `memory_id`
///   is parsed from the `activity_id`, the row is looked up via [`friday_storage::memory::get`],
///   and it is surfaced ONLY if `memory_item.principal_id == owner_principal`. A missing
///   `memory_item`, an unowned (`None`) row, or any other owner ⇒ SKIPPED (fail-closed — never
///   surface another owner's, or an unowned, review item).
///
/// The title/deep-link are refs-only (the producer's already-body-free `summary`, and
/// `memory/{scope}/{id}` for a review) — never candidate content / approval params. The shared
/// [`reject_forbidden_output`] guard still runs over the whole snapshot in the caller as a backstop.
fn collect_actionable_needs_me(
    db: &Db,
    conn: &rusqlite::Connection,
    run_id: &str,
    owner_principal: &str,
) -> Result<Vec<Value>, String> {
    // This run's STILL-pending approval nonces (oldest-first). The owner gate already ran, so
    // these are this owner's nonces — `approval-needs-me-{nonce}` is the producer's id scheme.
    let pending_approvals: std::collections::HashMap<String, (String, String)> =
        friday_storage::list_pending_requests_for_run(conn, run_id)
            .map_err(|_| "read_failed".to_string())?
            .into_iter()
            .filter(|p| p.status == "pending")
            .map(|p| {
                (
                    format!("{APPROVAL_ACTIVITY_PREFIX}{}", p.approval_id),
                    (p.approval_id, p.action_digest),
                )
            })
            .collect();

    let mut out: Vec<Value> = Vec::new();
    for row in db.list_activity().map_err(|_| "read_failed".to_string())? {
        match row.kind.as_str() {
            // approval_required: surface ONLY if it is one of THIS run's live pending nonces.
            "approval_required" if pending_approvals.contains_key(&row.activity_id) => {
                let Some((nonce, action_digest)) = pending_approvals.get(&row.activity_id) else {
                    continue;
                };
                out.push(json!({
                    "kind": "approval_required",
                    // The producer's body-free summary ("approval required for {action} ...").
                    "title": row.summary,
                    // Where a surface acts on it: the owner-authed approve/reject control for the
                    // run + nonce (a ref, not a body).
                    "deep_link": format!("run/{run_id}/approval/{nonce}"),
                    "ref_id": nonce,
                    "state": row.state,
                    "activity_id": row.activity_id,
                    "action_digest": action_digest,
                    "summary": row.summary,
                    "signing_request": {
                        "run_id": run_id,
                        "approval_id": nonce,
                        "action_digest": action_digest,
                        "summary": row.summary,
                    },
                }));
            }
            // memory_review: owner-scope by joining the parsed memory_id back to its
            // `memory_item.principal_id`. Skip a missing / unowned / other-owner row (fail-closed).
            "memory_review" => {
                let Some(memory_id) = row.activity_id.strip_prefix(MEMORY_REVIEW_ACTIVITY_PREFIX)
                else {
                    continue;
                };
                // Owner-scope by the candidate's owning principal. `list_activity` drops
                // `deep_link`, so the review destination is reconstructed from the memory row's
                // own scope (`memory/{scope}/{id}`, a refs-only label — never candidate content).
                let Some(mem) = friday_storage::memory::get(conn, memory_id)
                    .map_err(|_| "read_failed".to_string())?
                else {
                    continue;
                };
                let owned_by_caller = mem
                    .principal_id
                    .as_deref()
                    .is_some_and(|pid| pid == owner_principal);
                if !owned_by_caller {
                    continue;
                }
                out.push(json!({
                    "kind": "memory_review",
                    // The producer's body-free summary ("{reason} ({destination})").
                    "title": row.summary,
                    // Where the user reviews it: the memory item's review entry (refs-only).
                    "deep_link": format!("memory/{}/{}", mem.scope.as_str(), memory_id),
                    "ref_id": memory_id,
                    "state": row.state,
                    "activity_id": row.activity_id,
                }));
            }
            _ => {}
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_str, Value};

    #[test]
    fn derive_loop_status_maps_terminal_markers_to_bounded_labels() {
        assert_eq!(
            derive_loop_status(&["plan.none".into(), "agent.finished".into()]),
            "finished"
        );
        // finished wins even if an error appears earlier (terminal success marker present).
        assert_eq!(
            derive_loop_status(&["agent.error:x".into(), "agent.finished".into()]),
            "finished"
        );
        assert_eq!(
            derive_loop_status(&["plan.none".into(), "agent.error:parse_error".into()]),
            "errored"
        );
        assert_eq!(
            derive_loop_status(&["plan.none".into(), "agent.loop_bounded".into()]),
            "bounded"
        );
        assert_eq!(
            derive_loop_status(&["tool.paused:requires_approval:write_file".into()]),
            "paused"
        );
        assert_eq!(
            derive_loop_status(&["tool.blocked:deny:reason".into()]),
            "blocked"
        );
        assert_eq!(derive_loop_status(&[]), "no_events");
        assert_eq!(derive_loop_status(&["plan.none".into()]), "in_progress");
        // The returned label is always from the closed vocabulary (never an event slice).
        let label = derive_loop_status(&["agent.error:LEAK_CANARY_modeltext".into()]);
        assert_eq!(label, "errored");
        assert!(!label.contains("LEAK_CANARY_modeltext"));
    }

    #[test]
    fn forbidden_output_guard_blocks_task_body_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"task":"raw run body"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/secret"}"#).is_err());
        // A RELATIVE filename inside an event kind is allowed (not over-redacted).
        assert!(reject_forbidden_output(
            r#"{"event_kinds":["tool.executed:read 15 bytes from notes.md"],"ok":true}"#
        )
        .is_ok());
    }

    const OWNER: &str = "principal:r2-proj-owner";

    #[test]
    fn project_run_readback_round_trips_a_seeded_run_refs_only() {
        use friday_storage::agent_run::{create_run, record_event};
        use friday_storage::{persist_run_result, RunResult};
        // Seed a run with events through the WRITE path, then read it back through the projection.
        let path = std::env::temp_dir()
            .join(format!(
                "friday-r2-projection-{}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();
        let now = 1_780_640_000_000;
        create_run(
            db.conn(),
            "run-r2-proj",
            "raw task body that must never leak",
            now,
        )
        .unwrap();
        record_event(db.conn(), "ev-r2-1", "run-r2-proj", "plan.none", now + 1).unwrap();
        record_event(
            db.conn(),
            "ev-r2-2",
            "run-r2-proj",
            "tool.executed:read 15 bytes from notes.md",
            now + 2,
        )
        .unwrap();
        record_event(
            db.conn(),
            "ev-r2-3",
            "run-r2-proj",
            "agent.finished",
            now + 3,
        )
        .unwrap();
        // M-3: a finished run records its bound OWNER principal via `run_result.owner_principal`
        // (the all-state owner axis `resolve_run_owner` reads), so the owner gate Grants the owner.
        persist_run_result(
            db.conn(),
            "run-r2-proj",
            &RunResult::new("finished", "owner-only answer body", None).with_owner_principal(OWNER),
            now + 4,
        )
        .unwrap();
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        // The OWNER reads its own run back — the happy path is preserved (a `Some` snapshot).
        let snapshot = project_run_readback(&ro, OWNER, "run-r2-proj")
            .expect("projects")
            .expect("the owner gets a snapshot");
        let v: Value = from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();

        assert_eq!(v["run_id"], "run-r2-proj");
        assert_eq!(v["loop_status_derived"], "finished");
        assert_eq!(v["turn_count"], 1);
        assert_eq!(v["executed_tool_count"], 1);
        assert_eq!(v["event_count"], 3);
        // DB-wide token totals are present + labelled DB-wide (here 0 — no model calls).
        assert_eq!(v["db_wide_token_total"], 0);
        assert!(v.get("db_wide_token_prompt_total").is_some());
        // Refs-only: the run task body never appears.
        assert!(
            v.get("task").is_none(),
            "must never carry the run task body"
        );
        let rendered = serde_json::to_string(&snapshot).unwrap();
        assert!(!rendered.contains("raw task body"));
        assert!(!rendered.contains("\"task\""));
        // Refs-only: the owner-only answer body never rides the readback snapshot either.
        assert!(!rendered.contains("owner-only answer body"));
    }

    #[test]
    fn project_run_readback_unknown_run_is_fail_closed() {
        let path = std::env::temp_dir()
            .join(format!("friday-r2-unknown-{}.sqlite", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();
        drop(db);
        let ro = Db::open_hub_readonly(&path).unwrap();
        // M-3: an unknown run is owner-less, so the gate collapses it to `Ok(None)` BEFORE the
        // summary read — fail-closed and INDISTINGUISHABLE from the not-owner case (the anti-oracle
        // property). The wire outcome is unchanged: the server maps this `Ok(None)` to the same
        // `run_not_found` typed error a non-existent run produced before.
        assert_eq!(
            project_run_readback(&ro, OWNER, "no-such-run").unwrap(),
            None
        );
    }

    #[test]
    fn project_run_readback_non_owner_is_fail_closed_no_oracle() {
        use friday_storage::agent_run::{create_run, record_event};
        use friday_storage::{persist_run_result, RunResult};
        // Seed a finished run OWNED by principal A.
        let path = std::env::temp_dir()
            .join(format!("friday-r2-nonowner-{}.sqlite", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();
        let now = 1_780_640_000_000;
        create_run(db.conn(), "run-r2-owned-by-a", "secret task body", now).unwrap();
        record_event(
            db.conn(),
            "ev-a-1",
            "run-r2-owned-by-a",
            "agent.finished",
            now + 1,
        )
        .unwrap();
        persist_run_result(
            db.conn(),
            "run-r2-owned-by-a",
            &RunResult::new("finished", "A's answer", None)
                .with_owner_principal("principal:owner-A"),
            now + 2,
        )
        .unwrap();
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        // The OWNER (A) reads it back — `Some` (control: the run genuinely exists + is readable).
        assert!(
            project_run_readback(&ro, "principal:owner-A", "run-r2-owned-by-a")
                .unwrap()
                .is_some()
        );
        // A DIFFERENT verified caller (B) reading A's run → `Ok(None)` — the M-3 gate. B learns
        // nothing: no body, no owner id, no existence/state oracle (identical to an unknown run).
        assert_eq!(
            project_run_readback(&ro, "principal:owner-B", "run-r2-owned-by-a").unwrap(),
            None
        );
        // An EMPTY caller is never an owner (fail-closed) → `Ok(None)`.
        assert_eq!(
            project_run_readback(&ro, "", "run-r2-owned-by-a").unwrap(),
            None
        );
    }

    #[test]
    fn project_run_readback_no_resolvable_owner_run_is_fail_closed_even_for_the_owner() {
        use friday_storage::agent_run::{create_run, record_event};
        // Seed an IN-PROGRESS run: an `agent_run` row + a non-terminal event, but NO pending
        // approval row and NO `run_result` — so `resolve_run_owner` returns `None` (M-3 behavior
        // change). Pre-M-3 this run read back a snapshot for anyone; now it fails closed.
        let path = std::env::temp_dir()
            .join(format!(
                "friday-r2-inprogress-{}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();
        let now = 1_780_640_000_000;
        create_run(db.conn(), "run-r2-in-progress", "task body", now).unwrap();
        record_event(
            db.conn(),
            "ev-ip-1",
            "run-r2-in-progress",
            "plan.none",
            now + 1,
        )
        .unwrap();
        // No pending row, no run_result ⇒ no resolvable owner.
        assert_eq!(
            crate::agent_run_control::resolve_run_owner(db.conn(), "run-r2-in-progress").unwrap(),
            None,
            "a run with no pending row and no run_result has no resolvable owner"
        );
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        // Even a non-empty, plausible owner principal gets `Ok(None)` — the run has no resolvable
        // owner, so NO caller is its owner (fail-closed; no owner-less fallback). This is the M-3
        // tightening: a verified owner can no longer read back their own non-terminal run.
        assert_eq!(
            project_run_readback(&ro, "principal:some-owner", "run-r2-in-progress").unwrap(),
            None
        );
    }

    // ===== NS-7 / NS-8 closure: the consumer now READS the actionable producer rows =====

    use friday_core::{MemoryScope, MemoryState};
    use friday_storage::memory::{record_candidate, NewMemoryCandidate};
    use friday_storage::{
        insert_pending_approval_activity, persist_pending_request, PendingApprovalRequest,
    };

    /// Seed a PAUSED run owned by `owner`: ONE still-`pending` approval row (so `resolve_run_owner`
    /// binds the owner and `detect_pause` reports a pause) bound to `nonce`. Returns nothing — the
    /// caller drives the activity producers on top. Mirrors the live Pause arm's persistence.
    fn seed_paused_run(
        conn: &rusqlite::Connection,
        run_id: &str,
        owner: &str,
        nonce: &str,
        now: i64,
    ) {
        let pending = PendingApprovalRequest {
            approval_id: nonce.to_string(),
            run_id: run_id.to_string(),
            action: "write_file".to_string(),
            action_digest: format!("digest-{nonce}"),
            principal_id: Some(owner.to_string()),
            surface: "agent".to_string(),
            resource_type: None,
            resource_id: None,
            expires_at: now + 60_000,
            issuer: "friday_canonical_gate".to_string(),
            status: "pending".to_string(),
            created_at: now,
            tool_params: None,
        };
        persist_pending_request(conn, &pending).unwrap();
    }

    /// E2E gate — seed an owner's `memory_review` candidate via the REAL producer path
    /// (`record_candidate`, which sets `principal_id`) + the producer's exact activity id scheme,
    /// then assert the consumer surfaces it in `actionable_needs_me`. ALSO covers the
    /// `approval_required` row via its real producer (`insert_pending_approval_activity`), and that
    /// the pre-existing `needs_me` (detect_pause) item still surfaces unchanged (no-degrade).
    #[test]
    fn actionable_needs_me_surfaces_memory_review_and_approval_required_for_the_owner() {
        let owner = "principal:ns-owner";
        let run_id = "run-ns-actionable";
        let nonce = "nonceAAAA1111";
        let memory_id = "mem-ns-1";
        let now = 1_780_650_000_000;

        let path = std::env::temp_dir()
            .join(format!(
                "friday-ns-actionable-{}.sqlite",
                std::process::id()
            ))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();

        // (1) PAUSED + owned run (pending approval row). This is the owner gate + detect_pause anchor.
        seed_paused_run(db.conn(), run_id, owner, nonce, now);

        // (2) approval_required activity row — via the REAL NS-7 producer for this run + nonce.
        insert_pending_approval_activity(db.conn(), run_id, nonce, "write_file", now).unwrap();

        // (3) memory_review: a REAL pending candidate OWNED by `owner` (sets memory_item.principal_id),
        //     plus the NS-8 producer's exact activity row (id = "memory-review-needs-me-{memory_id}").
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id,
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("a candidate fact"),
                principal_id: Some(owner),
                sensitive: false,
                created_at: now,
            },
        )
        .unwrap();
        assert_eq!(
            friday_storage::memory::get(db.conn(), memory_id)
                .unwrap()
                .unwrap()
                .state,
            MemoryState::Candidate
        );
        // Compose the activity row through the REAL NS-8 producer so the producer↔consumer
        // `activity_id` scheme is bound by THIS test (a producer-side drift fails it) — not
        // agreed only by a hand-typed literal.
        let review_row = crate::memory_extraction::memory_review_activity_row(
            memory_id,
            MemoryState::Candidate,
            MemoryScope::Session,
            "a candidate fact",
            now,
        )
        .expect("a pending candidate yields a memory_review activity row");
        db.insert_activity(&review_row).unwrap();
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        let snapshot = project_activity_needs_me(&ro, owner, run_id)
            .expect("projects")
            .expect("the owner gets a snapshot");
        let v: Value = from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();

        // No-degrade: the pre-existing detect_pause needs_me item still surfaces unchanged.
        assert!(
            !v["needs_me"].is_null(),
            "the pre-existing detect_pause Needs-Me item must still surface"
        );
        assert_eq!(v["needs_me"]["kind"], "approval");
        assert_eq!(v["needs_me"]["ref_id"], nonce);
        assert_eq!(v["needs_me"]["action_digest"], format!("digest-{nonce}"));
        assert_eq!(v["needs_me"]["summary"], "paused on write_file");
        assert_eq!(v["needs_me"]["signing_request"]["run_id"], run_id);
        assert_eq!(v["needs_me"]["signing_request"]["approval_id"], nonce);
        assert_eq!(
            v["needs_me"]["signing_request"]["action_digest"],
            format!("digest-{nonce}")
        );

        // The NEW actionable array surfaces BOTH the memory_review and the approval_required rows.
        let actionable = v["actionable_needs_me"].as_array().expect("array");
        assert_eq!(
            v["actionable_needs_me_count"].as_u64(),
            Some(actionable.len() as u64)
        );
        let kinds: Vec<&str> = actionable
            .iter()
            .map(|i| i["kind"].as_str().unwrap())
            .collect();
        assert!(
            kinds.contains(&"memory_review"),
            "memory_review must appear in actionable_needs_me, got {kinds:?}"
        );
        assert!(
            kinds.contains(&"approval_required"),
            "approval_required must appear in actionable_needs_me, got {kinds:?}"
        );

        // memory_review item: refs-only shape (ref_id = memory_id, deep_link = memory/{scope}/{id}).
        let mr = actionable
            .iter()
            .find(|i| i["kind"] == "memory_review")
            .unwrap();
        assert_eq!(mr["ref_id"], memory_id);
        assert_eq!(mr["deep_link"], "memory/session/mem-ns-1");
        assert_eq!(mr["state"], "pending");

        // approval_required item: ref_id = the run's live nonce, deep_link = run/{run}/approval/{nonce}.
        let ar = actionable
            .iter()
            .find(|i| i["kind"] == "approval_required")
            .unwrap();
        assert_eq!(ar["ref_id"], nonce);
        assert_eq!(ar["deep_link"], format!("run/{run_id}/approval/{nonce}"));
        assert_eq!(ar["action_digest"], format!("digest-{nonce}"));
        assert_eq!(ar["signing_request"]["run_id"], run_id);
        assert_eq!(ar["signing_request"]["approval_id"], nonce);
        assert_eq!(
            ar["signing_request"]["action_digest"],
            format!("digest-{nonce}")
        );
    }

    /// no-degrade regression: the pre-existing ask_receipt + detect_pause Needs-Me items still
    /// surface unchanged on a run that has NO actionable producer rows (the actionable array is
    /// simply empty — the existing surface is byte-equivalent to before).
    #[test]
    fn actionable_needs_me_preserves_ask_receipt_and_detect_pause_unchanged() {
        use friday_storage::ActivityRow;
        let owner = "principal:ns-nodegrade";
        let run_id = "run-ns-nodegrade";
        let nonce = "nonceBBBB2222";
        let now = 1_780_651_000_000;

        let path = std::env::temp_dir()
            .join(format!("friday-ns-nodegrade-{}.sqlite", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();
        seed_paused_run(db.conn(), run_id, owner, nonce, now);
        // An ask_receipt row for THIS run (the `{run_id}:t{n}:askreceipt` id scheme).
        db.insert_activity(&ActivityRow {
            activity_id: format!("{run_id}:t0:askreceipt"),
            session_id: Some(run_id.to_string()),
            kind: friday_core::ActivityType::AskReceipt,
            state: friday_core::ActivityState::Done,
            summary: "42 tokens via claude".to_string(),
            created_at: now,
            updated_at: now,
            deep_link: None,
        })
        .unwrap();
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        let snapshot = project_activity_needs_me(&ro, owner, run_id)
            .unwrap()
            .unwrap();
        let v: Value = from_str(&serde_json::to_string(&snapshot).unwrap()).unwrap();

        // ask_receipt surface unchanged.
        assert_eq!(v["ask_receipt_count"], 1);
        assert_eq!(v["ask_receipts"][0]["summary"], "42 tokens via claude");
        // detect_pause needs_me unchanged.
        assert_eq!(v["needs_me"]["ref_id"], nonce);
        assert_eq!(v["needs_me"]["status"], "awaiting_approval");
        // No actionable producer rows ⇒ the new array is empty (additive, not destructive).
        assert_eq!(v["actionable_needs_me"].as_array().unwrap().len(), 0);
        assert_eq!(v["actionable_needs_me_count"], 0);
    }

    /// owner-isolation: O2 (who owns their OWN paused run) must NOT see O's memory_review or
    /// approval_required actionable items. Critically O2 OWNS a run, so the projection returns
    /// `Some` (the gate Grants O2) — making the EXCLUSION assertion load-bearing, not vacuous.
    #[test]
    fn actionable_needs_me_owner_isolation_o2_does_not_see_o_items() {
        let o = "principal:iso-O";
        let o2 = "principal:iso-O2";
        let o_run = "run-iso-O";
        let o2_run = "run-iso-O2";
        let o_nonce = "nonceO00011112";
        let o2_nonce = "nonceO2_222233";
        let o_mem = "mem-iso-O";
        let now = 1_780_652_000_000;

        let path = std::env::temp_dir()
            .join(format!("friday-ns-iso-{}.sqlite", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();

        // O's paused run + O's actionable rows.
        seed_paused_run(db.conn(), o_run, o, o_nonce, now);
        insert_pending_approval_activity(db.conn(), o_run, o_nonce, "write_file", now).unwrap();
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: o_mem,
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("O's candidate"),
                principal_id: Some(o),
                sensitive: false,
                created_at: now,
            },
        )
        .unwrap();
        db.insert_activity(
            &crate::memory_extraction::memory_review_activity_row(
                o_mem,
                MemoryState::Candidate,
                MemoryScope::Session,
                "O's candidate",
                now,
            )
            .expect("a pending candidate yields a memory_review activity row"),
        )
        .unwrap();

        // O2 ALSO owns a paused run (so the gate Grants O2 a Some snapshot — non-vacuous test).
        seed_paused_run(db.conn(), o2_run, o2, o2_nonce, now);
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();

        // O2 reads back O2's OWN run: gate Grants (Some), but it carries NONE of O's items.
        let o2_snap = project_activity_needs_me(&ro, o2, o2_run)
            .unwrap()
            .expect("O2 owns o2_run so the gate grants a snapshot");
        let v2: Value = from_str(&serde_json::to_string(&o2_snap).unwrap()).unwrap();
        let o2_actionable = v2["actionable_needs_me"].as_array().unwrap();
        let rendered2 = serde_json::to_string(&o2_snap).unwrap();
        assert!(
            !rendered2.contains(o_mem) && !rendered2.contains(o_nonce),
            "O2's snapshot must not surface O's memory_id or approval nonce"
        );
        assert!(
            o2_actionable.is_empty(),
            "O2 owns no actionable producer rows, got {o2_actionable:?}"
        );

        // O2 reading O's run is a non-owner ⇒ `Ok(None)` (the M-3 anti-oracle gate, unchanged).
        assert_eq!(project_activity_needs_me(&ro, o2, o_run).unwrap(), None);

        // Sanity: O DOES see O's items (proves the rows exist and the filter is owner-keyed, not empty).
        let o_snap = project_activity_needs_me(&ro, o, o_run).unwrap().unwrap();
        let vo: Value = from_str(&serde_json::to_string(&o_snap).unwrap()).unwrap();
        let o_kinds: Vec<&str> = vo["actionable_needs_me"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap())
            .collect();
        assert!(o_kinds.contains(&"memory_review") && o_kinds.contains(&"approval_required"));
    }

    /// fail-closed: a `memory_review` activity row whose `memory_item` is UNOWNED (`principal_id =
    /// None`) is SKIPPED — never surfaced to the run owner (no unowned leak).
    #[test]
    fn actionable_needs_me_skips_unowned_memory_review() {
        let owner = "principal:unowned-test";
        let run_id = "run-unowned";
        let nonce = "nonceUUUU3333";
        let mem = "mem-unowned";
        let now = 1_780_653_000_000;

        let path = std::env::temp_dir()
            .join(format!("friday-ns-unowned-{}.sqlite", std::process::id()))
            .to_string_lossy()
            .into_owned();
        let db = Db::open_hub(&path).unwrap();
        seed_paused_run(db.conn(), run_id, owner, nonce, now);
        // An UNOWNED candidate (principal_id = None).
        record_candidate(
            db.conn(),
            &NewMemoryCandidate {
                memory_id: mem,
                scope: MemoryScope::Session,
                content_ref: None,
                content: Some("unowned"),
                principal_id: None,
                sensitive: false,
                created_at: now,
            },
        )
        .unwrap();
        db.insert_activity(
            &crate::memory_extraction::memory_review_activity_row(
                mem,
                MemoryState::Candidate,
                MemoryScope::Session,
                "unowned",
                now,
            )
            .expect("a pending candidate yields a memory_review activity row"),
        )
        .unwrap();
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        let snap = project_activity_needs_me(&ro, owner, run_id)
            .unwrap()
            .unwrap();
        let v: Value = from_str(&serde_json::to_string(&snap).unwrap()).unwrap();
        let kinds: Vec<&str> = v["actionable_needs_me"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["kind"].as_str().unwrap())
            .collect();
        assert!(
            !kinds.contains(&"memory_review"),
            "an UNOWNED memory_review row must never surface, got {kinds:?}"
        );
    }
}
