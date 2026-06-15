//! Read-only diagnostics surface — `diagnostics_snapshot`.
//!
//! PROOF-ONLY. A thin one-shot bin that projects the existing
//! [`friday_hub::diagnostics::DiagnosticsSnapshot::collect`] (a read-only
//! composition of the already-wired substrate — `token_ledger`, the hash-chained
//! `audit_ledger`, `agent_run`, `activity_item`) into a single refs-only JSON
//! object. It clones the read-only output-guard shape of the `hub_run_readback`
//! read-bridge and the `hub_providers_detect` surface (opens the hub DB with
//! [`friday_storage::Db::open_hub_readonly`], emits a refs-only payload, and runs
//! the output through a forbidden-marker guard before printing).
//!
//! This is NOT the observability/metrics-collection daemon (that XL subsystem
//! stays NO-GO — no heartbeat, no alerting, no scrape loop), registers NO
//! production route, replaces no run path, and confers no v1 GO. It exists to
//! prove the diagnostics substrate is consumer-projectable: that the truth-labeled
//! snapshot can be read and emitted without ever transporting a body/secret/PII.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no PII, no paths)
//! Emits a single JSON object to stdout carrying ONLY counts / booleans / ids /
//! static labels:
//! - `truth_label="rust_diagnostics_snapshot"`, `proof_only=true`, `ok=true`
//! - `build_id` (the crate version marker — version-granular, not a path/commit)
//! - `build_current` (anti-stale bool: snapshot's build matches the running build)
//! - `model_calls`, `total_tokens`, `agent_runs`, `activity_items` (REAL i64
//!   substrate counts — a real `0` is a genuine zero, never a fabricated
//!   placeholder; the unbuilt subsystems are truth-labeled in `unavailable`)
//! - `healthy` (bool: the audit chain verified)
//! - `audit_chain`: `{ "verified": bool, "status": "verified"|"broken",
//!   "entries": <int|null> }`
//! - `unavailable`: `[{ "metric": <static label>, "blocker": <static label> }]`
//!
//! ### Audit-chain `reason` is DELIBERATELY OMITTED
//! [`ChainStatus::Broken`] carries a `reason: String` derived from
//! [`friday_storage::StorageError`]. Two of that error's variants
//! (`Sqlite(#[from] rusqlite::Error)`, `Io(#[from] std::io::Error)`) can embed
//! arbitrary low-level detail (potentially a path or locked-file message). So this
//! projection NEVER emits the raw `reason`: a broken chain is surfaced as the
//! static label `"broken"` + `verified=false` + `entries=null` (the *fact* of the
//! anomaly is reported, never suppressed — only the unbounded detail string is
//! dropped). The [`reject_forbidden_output`] guard is a structural backstop on top
//! of this primary omission defense.

use std::env;
use std::ffi::OsString;
use std::path::Path;

use friday_hub::diagnostics::{ChainStatus, DiagnosticsSnapshot};
use friday_storage::{Db, StorageError};
use serde_json::json;

/// A fail-closed error: `kind` is a coarse, safe category (the only thing
/// surfaced); the raw detail is deliberately NOT carried so nothing path- or
/// secret-shaped can leak through an error path. `Debug` is safe to derive
/// because the only field is a closed-vocabulary `&'static str` (used by the
/// tests' `.expect`/`.unwrap_err`); it can never carry a path/secret.
#[derive(Debug)]
struct BridgeError {
    kind: &'static str,
}

