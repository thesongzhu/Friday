//! A5 dev read-bridge — `hub_workflow_evidence_export`
//! (`workflows.runs.evidence.export`).
//!
//! PROOF-ONLY (Rust-wired-DEV), DARK. The evidence-centric sibling of the S9
//! `hub_workflow_run_readback` bin: it opens the hub DB READ-ONLY
//! ([`friday_storage::Db::open_hub_readonly`]) and emits a refs-only JSON
//! EVIDENCE MANIFEST for ONE workflow run, by `--run-id`. It is the read
//! projection behind the `workflows.runs.evidence.export` surface.
//!
//! This is NOT a production route, NOT a TS integration, drives NO run, and
//! confers no v1 GO — the live workflow run-control plane remains METHOD-guarded
//! in TS (the G4 retirement guard `TS_RUNTIME_WORKFLOW_RUNS_RETIRED`) and is NOT
//! product-replaced. Deploying this binary changes NO live behavior: it only
//! reads existing rows the [`friday_hub::workflow_exec`] engine persists.
//!
//! ## Manifest, NOT body retrieval
//! "Export" here is the refs-only evidence MANIFEST/INVENTORY — per step: the
//! evidence-gating obligation (`has_side_effect`), the persisted status, the
//! m0027 retry `attempt`, and a BOUNDED FINGERPRINT (`evidence_sha256` +
//! `evidence_len`) of the attached `evidence_ref`, or `evidence_present=false`
//! when none is attached. It is NOT retrieval of the evidence BODY (the
//! receipt/artifact text). Body retrieval is a separate, gated surface — a
//! deferred sub-AC — and this bin cannot produce it: the raw `evidence_ref` text
//! is never carried out of [`friday_storage::workflow_read::list_evidence_export`]
//! (it is hashed+measured inside that storage fn and dropped), so the body is
//! structurally unreachable from this projection.
//!
//! ## Output contract — REFS ONLY (no bodies, no params, no evidence text)
//! One JSON object on stdout carrying ONLY safe identifiers/labels/counts:
//! `truth_label="rust_wired_dev"`, the run id, a BOUNDED projection of the
//! free-form workflow name (`workflow_name_sha256` + `workflow_name_len` — the
//! raw DB string is NEVER emitted), the closed-vocab `run_state`, the step
//! count, an evidence-COMPLIANCE rollup (`side_effect_step_count`,
//! `side_effect_with_evidence_count`, `side_effect_missing_evidence_count` — the
//! audit headline: how many gated steps actually attached verified evidence),
//! and a per-step manifest (step REF `<run_id>:s<seq>`, seq, side-effect flag,
//! status label, retry `attempt`, `evidence_present` bool, and for a present
//! ref its `evidence_sha256` hex + `evidence_len`). Step `status` and `step_ref`
//! are RE-VALIDATED fail-closed against the engine's closed vocabulary/shape by
//! the storage read helper, never passed through from a tampered DB.
//! [`reject_forbidden_output`] fails the WHOLE projection closed if any forbidden
//! marker ever appears.
//!
//! Usage: `hub_workflow_evidence_export --db <hub.sqlite> --run-id <id>`

use std::env;
use std::path::Path;

use friday_storage::workflow_read::{get_workflow_run_summary, list_evidence_export};
use friday_storage::{Db, StorageError};
use serde_json::json;
use sha2::{Digest, Sha256};

/// A fail-closed error: `kind` is a coarse, safe category (the only thing
/// surfaced); the raw detail is deliberately NOT printed so storage/IO errors
/// cannot leak paths.
struct ExportError {
    kind: &'static str,
}

impl ExportError {
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
            // Defense-in-depth: route the error payload through the SAME guard as
            // the success path. `error_kind` is a static closed-vocab token today,
            // so this never suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_workflow_evidence_export_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run(args: &[String]) -> Result<String, ExportError> {
    let db_path = arg_value(args, "--db").ok_or(ExportError::new("bad_args"))?;
    if !Path::new(&db_path).is_file() {
        return Err(ExportError::new("db_not_found"));
    }
    let run_id = arg_value(args, "--run-id").ok_or(ExportError::new("bad_args"))?;

