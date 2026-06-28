//! A6 / R3 dev catalog-mutation bin — `hub_workflow_catalog`.
//!
//! PROOF-ONLY (Rust-wired-DEV). The catalog sibling of `hub_workflow_def_inspect`
//! (read-only inspect) and `hub_workflow_run` (S9 run bridge): a thin one-shot bin
//! around the R3 catalog-mutation DOMAIN layer
//! ([`friday_hub::workflow_catalog`]) that exposes the five catalog ops the
//! retired TS `workflows.*` mutation surface maps to —
//! `create / update / archive / publish / deploy` — plus `get` / `list` for
//! refs-only readback (and `add_version`, see the scope note below), selecting the
//! op + args from argv and emitting a refs-only JSON receipt.
//!
//! ## DARK / DEPLOY-GO-gated (no operator gate to RUN this bin)
//! This is NOT a production route, NOT a TS integration, and confers no v1 GO.
//! It registers NO route, NO scheduler/trigger/daemon, and changes NO TS runtime
//! file. The live TS `workflows.*` routes stay fail-closed/retired; wiring this
//! Rust path behind them is operator-gated (GATE-WF-REPLACE) and OUTSIDE this dark
//! build. UNLIKE the provider bins, running this bin spends NO quota and touches NO
//! network — it is pure local SQLite domain work — so it is fully live-provable
//! DARK with no operator gate to exercise. The DEPLOY op here is the
//! storage/domain deploy POINTER only (it sets `deployed_version` to the
//! S8-published version); it does NOT start a run, register a schedule, or fire a
//! runtime trigger (that is A5/S10, separately gated).
//!
//! ## Output contract — REFS ONLY (no definition bodies, no free-form text)
//! One JSON object on stdout carrying ONLY safe identifiers/labels/counts:
//! `truth_label="rust_wired_dev"`, `proof_only=true`, the op, and the catalog
//! REFS — `workflow_id`, `version`, `revision`, `etag`, `deployed_version`,
//! `is_archived`, `created_at_ms`, `updated_at_ms`. The catalog's FREE-FORM caller
//! strings (`slug` / `name` / `description` / `tags_json`) are NEVER emitted
//! verbatim — only a BOUNDED projection (`<field>_sha256` + `<field>_len`), exactly
//! like `hub_workflow_run` projects the free-form workflow name. A free-form value
//! that embeds a secret/path marker is therefore structurally unable to reach
//! stdout through those fields. Definition BODIES (`definition_json`,
//! `source_meta`) are never selected. [`reject_forbidden_output`] fails the whole
//! receipt closed (defense in depth) if any forbidden marker ever appears.
//!
//! ## Fail-closed posture (mirrors the domain layer + the sibling bins)
//! - A missing `--db` FILE is `db_not_found` — never silently created.
//! - A present-but-unparsable `--expected-revision` / `--version` / `--now-ms` is
//!   `bad_args` — never a silent fallback (the `hub_workflow_run` posture).
//! - Every domain error is mapped to ONE coarse, closed-vocab `error_kind`
//!   (`invalid` / `not_found` / `conflict` / `def_invalid` / `storage_failed`).
//!   The domain `Display` strings embed `workflow_id`/slug, so the raw detail is
//!   NEVER surfaced (the `classify_failure_reason` discipline).
//!
//! ## `Db::open_hub` MIGRATES the target DB on open
//! NEVER point `--db` at the production hub DB — this bin is for dev/temp DBs only
//! (the `hub_workflow_run` warning, verbatim).
//!
//! Usage:
//!   hub_workflow_catalog --db <hub.sqlite> --op create   --workflow-id <id> --slug <s> --name <n> --def-json <json> [--description <d>] [--tags-json <j>] [--now-ms <ms>]
//!   hub_workflow_catalog --db <hub.sqlite> --op update    --workflow-id <id> --expected-revision <r> [--name <n>] [--description <d> | --clear-description] [--tags-json <j>] [--now-ms <ms>]
//!   hub_workflow_catalog --db <hub.sqlite> --op add-version --workflow-id <id> --version <v> --def-json <json> [--now-ms <ms>]
//!   hub_workflow_catalog --db <hub.sqlite> --op publish   --workflow-id <id> --version <v>
//!   hub_workflow_catalog --db <hub.sqlite> --op deploy    --workflow-id <id> --expected-revision <r> [--now-ms <ms>]
//!   hub_workflow_catalog --db <hub.sqlite> --op archive   --workflow-id <id> --expected-revision <r> [--now-ms <ms>]
//!   hub_workflow_catalog --db <hub.sqlite> --op get       --workflow-id <id>
//!   hub_workflow_catalog --db <hub.sqlite> --op list

