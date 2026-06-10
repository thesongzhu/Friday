//! S9 dev read-bridge — `hub_workflow_run_readback`.
//!
//! PROOF-ONLY (Rust-wired-DEV). The workflow sibling of the S2 `hub_run_readback`
//! read-bridge: opens the hub DB READ-ONLY
//! ([`friday_storage::Db::open_hub_readonly`]) and emits a refs-only JSON
//! projection of ONE workflow run's `workflow_run` + `workflow_step` records (the
//! rows the EXISTING [`friday_hub::workflow_exec`] engine persists), by
//! `--run-id`.
//!
//! This is NOT a production route, NOT a TS integration, and confers no v1 GO —
//! workflow execution remains fenced in TS and is NOT product-replaced.
//!
//! ## Output contract — REFS ONLY (no bodies, no params, no evidence text)
//! One JSON object on stdout carrying ONLY safe identifiers/labels/counts:
//! `truth_label="rust_wired_dev"`, the run summary (run id / workflow name label
//! / persisted state label / timestamps), per-step summaries (step REF
//! `<run_id>:s<seq>`, seq, side-effect flag, status label, `has_evidence` BOOL),
//! step counts by status, `first_pending_seq` (the paused checkpoint of an
//! `awaiting_checkpoint` run), and the audit-chain-verified bool. The
//! `evidence_ref` TEXT (a tool-receipt summary that can embed a relative
//! filename) is structurally unselectable — the storage read helper only ever
//! projects its presence — and step params / definition bodies are not stored on
//! run rows at all. [`reject_forbidden_output`] fails the WHOLE projection closed
//! if any forbidden marker ever appears.
//!
//! Usage: `hub_workflow_run_readback --db <hub.sqlite> --run-id <id>`

use std::env;
use std::path::Path;

