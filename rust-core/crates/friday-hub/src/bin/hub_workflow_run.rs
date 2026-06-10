//! S9 dev write-bridge — `hub_workflow_run`.
//!
//! PROOF-ONLY (Rust-wired-DEV). The workflow sibling of the S0 `hub_run_task`
//! write-bridge: a thin one-shot bin around the S9 seam
//! ([`friday_hub::workflow_run`]) that loads a STORED workflow definition (by
//! `--workflow-id` + `--version`, or its published version) from `--db` and
//! executes it through the EXISTING [`friday_hub::workflow_exec`] engine against
//! the `--workspace` root, emitting a refs-only JSON receipt.
//!
//! This is NOT a replacement for the (fail-closed-fenced) TS workflow runtime.
//! It registers NO production route, NO scheduler/trigger/cron (S10,
//! operator-gated), and confers no v1 GO. Live/manual PRODUCTION workflow runs
//! remain operator-gated — this bin exists for dev/temp DBs and workspaces.
//!
//! ## Gate posture (unchanged — no gate/approval code is touched)
//! The approval policy is hard-wired DENY-ALL: no approval is ever minted, so a
//! mutating/checkpoint step PAUSES the run (`AwaitingCheckpoint`) and is never
//! executed — the engine's existing posture. The gate-approval signing secret is
//! therefore DORMANT; like `hub_run_task`, ephemeral non-secret bytes are
//! derived from pid+nanos rather than reading any real key.
//!
//! ## Output contract — REFS ONLY (no bodies, no params, no prompts, no secrets)
//! One JSON object on stdout carrying ONLY safe identifiers/labels/counts:
//! `truth_label="rust_wired_dev"`, run/workflow/version identifiers, a BOUNDED
//! projection of the free-form workflow name (`workflow_name_sha256` +
//! `workflow_name_len` — the raw DB string is NEVER emitted, so a marker-bearing
//! name is structurally impossible in output), closed-vocab status + a BOUNDED
//! `status_detail` token (never the engine's free-form failure text, which can
//! embed executor error detail), the paused/failed step REF (`<run_id>:s<seq>`),
//! step counts by status (`verified`/`pending`/`proof_pending`/`failed`/
//! `running` — the FULL persisted `StepStatus` vocabulary, so the five counters
//! PARTITION `step_count`; note the engine persists an exec-errored
//! non-side-effect step as `running`), and `audit_rows_verified` (the COUNT of
//! hash-chain-verified audit rows — honest: the workflow driver writes zero
//! audit rows today, so this is 0, attesting chain integrity over whatever rows
//! exist, not workflow coverage). Step params, definition bodies and evidence
//! text are NEVER emitted; [`reject_forbidden_output`] fails the whole receipt
//! closed if any forbidden marker appears.
//!
//! ## Bridge-success semantics + known coarseness + dev fence (consumer notes)
//! - A run whose ENGINE status is `failed` still exits 0 with `ok: true` — exit
//!   0 means "the bridge dispatched and reported"; consumers MUST key on
//!   `status`, never on the exit code alone.
//! - A duplicate `--run-id` (engine single-shot, dup PK at `create_run`) and a
//!   genuine storage failure both surface as `storage_failed` (known
//!   coarseness; acceptable for a dev bridge).
//! - `Db::open_hub` MIGRATES the target DB on open. NEVER point `--db` at the
//!   production hub DB — this bin is for dev/temp DBs and workspaces only.

use std::env;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
use friday_hub::workflow_def::WorkflowDefError;
use friday_hub::workflow_exec::WorkflowRunStatus;
use friday_hub::workflow_run::{run_stored_published_workflow, run_stored_workflow};
use friday_hub::FsToolExecutor;
use friday_storage::audit::verify_audit_chain;
use friday_storage::workflow::first_pending_seq;
use friday_storage::workflow_read::{get_workflow_run_summary, list_workflow_step_summaries};
use friday_storage::Db;
use serde_json::json;
use sha2::{Digest, Sha256};

