//! The `surface_event` timeline PRODUCER (`FRIDAY_SURFACE_EVENTS`, DARK, default-OFF).
//!
//! Registry path #6: the storage (`surface_event` table), the [`friday_core::SurfaceEvent`]
//! struct, the persist (`upsert_surface_event`), AND the workbench-timeline READER
//! ([`crate::workbench_projection::project_workbench`] → `append_surface_events`, which reads
//! [`friday_storage::Db::list_surface_events_for_mission`]) all already exist — but NOTHING emits
//! `surface_event` rows on the live path, so the Mission Workbench timeline is empty of surface
//! events. This module is the missing PRODUCER. It is the ONLY new emit; it reuses the existing
//! [`friday_storage::Db::upsert_surface_event`] persist (no reimplementation) and never touches the
//! reader.
//!
//! ## No-degrade · best-effort · refs-only
//! Every emit is GATED by [`crate::FRIDAY_SURFACE_EVENTS`] (read once at each producer entry,
//! threaded in as a pure bool). Flag-OFF ⇒ the caller skips this module entirely ⇒ byte-identical.
//! Each emit is BEST-EFFORT / failure-isolated: a write failure is logged + swallowed and NEVER
//! fails the run or the intake (the run/proof path is load-bearing; the timeline is observability).
//! The rows carry only Friday-owned REFS (`body_ref` / `proof_ref` validated by the storage layer),
//! never raw transcript / provider text.

use friday_core::{SurfaceEvent, SurfaceEventKind, SurfaceKind, SurfaceThread, VisibilityPolicy};
use friday_storage::Db;

/// One lifecycle point at which a `surface_event` is emitted. Each maps to a defined
/// [`SurfaceEventKind`] — we use ONLY existing kinds (no new kinds invented):
/// - [`Self::IntakeBirth`] ⇒ [`SurfaceEventKind::SystemStatus`]: a Mission was just born from a
///   surface input — a system-level lifecycle fact, not a user/Friday/provider chat message.
/// - [`Self::RunStarted`] ⇒ [`SurfaceEventKind::ProviderTrace`]: Friday dispatched the bound
///   WorkItem to its provider/agent (the reader renders this as `provider_ack` — honest: a run is
///   in flight, NOT yet completion).
/// - [`Self::RunCompletedWithProof`] ⇒ [`SurfaceEventKind::ProofReceipt`]: the run Finished and the
///   bound WorkItem reached `CompletedWithProof` with the run as proof (the reader renders this as
///   `completed_with_proof` — the unambiguous done state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SurfaceEventLifecycle {
    IntakeBirth,
    RunStarted,
    RunCompletedWithProof,
}

impl SurfaceEventLifecycle {
    fn event_kind(self) -> SurfaceEventKind {
        match self {
            SurfaceEventLifecycle::IntakeBirth => SurfaceEventKind::SystemStatus,
            SurfaceEventLifecycle::RunStarted => SurfaceEventKind::ProviderTrace,
            SurfaceEventLifecycle::RunCompletedWithProof => SurfaceEventKind::ProofReceipt,
        }
    }

    /// The stable, idempotent `surface_event_id` slug per lifecycle point. Keying on the stable
    /// id (the `mission_id` for the once-per-mission birth, the `run_id` for the per-run points)
    /// makes a re-emit a clean UPSERT (`ON CONFLICT(surface_event_id) DO UPDATE`) — never a
    /// duplicate row.
    fn event_id(self, mission_id: &str, run_id: &str) -> String {
        match self {
            SurfaceEventLifecycle::IntakeBirth => {
                format!("surface_event:intake:{mission_id}")
            }
            SurfaceEventLifecycle::RunStarted => {
                format!("surface_event:run-start:{run_id}")
            }
            SurfaceEventLifecycle::RunCompletedWithProof => {
                format!("surface_event:run-proof:{run_id}")
            }
        }
    }
}

/// The fully-resolved linkage a `surface_event` needs to satisfy `validate_surface_event`:
/// an existing Mission (conversation match), an existing SurfaceThread bound to that Mission with a
/// matching `surface_kind`, and (optionally) a WorkItem of that Mission.
pub(crate) struct SurfaceEventLink<'a> {
    pub friday_conversation_id: &'a str,
    pub mission_id: &'a str,
    pub work_item_id: Option<&'a str>,
    pub surface_thread_id: &'a str,
    pub source_surface: SurfaceKind,
}