use friday_storage::audit::verify_audit_chain;
use friday_storage::workflow::first_pending_seq;
use friday_storage::workflow_read::{get_workflow_run_summary, list_workflow_step_summaries};
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
    let args: Vec<String> = env::args().collect();
    match run(&args) {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            // Refs-only error to stdout (no detail), coarse category to stderr, non-zero exit.
            let payload = json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            // Defense-in-depth: route the error payload through the SAME guard as the
            // success path. `error_kind` is a static closed-vocab token today, so this
            // never suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_workflow_run_readback_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run(args: &[String]) -> Result<String, ReadbackError> {
    let db_path = arg_value(args, "--db").ok_or(ReadbackError::new("bad_args"))?;
    if !Path::new(&db_path).is_file() {
        return Err(ReadbackError::new("db_not_found"));
    }
    let run_id = arg_value(args, "--run-id").ok_or(ReadbackError::new("bad_args"))?;

    // Read-only open: a readback can NEVER mutate an operator DB just because TS asks.
    let db = Db::open_hub_readonly(&db_path).map_err(|_| ReadbackError::new("open_failed"))?;

    let summary = get_workflow_run_summary(db.conn(), &run_id)
        .map_err(|_| ReadbackError::new("read_failed"))?
        .ok_or(ReadbackError::new("run_not_found"))?;
    let steps = list_workflow_step_summaries(db.conn(), &run_id)
        .map_err(|_| ReadbackError::new("read_failed"))?;
    let pending_seq =
        first_pending_seq(db.conn(), &run_id).map_err(|_| ReadbackError::new("read_failed"))?;

    // Audit chain verification over the readback DB (a bool, never the rows).
    let audit_chain_verified = verify_audit_chain(db.conn()).is_ok();

    let count_status =
        |status: &str| -> usize { steps.iter().filter(|s| s.status == status).count() };

    let step_objects: Vec<serde_json::Value> = steps
        .iter()
        .map(|s| {
            json!({
                "step_ref": s.step_id,
                "seq": s.seq,
                "has_side_effect": s.has_side_effect,
                "status": s.status,
                "has_evidence": s.has_evidence,
                "created_at_ms": s.created_at,
                "updated_at_ms": s.updated_at,
            })
        })
        .collect();

    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": summary.run_id,
        "workflow_name": summary.name,
        "run_state": summary.state,
        "created_at_ms": summary.created_at,
        "updated_at_ms": summary.updated_at,
        "step_count": steps.len(),
        "verified_count": count_status("verified"),
        "pending_count": count_status("pending"),
        "proof_pending_count": count_status("proof_pending"),
        "failed_count": count_status("failed"),
        "side_effect_step_count": steps.iter().filter(|s| s.has_side_effect).count(),
        "first_pending_seq": pending_seq,
        "steps": step_objects,
        "audit_chain_verified": audit_chain_verified,
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

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the
/// refs-only projection. Beyond the shared secret/path markers, this bin's
/// body-bearing fields must never appear: the `"evidence_ref"` text, step
/// `"params"`, and the stored `"definition_json"` body.
fn reject_forbidden_output(rendered: &str) -> Result<(), ReadbackError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &["\"evidence_ref\"", "\"params\"", "\"definition_json\""],
    )
    .map_err(|_| ReadbackError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
    use friday_hub::workflow_def::{
        store_published_version, StoredWorkflowDefV1, StoredWorkflowStepV1,
        WORKFLOW_DEF_SCHEMA_VERSION,
    };
    use friday_hub::workflow_run::run_stored_published_workflow;
    use friday_hub::FsToolExecutor;
    use friday_storage::workflow_def::DefinitionSource;
    use serde_json::{from_str, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "friday-wfrbk-{}-{}-{}",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
    }

    const SECRET: &[u8] = b"wf-readback-secret-0123456789ab";

    fn deny_all(_r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }

    fn step(id: &str, action: &str, params: &[(&str, &str)]) -> StoredWorkflowStepV1 {
        StoredWorkflowStepV1 {
            id: id.to_string(),
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            force_checkpoint: false,
            evidence_required: false,
        }
    }

    /// Seed a temp hub DB with a published definition, run it through the REAL
    /// S9 seam (stored def → loader → existing engine) against a real temp
    /// workspace, and return the DB path. This makes the readback test a genuine
    /// end-to-end: it projects rows the ENGINE persisted, not hand-inserted ones.
    fn seeded_run(tag: &str, steps: Vec<StoredWorkflowStepV1>, run_id: &str) -> String {
        let db_path = tmp(tag)
            .with_extension("sqlite")
            .to_string_lossy()
            .into_owned();
        let db = friday_storage::Db::open_hub(&db_path).unwrap();
        store_published_version(
            db.conn(),
            "wf1",
            1,
            &StoredWorkflowDefV1 {
                schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
                name: "research".into(),
                steps,
            },
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let ws = tmp(&format!("{tag}-ws"));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("notes.txt"), b"hello readback").unwrap();
        let exec = FsToolExecutor::new(&ws);
        run_stored_published_workflow(db.conn(), &exec, "wf1", run_id, SECRET, &deny_all, 200)
            .unwrap();
        db_path
    }

    fn bin_args(db: &str, run_id: &str) -> Vec<String> {
        vec![
            "hub_workflow_run_readback".to_string(),
            format!("--db={db}"),
            format!("--run-id={run_id}"),
        ]
    }

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
    fn completed_run_projects_refs_only_and_never_the_evidence_text() {
        // End-to-end: engine-persisted rows (via the real seam) → readback. The
        // verified steps carry evidence_ref TEXT in the DB ("read N bytes from
        // notes.txt") — the projection must surface ONLY the has_evidence bool.
        let db = seeded_run(
            "done",
            vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step("ls", "list_dir", &[("path", ".")]),
            ],
            "run1",
        );
        let rendered = run(&bin_args(&db, "run1")).map_err(|e| e.kind).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["truth_label"], "rust_wired_dev");
        assert_eq!(v["proof_only"], true);
        assert_eq!(v["ok"], true);
        assert_eq!(v["run_id"], "run1");
        assert_eq!(v["workflow_name"], "research");
        assert_eq!(v["run_state"], "done");
        assert_eq!(v["step_count"], 2);
        assert_eq!(v["verified_count"], 2);
        assert_eq!(v["first_pending_seq"], Value::Null);
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0]["step_ref"], "run1:s0");
        assert_eq!(steps[0]["status"], "verified");
        assert_eq!(steps[0]["has_evidence"], true);
        assert_eq!(steps[1]["seq"], 1);
        // THE refs-only assertion: the DB row's evidence text embeds the
        // filename; the projection must not.
        assert!(
            !rendered.contains("notes.txt") && !rendered.contains("bytes from"),
            "evidence text must never be projected: {rendered}"
        );
        assert!(steps[0].get("evidence_ref").is_none());
        assert!(reject_forbidden_output(&rendered).is_ok());
    }

    #[test]
    fn paused_run_projects_the_pending_checkpoint_step() {
        let db = seeded_run(
            "paused",
            vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step(
                    "write",
                    "write_file",
                    &[("path", "out.txt"), ("content", "y")],
                ),
            ],
            "run1",
        );
        let rendered = run(&bin_args(&db, "run1")).map_err(|e| e.kind).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["run_state"], "awaiting_checkpoint");
        assert_eq!(v["pending_count"], 1);
        assert_eq!(v["first_pending_seq"], 1);
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps[1]["status"], "pending");
        assert_eq!(steps[1]["has_side_effect"], true);
        assert_eq!(steps[1]["has_evidence"], false);
        // The paused write's params (path/content) are not stored on run rows
        // and must not appear.
        assert!(!rendered.contains("out.txt"));
    }

    #[test]
    fn missing_db_and_unknown_run_fail_closed() {
        let ghost = tmp("ghost").with_extension("sqlite");
        let err = run(&bin_args(&ghost.to_string_lossy(), "run1"))
            .err()
            .unwrap();
        assert_eq!(err.kind, "db_not_found");
        assert!(!ghost.exists(), "a readback must never create a DB");

        let db = seeded_run(
            "unknown-run",
            vec![step("read", "read_file", &[("path", "notes.txt")])],
            "run1",
        );
        assert_eq!(
            run(&bin_args(&db, "ghost-run")).err().unwrap().kind,
            "run_not_found"
        );
        assert_eq!(run(&["bin".to_string()]).err().unwrap().kind, "bad_args");
    }

    #[test]
    fn forbidden_output_canary_fails_the_whole_projection_closed() {
        // CANARY through the REAL path: hand-corrupt the persisted run name so an
        // absolute path would enter the projection — the guard must refuse to
        // print (fail-closed), proving it sits between the DB and stdout.
        let db = seeded_run(
            "canary",
            vec![step("read", "read_file", &[("path", "notes.txt")])],
            "run1",
        );
        {
            let w = friday_storage::Db::open_hub(&db).unwrap();
            w.conn()
                .execute(
                    "UPDATE workflow_run SET name = '/Users/jarvis/leak' WHERE run_id = 'run1'",
                    [],
                )
                .unwrap();
        }
        let err = run(&bin_args(&db, "run1")).err().unwrap();
        assert_eq!(err.kind, "output_guard");
    }

    #[test]
    fn forbidden_output_guard_blocks_evidence_text_params_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"evidence_ref":"read 3 bytes from x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"params":[["path","x"]]}"#).is_err());
        assert!(reject_forbidden_output(r#"{"definition_json":"{}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/x"}"#).is_err());
        // The refs-only step shape passes.
        assert!(reject_forbidden_output(
            r#"{"steps":[{"step_ref":"run1:s0","status":"verified","has_evidence":true}]}"#
        )
        .is_ok());
    }
}