    // Read-only open: an export can NEVER mutate an operator DB just because TS asks.
    // FAIL CLOSED + NAME the skew if the on-disk schema is strictly NEWER than this (stale)
    // binary understands — the always-on `Db::open_hub_readonly` guard surfaced distinctly.
    let db = Db::open_hub_readonly(&db_path).map_err(|e| match e {
        StorageError::SchemaTooNew { disk, code } => {
            eprintln!(
                "hub_workflow_evidence_export: leg=open error_kind=schema_too_new \
                 disk_version={disk} code_version={code} (stale binary: rebuild from the \
                 deploying commit)"
            );
            ExportError::new("schema_too_new")
        }
        _ => ExportError::new("open_failed"),
    })?;

    // The run summary is the run-EXISTENCE oracle (an unknown run is an explicit
    // fail-closed `run_not_found`, distinct from a known run with zero steps).
    let summary = get_workflow_run_summary(db.conn(), &run_id)
        .map_err(|_| ExportError::new("read_failed"))?
        .ok_or(ExportError::new("run_not_found"))?;

    // The evidence manifest. The raw `evidence_ref` text NEVER crosses this
    // boundary — the storage fn returns only the bounded fingerprint.
    let manifest =
        list_evidence_export(db.conn(), &run_id).map_err(|_| ExportError::new("read_failed"))?;

    // Evidence rollup: of the gated (side-effect) steps, how many have attached
    // evidence vs do not (yet). NOTE: "missing" counts every side-effect step
    // WITHOUT an attached evidence_ref — that includes not-yet-executed Pending
    // steps (a paused checkpoint), so it is "side-effect steps without attached
    // evidence", NOT a count of compliance VIOLATIONS. The audit headline pairs
    // the gating obligation against attached evidence; per-step status
    // disambiguates pending-vs-failed.
    let side_effect_step_count = manifest.iter().filter(|s| s.has_side_effect).count();
    let side_effect_with_evidence_count = manifest
        .iter()
        .filter(|s| s.has_side_effect && s.fingerprint.is_some())
        .count();
    let side_effect_missing_evidence_count =
        side_effect_step_count - side_effect_with_evidence_count;