/// A fail-closed error: `kind` is a coarse, safe category (the only thing
/// surfaced); the raw detail is deliberately NOT printed so storage/loader
/// errors cannot leak paths or definition content.
struct BridgeError {
    kind: &'static str,
}

impl BridgeError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match run(&args) {
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
            // Defense-in-depth: route the error payload through the SAME guard as the
            // success path (fail closed if a marker ever leaked). `error_kind` is a
            // static closed-vocab token today, so this never suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_workflow_run_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run(args: &[String]) -> Result<String, BridgeError> {
    // The hub DB must ALREADY exist and hold the stored definition — a missing
    // DB is fail-closed (`db_not_found`), never silently created.
    let db_path = arg_value(args, "--db").ok_or(BridgeError::new("bad_args"))?;
    if !Path::new(&db_path).is_file() {
        return Err(BridgeError::new("db_not_found"));
    }
    // Workspace root: the engine's fs tools are contained to this root (required).
    let workspace_root = arg_value(args, "--workspace").ok_or(BridgeError::new("bad_args"))?;
    let workflow_id = arg_value(args, "--workflow-id").ok_or(BridgeError::new("bad_args"))?;
    // Optional explicit version; absent ⇒ the PUBLISHED version. A present but
    // unparsable value is bad_args (fail-closed, never silently "published").
    let version = match arg_value(args, "--version") {
        Some(raw) => Some(
            raw.parse::<i64>()
                .map_err(|_| BridgeError::new("bad_args"))?,
        ),
        None => None,
    };

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let run_id = arg_value(args, "--run-id")
        .unwrap_or_else(|| format!("hub_workflow_run_dev_{pid}_{nanos}"));
    // A PRESENT but unparsable --now-ms is bad_args (fail-closed) — never a
    // silent wall-clock fallback (the same posture as --version above).
    let now_ms = match arg_value(args, "--now-ms") {
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|_| BridgeError::new("bad_args"))?,
        None => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    };

    let db = Db::open_hub(&db_path).map_err(|_| BridgeError::new("open_failed"))?;
    let executor = FsToolExecutor::new(&workspace_root);
    // Gate-approval signing secret: DORMANT under the hard-wired deny-all policy
    // below (no approval is ever minted/verified), so ephemeral, non-secret bytes
    // are derived from pid+nanos — nothing secret-shaped is read or persisted.
    let secret = ephemeral_dev_secret(pid, nanos);

    let stored_run = match version {
        Some(version) => run_stored_workflow(
            db.conn(),
            &executor,
            &workflow_id,
            version,
            &run_id,
            &secret,
            &deny_all,
            now_ms,
        ),
        None => run_stored_published_workflow(
            db.conn(),
            &executor,
            &workflow_id,
            &run_id,
            &secret,
            &deny_all,
            now_ms,
        ),
    }
    .map_err(|err| BridgeError::new(workflow_def_error_kind(&err)))?;

    // Refs-only projection of what the engine persisted (read helpers never
    // select evidence text; step params are not stored at all).
    let summary = get_workflow_run_summary(db.conn(), &run_id)
        .map_err(|_| BridgeError::new("read_failed"))?
        .ok_or(BridgeError::new("read_failed"))?;
    let steps = list_workflow_step_summaries(db.conn(), &run_id)
        .map_err(|_| BridgeError::new("read_failed"))?;
    let pending_seq =
        first_pending_seq(db.conn(), &run_id).map_err(|_| BridgeError::new("read_failed"))?;
    // HONEST attestation: the COUNT of hash-chain-verified audit rows (the
    // workflow driver writes zero audit rows today, so this is 0 — a bool here
    // would be vacuously true). A broken chain fails the receipt closed.
    let audit_rows_verified =
        verify_audit_chain(db.conn()).map_err(|_| BridgeError::new("audit_verify_failed"))?;

    let count_status =
        |status: &str| -> usize { steps.iter().filter(|s| s.status == status).count() };

    // Closed-vocab status + BOUNDED detail token + step REF. CRITICAL: the
    // engine's pause/fail `reason` strings can embed free-form executor error
    // detail; only fixed `&'static str` tokens from a closed vocabulary are
    // emitted (the `hub_run_task` classify_error_category discipline).
    let (status, status_detail, step_ref): (&'static str, Option<&'static str>, Option<&str>) =
        match &stored_run.outcome.status {
            WorkflowRunStatus::Completed => ("completed", None, None),
            WorkflowRunStatus::AwaitingCheckpoint { step_id, reason } => (
                "awaiting_checkpoint",
                Some(classify_pause_reason(reason)),
                Some(step_id.as_str()),
            ),
            WorkflowRunStatus::Failed { step_id, reason } => (
                "failed",
                Some(classify_failure_reason(reason)),
                Some(step_id.as_str()),
            ),
        };

    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "run_id": run_id,
        "workflow_id": stored_run.workflow_id,
        "version": stored_run.version,
        // The workflow name is a FREE-FORM DB string — never emitted verbatim.
        // Bounded refs-only projection: sha256 hex + UTF-8 byte length.
        "workflow_name_sha256": sha256_hex(summary.name.as_bytes()),
        "workflow_name_len": summary.name.len(),
        "run_state": summary.state,
        "status": status,
        "status_detail": status_detail,
        "step_ref": step_ref,
        "executed_steps": stored_run.outcome.executed_steps,
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
        "audit_rows_verified": audit_rows_verified,
    });

    let rendered =
        serde_json::to_string(&payload).map_err(|_| BridgeError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

/// Hard-wired DENY-ALL approval policy: no approval is ever minted, so mutating
/// steps stay gate-paused — the engine's existing posture, unchanged.
fn deny_all(_r: &MutatingActionRequest) -> Option<CanonicalApproval> {
    None
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

/// Map a loader/seam error to ONE coarse, closed-vocab kind (never the detail —
/// a parse error can quote definition content; a storage error can embed paths).
fn workflow_def_error_kind(err: &WorkflowDefError) -> &'static str {
    match err {
        WorkflowDefError::NotFound(_) => "def_not_found",
        WorkflowDefError::Parse(_)
        | WorkflowDefError::Invalid(_)
        | WorkflowDefError::UnsupportedSchemaVersion { .. } => "def_invalid",
        WorkflowDefError::Storage(_) => "storage_failed",
    }
}

/// Map an `AwaitingCheckpoint` reason to ONE bounded, refs-only token.
///
/// Today these reasons are static closed-vocab strings (`CheckpointReason::as_str`
/// or `"gate_requires_approval"`), but this classifier makes leakage structurally
/// impossible if a future engine change ever embeds dynamic text: it returns ONLY
/// a fixed `&'static str`, never any slice of `reason`.
fn classify_pause_reason(reason: &str) -> &'static str {
    if reason.contains("gate_requires_approval") {
        "gate_requires_approval"
    } else if reason.contains("mutating") {
        "checkpoint_mutating"
    } else if reason.contains("high-risk") {
        "checkpoint_high_risk"
    } else if reason.contains("sensitive resource") {
        "checkpoint_sensitive_resource"
    } else if reason.contains("template") {
        "checkpoint_template_policy"
    } else if reason.contains("unclassifiable") {
        "checkpoint_unclassifiable"
    } else {
        "checkpoint_other"
    }
}