impl BridgeError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    // Read argv as OsString and convert fail-closed: a non-UTF-8 arg (in ANY
    // position) maps to a coarse `bad_args` error rather than PANICKING the way
    // `env::args()` does inside `.collect()` (mirrors the hub_providers_detect
    // fix). This keeps the "never a panic / fail-closed, coarse kind + exit 2"
    // contract intact for inputs like `diagnostics_snapshot $'\xff'`.
    let parsed = parse_args(env::args_os()).and_then(|args| run(&args));
    match parsed {
        Ok(rendered) => {
            println!("{rendered}");
        }
        Err(err) => {
            // Refs-only error to stdout (no detail), coarse category to stderr, non-zero exit.
            let payload = json!({
                "truth_label": "rust_diagnostics_snapshot",
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
            eprintln!("diagnostics_snapshot_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

/// Convert raw OS argv into UTF-8 `String`s fail-closed. `std::env::args()`
/// PANICS (abort, exit 101) the moment any argv entry is not valid UTF-8 — it
/// fires inside `.collect()` BEFORE the fail-closed arg-parse path can run. By
/// reading `args_os()` and mapping each `OsString -> String` failure to a coarse
/// `bad_args` error, any non-UTF-8 arg in any position routes to the refs-only
/// error + exit 2 instead of a panic.
fn parse_args(args: impl Iterator<Item = OsString>) -> Result<Vec<String>, BridgeError> {
    args.map(|a| a.into_string().map_err(|_| BridgeError::new("bad_args")))
        .collect()
}

fn run(args: &[String]) -> Result<String, BridgeError> {
    // `--db <path>` is required.
    let db_path = arg_value(args, "--db").ok_or(BridgeError::new("bad_args"))?;
    // `--format` is optional and defaults to `json`. An UNRECOGNIZED format is a
    // hard `bad_args` (never silently emit json for `--format table`): a
    // wrong-but-plausible output is worse than a coarse error.
    match arg_value(args, "--format").as_deref().unwrap_or("json") {
        "json" => {}
        _ => return Err(BridgeError::new("bad_args")),
    }

    if !Path::new(&db_path).is_file() {
        return Err(BridgeError::new("db_not_found"));
    }
    // Read-only open: a diagnostics read can NEVER mutate an operator DB.
    // FAIL CLOSED + NAME the skew if the on-disk schema is strictly NEWER than this (stale)
    // binary understands — the always-on `Db::open_hub_readonly` guard surfaced distinctly.
    let db = Db::open_hub_readonly(&db_path).map_err(|e| match e {
        StorageError::SchemaTooNew { disk, code } => {
            eprintln!(
                "diagnostics_snapshot: leg=open error_kind=schema_too_new disk_version={disk} \
                 code_version={code} (stale binary: rebuild from the deploying commit)"
            );
            BridgeError::new("schema_too_new")
        }
        _ => BridgeError::new("open_failed"),
    })?;
    // The collect error path is mapped to a coarse kind — a StorageError can
    // carry path/io detail, so it is never printed (same leak surface as the
    // omitted `reason`).
    let snapshot =
        DiagnosticsSnapshot::collect(&db).map_err(|_| BridgeError::new("read_failed"))?;
    render(&snapshot)
}

/// Core: project a [`DiagnosticsSnapshot`] into the refs-only JSON and run it
/// through the output guard. Taking `&DiagnosticsSnapshot` (not the db) means the
/// real-DB test (collect on a seeded temp db) and the hand-built Broken-reason
/// canary both exercise the IDENTICAL render+guard path — so the "omits the raw
/// reason" property is checked end-to-end, not helper-only.
fn render(snapshot: &DiagnosticsSnapshot) -> Result<String, BridgeError> {
    // Map the audit chain to refs-only fields ONLY: a bool, a static status
    // label, and (for Verified) the integer entry count. The `Broken.reason`
    // String is DELIBERATELY DROPPED — it can embed sqlite/io detail. The fact of
    // the anomaly is still surfaced (`verified=false`, `status="broken"`), never
    // suppressed; only the unbounded detail string is omitted.
    let (chain_verified, chain_status, chain_entries) = match &snapshot.audit_chain {
        ChainStatus::Verified { entries } => (true, "verified", Some(*entries)),
        ChainStatus::Broken { .. } => (false, "broken", None),
    };

    // Truth-labeled unbuilt subsystems: both fields are `&'static str` labels
    // (never a fabricated `0`) — refs-safe by construction.
    let unavailable: Vec<_> = snapshot
        .unavailable
        .iter()
        .map(|u| {
            json!({
                "metric": u.metric,
                "blocker": u.blocker,
            })
        })
        .collect();

    let payload = json!({
        "truth_label": "rust_diagnostics_snapshot",
        "proof_only": true,
        "ok": true,
        "build_id": snapshot.build_id,
        "build_current": snapshot.is_current(),
        "model_calls": snapshot.model_calls,
        "total_tokens": snapshot.total_tokens,
        "agent_runs": snapshot.agent_runs,
        "activity_items": snapshot.activity_items,
        "healthy": snapshot.is_healthy(),
        "audit_chain": {
            "verified": chain_verified,
            "status": chain_status,
            "entries": chain_entries,
        },
        "unavailable": unavailable,
    });

    let rendered =
        serde_json::to_string(&payload).map_err(|_| BridgeError::new("serialize_failed"))?;
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
/// refs-only payload. Mirrors `hub_run_readback` / `hub_providers_detect`. The
/// primary defense is structural — the payload carries only counts/booleans/ids/
/// static labels and the `Broken.reason` String is dropped before this point — so
/// these markers should never appear; the guard is the backstop that fails the
/// WHOLE projection closed if one ever does (non-zero exit + refs-only error).
fn reject_forbidden_output(rendered: &str) -> Result<(), BridgeError> {
    // Delegates to the single shared guard (common secret/path markers
    // Authorization/Bearer/sk-/`/Users/`/`/private/`). This bin has no extra body-field
    // markers — the payload carries only counts/booleans/ids/static labels.
    friday_hub::refs_guard::reject_forbidden_output(rendered, &[])
        .map_err(|_| BridgeError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_hub::diagnostics::{current_build_id, UnavailableMetric};
    use friday_hub::record_friday_ask;
    use serde_json::{from_str, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    /// Canned DeepSeek transport: seeds ONE real billable model call through the
    /// real `record_friday_ask` path (token_ledger + activity + hash-chained
    /// audit), so the bin's render runs over a REAL collected snapshot — not a
    /// hand-built one. Mirrors the diagnostics module's own test transport.
    struct MockTransport;
    impl friday_deepseek::Transport for MockTransport {
        fn get_json(
            &self,
            _url: &str,
            _bearer: &str,
        ) -> Result<Value, friday_deepseek::DeepSeekError> {
            Ok(serde_json::json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, friday_deepseek::DeepSeekError> {
            Ok(serde_json::json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":"hello"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}
            }))
        }
    }

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-hub-diagbin-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn parse(rendered: &str) -> Value {
        from_str(rendered).expect("rendered payload is valid JSON")
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "hub.sqlite".to_string(),
            "--format=json".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("hub.sqlite"));
        assert_eq!(arg_value(&args, "--format").as_deref(), Some("json"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn render_over_real_collected_snapshot_has_exact_safe_shape() {
        // Seed ONE real model call so the render runs over a non-trivial REAL
        // snapshot (collect through the production substrate path).
        let mut db = Db::open_hub(&tmp("real")).unwrap();
        let client = friday_deepseek::DeepSeekClient::with_transport(MockTransport, "k".into());
        let out = record_friday_ask(&mut db, &client, "l1", "s1", "a1", "hi", 128, 1000).unwrap();
        assert_eq!(out.total_tokens, 15);

        let snap = DiagnosticsSnapshot::collect(&db).unwrap();
        let rendered = render(&snap).expect("renders");
        // The bin's REAL safe output clears the guard (no marker collision —
        // verified, not merely reasoned: the `unavailable` blockers contain words
        // like "skills"/"PII" which are NOT the `sk-` marker).
        assert!(reject_forbidden_output(&rendered).is_ok());

        let v = parse(&rendered);
        assert_eq!(v["truth_label"], "rust_diagnostics_snapshot");
        assert_eq!(v["proof_only"], true);
        assert_eq!(v["ok"], true);
        assert_eq!(v["build_id"], current_build_id());
        assert_eq!(v["build_current"], true);
        // REAL substrate counts surfaced truthfully.
        assert_eq!(v["model_calls"], 1);
        assert_eq!(v["total_tokens"], 15);
        assert_eq!(v["agent_runs"], 0);
        assert_eq!(v["activity_items"], 1);
        assert_eq!(v["healthy"], true);
        // Audit chain surfaced as refs-only fields (verified + status + entries).
        assert_eq!(v["audit_chain"]["verified"], true);
        assert_eq!(v["audit_chain"]["status"], "verified");
        assert_eq!(v["audit_chain"]["entries"], 1);
        // Unbuilt subsystems truth-labeled (never a fabricated 0).
        let unavail = v["unavailable"].as_array().expect("unavailable is array");
        assert!(!unavail.is_empty());
        for entry in unavail {
            let obj = entry.as_object().expect("entry is an object");
            assert_eq!(obj.len(), 2, "exactly metric + blocker");
            assert!(obj.contains_key("metric"));
            assert!(obj.contains_key("blocker"));
        }

        // EXACT top-level shape: ONLY the safe keys, no raw/body field smuggled.
        let top = v.as_object().unwrap();
        let mut keys: Vec<&str> = top.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "activity_items",
                "agent_runs",
                "audit_chain",
                "build_current",
                "build_id",
                "healthy",
                "model_calls",
                "ok",
                "proof_only",
                "total_tokens",
                "truth_label",
                "unavailable",
            ]
        );
    }

    #[test]
    fn empty_db_renders_real_zeros_not_fabricated() {
        let db = Db::open_hub(&tmp("empty")).unwrap();
        let snap = DiagnosticsSnapshot::collect(&db).unwrap();
        let v = parse(&render(&snap).expect("renders"));
        // A genuine zero (no calls) — surfaced as 0, distinct from the unavailable
        // truth-labels (unbuilt subsystems never collapse into a fabricated 0).
        assert_eq!(v["model_calls"], 0);
        assert_eq!(v["total_tokens"], 0);
        assert_eq!(v["audit_chain"]["status"], "verified");
        assert_eq!(v["audit_chain"]["entries"], 0);
        assert!(!v["unavailable"].as_array().unwrap().is_empty());
    }

    #[test]
    fn broken_chain_reason_is_omitted_from_render() {
        // LOAD-BEARING omission canary (distinct from the guard-trip canary): a
        // hand-built Broken snapshot whose `reason` carries an absolute path +
        // locked-file text — exactly the kind of sqlite/io detail StorageError can
        // embed. The render must DROP the reason entirely (surfacing only the
        // static `"broken"` label + verified=false + entries=null) — proven
        // independent of what real sqlite/io text looks like at runtime. A
        // regression that re-added `reason` to the payload would be caught here
        // EVEN IF the reason text happened to contain no forbidden marker.
        let secret_reason = "/private/tmp/hub.sqlite is locked at /Users/op/db";
        let snap = DiagnosticsSnapshot {
            build_id: current_build_id().to_string(),
            model_calls: 3,
            total_tokens: 42,
            agent_runs: 1,
            activity_items: 2,
            audit_chain: ChainStatus::Broken {
                reason: secret_reason.to_string(),
            },
            unavailable: vec![UnavailableMetric {
                metric: "workflow_runtime_metrics",
                blocker: "no workflow execution engine",
            }],
        };
        let rendered = render(&snap).expect("renders (guard passes — reason was dropped)");
        // The raw reason text and its path markers never reach output.
        assert!(
            !rendered.contains(secret_reason),
            "raw Broken reason must be omitted"
        );
        assert!(!rendered.contains("/private/"), "no absolute path leaks");
        assert!(!rendered.contains("/Users/"), "no absolute path leaks");
        assert!(!rendered.contains("is locked"), "no io detail leaks");
        // The anomaly is still surfaced (not suppressed): broken + unhealthy.
        let v = parse(&rendered);
        assert_eq!(v["audit_chain"]["verified"], false);
        assert_eq!(v["audit_chain"]["status"], "broken");
        assert_eq!(v["audit_chain"]["entries"], Value::Null);
        assert_eq!(v["healthy"], false);
        // Real counts alongside the surfaced anomaly are still read truthfully.
        assert_eq!(v["model_calls"], 3);
        assert_eq!(v["total_tokens"], 42);
    }

    #[test]
    fn forbidden_output_guard_blocks_secret_and_path_markers() {
        // CANARY: prove the backstop guard itself trips — if some future
        // regression DID let a secret/path reach the payload, printing is blocked.
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"sk-secret"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"path":"/Users/someone"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"path":"/private/tmp"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"h":"Authorization: x"}"#).is_err());
        // A safe refs-only payload clears it.
        assert!(reject_forbidden_output(
            r#"{"truth_label":"rust_diagnostics_snapshot","model_calls":0}"#
        )
        .is_ok());
    }

    #[test]
    fn run_rejects_unknown_format() {
        // `--format table` (or any non-json) is a hard bad_args, NOT a silent
        // fall-through to json: a wrong-but-plausible output is worse than a
        // coarse error. (db existence is checked AFTER format, so a bad format
        // short-circuits before any DB open.)
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "ignored.sqlite".to_string(),
            "--format".to_string(),
            "table".to_string(),
        ];
        let err = run(&args).expect_err("unknown format must be bad_args");
        assert_eq!(err.kind, "bad_args");
    }

    #[test]
    fn run_requires_db_arg() {
        let err = run(&["bin".to_string()]).expect_err("missing --db must be bad_args");
        assert_eq!(err.kind, "bad_args");
    }

    /// Fail-closed argv: a NON-UTF-8 arg must route to the coarse `bad_args`
    /// error (then exit 2 in `main`), NEVER panic — mirrors the hub_providers_detect
    /// contract. Drives `parse_args` directly (no process spawn) for determinism.
    #[cfg(unix)]
    #[test]
    fn non_utf8_argv_is_fail_closed_not_a_panic() {
        use std::os::unix::ffi::OsStrExt;
        let argv = [
            OsString::from("diagnostics_snapshot"),
            std::ffi::OsStr::from_bytes(&[0xff]).to_os_string(),
        ];
        let err = parse_args(argv.into_iter())
            .expect_err("non-UTF-8 argv must be rejected, not converted/panicked");
        assert_eq!(err.kind, "bad_args");
    }
}