use std::env;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_hub::workflow_catalog as catalog;
use friday_hub::workflow_def::{parse_definition_json, StoredWorkflowDefV1, WorkflowDefError};
use friday_storage::workflow_catalog::WorkflowCatalogRow;
use friday_storage::Db;
use serde_json::json;
use sha2::{Digest, Sha256};

/// A fail-closed error: `kind` is a coarse, safe category (the only thing
/// surfaced); raw detail is deliberately NOT printed so storage/domain errors
/// cannot leak the workflow id, slug, or a path.
struct BinError {
    kind: &'static str,
}

impl BinError {
    fn new(kind: &'static str) -> Self {
        Self { kind }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    match run(&args) {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            // Defense-in-depth: route the error payload through the SAME guard as
            // the success path. `error_kind` is a static closed-vocab token, so
            // this never suppresses a legitimate error report.
            let rendered = payload.to_string();
            if reject_forbidden_output(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_workflow_catalog_unavailable: {}", err.kind);
            std::process::exit(2);
        }
    }
}

fn run(args: &[String]) -> Result<String, BinError> {
    let db_path = arg_value(args, "--db").ok_or(BinError::new("bad_args"))?;
    // The hub DB must ALREADY exist — a missing DB is fail-closed, never created.
    if !Path::new(&db_path).is_file() {
        return Err(BinError::new("db_not_found"));
    }
    let op = arg_value(args, "--op").ok_or(BinError::new("bad_args"))?;

    // Db::open_hub MIGRATES on open (mutations need RW). DEV/temp DBs ONLY.
    let db = Db::open_hub(&db_path).map_err(|_| BinError::new("open_failed"))?;
    let conn = db.conn();

    let payload = match op.as_str() {
        "create" => {
            let workflow_id = req(args, "--workflow-id")?;
            let slug = req(args, "--slug")?;
            let name = req(args, "--name")?;
            let description = arg_value(args, "--description");
            let tags_json = arg_value(args, "--tags-json");
            let def = parse_def(args)?;
            let now_ms = now_ms(args)?;
            let m = catalog::create(
                conn,
                &workflow_id,
                &slug,
                &name,
                description.as_deref(),
                tags_json.as_deref(),
                &def,
                now_ms,
            )
            .map_err(map_catalog_err)?;
            // Read the just-minted row so the receipt carries the full refs set
            // (the catalog op returns only the new (revision, etag) token).
            mutation_receipt("create", conn, &workflow_id, &m)?
        }
        "update" => {
            let workflow_id = req(args, "--workflow-id")?;
            let expected_revision = req_i64(args, "--expected-revision")?;
            let name = arg_value(args, "--name");
            // Tri-state description: `--description <v>` SETS, `--clear-description`
            // CLEARS, NEITHER leaves unchanged. The two are mutually exclusive
            // (both present is ambiguous → bad_args, never a silent precedence).
            let has_clear = flag(args, "--clear-description");
            let set_desc = arg_value(args, "--description");
            let description: Option<Option<&str>> = match (set_desc.as_deref(), has_clear) {
                (Some(_), true) => return Err(BinError::new("bad_args")),
                (Some(d), false) => Some(Some(d)),
                (None, true) => Some(None),
                (None, false) => None,
            };
            let tags_json = arg_value(args, "--tags-json");
            let now_ms = now_ms(args)?;
            let m = catalog::update(
                conn,
                &workflow_id,
                expected_revision,
                name.as_deref(),
                description,
                tags_json.as_deref(),
                now_ms,
            )
            .map_err(map_catalog_err)?;
            mutation_receipt("update", conn, &workflow_id, &m)?
        }
        "add-version" => {
            // BEYOND the spec's five-op surface (the spec enumerates
            // create/update/archive/publish/deploy). Included because minting a
            // SECOND immutable version is the only way to exercise the
            // single-published flip + deploy-of-vN through the bin, and it is a thin
            // pass-through to the proven domain `add_version`. It returns a CHECKSUM
            // (no catalog revision bump — the catalog identity is unchanged), so its
            // receipt carries the version checksum, not a (revision, etag) token.
            let workflow_id = req(args, "--workflow-id")?;
            let version = req_i64(args, "--version")?;
            let def = parse_def(args)?;
            let now_ms = now_ms(args)?;
            let checksum = catalog::add_version(conn, &workflow_id, version, &def, now_ms)
                .map_err(map_catalog_err)?;
            let row = require_row(conn, &workflow_id)?;
            let mut p = row_refs(&row);
            p["op"] = json!("add-version");
            p["added_version"] = json!(version);
            p["version_checksum_sha256"] = json!(checksum);
            p
        }
        "publish" => {
            let workflow_id = req(args, "--workflow-id")?;
            let version = req_i64(args, "--version")?;
            catalog::publish(conn, &workflow_id, version).map_err(map_catalog_err)?;
            // publish delegates the flip to S8 and does NOT bump the catalog
            // revision — re-read the row so the receipt reflects the (unchanged)
            // catalog refs, and surface the published version.
            let row = require_row(conn, &workflow_id)?;
            let mut p = row_refs(&row);
            p["op"] = json!("publish");
            p["published_version"] = json!(version);
            p
        }
        "deploy" => {
            let workflow_id = req(args, "--workflow-id")?;
            let expected_revision = req_i64(args, "--expected-revision")?;
            let now_ms = now_ms(args)?;
            let m = catalog::deploy(conn, &workflow_id, expected_revision, now_ms)
                .map_err(map_catalog_err)?;
            mutation_receipt("deploy", conn, &workflow_id, &m)?
        }
        "archive" => {
            let workflow_id = req(args, "--workflow-id")?;
            let expected_revision = req_i64(args, "--expected-revision")?;
            let now_ms = now_ms(args)?;
            let m = catalog::archive(conn, &workflow_id, expected_revision, now_ms)
                .map_err(map_catalog_err)?;
            mutation_receipt("archive", conn, &workflow_id, &m)?
        }
        "get" => {
            let workflow_id = req(args, "--workflow-id")?;
            let row = catalog::get(conn, &workflow_id).map_err(map_catalog_err)?;
            match row {
                Some(row) => {
                    let mut p = row_refs(&row);
                    p["op"] = json!("get");
                    p["found"] = json!(true);
                    p
                }
                None => json!({
                    "truth_label": "rust_wired_dev",
                    "proof_only": true,
                    "ok": true,
                    "op": "get",
                    "found": false,
                    "workflow_id": workflow_id,
                }),
            }
        }
        "list" => {
            let rows = catalog::list(conn).map_err(map_catalog_err)?;
            let entries: Vec<serde_json::Value> = rows.iter().map(row_refs).collect();
            json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": true,
                "op": "list",
                "entry_count": entries.len(),
                "entries": entries,
            })
        }
        _ => return Err(BinError::new("bad_args")),
    };

    let rendered =
        serde_json::to_string(&payload).map_err(|_| BinError::new("serialize_failed"))?;
    reject_forbidden_output(&rendered)?;
    Ok(rendered)
}