    let step_objects: Vec<serde_json::Value> = manifest
        .iter()
        .map(|s| {
            let (present, sha, len) = match &s.fingerprint {
                Some(fp) => (true, Some(fp.sha256.clone()), Some(fp.len)),
                None => (false, None, None),
            };
            json!({
                "step_ref": s.step_id,
                "seq": s.seq,
                "has_side_effect": s.has_side_effect,
                "status": s.status,
                "attempt": s.attempt,
                "evidence_present": present,
                // Bounded fingerprint of the receipt text — the text itself is
                // structurally unreachable here (null when no evidence attached).
                "evidence_sha256": sha,
                "evidence_len": len,
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
        "step_count": manifest.len(),
        "side_effect_step_count": side_effect_step_count,
        "side_effect_with_evidence_count": side_effect_with_evidence_count,
        "side_effect_missing_evidence_count": side_effect_missing_evidence_count,
        "steps": step_objects,
    });

    let rendered =
        serde_json::to_string(&payload).map_err(|_| ExportError::new("serialize_failed"))?;
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
/// (mirrors `hub_workflow_run_readback::sha256_hex`).
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Defense-in-depth: refuse to print if any forbidden marker leaked into the
/// refs-only projection. Beyond the shared secret/path markers, this bin's
/// body-bearing fields must never appear: the `"evidence_ref"` text (the raw
/// receipt), step `"params"`, and the stored `"definition_json"` / `"source_meta"`
/// bodies (kept in lockstep with the `hub_workflow_run_readback` set so the two
/// workflow read bins cannot drift).
fn reject_forbidden_output(rendered: &str) -> Result<(), ExportError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &[
            "\"evidence_ref\"",
            "\"params\"",
            "\"definition_json\"",
            "\"source_meta\"",
        ],
    )
    .map_err(|_| ExportError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::StepStatus;
    use friday_storage::workflow::{add_step, complete_step, create_run, reopen_failed_step};
    use friday_storage::Db;
    use serde_json::{from_str, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "friday-wfevxbin-{}-{}-{}",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Seed a hub DB with one run + two side-effect steps through the REAL write
    /// primitives: s0 verified WITH a receipt (the ref text embeds a filename,
    /// exactly what the engine stores), s1 a Pending gated step (no evidence yet).
    /// Returns the DB path. The DB is closed before the bin re-opens it read-only.
    fn seed(tag: &str) -> String {
        let db_path = tmp(tag)
            .with_extension("sqlite")
            .to_string_lossy()
            .into_owned();
        {
            let db = Db::open_hub(&db_path).unwrap();
            let conn = db.conn();
            create_run(conn, "run1", "research", 100).unwrap();
            add_step(conn, "run1:s0", "run1", 0, true, 100).unwrap();
            let st = complete_step(
                conn,
                "run1:s0",
                Some("wrote 14 bytes to notes.txt"),
                false,
                110,
            )
            .unwrap();
            assert_eq!(st, StepStatus::Verified);
            add_step(conn, "run1:s1", "run1", 1, true, 100).unwrap();
        }
        db_path
    }

    fn bin_args(db: &str, run_id: &str) -> Vec<String> {
        vec![
            "hub_workflow_evidence_export".to_string(),
            format!("--db={db}"),
            format!("--run-id={run_id}"),
        ]
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/x/hub.sqlite".to_string(),
            "--run-id=run-xyz".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/x/hub.sqlite"));
        assert_eq!(arg_value(&args, "--run-id").as_deref(), Some("run-xyz"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn manifest_projects_fingerprint_and_compliance_rollup_never_the_evidence_text() {
        // End-to-end: real engine-write primitives → read-only export. The verified
        // step carries the receipt text in the DB; the manifest must surface ONLY
        // the sha256+len fingerprint and the compliance rollup.
        let db = seed("ok");
        let rendered = run(&bin_args(&db, "run1")).map_err(|e| e.kind).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["truth_label"], "rust_wired_dev");
        assert_eq!(v["proof_only"], true);
        assert_eq!(v["ok"], true);
        assert_eq!(v["run_id"], "run1");
        // The free-form name is bounded (hash+len), never verbatim.
        assert_eq!(v["workflow_name_sha256"], sha256_hex(b"research"));
        assert_eq!(v["workflow_name_len"], "research".len());
        assert!(v.get("workflow_name").is_none(), "raw name never emitted");
        assert_eq!(v["step_count"], 2);
        // Compliance rollup: 2 gated steps, 1 with evidence, 1 missing.
        assert_eq!(v["side_effect_step_count"], 2);
        assert_eq!(v["side_effect_with_evidence_count"], 1);
        assert_eq!(v["side_effect_missing_evidence_count"], 1);

        let steps = v["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 2);
        // s0: verified, evidence present → fingerprint surfaced.
        assert_eq!(steps[0]["step_ref"], "run1:s0");
        assert_eq!(steps[0]["status"], "verified");
        assert_eq!(steps[0]["attempt"], 1);
        assert_eq!(steps[0]["evidence_present"], true);
        assert_eq!(
            steps[0]["evidence_sha256"],
            sha256_hex(b"wrote 14 bytes to notes.txt")
        );
        assert_eq!(
            steps[0]["evidence_len"],
            "wrote 14 bytes to notes.txt".len()
        );
        // s1: pending gated step, no evidence → null fingerprint.
        assert_eq!(steps[1]["step_ref"], "run1:s1");
        assert_eq!(steps[1]["evidence_present"], false);
        assert_eq!(steps[1]["evidence_sha256"], Value::Null);
        assert_eq!(steps[1]["evidence_len"], Value::Null);

        // THE refs-only assertion: the receipt text embeds the filename; the
        // export must not carry it.
        assert!(
            !rendered.contains("notes.txt") && !rendered.contains("bytes to"),
            "evidence text must never be exported: {rendered}"
        );
        assert!(steps[0].get("evidence_ref").is_none());
        assert!(reject_forbidden_output(&rendered).is_ok());
    }

    #[test]
    fn attempt_provenance_is_visible_after_a_reopen() {
        // The m0027 attempt provenance through the bin: reopen the gated step (as a
        // retry would) → its attempt reads back as 2 in the exported manifest.
        let db = seed("attempt");
        {
            let w = Db::open_hub(&db).unwrap();
            assert_eq!(reopen_failed_step(w.conn(), "run1:s1", 200).unwrap(), 2);
        }
        let rendered = run(&bin_args(&db, "run1")).map_err(|e| e.kind).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["steps"][1]["attempt"], 2);
        assert_eq!(v["steps"][1]["evidence_present"], false);
    }

    #[test]
    fn missing_db_and_unknown_run_fail_closed() {
        let ghost = tmp("ghost").with_extension("sqlite");
        let err = run(&bin_args(&ghost.to_string_lossy(), "run1"))
            .err()
            .unwrap();
        assert_eq!(err.kind, "db_not_found");
        assert!(!ghost.exists(), "an export must never create a DB");

        let db = seed("unknown");
        assert_eq!(
            run(&bin_args(&db, "ghost-run")).err().unwrap().kind,
            "run_not_found"
        );
        assert_eq!(run(&["bin".to_string()]).err().unwrap().kind, "bad_args");
    }

    #[test]
    fn marker_bearing_name_is_structurally_impossible_in_output() {
        // STRUCTURAL: hand-corrupt the persisted run name with an absolute-path
        // marker — the export still SUCCEEDS, because the name is never emitted
        // verbatim, only its sha256+len. The marker cannot reach stdout.
        let tampered = "/Users/jarvis/leak";
        let db = seed("canary-name");
        {
            let w = Db::open_hub(&db).unwrap();
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
        assert_eq!(v["workflow_name_sha256"], sha256_hex(tampered.as_bytes()));
        assert_eq!(v["workflow_name_len"], tampered.len());
    }

    #[test]
    fn forbidden_output_canary_on_a_verbatim_field_fails_the_export_closed() {
        // CANARY through the REAL path on a verbatim field (run STATE): hand-corrupt
        // it so an absolute path would enter the projection — the guard must refuse
        // to print (fail-closed), proving it sits between DB and stdout.
        let db = seed("canary-state");
        {
            let w = Db::open_hub(&db).unwrap();
            w.conn()
                .execute(
                    "UPDATE workflow_run SET state = '/Users/jarvis/leak' WHERE run_id = 'run1'",
                    [],
                )
                .unwrap();
        }
        assert_eq!(
            run(&bin_args(&db, "run1")).err().unwrap().kind,
            "output_guard"
        );
    }

    #[test]
    fn tampered_step_status_fails_the_export_closed() {
        // DB strings are NOT trusted: a status outside the engine vocabulary fails
        // the WHOLE export closed (the storage helper re-validates), surfaced as the
        // coarse `read_failed`.
        let db = seed("tamper-status");
        {
            let w = Db::open_hub(&db).unwrap();
            w.conn()
                .execute(
                    "UPDATE workflow_step SET status = 'sk-bogus' WHERE step_id = 'run1:s1'",
                    [],
                )
                .unwrap();
        }
        assert_eq!(
            run(&bin_args(&db, "run1")).err().unwrap().kind,
            "read_failed"
        );
    }

    #[test]
    fn a_path_bearing_evidence_ref_is_hashed_away_and_the_export_still_succeeds() {
        // THE security invariant that justifies hashing INSIDE the storage fn: a
        // receipt whose text embeds a real absolute-path marker must NOT trip the
        // output guard (which would fail-close a legitimate export) and must NOT
        // leak — the export SUCCEEDS and carries only the sha256 fingerprint, never
        // the path. This is the structural reason the raw text never crosses the
        // storage boundary.
        let leaky = "/Users/jarvis/secret/receipt.txt";
        let db = tmp("path-evidence")
            .with_extension("sqlite")
            .to_string_lossy()
            .into_owned();
        {
            let w = Db::open_hub(&db).unwrap();
            let conn = w.conn();
            create_run(conn, "run1", "research", 100).unwrap();
            add_step(conn, "run1:s0", "run1", 0, true, 100).unwrap();
            // A verified side-effect step whose evidence receipt embeds the marker.
            complete_step(conn, "run1:s0", Some(leaky), false, 110).unwrap();
        }
        let rendered = run(&bin_args(&db, "run1")).map_err(|e| e.kind).unwrap();
        // The export SUCCEEDED (no false fail-close) and the path is absent.
        assert!(
            !rendered.contains("/Users/") && !rendered.contains("receipt.txt"),
            "a path-bearing evidence_ref must be hashed away, never leaked: {rendered}"
        );
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["ok"], true);
        // Only the fingerprint of the marker-bearing text is surfaced.
        assert_eq!(v["steps"][0]["evidence_present"], true);
        assert_eq!(
            v["steps"][0]["evidence_sha256"],
            sha256_hex(leaky.as_bytes())
        );
        assert_eq!(v["steps"][0]["evidence_len"], leaky.len());
        assert!(reject_forbidden_output(&rendered).is_ok());
    }

    #[test]
    fn forbidden_output_guard_blocks_evidence_text_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"evidence_ref":"wrote 3 bytes to x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"params":[["path","x"]]}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/x"}"#).is_err());
        // The refs-only manifest shape (fingerprint, not text) passes.
        assert!(reject_forbidden_output(
            r#"{"steps":[{"step_ref":"run1:s0","status":"verified","evidence_present":true,"evidence_sha256":"00ab","evidence_len":3}]}"#
        )
        .is_ok());
    }
}
