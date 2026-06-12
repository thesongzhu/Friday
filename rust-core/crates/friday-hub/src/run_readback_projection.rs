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
use friday_storage::audit::verify_audit_chain;
use friday_storage::Db;
use serde_json::{json, Value};

/// Project the refs-only run-readback snapshot for `run_id` from an already-opened read-only hub
/// [`Db`]. Returns the refs-only snapshot `serde_json::Value` on success.
///
/// Fail-closed: a read error, an unknown run, or a forbidden-marker leak all return `Err(String)`
/// (the SAME coarse error-kind strings the bin surfaced) — never a partial or a raw body. The
/// forbidden-output guard runs INSIDE this fn so both the bin and the read server inherit it.
pub fn project_run_readback(db: &Db, run_id: &str) -> Result<Value, String> {
    let conn = db.conn();

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
    Ok(snapshot)
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

    #[test]
    fn project_run_readback_round_trips_a_seeded_run_refs_only() {
        use friday_storage::agent_run::{create_run, record_event};
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
        drop(db);

        let ro = Db::open_hub_readonly(&path).unwrap();
        let snapshot = project_run_readback(&ro, "run-r2-proj").expect("projects");
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
        assert_eq!(
            project_run_readback(&ro, "no-such-run").unwrap_err(),
            "run_not_found"
        );
    }
}