/// Build a mutation receipt: re-read the row by id so the returned refs match the
/// PERSISTED state exactly (the op returns only the new `(revision, etag)` token).
/// The op's returned token and the re-read row are cross-checked so a torn read
/// can't surface a stale revision — they must agree on the new revision/etag.
fn mutation_receipt(
    op: &'static str,
    conn: &rusqlite::Connection,
    workflow_id: &str,
    m: &catalog::CatalogMutation,
) -> Result<serde_json::Value, BinError> {
    let row = require_row(conn, workflow_id)?;
    // Cross-check: the persisted row must match the op's returned token (defense
    // in depth against a concurrent writer between the op and the readback).
    if row.revision != m.revision || row.etag != m.etag {
        return Err(BinError::new("storage_failed"));
    }
    let mut p = row_refs(&row);
    p["op"] = json!(op);
    Ok(p)
}

/// Re-read a catalog row by id, failing closed (`not_found`) if it vanished.
fn require_row(
    conn: &rusqlite::Connection,
    workflow_id: &str,
) -> Result<WorkflowCatalogRow, BinError> {
    catalog::get(conn, workflow_id)
        .map_err(map_catalog_err)?
        .ok_or(BinError::new("not_found"))
}

/// REFS-ONLY projection of a catalog row. The IDENTITY/state fields that are safe
/// (ids, counters, booleans, timestamps) are emitted verbatim; the FREE-FORM
/// caller strings (`slug` / `name` / `description` / `tags_json`) are projected
/// BOUNDED — `<field>_sha256` + `<field>_len` — and NEVER emitted verbatim, so a
/// marker-bearing slug/name/description/tags value is structurally unable to reach
/// stdout through these fields (the `hub_workflow_run` workflow_name discipline).
/// `description` is nullable: a NULL description yields `description_sha256: null`,
/// `description_len: null` (distinguishable from an empty-string description).
fn row_refs(row: &WorkflowCatalogRow) -> serde_json::Value {
    let (desc_sha, desc_len) = match &row.description {
        Some(d) => (json!(sha256_hex(d.as_bytes())), json!(d.len())),
        None => (serde_json::Value::Null, serde_json::Value::Null),
    };
    json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "workflow_id": row.workflow_id,
        // FREE-FORM caller strings: bounded projection only (never verbatim).
        "slug_sha256": sha256_hex(row.slug.as_bytes()),
        "slug_len": row.slug.len(),
        "name_sha256": sha256_hex(row.name.as_bytes()),
        "name_len": row.name.len(),
        "description_sha256": desc_sha,
        "description_len": desc_len,
        "tags_json_sha256": sha256_hex(row.tags_json.as_bytes()),
        "tags_json_len": row.tags_json.len(),
        // Safe identity/state/concurrency refs (verbatim; the guard is a backstop).
        "is_archived": row.is_archived,
        "revision": row.revision,
        "etag": row.etag,
        "deployed_version": row.deployed_version,
        "created_at_ms": row.created_at,
        "updated_at_ms": row.updated_at,
    })
}

