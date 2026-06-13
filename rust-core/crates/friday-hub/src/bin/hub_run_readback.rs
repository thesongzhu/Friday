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
//! ## M-3 OWNER GATE — the readback is now owner-scoped
//! `project_run_readback` is owner-gated: it reads back a run ONLY for its bound
//! owner principal (`resolve_run_owner`, the all-state owner axis). This bin
//! supplies the asserted owner via `--owner <principal>` (the configured owner the
//! run was bound to). The owner is NEVER resolved from the run's own row (that would
//! re-open the cross-principal oracle M-3 closes). A missing/blank `--owner` ⇒ an
//! empty caller ⇒ the gate fails closed; a not-owner / owner-less / unknown run all
//! collapse to the bin's existing `run_not_found` error kind (indistinguishable, no
//! existence/state oracle).
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

use friday_hub::run_readback_projection::project_run_readback;
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
            // Defense-in-depth: route the error payload through the SAME shared guard as the
            // success path (fail closed if a marker ever leaked). `error_kind` is a static
            // closed-vocab token today, so this never suppresses output.
            let rendered = payload.to_string();
            if friday_hub::run_readback_projection::reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
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

    // M-3: the run-readback projection is now OWNER-GATED — it reads back a run ONLY for its bound
    // owner principal. This operator-local readback supplies the owner principal via `--owner` (the
    // configured owner the run was bound to). It is NEVER resolved from the run's own row (that would
    // re-open the cross-principal oracle the M-3 gate closes); a caller asserts WHO it is, and the
    // gate matches that against the run's bound owner. A missing/blank `--owner` ⇒ an empty caller
    // ⇒ the gate fails closed (`Ok(None)` ⇒ `run_not_found`), mirroring the read server's
    // blank-allowlist discipline (a readback with no asserted owner reads nothing).
    let owner = arg_value(&args, "--owner").unwrap_or_default();

    // Read-only open: a readback can NEVER mutate an operator DB just because TS asks.
    let db = Db::open_hub_readonly(&db_path).map_err(|_| ReadbackError::new("open_failed"))?;

    // S-R2: the refs-only projection (state/loop-status/event-kinds/counts + DB-WIDE token totals,
    // with the forbidden-output guard run INSIDE) is the SHARED library fn so this bin and the DARK
    // read-projection server cannot drift. Map the projection's coarse error string back to this
    // bin's exact error-kind vocabulary (so its stderr/exit contract is unchanged). M-3: a
    // non-owner / owner-less / unknown run all yield `Ok(None)` from the owner gate — surface it as
    // the bin's existing `run_not_found` so not-owner is indistinguishable from unknown-run.
    let snapshot = project_run_readback(&db, &owner, &run_id)
        .map_err(map_projection_error)?
        .ok_or_else(|| ReadbackError::new("run_not_found"))?;
    serde_json::to_string(&snapshot).map_err(|_| ReadbackError::new("serialize_failed"))
}

/// Map the shared projection's coarse error string into this bin's `&'static str` error-kind
/// vocabulary so the bin's stderr/exit-2 contract is byte-unchanged from before the extraction.
fn map_projection_error(err: String) -> ReadbackError {
    let kind = match err.as_str() {
        "run_not_found" => "run_not_found",
        "serialize_failed" => "serialize_failed",
        _ if err.starts_with("forbidden marker") => "output_guard",
        // "read_failed" and any other coarse read/serialize failure.
        _ => "read_failed",
    };
    ReadbackError::new(kind)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/tmp/hub.sqlite".to_string(),
            "--run-id=run-xyz".to_string(),
            "--owner".to_string(),
            "principal:owner-x".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(arg_value(&args, "--run-id").as_deref(), Some("run-xyz"));
        // M-3: the owner principal the readback gates on (space-form parse).
        assert_eq!(
            arg_value(&args, "--owner").as_deref(),
            Some("principal:owner-x")
        );
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn map_projection_error_preserves_the_exact_error_kind_vocabulary() {
        // The shared projection's coarse strings map back to this bin's stable `&'static str`
        // error-kind vocab (so the bin's stderr/exit-2 contract is unchanged by the extraction).
        assert_eq!(
            map_projection_error("run_not_found".into()).kind,
            "run_not_found"
        );
        assert_eq!(
            map_projection_error("read_failed".into()).kind,
            "read_failed"
        );
        assert_eq!(
            map_projection_error("serialize_failed".into()).kind,
            "serialize_failed"
        );
        assert_eq!(
            map_projection_error("forbidden marker in projection: Bearer".into()).kind,
            "output_guard"
        );
        // An unknown coarse string fails closed to `read_failed` (never a panic / never a leak).
        assert_eq!(
            map_projection_error("something_else".into()).kind,
            "read_failed"
        );
    }
}
