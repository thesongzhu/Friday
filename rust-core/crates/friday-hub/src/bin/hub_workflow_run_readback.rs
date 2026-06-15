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
//! `truth_label="rust_wired_dev"`, the run summary (run id / a BOUNDED
//! projection of the free-form workflow name as `workflow_name_sha256` +
//! `workflow_name_len` — the raw DB string is NEVER emitted, so a marker-bearing
//! name is structurally impossible in output / persisted state label /
//! timestamps), per-step summaries (step REF `<run_id>:s<seq>`, seq, side-effect
//! flag, status label, `has_evidence` BOOL — step `status` and `step_ref` are
//! RE-VALIDATED fail-closed against the engine's closed vocabulary/shape by the
//! storage read helper, never passed through from a tampered DB), step counts by
//! status (`verified`/`pending`/`proof_pending`/`failed`/`running` — the FULL
//! persisted `StepStatus` vocabulary, so the five counters PARTITION
//! `step_count`), `first_pending_seq` (the paused checkpoint of an
//! `awaiting_checkpoint` run), and `audit_rows_verified` (the COUNT of
//! hash-chain-verified audit rows — honest: the workflow driver writes zero
//! audit rows today, so this is 0). The `evidence_ref` TEXT (a tool-receipt
//! summary that can embed a relative filename) is structurally unselectable —
//! the storage read helper only ever projects its presence — and step params /
//! definition bodies are not stored on run rows at all.
//! [`reject_forbidden_output`] fails the WHOLE projection closed if any
//! forbidden marker ever appears.
//!
//! Usage: `hub_workflow_run_readback --db <hub.sqlite> --run-id <id>`

use std::env;
use std::path::Path;

use friday_storage::audit::verify_audit_chain;
use friday_storage::workflow::first_pending_seq;
use friday_storage::workflow_read::{get_workflow_run_summary, list_workflow_step_summaries};
use friday_storage::{Db, StorageError};
use serde_json::json;
use sha2::{Digest, Sha256};

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
    // FAIL CLOSED + NAME the skew if the on-disk schema is strictly NEWER than this (stale)
    // binary understands — the always-on `Db::open_hub_readonly` guard surfaced distinctly.
    let db = Db::open_hub_readonly(&db_path).map_err(|e| match e {
        StorageError::SchemaTooNew { disk, code } => {
            eprintln!(
                "hub_workflow_run_readback: leg=open error_kind=schema_too_new disk_version={disk} \
                 code_version={code} (stale binary: rebuild from the deploying commit)"
            );
            ReadbackError::new("schema_too_new")
        }
        _ => ReadbackError::new("open_failed"),
    })?;

    let summary = get_workflow_run_summary(db.conn(), &run_id)
        .map_err(|_| ReadbackError::new("read_failed"))?
        .ok_or(ReadbackError::new("run_not_found"))?;
    let steps = list_workflow_step_summaries(db.conn(), &run_id)
        .map_err(|_| ReadbackError::new("read_failed"))?;
    let pending_seq =
        first_pending_seq(db.conn(), &run_id).map_err(|_| ReadbackError::new("read_failed"))?;

    // HONEST attestation: the COUNT of hash-chain-verified audit rows (the
    // workflow driver writes zero audit rows today, so this is 0 — a bool here
    // would be vacuously true). A broken chain fails the projection closed.
    let audit_rows_verified =
        verify_audit_chain(db.conn()).map_err(|_| ReadbackError::new("audit_verify_failed"))?;

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
        // The workflow name is a FREE-FORM DB string — never emitted verbatim.
        // Bounded refs-only projection: sha256 hex + UTF-8 byte length.
        "workflow_name_sha256": sha256_hex(summary.name.as_bytes()),
        "workflow_name_len": summary.name.len(),
        "run_state": summary.state,
        "created_at_ms": summary.created_at,
        "updated_at_ms": summary.updated_at,
        "step_count": steps.len(),
        // The FULL persisted StepStatus vocabulary — these five PARTITION
        // step_count ('running' is how the engine persists an exec-errored
        // non-side-effect step: resolve_step_completion(false, false, false)).
        "verified_count": count_status("verified"),
        "pending_count": count_status("pending"),
        "proof_pending_count": count_status("proof_pending"),
        "failed_count": count_status("failed"),
        "running_count": count_status("running"),
        "side_effect_step_count": steps.iter().filter(|s| s.has_side_effect).count(),
        "first_pending_seq": pending_seq,
        "steps": step_objects,
        "audit_rows_verified": audit_rows_verified,
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