/// Parse + validate the `--def-json` body fail-closed. The body is INPUT (it never
/// reaches the output guard), so the raw JSON is accepted as-is; a missing or
/// unparsable body is fail-closed.
fn parse_def(args: &[String]) -> Result<StoredWorkflowDefV1, BinError> {
    let raw = arg_value(args, "--def-json").ok_or(BinError::new("bad_args"))?;
    parse_definition_json(&raw).map_err(|e| BinError::new(workflow_def_error_kind(&e)))
}

/// A required string arg → `bad_args` if absent.
fn req(args: &[String], name: &str) -> Result<String, BinError> {
    arg_value(args, name).ok_or(BinError::new("bad_args"))
}

/// A required i64 arg → `bad_args` if absent OR present-but-unparsable (never a
/// silent fallback).
fn req_i64(args: &[String], name: &str) -> Result<i64, BinError> {
    req(args, name)?
        .parse::<i64>()
        .map_err(|_| BinError::new("bad_args"))
}

/// `--now-ms`: a PRESENT-but-unparsable value is `bad_args` (fail-closed); absent
/// ⇒ the wall clock (the `hub_workflow_run` posture).
fn now_ms(args: &[String]) -> Result<i64, BinError> {
    match arg_value(args, "--now-ms") {
        Some(raw) => raw.parse::<i64>().map_err(|_| BinError::new("bad_args")),
        None => Ok(SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)),
    }
}

/// True iff a bare flag (`--clear-description`) is present in argv.
fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
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

/// Map a catalog-domain error to ONE coarse, closed-vocab kind. The domain
/// `Display` strings embed the workflow id / slug, so they are NEVER surfaced —
/// only the fixed token is emitted (the `classify_failure_reason` discipline).
fn map_catalog_err(err: catalog::WorkflowCatalogError) -> BinError {
    use catalog::WorkflowCatalogError as E;
    let kind = match err {
        E::Invalid(_) => "invalid",
        E::NotFound(_) => "not_found",
        E::Conflict(_) => "conflict",
        E::Definition(_) => "def_invalid",
        E::Storage(_) => "storage_failed",
    };
    BinError::new(kind)
}

/// Map a definition-layer parse/validate error to ONE coarse kind (a parse error
/// can quote definition content; never surfaced).
fn workflow_def_error_kind(err: &WorkflowDefError) -> &'static str {
    match err {
        WorkflowDefError::NotFound(_) => "not_found",
        WorkflowDefError::Parse(_)
        | WorkflowDefError::Invalid(_)
        | WorkflowDefError::UnsupportedSchemaVersion { .. } => "def_invalid",
        WorkflowDefError::Storage(_) => "storage_failed",
    }
}

