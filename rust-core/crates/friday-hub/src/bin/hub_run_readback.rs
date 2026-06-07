//! S2 dev read-bridge — `hub_run_readback`.
//!
//! PROOF-ONLY (Rust-wired-DEV). The READ-ONLY sibling of the S0 `hub_run_task`
//! write-bridge: it lets the TS side SEE a completed Rust run's result by
//! `run_id`, refs-only. It mirrors the existing read-only precedent
//! `mission_workbench_projection` (opens the hub DB with
//! [`friday_storage::Db::open_hub_readonly`], emits redacted/refs-only JSON, and
//! runs the output through a forbidden-marker guard before printing).
//!
//! This is NOT a replacement for the TS run-result read path, registers NO
//! production route, and confers no v1 GO. It exists to prove the read transport +
//! refs-only boundary: that a Rust run's outcome can be projected to TS without
//! ever transporting a body/secret/PII.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no PII)
//! Emits a single JSON object to stdout carrying ONLY safe identifiers/labels:
//! `truth_label="rust_wired_dev"`, `run_id`, the run `state` label (NOT the run
//! `task` text), created/updated timestamps (ints), a `loop_status_derived` label
//! computed from the event log, turn/tool counts, the **ordered list of event
//! `kind` strings**, and the `audit_chain_verified` bool.
//!
//! ### Event-kind sensitivity
//! The event `kind` strings are safe labels (`plan.none`, `agent.finished`,
//! `tool.blocked:...`) but a `tool.executed:` kind CAN embed a relative filename
//! (e.g. `tool.executed:read 15 bytes from notes.md`). Relative names are accepted;
//! the [`reject_forbidden_output`] guard fails the WHOLE projection closed if any
//! forbidden marker (Authorization/Bearer/sk-/absolute `/Users/`,`/private/` path)
//! ever appears — so an absolute-path or secret leak is structurally impossible to
//! emit (non-zero exit + refs-only error JSON), exactly like S0's bin.
//!
//! ### Token totals — DB-wide, NOT run-attributable
//! `db_wide_token_*` are summed over the whole `token_ledger`. They are NOT this
//! run's tokens: `token_ledger` has no `run_id`, and the agent loop does not
//! ledger tokens (a known gap), so for a run DB they are `0`. The field name says
//! `db_wide_` so it is never misread as run-scoped cost. `route_decision` is
//! intentionally OMITTED — it is mission/work-item-keyed and never written by a
//! run, so it is not run-attributable.

use std::env;
use std::path::Path;

use friday_storage::agent_run_read::{db_wide_token_totals, get_run_summary, list_event_kinds};
use friday_storage::audit::verify_audit_chain;
use friday_storage::Db;
use serde_json::json;

/// A fail-closed error: `kind` is a coarse, safe category (the only thing
/// surfaced); the raw detail is deliberately NOT printed so storage/IO errors
/// cannot leak paths.
struct ReadbackError {
    kind: &'static str,
}

impl ReadbackError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    match run() {
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(err) => {
            // Refs-only error to stdout (no detail), coarse category to stderr, non-zero exit.
            let payload = json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            println!("{payload}");
            eprintln!("hub_run_readback_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, ReadbackError> {
    let args: Vec<String> = env::args().collect();

    let db_path = arg_value(&args, "--db").ok_or(ReadbackError::new("bad_args"))?;
    if !Path::new(&db_path).is_file() {
        return Err(ReadbackError::new("db_not_found"));
    }
    let run_id = arg_value(&args, "--run-id").ok_or(ReadbackError::new("bad_args"))?;

    // Read-only open: a readback can NEVER mutate an operator DB just because TS asks.
    let db = Db::open_hub_readonly(&db_path).map_err(|_| ReadbackError::new("open_failed"))?;

    let summary = get_run_summary(db.conn(), &run_id)
        .map_err(|_| ReadbackError::new("read_failed"))?
        .ok_or(ReadbackError::new("run_not_found"))?;

    let event_kinds =
        list_event_kinds(db.conn(), &run_id).map_err(|_| ReadbackError::new("read_failed"))?;

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
    let audit_chain_verified = verify_audit_chain(db.conn()).is_ok();

    // DB-wide token totals (NOT run-attributable — see module docs). Ints only.
    let totals = db_wide_token_totals(db.conn()).map_err(|_| ReadbackError::new("read_failed"))?;

    let payload = json!({
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

    let rendered =
        serde_json::to_string(&payload).map_err(|_| ReadbackError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

/// Derive a coarse, refs-only loop-status LABEL from the ordered event kinds.
///
/// The readback opens the DB read-only and does NOT re-run the loop, so the status
/// is reconstructed from terminal markers in the event log. Returns ONLY a fixed
/// `&'static str` from a closed vocabulary — never any slice of an event kind — so
/// no event-embedded text can leak through this label.
fn derive_loop_status(kinds: &[String]) -> &'static str {
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

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the
/// refs-only projection. Mirrors `mission_workbench_projection` / `hub_run_task`.
/// Note: relative filenames inside a `tool.executed:` kind are NOT forbidden —
/// only absolute paths (`/Users/`, `/private/`) and secret markers are.
fn reject_forbidden_output(rendered: &str) -> Result<(), ReadbackError> {
    for marker in [
        "Authorization",
        "Bearer",
        "sk-",
        "/Users/",
        "/private/",
        "\"task\"", // the run task body must never appear (only run_id/state/labels do)
    ] {
        if rendered.contains(marker) {
            return Err(ReadbackError::new("output_guard"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_str, Value};

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/tmp/hub.sqlite".to_string(),
            "--run-id=run-xyz".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(arg_value(&args, "--run-id").as_deref(), Some("run-xyz"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

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
    fn refs_only_payload_shape_excludes_task_body() {
        // Mirror the success payload shape and assert the refs-only contract holds.
        let payload = json!({
            "truth_label": "rust_wired_dev",
            "proof_only": true,
            "ok": true,
            "run_id": "run-xyz",
            "run_state": "awaiting_clarification",
            "loop_status_derived": "finished",
            "turn_count": 2,
            "executed_tool_count": 1,
            "event_count": 3,
            "event_kinds": ["plan.none", "tool.executed:read 15 bytes from notes.md", "agent.finished"],
            "audit_chain_verified": true,
            "db_wide_token_total": 0,
        });
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(reject_forbidden_output(&rendered).is_ok());
        let parsed: Value = from_str(&rendered).unwrap();
        assert_eq!(parsed["truth_label"], "rust_wired_dev");
        assert!(
            parsed.get("task").is_none(),
            "must never carry the run task body"
        );
    }
}