/// Map a `Failed` reason to ONE bounded, refs-only token. CRITICAL leak boundary:
/// the engine's failure reason embeds free-form detail (`exec_error:<ExecError>`
/// can carry fs error text; `unregistered:<action>` carries the raw action
/// string) — only the fixed prefix-derived token is ever emitted.
fn classify_failure_reason(reason: &str) -> &'static str {
    if reason.starts_with("denied:") {
        "denied"
    } else if reason.starts_with("exec_error:") {
        "exec_error"
    } else if reason.starts_with("unregistered:") {
        "unregistered_action"
    } else {
        "failed_other"
    }
}

/// Ephemeral, non-secret bytes (dormant under deny-all — see module docs).
/// Derived, not read — mirrors `hub_run_task`.
fn ephemeral_dev_secret(pid: u32, nanos: u128) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(format!("hub-workflow-run-dev-bridge:{pid}:{nanos}").as_bytes());
    hasher.finalize().to_vec()
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
/// refs-only receipt. Beyond the shared secret/path markers, this bin's
/// body-bearing fields must never appear: step `"params"`, the stored
/// `"definition_json"` / `"source_meta"` bodies, and the `"evidence_ref"` text.
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &[
            "\"params\"",
            "\"definition_json\"",
            "\"source_meta\"",
            "\"evidence_ref\"",
        ],
    )
    .map_err(|_| BridgeError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_hub::workflow_def::{
        store_published_version, StoredWorkflowDefV1, StoredWorkflowStepV1,
        WORKFLOW_DEF_SCHEMA_VERSION,
    };
    use friday_storage::workflow_def::DefinitionSource;
    use serde_json::{from_str, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "friday-wfrunbin-{}-{}-{}",
            std::process::id(),
            tag,
            C.fetch_add(1, Ordering::Relaxed)
        ))
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

    fn def(name: &str, steps: Vec<StoredWorkflowStepV1>) -> StoredWorkflowDefV1 {
        StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: name.into(),
            steps,
        }
    }

    /// A temp hub DB seeded with one PUBLISHED definition + a temp workspace
    /// containing `notes.txt`. Returns (db_path, workspace_path).
    fn seeded(tag: &str, d: &StoredWorkflowDefV1, version: i64) -> (String, String) {
        let db_path = tmp(tag)
            .with_extension("sqlite")
            .to_string_lossy()
            .into_owned();
        let db = friday_storage::Db::open_hub(&db_path).unwrap();
        store_published_version(
            db.conn(),
            "wf1",
            version,
            d,
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let ws = tmp(&format!("{tag}-ws"));
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("notes.txt"), b"hello").unwrap();
        (db_path, ws.to_string_lossy().into_owned())
    }

    fn bin_args(db: &str, ws: &str, extra: &[&str]) -> Vec<String> {
        let mut args = vec![
            "hub_workflow_run".to_string(),
            format!("--db={db}"),
            format!("--workspace={ws}"),
            "--workflow-id=wf1".to_string(),
        ];
        args.extend(extra.iter().map(|s| s.to_string()));
        args
    }

    /// The five status counters (the FULL persisted StepStatus vocabulary) must
    /// PARTITION step_count — no persisted step status is ever invisible to the
    /// receipt (the original four-counter set silently dropped 'running').
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

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/tmp/hub.sqlite".to_string(),
            "--workflow-id=wf-1".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(arg_value(&args, "--workflow-id").as_deref(), Some("wf-1"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn read_only_published_workflow_runs_to_completed_with_a_refs_only_receipt() {
        // The full BIN path (not a mock): seeded stored def → run(args) → the
        // EXISTING engine executes both read-only steps → refs-only receipt.
        let (db, ws) = seeded(
            "ok",
            &def(
                "research",
                vec![
                    step("read", "read_file", &[("path", "notes.txt")]),
                    step("ls", "list_dir", &[("path", ".")]),
                ],
            ),
            3,
        );
        let rendered = run(&bin_args(&db, &ws, &["--run-id=run1", "--now-ms=500"]))
            .map_err(|e| e.kind)
            .unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["truth_label"], "rust_wired_dev");
        assert_eq!(v["proof_only"], true);
        assert_eq!(v["ok"], true);
        assert_eq!(v["run_id"], "run1");
        assert_eq!(v["workflow_id"], "wf1");
        assert_eq!(v["version"], 3, "published version resolved + reported");
        // The free-form name is projected BOUNDED (hash + byte length), never verbatim.
        assert_eq!(v["workflow_name_sha256"], sha256_hex(b"research"));
        assert_eq!(v["workflow_name_len"], "research".len());
        assert!(v.get("workflow_name").is_none(), "raw name never emitted");
        assert_eq!(v["status"], "completed");
        assert_eq!(v["run_state"], "done");
        assert_eq!(v["status_detail"], Value::Null);
        assert_eq!(v["step_ref"], Value::Null);
        assert_eq!(v["executed_steps"], 2);
        assert_eq!(v["step_count"], 2);
        assert_eq!(v["verified_count"], 2);
        assert_eq!(v["pending_count"], 0);
        assert_eq!(v["running_count"], 0);
        assert_counters_partition_step_count(&v);
        assert_eq!(v["first_pending_seq"], Value::Null);
        // Honest audit attestation: a COUNT (0 — the workflow driver writes no
        // audit rows), never a vacuous bool.
        assert_eq!(v["audit_rows_verified"], 0);
        assert!(v.get("audit_chain_verified").is_none());
        // Refs-only: no step params / definition body / evidence text fields.
        assert!(v.get("steps").is_none());
        assert!(!rendered.contains("notes.txt"), "no path/body text leaks");
        assert!(!rendered.contains("research"), "name label not verbatim");
        assert!(reject_forbidden_output(&rendered).is_ok());
    }

    #[test]
    fn explicit_version_flag_runs_that_version() {
        let (db, ws) = seeded(
            "ver",
            &def(
                "research",
                vec![step("read", "read_file", &[("path", "notes.txt")])],
            ),
            7,
        );
        let rendered = run(&bin_args(&db, &ws, &["--version=7", "--run-id=run-v"]))
            .map_err(|e| e.kind)
            .unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["version"], 7);
        assert_eq!(v["status"], "completed");
        // An unparsable version is bad_args (never silently falls back to published).
        let err = run(&bin_args(&db, &ws, &["--version=seven"]))
            .err()
            .unwrap();
        assert_eq!(err.kind, "bad_args");
    }

    #[test]
    fn unparsable_now_ms_is_bad_args_never_a_silent_wall_clock_fallback() {
        let (db, ws) = seeded(
            "badnow",
            &def(
                "research",
                vec![step("read", "read_file", &[("path", "notes.txt")])],
            ),
            1,
        );
        let err = run(&bin_args(&db, &ws, &["--now-ms=soon"])).err().unwrap();
        assert_eq!(err.kind, "bad_args");
        // And the parsable form still works (the fail-closed check is on
        // PRESENT-but-unparsable, not on presence).
        let rendered = run(&bin_args(&db, &ws, &["--now-ms=500", "--run-id=run-now"]))
            .map_err(|e| e.kind)
            .unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["status"], "completed");
    }

    #[test]
    fn mutating_step_gate_pauses_and_the_workspace_is_unchanged() {
        // THE safety witness at the bin level: a stored write step pauses under
        // the hard-wired deny-all; the write never executes; out.txt is absent.
        let (db, ws) = seeded(
            "pause",
            &def(
                "ship",
                vec![
                    step("read", "read_file", &[("path", "notes.txt")]),
                    step(
                        "write",
                        "write_file",
                        &[("path", "out.txt"), ("content", "y")],
                    ),
                ],
            ),
            1,
        );
        let rendered = run(&bin_args(&db, &ws, &["--run-id=run1"]))
            .map_err(|e| e.kind)
            .unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["status"], "awaiting_checkpoint");
        assert_eq!(v["run_state"], "awaiting_checkpoint");
        assert_eq!(v["status_detail"], "checkpoint_mutating");
        assert_eq!(v["step_ref"], "run1:s1");
        assert_eq!(v["executed_steps"], 1);
        assert_eq!(v["pending_count"], 1);
        assert_eq!(v["running_count"], 0);
        assert_counters_partition_step_count(&v);
        assert_eq!(v["first_pending_seq"], 1);
        assert_eq!(v["side_effect_step_count"], 1);
        assert!(
            !std::path::Path::new(&ws).join("out.txt").exists(),
            "the gate-paused write must NOT touch the workspace"
        );
        // The mutating step's params ("content"="y") are never in the receipt.
        assert!(!rendered.contains("out.txt"));
        assert!(reject_forbidden_output(&rendered).is_ok());
    }

    #[test]
    fn exec_errored_step_is_persisted_running_and_counted_running_count() {
        // THE counter-vocabulary repro: a stored READ-ONLY def run against a
        // NONEXISTENT workspace exec-errors at s0. The engine persists that
        // step via resolve_step_completion(false, false, false) == Running and
        // fails the run — so the receipt must show status=failed AND
        // running_count=1, with the five counters still partitioning
        // step_count (the original four counters made this step invisible).
        let (db, _ws) = seeded(
            "execerr",
            &def(
                "research",
                vec![
                    step("read", "read_file", &[("path", "notes.txt")]),
                    step("ls", "list_dir", &[("path", ".")]),
                ],
            ),
            1,
        );
        let ghost_ws = tmp("execerr-ghost-ws").to_string_lossy().into_owned();
        let rendered = run(&bin_args(&db, &ghost_ws, &["--run-id=run-err"]))
            .map_err(|e| e.kind)
            .unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(
            v["ok"], true,
            "bridge-success semantics: ok keys on the bridge"
        );
        assert_eq!(v["status"], "failed");
        assert_eq!(v["run_state"], "failed");
        assert_eq!(v["status_detail"], "exec_error");
        assert_eq!(v["step_ref"], "run-err:s0");
        assert_eq!(v["executed_steps"], 0);
        // Step rows are added lazily as the loop reaches them: only s0 exists.
        assert_eq!(v["step_count"], 1);
        assert_eq!(v["running_count"], 1, "the exec-errored step is VISIBLE");
        assert_eq!(v["verified_count"], 0);
        assert_eq!(v["failed_count"], 0);
        assert_counters_partition_step_count(&v);
        // The fs error text (which embeds the ghost path) never leaks.
        assert!(!rendered.contains("ghost-ws"));
        assert!(reject_forbidden_output(&rendered).is_ok());
    }

    #[test]
    fn missing_db_and_missing_definition_fail_closed() {
        // Missing DB file: fail-closed, never silently created.
        let ghost_db = tmp("ghost").with_extension("sqlite");
        let err = run(&[
            "bin".to_string(),
            format!("--db={}", ghost_db.to_string_lossy()),
            "--workspace=/tmp/x".to_string(),
            "--workflow-id=wf1".to_string(),
        ])
        .err()
        .unwrap();
        assert_eq!(err.kind, "db_not_found");
        assert!(!ghost_db.exists(), "a missing DB must not be created");

        // DB exists but the definition does not.
        let (db, ws) = seeded(
            "nodef",
            &def(
                "research",
                vec![step("read", "read_file", &[("path", "notes.txt")])],
            ),
            1,
        );
        let mut args = bin_args(&db, &ws, &[]);
        args[3] = "--workflow-id=ghost-wf".to_string();
        assert_eq!(run(&args).err().unwrap().kind, "def_not_found");
        // Known id, missing version.
        assert_eq!(
            run(&bin_args(&db, &ws, &["--version=9"]))
                .err()
                .unwrap()
                .kind,
            "def_not_found"
        );
        // Missing required args.
        assert_eq!(run(&["bin".to_string()]).err().unwrap().kind, "bad_args");
    }

    #[test]
    fn marker_bearing_name_is_structurally_impossible_in_output() {
        // STRUCTURAL (not canary-caught): a definition whose NAME embeds a
        // secret marker still produces a SUCCESSFUL receipt, because the name
        // is never emitted verbatim — only its sha256 + byte length. The marker
        // cannot reach stdout through the name field at all.
        let name = "Bearer canary-name";
        let (db, ws) = seeded(
            "canary-name",
            &def(
                name,
                vec![step("read", "read_file", &[("path", "notes.txt")])],
            ),
            1,
        );
        let rendered = run(&bin_args(&db, &ws, &["--run-id=run1"]))
            .map_err(|e| e.kind)
            .unwrap();
        assert!(!rendered.contains("Bearer"), "marker never in output");
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["status"], "completed");
        assert_eq!(v["workflow_name_sha256"], sha256_hex(name.as_bytes()));
        assert_eq!(v["workflow_name_len"], name.len());
        assert!(v.get("workflow_name").is_none());
    }

    #[test]
    fn forbidden_output_canary_fails_the_whole_receipt_closed() {
        // CANARY through the REAL path (defense-in-depth on the OTHER verbatim
        // fields): a marker-bearing --run-id flows verbatim into the receipt's
        // run_id/step_ref — the output guard must refuse to print anything
        // (fail-closed), proving the guard still sits between the projection
        // and stdout for every field that is not structurally bounded.
        let (db, ws) = seeded(
            "canary-runid",
            &def(
                "research",
                vec![step("read", "read_file", &[("path", "notes.txt")])],
            ),
            1,
        );
        let err = run(&bin_args(&db, &ws, &["--run-id=run-Bearer-1"]))
            .err()
            .unwrap();
        assert_eq!(err.kind, "output_guard");
    }

    #[test]
    fn forbidden_output_guard_blocks_bodies_params_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"params":[["path","x"]]}"#).is_err());
        assert!(reject_forbidden_output(r#"{"definition_json":"{}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"source_meta":"{}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"evidence_ref":"read 3 bytes"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/x"}"#).is_err());
        // The refs-only key shapes pass.
        assert!(reject_forbidden_output(
            r#"{"status":"completed","step_count":2,"verified_count":2}"#
        )
        .is_ok());
    }

    #[test]
    fn reason_classifiers_return_only_bounded_tokens_never_detail_slices() {
        // Pause reasons (today: closed-vocab planner/gate strings).
        assert_eq!(
            classify_pause_reason("mutating action (gate floor)"),
            "checkpoint_mutating"
        );
        assert_eq!(
            classify_pause_reason("high-risk action (gate floor)"),
            "checkpoint_high_risk"
        );
        assert_eq!(
            classify_pause_reason("sensitive resource access (gate floor)"),
            "checkpoint_sensitive_resource"
        );
        assert_eq!(
            classify_pause_reason("template checkpoint policy"),
            "checkpoint_template_policy"
        );
        assert_eq!(
            classify_pause_reason("unclassifiable/unregistered action (fail-closed)"),
            "checkpoint_unclassifiable"
        );
        assert_eq!(
            classify_pause_reason("gate_requires_approval (resume without a valid approval)"),
            "gate_requires_approval"
        );
        assert_eq!(classify_pause_reason("something new"), "checkpoint_other");

        // Failure reasons embed free-form detail — the token must never carry it.
        let leaky = "exec_error:fs error LEAK_CANARY_path_9f3 /somewhere/deep";
        let token = classify_failure_reason(leaky);
        assert_eq!(token, "exec_error");
        assert!(!token.contains("LEAK_CANARY_path_9f3"));
        assert_eq!(classify_failure_reason("denied:reserved"), "denied");
        assert_eq!(
            classify_failure_reason("unregistered:frobnicate"),
            "unregistered_action"
        );
        assert_eq!(classify_failure_reason("???"), "failed_other");
    }

    #[test]
    fn ephemeral_secret_is_32_bytes_and_not_a_read_key() {
        assert_eq!(ephemeral_dev_secret(123, 456).len(), 32);
    }
}