/// Lowercase sha256 hex — the bounded projection of a free-form DB string
/// (mirrors `hub_workflow_run::sha256_hex`).
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
/// refs-only receipt. Beyond the shared secret/path markers, the catalog's
/// free-form fields and the definition bodies must never appear verbatim — so the
/// raw `"slug"` / `"name"` / `"description"` / `"tags_json"` keys (the verbatim
/// columns, NOT the `_sha256`/`_len` projections) and the body columns
/// (`"definition_json"` / `"source_meta"`) are blocked.
fn reject_forbidden_output(rendered: &str) -> Result<(), BinError> {
    friday_hub::refs_guard::reject_forbidden_output(
        rendered,
        &[
            "\"slug\"",
            "\"name\"",
            "\"description\"",
            "\"tags_json\"",
            "\"definition_json\"",
            "\"source_meta\"",
        ],
    )
    .map_err(|_| BinError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{from_str, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-wfcatbin-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Create an EMPTY hub DB file (migrated on open) and return its path — the
    /// precondition the bin requires (a missing DB is fail-closed).
    fn fresh_db(tag: &str) -> String {
        let path = tmp(tag);
        let _db = Db::open_hub(&path).unwrap();
        path
    }

    /// A minimal valid linear def body, as the inline `--def-json` argument.
    fn def_json(name: &str) -> String {
        format!(
            r#"{{"schema_version":1,"name":{},"steps":[{{"id":"read","action":"read_file"}}]}}"#,
            serde_json::to_string(name).unwrap()
        )
    }

    fn argv(db: &str, op: &str, extra: &[&str]) -> Vec<String> {
        let mut a = vec![
            "hub_workflow_catalog".to_string(),
            format!("--db={db}"),
            format!("--op={op}"),
        ];
        a.extend(extra.iter().map(|s| s.to_string()));
        a
    }

    fn ok_value(db: &str, op: &str, extra: &[&str]) -> Value {
        let rendered = run(&argv(db, op, extra)).map_err(|e| e.kind).unwrap();
        assert!(reject_forbidden_output(&rendered).is_ok());
        from_str(&rendered).unwrap()
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/tmp/hub.sqlite".to_string(),
            "--op=create".to_string(),
        ];
        assert_eq!(arg_value(&args, "--db").as_deref(), Some("/tmp/hub.sqlite"));
        assert_eq!(arg_value(&args, "--op").as_deref(), Some("create"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn flag_detects_bare_presence() {
        let args = vec![
            "bin".to_string(),
            "--clear-description".to_string(),
            "--name".to_string(),
            "X".to_string(),
        ];
        assert!(flag(&args, "--clear-description"));
        assert!(!flag(&args, "--missing"));
    }

    #[test]
    fn full_lifecycle_create_update_publish_deploy_archive_through_the_bin() {
        let db = fresh_db("lifecycle");

        // CREATE: born revision 1, not archived, no deploy pointer.
        let created = ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=research-wf",
                "--name=Research",
                "--description=a research workflow",
                &format!("--def-json={}", def_json("Research")),
                "--now-ms=100",
            ],
        );
        assert_eq!(created["op"], "create");
        assert_eq!(created["workflow_id"], "wf1");
        assert_eq!(created["revision"], 1);
        assert_eq!(created["is_archived"], false);
        assert_eq!(created["deployed_version"], Value::Null);
        assert_eq!(created["etag"].as_str().unwrap().len(), 64);
        // Free-form fields are projected BOUNDED, never verbatim.
        assert_eq!(created["name_sha256"], sha256_hex(b"Research"));
        assert_eq!(created["name_len"], "Research".len());
        assert_eq!(created["slug_sha256"], sha256_hex(b"research-wf"));
        assert_eq!(
            created["description_sha256"],
            sha256_hex(b"a research workflow")
        );
        assert!(created.get("name").is_none(), "raw name never emitted");
        assert!(created.get("slug").is_none(), "raw slug never emitted");

        // UPDATE under optimistic concurrency: revision bumps to 2, etag changes.
        let updated = ok_value(
            &db,
            "update",
            &[
                "--workflow-id=wf1",
                "--expected-revision=1",
                "--name=Research v2",
                "--description=updated",
                r#"--tags-json=["ai","research"]"#,
                "--now-ms=200",
            ],
        );
        assert_eq!(updated["revision"], 2);
        assert_ne!(updated["etag"], created["etag"]);
        assert_eq!(updated["name_sha256"], sha256_hex(b"Research v2"));
        assert_eq!(
            updated["tags_json_sha256"],
            sha256_hex(br#"["ai","research"]"#)
        );

        // PUBLISH v1: delegates the flip to S8; catalog revision UNCHANGED (2).
        let published = ok_value(&db, "publish", &["--workflow-id=wf1", "--version=1"]);
        assert_eq!(published["op"], "publish");
        assert_eq!(published["published_version"], 1);
        assert_eq!(
            published["revision"], 2,
            "publish does not bump the catalog revision"
        );

        // DEPLOY: sets the pointer to the S8-published version (1); revision → 3.
        let deployed = ok_value(
            &db,
            "deploy",
            &["--workflow-id=wf1", "--expected-revision=2", "--now-ms=300"],
        );
        assert_eq!(deployed["op"], "deploy");
        assert_eq!(deployed["revision"], 3);
        assert_eq!(deployed["deployed_version"], 1);

        // GET reflects the deployed state.
        let got = ok_value(&db, "get", &["--workflow-id=wf1"]);
        assert_eq!(got["found"], true);
        assert_eq!(got["deployed_version"], 1);
        assert_eq!(got["revision"], 3);

        // ARCHIVE under optimistic concurrency: revision → 4, is_archived true.
        let archived = ok_value(
            &db,
            "archive",
            &["--workflow-id=wf1", "--expected-revision=3", "--now-ms=400"],
        );
        assert_eq!(archived["revision"], 4);
        assert_eq!(archived["is_archived"], true);
    }

    #[test]
    fn add_version_then_deploy_of_v2_moves_the_pointer() {
        // add-version (beyond the five-op spec surface) + publish v2 + deploy →
        // the deploy pointer follows the S8-published version, exercised end-to-end
        // through the bin.
        let db = fresh_db("addver");
        ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=wf",
                "--name=WF",
                &format!("--def-json={}", def_json("WF")),
                "--now-ms=100",
            ],
        );
        let added = ok_value(
            &db,
            "add-version",
            &[
                "--workflow-id=wf1",
                "--version=2",
                &format!("--def-json={}", def_json("WF v2")),
                "--now-ms=150",
            ],
        );
        assert_eq!(added["op"], "add-version");
        assert_eq!(added["added_version"], 2);
        assert_eq!(added["version_checksum_sha256"].as_str().unwrap().len(), 64);
        // add-version does NOT bump the catalog revision.
        assert_eq!(added["revision"], 1);

        ok_value(&db, "publish", &["--workflow-id=wf1", "--version=2"]);
        let deployed = ok_value(
            &db,
            "deploy",
            &["--workflow-id=wf1", "--expected-revision=1", "--now-ms=200"],
        );
        assert_eq!(
            deployed["deployed_version"], 2,
            "deploy follows published v2"
        );
    }

    #[test]
    fn deploy_without_a_published_version_fails_closed_conflict() {
        let db = fresh_db("nopub");
        ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=wf",
                "--name=WF",
                &format!("--def-json={}", def_json("WF")),
                "--now-ms=100",
            ],
        );
        // No published version → nothing deployable → coarse `conflict`.
        let err = run(&argv(
            &db,
            "deploy",
            &["--workflow-id=wf1", "--expected-revision=1", "--now-ms=200"],
        ))
        .err()
        .unwrap();
        assert_eq!(err.kind, "conflict");
        // The pointer stays None (no partial write).
        let got = ok_value(&db, "get", &["--workflow-id=wf1"]);
        assert_eq!(got["deployed_version"], Value::Null);
    }

    #[test]
    fn stale_revision_and_unknown_entry_fail_closed() {
        let db = fresh_db("stale");
        ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=wf",
                "--name=WF",
                &format!("--def-json={}", def_json("WF")),
                "--now-ms=100",
            ],
        );
        // STALE expected_revision → storage_failed (optimistic-concurrency refusal).
        let err = run(&argv(
            &db,
            "update",
            &[
                "--workflow-id=wf1",
                "--expected-revision=99",
                "--name=X",
                "--now-ms=200",
            ],
        ))
        .err()
        .unwrap();
        assert_eq!(err.kind, "storage_failed");
        // The name is unchanged (no write).
        let got = ok_value(&db, "get", &["--workflow-id=wf1"]);
        assert_eq!(got["name_sha256"], sha256_hex(b"WF"));

        // UNKNOWN entry on publish → not_found.
        let err = run(&argv(
            &db,
            "publish",
            &["--workflow-id=ghost", "--version=1"],
        ))
        .err()
        .unwrap();
        assert_eq!(err.kind, "not_found");
    }

    #[test]
    fn archived_entry_is_read_only_publish_update_deploy_refuse() {
        let db = fresh_db("archived");
        ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=wf",
                "--name=WF",
                &format!("--def-json={}", def_json("WF")),
                "--now-ms=100",
            ],
        );
        ok_value(
            &db,
            "archive",
            &["--workflow-id=wf1", "--expected-revision=1", "--now-ms=200"],
        );
        // publish on an archived entry → conflict (hub-layer pre-tx fence).
        assert_eq!(
            run(&argv(&db, "publish", &["--workflow-id=wf1", "--version=1"]))
                .err()
                .unwrap()
                .kind,
            "conflict"
        );
        // update on an archived entry → storage_failed (in-tx archived re-check).
        assert_eq!(
            run(&argv(
                &db,
                "update",
                &[
                    "--workflow-id=wf1",
                    "--expected-revision=2",
                    "--name=X",
                    "--now-ms=300"
                ]
            ))
            .err()
            .unwrap()
            .kind,
            "storage_failed"
        );
    }

    #[test]
    fn update_description_tristate_set_clear_and_unchanged() {
        let db = fresh_db("tristate");
        ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=wf",
                "--name=WF",
                "--description=initial",
                &format!("--def-json={}", def_json("WF")),
                "--now-ms=100",
            ],
        );
        // UNCHANGED: neither flag → description stays "initial".
        let u1 = ok_value(
            &db,
            "update",
            &[
                "--workflow-id=wf1",
                "--expected-revision=1",
                "--name=WF2",
                "--now-ms=200",
            ],
        );
        assert_eq!(u1["description_sha256"], sha256_hex(b"initial"));

        // CLEAR: --clear-description → description NULL.
        let u2 = ok_value(
            &db,
            "update",
            &[
                "--workflow-id=wf1",
                "--expected-revision=2",
                "--clear-description",
                "--now-ms=300",
            ],
        );
        assert_eq!(u2["description_sha256"], Value::Null);
        assert_eq!(u2["description_len"], Value::Null);

        // SET: --description back to a value.
        let u3 = ok_value(
            &db,
            "update",
            &[
                "--workflow-id=wf1",
                "--expected-revision=3",
                "--description=restored",
                "--now-ms=400",
            ],
        );
        assert_eq!(u3["description_sha256"], sha256_hex(b"restored"));

        // BOTH --description and --clear-description → ambiguous → bad_args (no
        // silent precedence, no write).
        let err = run(&argv(
            &db,
            "update",
            &[
                "--workflow-id=wf1",
                "--expected-revision=4",
                "--description=x",
                "--clear-description",
                "--now-ms=500",
            ],
        ))
        .err()
        .unwrap();
        assert_eq!(err.kind, "bad_args");
    }

    #[test]
    fn marker_bearing_free_form_fields_are_structurally_impossible_in_output() {
        // STRUCTURAL (not canary-caught): a slug/name/description that embeds a
        // secret/path marker still produces a SUCCESSFUL receipt, because those
        // fields are never emitted verbatim — only their sha256 + byte length. The
        // marker cannot reach stdout through them at all.
        let db = fresh_db("marker");
        let name = "Bearer canary-name";
        let desc = "/Users/example/secret";
        let created = ok_value(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=safe-slug",
                &format!("--name={name}"),
                &format!("--description={desc}"),
                &format!("--def-json={}", def_json("WF")),
                "--now-ms=100",
            ],
        );
        // The markers are absent from the rendered receipt (the guard would also
        // have fired, but the point is they never get there).
        let rendered = serde_json::to_string(&created).unwrap();
        assert!(!rendered.contains("Bearer"), "marker never in output");
        assert!(!rendered.contains("/Users/"), "path marker never in output");
        assert_eq!(created["name_sha256"], sha256_hex(name.as_bytes()));
        assert_eq!(created["description_sha256"], sha256_hex(desc.as_bytes()));
        assert!(created.get("name").is_none());
        assert!(created.get("description").is_none());

        // And get/list of the same entry are equally bounded.
        let got = ok_value(&db, "get", &["--workflow-id=wf1"]);
        assert!(!serde_json::to_string(&got).unwrap().contains("Bearer"));
        let listed = ok_value(&db, "list", &[]);
        assert_eq!(listed["entry_count"], 1);
        assert!(!serde_json::to_string(&listed).unwrap().contains("Bearer"));
    }

    #[test]
    fn marker_bearing_workflow_id_fails_the_whole_receipt_closed() {
        // `workflow_id` is the ONE caller-controlled field emitted VERBATIM (the
        // free-form slug/name/description/tags are bounded; the id is an identity
        // ref, surfaced as-is like `hub_workflow_run`'s run_id). A marker-bearing
        // --workflow-id flows verbatim into the receipt, so the output guard must
        // refuse to print anything (fail-closed) — proving the guard sits between
        // the projection and stdout for the one field that is not bounded. This is
        // the catalog twin of hub_workflow_run's run_id canary.
        let db = fresh_db("canary-id");
        let err = run(&argv(&db, "get", &["--workflow-id=Bearer-wf"]))
            .err()
            .unwrap();
        assert_eq!(err.kind, "output_guard");
    }

    #[test]
    fn missing_db_is_fail_closed_and_not_created() {
        let ghost = tmp("ghost");
        let err = run(&argv(&ghost, "list", &[])).err().unwrap();
        assert_eq!(err.kind, "db_not_found");
        assert!(
            !Path::new(&ghost).exists(),
            "a missing DB must never be created"
        );
    }

    #[test]
    fn bad_args_for_unknown_op_and_unparsable_numeric_flags() {
        let db = fresh_db("badargs");
        // Unknown op.
        assert_eq!(
            run(&argv(&db, "frobnicate", &[])).err().unwrap().kind,
            "bad_args"
        );
        // Missing --op.
        assert_eq!(
            run(&["bin".to_string(), format!("--db={db}"),])
                .err()
                .unwrap()
                .kind,
            "bad_args"
        );
        // create with an unparsable --now-ms.
        assert_eq!(
            run(&argv(
                &db,
                "create",
                &[
                    "--workflow-id=wf1",
                    "--slug=wf",
                    "--name=WF",
                    &format!("--def-json={}", def_json("WF")),
                    "--now-ms=soon",
                ]
            ))
            .err()
            .unwrap()
            .kind,
            "bad_args"
        );
        // deploy with an unparsable --expected-revision.
        assert_eq!(
            run(&argv(
                &db,
                "deploy",
                &["--workflow-id=wf1", "--expected-revision=many"]
            ))
            .err()
            .unwrap()
            .kind,
            "bad_args"
        );
        // create with a missing --def-json.
        assert_eq!(
            run(&argv(
                &db,
                "create",
                &["--workflow-id=wf1", "--slug=wf", "--name=WF", "--now-ms=1"]
            ))
            .err()
            .unwrap()
            .kind,
            "bad_args"
        );
    }

    #[test]
    fn create_with_an_invalid_body_fails_closed_def_invalid_and_persists_nothing() {
        let db = fresh_db("badbody");
        // A foreign schema_version body → def_invalid; nothing persists.
        let err = run(&argv(
            &db,
            "create",
            &[
                "--workflow-id=wf1",
                "--slug=wf",
                "--name=WF",
                r#"--def-json={"schema_version":2,"name":"WF","steps":[]}"#,
                "--now-ms=100",
            ],
        ))
        .err()
        .unwrap();
        assert_eq!(err.kind, "def_invalid");
        let got = ok_value(&db, "get", &["--workflow-id=wf1"]);
        assert_eq!(got["found"], false, "no half-created entry");
    }

    #[test]
    fn get_of_unknown_entry_reports_not_found_without_erroring() {
        let db = fresh_db("getunknown");
        let got = ok_value(&db, "get", &["--workflow-id=ghost"]);
        assert_eq!(got["op"], "get");
        assert_eq!(got["found"], false);
        assert_eq!(got["workflow_id"], "ghost");
    }

    #[test]
    fn forbidden_output_guard_blocks_bodies_free_form_keys_and_secret_markers() {
        // Verbatim free-form keys (the un-projected columns) are blocked.
        assert!(reject_forbidden_output(r#"{"name":"x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"slug":"x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"description":"x"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"tags_json":"[]"}"#).is_err());
        // Body columns blocked.
        assert!(reject_forbidden_output(r#"{"definition_json":"{}"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"source_meta":"{}"}"#).is_err());
        // Secret/path markers blocked.
        assert!(reject_forbidden_output(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output(r#"{"k":"/Users/example/x"}"#).is_err());
        // The bounded projections + safe refs pass.
        assert!(reject_forbidden_output(
            r#"{"name_sha256":"ab","name_len":2,"slug_sha256":"cd","revision":1,"etag":"00","deployed_version":1}"#
        )
        .is_ok());
    }
}