/// Lowercase sha256 hex — the bounded projection of a free-form DB string
/// (mirrors `hub_run_task::sha256_hex`).
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the
/// refs-only projection. Beyond the shared secret/path markers, this bin's
/// body-bearing fields must never appear: the `"evidence_ref"` text, step
/// `"params"`, and the stored `"definition_json"` / `"source_meta"` bodies
/// (the same extras set as the `hub_workflow_run` write-bridge — kept in
/// lockstep so the two S9 bins cannot drift).
fn reject_forbidden_output(rendered: &str) -> Result<(), ReadbackError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &[
            "\"evidence_ref\"",
            "\"params\"",
            "\"definition_json\"",
            "\"source_meta\"",
        ],
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
    /// `create_workspace: false` leaves the workspace path NONEXISTENT — the
    /// exec-error repro (the engine persists the errored step as 'running').
    fn seeded_run_in(
        tag: &str,
        steps: Vec<StoredWorkflowStepV1>,
        run_id: &str,
        create_workspace: bool,
    ) -> String {
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
        if create_workspace {
            std::fs::create_dir_all(&ws).unwrap();
            std::fs::write(ws.join("notes.txt"), b"hello readback").unwrap();
        }
        let exec = FsToolExecutor::new(&ws);
        run_stored_published_workflow(db.conn(), &exec, "wf1", run_id, SECRET, &deny_all, 200)
            .unwrap();
        db_path
    }

    fn seeded_run(tag: &str, steps: Vec<StoredWorkflowStepV1>, run_id: &str) -> String {
        seeded_run_in(tag, steps, run_id, true)
    }

    /// The five status counters (the FULL persisted StepStatus vocabulary) must
    /// PARTITION step_count — no persisted step status is ever invisible to the
    /// projection (the original four-counter set silently dropped 'running').
    fn assert_counters_partition_step_count(v: &Value) {
        let sum = ["verified", "pending", "proof_pending", "failed", "running"]
            .iter()
            .map(|s| v[&format!("{s}_count")].as_u64().unwrap())
            .sum::<u64>();
        assert_eq!(
            sum,
            v["step_count"].as_u64().unwrap(),
            "status counters must partition step_count: {v}"
        );
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
        // The free-form name is projected BOUNDED (hash + byte length), never verbatim.
        assert_eq!(v["workflow_name_sha256"], sha256_hex(b"research"));
        assert_eq!(v["workflow_name_len"], "research".len());
        assert!(v.get("workflow_name").is_none(), "raw name never emitted");
        assert_eq!(v["run_state"], "done");
        assert_eq!(v["step_count"], 2);
        assert_eq!(v["verified_count"], 2);
        assert_eq!(v["running_count"], 0);
        assert_counters_partition_step_count(&v);
        assert_eq!(v["first_pending_seq"], Value::Null);
        // Honest audit attestation: a COUNT (0 — the workflow driver writes no
        // audit rows), never a vacuous bool.
        assert_eq!(v["audit_rows_verified"], 0);
        assert!(v.get("audit_chain_verified").is_none());
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
        assert_eq!(v["running_count"], 0);
        assert_counters_partition_step_count(&v);
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
    fn exec_errored_step_reads_back_as_running_count_and_counters_partition() {
        // THE counter-vocabulary repro at the readback side: the engine ran a
        // READ-ONLY def against a NONEXISTENT workspace, persisting the
        // exec-errored step as 'running' (resolve_step_completion(false, false,
        // false)) and the run as failed. The projection must make that step
        // VISIBLE (running_count=1) and the five counters must still partition
        // step_count.
        let db = seeded_run_in(
            "execerr",
            vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step("ls", "list_dir", &[("path", ".")]),
            ],
            "run-err",
            false,
        );
        let rendered = run(&bin_args(&db, "run-err")).map_err(|e| e.kind).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["run_state"], "failed");
        // Step rows are added lazily as the engine loop reaches them: only s0.
        assert_eq!(v["step_count"], 1);
        assert_eq!(v["running_count"], 1, "the exec-errored step is VISIBLE");
        assert_eq!(v["verified_count"], 0);
        assert_eq!(v["failed_count"], 0);
        assert_counters_partition_step_count(&v);
        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps[0]["status"], "running");
        assert_eq!(steps[0]["has_evidence"], false);
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
    fn marker_bearing_name_is_structurally_impossible_in_output() {
        // STRUCTURAL (not canary-caught): hand-corrupt the persisted run name
        // with an absolute-path marker — the projection still SUCCEEDS, because
        // the name is never emitted verbatim, only its sha256 + byte length.
        // The marker cannot reach stdout through the name field at all.
        let tampered_name = "/Users/jarvis/leak";
        let db = seeded_run(
            "canary-name",
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
        let rendered = run(&bin_args(&db, "run1")).map_err(|e| e.kind).unwrap();
        assert!(!rendered.contains("/Users/"), "marker never in output");
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(
            v["workflow_name_sha256"],
            sha256_hex(tampered_name.as_bytes())
        );
        assert_eq!(v["workflow_name_len"], tampered_name.len());
        assert!(v.get("workflow_name").is_none());
    }

    #[test]
    fn forbidden_output_canary_fails_the_whole_projection_closed() {
        // CANARY through the REAL path (defense-in-depth on the OTHER verbatim
        // fields): hand-corrupt the persisted run STATE (a label emitted
        // verbatim) so an absolute path would enter the projection — the guard
        // must refuse to print (fail-closed), proving it still sits between the
        // DB and stdout for every field that is not structurally bounded.
        let db = seeded_run(
            "canary-state",
            vec![step("read", "read_file", &[("path", "notes.txt")])],
            "run1",
        );
        {
            let w = friday_storage::Db::open_hub(&db).unwrap();
            w.conn()
                .execute(
                    "UPDATE workflow_run SET state = '/Users/jarvis/leak' WHERE run_id = 'run1'",
                    [],
                )
                .unwrap();
        }
        let err = run(&bin_args(&db, "run1")).err().unwrap();
        assert_eq!(err.kind, "output_guard");
    }

    #[test]
    fn tampered_step_status_or_step_ref_fails_the_readback_closed() {
        // DB strings are NOT trusted: the storage read helper re-validates step
        // `status` (engine closed vocabulary) and `step_id` (`<run_id>:s<seq>`
        // shape) and fails CLOSED — the readback surfaces the coarse
        // `read_failed`, never a free-form passthrough.
        let db = seeded_run(
            "tamper-status",
            vec![step("read", "read_file", &[("path", "notes.txt")])],
            "run1",
        );
        {
            let w = friday_storage::Db::open_hub(&db).unwrap();
            w.conn()
                .execute(
                    "UPDATE workflow_step SET status = 'sk-totally-bogus' WHERE step_id = 'run1:s0'",
                    [],
                )
                .unwrap();
        }
        assert_eq!(
            run(&bin_args(&db, "run1")).err().unwrap().kind,
            "read_failed"
        );

        let db2 = seeded_run(
            "tamper-ref",
            vec![step("read", "read_file", &[("path", "notes.txt")])],
            "run1",
        );
        {
            let w = friday_storage::Db::open_hub(&db2).unwrap();
            w.conn()
                .execute(
                    "UPDATE workflow_step SET step_id = 'Bearer evil' WHERE step_id = 'run1:s0'",
                    [],
                )
                .unwrap();
        }
        assert_eq!(
            run(&bin_args(&db2, "run1")).err().unwrap().kind,
            "read_failed"
        );
    }

    #[test]
    fn forbidden_output_guard_blocks_evidence_text_params_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"evidence_ref":"read 3 bytes from x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"params":[["path","x"]]}"#).is_err());
        assert!(reject_forbidden_output(r#"{"definition_json":"{}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"source_meta":"{}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/x"}"#).is_err());
        // The refs-only step shape passes.
        assert!(reject_forbidden_output(
            r#"{"steps":[{"step_ref":"run1:s0","status":"verified","has_evidence":true}]}"#
        )
        .is_ok());
    }
}
