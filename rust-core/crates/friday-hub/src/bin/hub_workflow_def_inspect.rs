//! S8 dev inspect bin — `hub_workflow_def_inspect`.
//!
//! PROOF-ONLY (Rust-wired-DEV), mirroring the `hub_run_readback` house pattern:
//! opens the hub DB READ-ONLY ([`friday_storage::Db::open_hub_readonly`]), emits
//! a refs-only JSON projection of the stored workflow DEFINITIONS, and runs the
//! output through the shared forbidden-marker guard before printing.
//!
//! This is NOT a production route, NOT a TS integration, and confers no v1 GO —
//! workflow execution remains fenced in TS and is NOT product-replaced. It
//! exists so a developer/coordinator can inspect the S8 definition store
//! (versions, published flags, provenance, fingerprints) without ever
//! transporting a definition body.
//!
//! ## Output contract — REFS ONLY (no bodies, no secrets, no PII)
//! One JSON object on stdout carrying ONLY safe identifiers/labels:
//! `truth_label="rust_wired_dev"`, the definition summaries (workflow_id /
//! version / name label / sha256 checksum / source label / is_published /
//! created_at_ms) and counts. The body-bearing columns (`definition_json`,
//! `source_meta`) are NEVER selected (the storage summary type does not carry
//! them), and the [`reject_forbidden_output`] guard fails the WHOLE projection
//! closed if any forbidden marker ever appears.
//!
//! Usage: `hub_workflow_def_inspect --db <hub.sqlite> [--workflow-id <id>]`

use std::env;
use std::path::Path;

use friday_storage::workflow_def::list_definitions;
use friday_storage::{Db, StorageError};
use serde_json::json;

/// Fail-closed error: only a coarse, safe category is surfaced (no raw detail,
/// so storage/IO errors cannot leak paths).
struct InspectError {
    kind: &'static str,
}

impl InspectError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_workflow_def_inspect_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, InspectError> {
    let args: Vec<String> = env::args().collect();
    let db_path = arg_value(&args, "--db").ok_or(InspectError::new("bad_args"))?;
    if !Path::new(&db_path).is_file() {
        return Err(InspectError::new("db_not_found"));
    }
    let workflow_filter = arg_value(&args, "--workflow-id");

    // Read-only open: inspection can NEVER mutate an operator DB.
    // FAIL CLOSED + NAME the skew if the on-disk schema is strictly NEWER than this (stale)
    // binary understands — the always-on `Db::open_hub_readonly` guard surfaced distinctly.
    let db = Db::open_hub_readonly(&db_path).map_err(|e| match e {
        StorageError::SchemaTooNew { disk, code } => {
            eprintln!(
                "hub_workflow_def_inspect: leg=open error_kind=schema_too_new disk_version={disk} \
                 code_version={code} (stale binary: rebuild from the deploying commit)"
            );
            InspectError::new("schema_too_new")
        }
        _ => InspectError::new("open_failed"),
    })?;

    let mut summaries =
        list_definitions(db.conn()).map_err(|_| InspectError::new("read_failed"))?;
    if let Some(filter) = &workflow_filter {
        summaries.retain(|s| &s.workflow_id == filter);
    }

    let definitions: Vec<serde_json::Value> = summaries
        .iter()
        .map(|s| {
            json!({
                "workflow_id": s.workflow_id,
                "version": s.version,
                "name": s.name,
                "checksum_sha256": s.checksum,
                "source": s.source.as_str(),
                "is_published": s.is_published,
                "created_at_ms": s.created_at,
            })
        })
        .collect();
    let published_count = summaries.iter().filter(|s| s.is_published).count();

    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "definition_count": definitions.len(),
        "published_count": published_count,
        "definitions": definitions,
    });

    let rendered =
        serde_json::to_string(&payload).map_err(|_| InspectError::new("serialize_failed"))?;
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
/// body-bearing fields (`definition_json`, `source_meta`) must never appear —
/// only summaries do.
fn reject_forbidden_output(rendered: &str) -> Result<(), InspectError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &["\"definition_json\"", "\"source_meta\""],
    )
    .map_err(|_| InspectError::new("output_guard"))
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
            "--workflow-id=wf-1".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(arg_value(&args, "--workflow-id").as_deref(), Some("wf-1"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn forbidden_output_guard_blocks_bodies_and_secret_markers() {
        assert!(reject_forbidden_output(r#"{"definition_json":"{...}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"source_meta":"{...}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/jarvis/x"}"#).is_err());
    }

    #[test]
    fn refs_only_payload_shape_passes_the_guard() {
        let payload = json!({
            "truth_label": "rust_wired_dev",
            "proof_only": true,
            "ok": true,
            "definition_count": 1,
            "published_count": 1,
            "definitions": [{
                "workflow_id": "wf-1",
                "version": 2,
                "name": "research",
                "checksum_sha256": "ab".repeat(32),
                "source": "ts_translated",
                "is_published": true,
                "created_at_ms": 100,
            }],
        });
        let rendered = serde_json::to_string(&payload).unwrap();
        assert!(reject_forbidden_output(&rendered).is_ok());
        let parsed: Value = from_str(&rendered).unwrap();
        assert!(
            parsed.get("definitions").unwrap()[0]
                .get("definition_json")
                .is_none(),
            "must never carry the definition body"
        );
    }
}