/// Emit ONE `surface_event` for `lifecycle`, BEST-EFFORT. `enabled = false` (the prod default) ⇒
/// returns immediately with NO write (the caller already skips this on flag-OFF; this is a second
/// belt-and-suspenders guard so the byte-identical-off invariant holds even on a stray call). On a
/// persist error (e.g. the linkage validation rejects it) the error is logged to `stderr` and
/// SWALLOWED — the caller's run/intake outcome is NEVER affected.
///
/// `proof_ref` is included ONLY for the proof point and MUST be a Friday-owned `proof://`/`audit://`
/// ref (the storage layer's `require_safe_surface_proof_ref` enforces this); a `body_ref` (when
/// present) MUST be a `friday://body/` / `friday://surface-event-body/` / `blob://` ref.
#[allow(clippy::too_many_arguments)]
pub(crate) fn emit_surface_event(
    db: &Db,
    enabled: bool,
    lifecycle: SurfaceEventLifecycle,
    link: &SurfaceEventLink<'_>,
    run_id: &str,
    body_ref: Option<String>,
    proof_ref: Option<String>,
    now_ms: i64,
) {
    if !enabled {
        return;
    }
    let event = SurfaceEvent {
        surface_event_id: lifecycle.event_id(link.mission_id, run_id),
        friday_conversation_id: link.friday_conversation_id.to_string(),
        mission_id: link.mission_id.to_string(),
        work_item_id: link.work_item_id.map(str::to_string),
        surface_thread_id: link.surface_thread_id.to_string(),
        source_surface: link.source_surface,
        event_kind: lifecycle.event_kind(),
        body_ref,
        // The timeline row is refs-only observability, so a Compact policy is correct (a proof
        // point still carries its proof_ref; the reader applies its own visibility shaping).
        visibility_policy: VisibilityPolicy::Compact,
        proof_ref,
        created_at_ms: now_ms,
    };
    // BEST-EFFORT / failure-isolated: a surface_event is OBSERVABILITY, never load-bearing. A write
    // failure is logged + swallowed so it can NEVER fail the run or the intake. (Mirrors the
    // memory-extraction producer's `let _ =` swallow at the run-finish point.)
    if let Err(err) = db.upsert_surface_event(&event) {
        eprintln!(
            "[surface-events] non-fatal: emit {kind} for mission {mission} failed: {err}",
            kind = lifecycle.event_kind().as_str(),
            mission = link.mission_id,
        );
    }
}

/// Resolve the SurfaceThread bound to `mission_id` for the RUN lifecycle points (intake builds its
/// thread inline and does NOT call this). The resolved mission context carries an OPTIONAL
/// `surface_thread_id` (the `by_mission_work_item` lookup the live mission-bound run uses leaves it
/// `None`), so the producer resolves the bound thread by the surface_thread row's OWN `mission_id`
/// column here (index-backed `list_surface_threads_for_mission`).
///
/// If a mission has been consumed from multiple surfaces, prefer the thread whose conversation
/// matches the current mission-bound envelope. This keeps storage's strict
/// Mission/SurfaceThread/source-surface validation intact instead of accidentally picking the
/// oldest thread from a different surface. If no matching thread exists, fall back to the oldest
/// bound thread (the historical single-surface behavior). `Ok(None)` ⇒ no bound thread exists ⇒ the
/// caller SKIPS the emit (best-effort: a run without a bound surface thread simply produces no
/// surface_event — never an error). A storage error is logged + swallowed (returns `None`) so
/// resolution can never break the run.
pub(crate) fn resolve_bound_surface_thread(
    db: &Db,
    mission_id: &str,
    friday_conversation_id: &str,
) -> Option<SurfaceThread> {
    match db.list_surface_threads_for_mission(mission_id) {
        Ok(mut threads) => {
            let matching = threads
                .iter()
                .position(|thread| thread.friday_conversation_id == friday_conversation_id);
            matching.map(|idx| threads.remove(idx)).or_else(|| {
                if threads.is_empty() {
                    None
                } else {
                    Some(threads.remove(0))
                }
            })
        }
        Err(err) => {
            eprintln!(
                "[surface-events] non-fatal: resolve bound surface thread for mission \
                 {mission_id} failed: {err}"
            );
            None
        }
    }
}
