//! S3 DARK owner-gated answer-BODY readback — `hub_run_answer_readback`.
//!
//! PROOF-ONLY (Rust-wired-DEV), DARK (no production route consumes this yet). This is
//! the OWNER-GATED BODY sibling of the REFS-ONLY proof bin
//! [`hub_run_readback`](super) — and it is deliberately a **SEPARATE PATH**: the
//! refs-only proof bins NEVER transport a body, while THIS bin's whole reason to
//! exist is to return the agent-run ANSWER BODY back to the authenticated OWNER (the
//! future `executeRun`-replacement's owner-scoped body-return readback).
//!
//! It is the proof substrate behind D1-Q1's "(b) authenticated answer-body
//! projection": given a `run_id` + a TRUSTED caller principal, it calls
//! [`friday_storage::get_run_answer_for_principal`] (owner==caller gate) and:
//!
//! * `Granted` (caller == the run's bound owner) → emits the answer BODY verbatim
//!   (`answer` + its `answer_sha256`/`answer_len` fingerprint + status), labeled
//!   `outcome="delivered"`;
//! * `Denied` (non-owner caller / anonymous caller / NO bound owner) → emits NO body,
//!   only a coarse, owner-free `deny_reason` label + the refs-only fingerprint,
//!   labeled `outcome="denied"`;
//! * `NotFound` (no stored result for `run_id`) → emits NO body, `outcome="not_found"`.
//!
//! ## Trusted-principal contract (NOT authentication)
//! `--caller-principal` is a TRUSTED argument. This bin enforces ONLY the ownership
//! MATCH (`caller == owner`); it does NOT authenticate the caller. The transport that
//! authenticates a caller and supplies a trusted principal is a later composition
//! slice (a long-lived `hub_server` WS transport) — OUT OF SCOPE here. This slice
//! proves the owner-gating + body-return contract against a fixture DB only. It
//! registers NO production route, replaces no TS read path, and confers no v1 GO.
//!
//! ## Guard discipline — the body flows ONLY through the Granted branch
//! The owner's answer body can LEGITIMATELY contain any text — including `/Users/`,
//! `Bearer`, `sk-`, even the literal `final_message`. So the Granted body is emitted
//! WITHOUT the refs-only marker scan (scanning it would WITHHOLD legitimate owner
//! content and would tempt loosening the shared guard — which this slice must NOT do).
//! What makes that safe is the INVARIANT, not a scan: the `answer` field appears ONLY
//! in the `delivered` branch, and a non-owner structurally NEVER reaches that branch
//! ([`RunAnswerAccess::Granted`] is the sole body-bearing variant; everything else is
//! body-free). The body-free `denied` / `not_found` / ERROR payloads (which must
//! carry only labels + refs) ARE run through [`reject_forbidden_output`] as
//! defense-in-depth. The refs-only proof bins and their `final_message`/`task` rejects
//! are left UNTOUCHED — the body comes back through THIS owner-gated path alone.

use std::env;
use std::path::Path;

use friday_storage::{
    get_run_answer_for_principal, AnswerDenyReason, Db, RunAnswerAccess, StorageError,
    StoredRunResult,
};
use serde_json::json;

/// A fail-closed error: `kind` is a coarse, safe category (the only thing surfaced);
/// the raw detail is deliberately NOT printed so storage/IO errors cannot leak paths.
/// `Debug` carries ONLY the closed-vocab `kind` token (never a body/path), so it is
/// safe for test `unwrap` diagnostics.
#[derive(Debug)]
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
            // Body-free error to stdout (no detail), coarse category to stderr, non-zero exit.
            let payload = json!({
                "truth_label": "rust_wired_dev",
                "proof_only": true,
                "ok": false,
                "error_kind": err.kind,
            });
            // Defense-in-depth: route the BODY-FREE error payload through the shared guard
            // (fail closed if a marker ever leaked). `error_kind` is a static closed-vocab
            // token today, so this never suppresses output.
            let rendered = payload.to_string();
            if reject_forbidden_output_body_free(&rendered).is_ok() {
                println!("{rendered}");
            }
            eprintln!("hub_run_answer_readback_unavailable: {}", err.kind);
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
    // The TRUSTED caller principal (see module docs: this bin enforces the ownership
    // MATCH, it does NOT authenticate). Required — a missing principal is bad args, NOT
    // an anonymous body read.
    let caller_principal =
        arg_value(&args, "--caller-principal").ok_or(ReadbackError::new("bad_args"))?;

    // Read-only open: a readback can NEVER mutate an operator DB just because a caller asks.
    // (observability) On a failure, log {run_id, leg, error_kind} to stderr — body-free
    // (the run_id is a uuid ref, never the answer/owner/path) — so the 503-after-billing
    // readback failure that left NO log trail is attributable to a leg next time. As of the
    // WAL + busy_timeout opener fix a contended open RETRIES instead of an immediate
    // SQLITE_BUSY, so `open_failed` should be rare; logging it confirms that.
    let db = open_hub_readonly_guarded(&db_path, &run_id)?;

    // The OWNER-GATING decision lives entirely in this single storage primitive: it
    // releases the body ONLY inside `Granted` (caller == the run's bound owner); every
    // other arm is body-free AND owner-free (fail-closed).
    let access =
        get_run_answer_for_principal(db.conn(), &run_id, &caller_principal).map_err(|_| {
            eprintln!("hub_run_answer_readback: run_id={run_id} leg=read error_kind=read_failed");
            ReadbackError::new("read_failed")
        })?;

    match access {
        // OWNER == CALLER: release the answer BODY verbatim. This is the ONLY branch that
        // emits `answer`; it is NOT marker-scanned (the owner's own content may legitimately
        // contain path/secret-looking substrings — see module docs).
        RunAnswerAccess::Granted(stored) => Ok(render_delivered(&run_id, &stored)),
        // NON-OWNER / ANONYMOUS / NO-OWNER-BOUND: NO body. Only a coarse, owner-free
        // deny label. This payload is body-free and IS guard-scanned.
        RunAnswerAccess::Denied(reason) => render_denied(&run_id, reason),
        // No stored result for this run: NO body.
        RunAnswerAccess::NotFound => render_not_found(&run_id),
    }
}

/// The OWNER-GATED `delivered` payload: carries the answer BODY (`answer`) plus its
/// refs-only fingerprint. Emitted ONLY for a `Granted` access (caller == owner). NOT
/// run through the refs-only marker guard — the owner's body may legitimately contain
/// marker-like substrings, and withholding it would defeat the slice's purpose.
fn render_delivered(run_id: &str, stored: &StoredRunResult) -> String {
    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "outcome": "delivered",
        "run_id": run_id,
        "status": stored.status,
        // The owner-gated BODY — released ONLY to the matching owner principal.
        "answer": stored.answer,
        "answer_sha256": stored.answer_sha256,
        "answer_len": stored.answer_len,
    });
    payload.to_string()
}

/// The body-free `denied` payload: a coarse deny label, NO body, NO owner principal.
/// Guard-scanned as defense-in-depth (it must only ever carry labels/refs).
fn render_denied(run_id: &str, reason: AnswerDenyReason) -> Result<String, ReadbackError> {
    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "outcome": "denied",
        "run_id": run_id,
        "deny_reason": deny_reason_label(reason),
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| ReadbackError::new("serialize_failed"))?;
    reject_forbidden_output_body_free(&rendered)?;
    Ok(rendered)
}

/// The body-free `not_found` payload (no stored result for this run). Guard-scanned.
fn render_not_found(run_id: &str) -> Result<String, ReadbackError> {
    let payload = json!({
        "truth_label": "rust_wired_dev",
        "proof_only": true,
        "ok": true,
        "outcome": "not_found",
        "run_id": run_id,
    });
    let rendered =
        serde_json::to_string(&payload).map_err(|_| ReadbackError::new("serialize_failed"))?;
    reject_forbidden_output_body_free(&rendered)?;
    Ok(rendered)
}

/// A coarse, owner-free deny LABEL from a closed vocabulary. Never carries the owner
/// principal or the body — mirrors the payload-free `AnswerDenyReason` contract.
fn deny_reason_label(reason: AnswerDenyReason) -> &'static str {
    match reason {
        AnswerDenyReason::NoOwnerPrincipal => "no_owner_principal",
        AnswerDenyReason::AnonymousCaller => "anonymous_caller",
        AnswerDenyReason::PrincipalMismatch => "principal_mismatch",
    }
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

/// Open the hub DB READ-ONLY, mapping a fail-closed schema-version skew to a DISTINCT,
/// diagnosable `error_kind`. [`Db::open_hub_readonly`] already FAILS CLOSED when the
/// on-disk schema is strictly NEWER than this binary understands (`StorageError::SchemaTooNew`
/// — the always-on guard a STALE bin, built from an older commit with a lower `hub_code_max()`,
/// hits against a forward-migrated DB). The behavior is unchanged — the open still errors and
/// the bin refuses to serve — but instead of collapsing it into the generic `open_failed`, we
/// surface `schema_too_new` and a stderr line NAMING the version skew so the next stale-bin
/// incident (the 13:40-vs-19:04 case) is attributable instead of an opaque open failure. Every
/// other open error keeps the existing `open_failed` kind, byte-identical to before.
fn open_hub_readonly_guarded(db_path: &str, run_id: &str) -> Result<Db, ReadbackError> {
    Db::open_hub_readonly(db_path).map_err(|e| match e {
        StorageError::SchemaTooNew { disk, code } => {
            eprintln!(
                "hub_run_answer_readback: run_id={run_id} leg=open error_kind=schema_too_new \
                 disk_version={disk} code_version={code} (stale binary: on-disk schema is newer \
                 than this build understands — rebuild from the deploying commit)"
            );
            ReadbackError::new("schema_too_new")
        }
        _ => {
            eprintln!("hub_run_answer_readback: run_id={run_id} leg=open error_kind=open_failed");
            ReadbackError::new("open_failed")
        }
    })
}

/// Defense-in-depth for the BODY-FREE payloads ONLY (`denied` / `not_found` / error):
/// refuse to print if any forbidden marker leaked into a payload that must carry only
/// labels/refs. Delegates to the SAME shared guard the refs-only proof bins use
/// ([`friday_hub::refs_guard::reject_forbidden_output`]) and additionally blocks the
/// `"answer"` body field — these payloads must NEVER carry it (only `delivered` does,
/// via [`render_delivered`], which intentionally bypasses this scan). The shared guard
/// itself is UNTOUCHED.
fn reject_forbidden_output_body_free(rendered: &str) -> Result<(), ReadbackError> {
    friday_hub::refs_guard::reject_forbidden_output(rendered, &["\"answer\"", "\"task\""])
        .map_err(|_| ReadbackError::new("output_guard"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_storage::{persist_run_result, RunResult};
    use serde_json::{from_str, Value};
    use std::sync::atomic::{AtomicU64, Ordering};

    const OWNER: &str = "principal:owner-alice";
    const OTHER: &str = "principal:intruder-bob";
    const BODY: &str = "the durable final answer body for this run";

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-answer-readback-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Seed a Finished run with `body`, owned by `owner` (or unowned when `owner` is
    /// `None`), and return its DB path (closing the writable handle so the bin can
    /// re-open read-only).
    fn seed(tag: &str, run_id: &str, owner: Option<&str>, body: &str) -> String {
        let path = tmp(tag);
        let db = Db::open_hub(&path).unwrap();
        let mut result = RunResult::new("finished", body, Some("audit-s3".to_string()));
        if let Some(o) = owner {
            result = result.with_owner_principal(o);
        }
        persist_run_result(db.conn(), run_id, &result, 7000).unwrap();
        drop(db);
        path
    }

    fn run_with(db: &str, run_id: &str, caller: &str) -> Result<String, ReadbackError> {
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            db.to_string(),
            "--run-id".to_string(),
            run_id.to_string(),
            "--caller-principal".to_string(),
            caller.to_string(),
        ];
        // Mirror `run()` without re-parsing argv ordering concerns; this drives the SAME
        // owner-gating primitive + render functions the bin's `run()` uses.
        let db_path = arg_value(&args, "--db").unwrap();
        let run_id = arg_value(&args, "--run-id").unwrap();
        let caller_principal = arg_value(&args, "--caller-principal").unwrap();
        let opened = open_hub_readonly_guarded(&db_path, &run_id)?;
        let access = get_run_answer_for_principal(opened.conn(), &run_id, &caller_principal)
            .map_err(|_| ReadbackError::new("read_failed"))?;
        match access {
            RunAnswerAccess::Granted(stored) => Ok(render_delivered(&run_id, &stored)),
            RunAnswerAccess::Denied(reason) => render_denied(&run_id, reason),
            RunAnswerAccess::NotFound => render_not_found(&run_id),
        }
    }

    #[test]
    fn owner_caller_gets_the_answer_body_delivered() {
        let db = seed("grant", "run-1", Some(OWNER), BODY);
        let rendered = run_with(&db, "run-1", OWNER).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["outcome"], "delivered");
        assert_eq!(v["truth_label"], "rust_wired_dev");
        // The OWNER receives the real body verbatim, with its matching fingerprint.
        assert_eq!(v["answer"], BODY);
        assert_eq!(v["answer_len"], BODY.len() as i64);
        assert_eq!(v["status"], "finished");
        assert_eq!(v["answer_sha256"].as_str().unwrap().len(), 64);
    }

    #[test]
    fn non_owner_caller_gets_no_body() {
        let db = seed("mismatch", "run-1", Some(OWNER), BODY);
        let rendered = run_with(&db, "run-1", OTHER).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["outcome"], "denied");
        assert_eq!(v["deny_reason"], "principal_mismatch");
        // FAIL-CLOSED: no body, and no leak of the owner principal, to a non-owner.
        assert!(v.get("answer").is_none(), "a non-owner must get NO body");
        assert!(
            !rendered.contains(BODY),
            "the body must never appear in a denied payload"
        );
        assert!(
            !rendered.contains(OWNER),
            "the owner principal must never leak to a non-owner"
        );
    }

    #[test]
    fn no_owner_bound_run_gets_no_body() {
        // A run persisted with NO bound owner (the unchanged 3-arg `new`).
        let db = seed("noowner", "run-1", None, BODY);
        // Even a caller that supplies a perfectly valid principal gets NOTHING.
        let rendered = run_with(&db, "run-1", OWNER).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["outcome"], "denied");
        assert_eq!(v["deny_reason"], "no_owner_principal");
        assert!(v.get("answer").is_none(), "an unowned run releases NO body");
        assert!(!rendered.contains(BODY));
    }

    #[test]
    fn anonymous_or_public_caller_gets_no_body() {
        let db = seed("anon", "run-1", Some(OWNER), BODY);
        for anon in ["", "   ", "public", "public:default"] {
            let rendered = run_with(&db, "run-1", anon).unwrap();
            let v: Value = from_str(&rendered).unwrap();
            assert_eq!(
                v["outcome"], "denied",
                "anon caller '{anon}' must be denied"
            );
            assert_eq!(v["deny_reason"], "anonymous_caller");
            assert!(
                v.get("answer").is_none(),
                "anon caller '{anon}' gets NO body"
            );
            assert!(!rendered.contains(BODY));
        }
    }

    #[test]
    fn unknown_run_is_not_found_with_no_body() {
        let db = seed("notfound", "run-1", Some(OWNER), BODY);
        let rendered = run_with(&db, "run-DOES-NOT-EXIST", OWNER).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["outcome"], "not_found");
        assert!(v.get("answer").is_none());
        assert!(!rendered.contains(BODY));
    }

    #[test]
    fn owner_gets_a_marker_bearing_body_verbatim_but_a_non_owner_never_sees_it() {
        // SECURITY: the owner's own answer may legitimately contain path/secret-LOOKING
        // substrings (`/Users/`, `Bearer`). The owner must receive it VERBATIM (proving
        // the Granted body is NOT over-blocked by a marker scan)...
        let marker_body = "see /Users/alice/report and use Bearer tok-xyz to fetch it";
        let db = seed("markerbody", "run-1", Some(OWNER), marker_body);
        let owner_view = run_with(&db, "run-1", OWNER).unwrap();
        let ov: Value = from_str(&owner_view).unwrap();
        assert_eq!(ov["outcome"], "delivered");
        assert_eq!(
            ov["answer"], marker_body,
            "the owner must get the marker-bearing body verbatim (no over-block)"
        );
        // ...AND a non-owner reading the SAME run gets NO body and no marker leak,
        // proving the body never escapes the owner-gated branch.
        let other_view = run_with(&db, "run-1", OTHER).unwrap();
        let xv: Value = from_str(&other_view).unwrap();
        assert_eq!(xv["outcome"], "denied");
        assert!(xv.get("answer").is_none());
        assert!(
            !other_view.contains("/Users/") && !other_view.contains("Bearer"),
            "a non-owner deny must never leak the marker-bearing body"
        );
    }

    #[test]
    fn missing_caller_principal_is_bad_args_not_an_anonymous_read() {
        // A missing --caller-principal must FAIL (bad_args), never default to an
        // anonymous/empty principal that could pathologically read a body.
        let args = vec![
            "bin".to_string(),
            "--db".to_string(),
            "/tmp/x.sqlite".to_string(),
            "--run-id".to_string(),
            "run-1".to_string(),
        ];
        assert!(arg_value(&args, "--caller-principal").is_none());
    }

    #[test]
    fn body_free_guard_blocks_answer_and_secret_markers_but_not_safe_labels() {
        // The body-free deny/not_found/error payloads must never carry an `"answer"` field
        // or a secret/path marker.
        assert!(reject_forbidden_output_body_free(r#"{"answer":"leak"}"#).is_err());
        assert!(reject_forbidden_output_body_free(r#"{"x":"Bearer abc"}"#).is_err());
        assert!(reject_forbidden_output_body_free(r#"{"p":"/Users/alice/x"}"#).is_err());
        assert!(reject_forbidden_output_body_free(r#"{"task":"raw body"}"#).is_err());
        // A clean labels-only deny payload passes.
        assert!(reject_forbidden_output_body_free(
            r#"{"outcome":"denied","deny_reason":"principal_mismatch","run_id":"run-1"}"#
        )
        .is_ok());
    }

    #[test]
    fn refs_only_shared_guard_still_rejects_final_message_body() {
        // GUARD-INTACT: the refs-only proof bins reject a `final_message` body via the
        // shared guard (the marker this slice must NOT loosen). Asserted here so "guard
        // intact" is test-backed, not merely "files untouched". The body comes back ONLY
        // via THIS owner-gated path (`render_delivered`), never by loosening the guard.
        assert!(friday_hub::refs_guard::reject_forbidden_output(
            r#"{"final_message":"body"}"#,
            &["final_message\""]
        )
        .is_err());
        // A refs-only fingerprint payload (no body) still passes — proving the guard
        // blocks the BODY, not the fingerprint refs.
        assert!(friday_hub::refs_guard::reject_forbidden_output(
            r#"{"final_message_sha256":"00ab","final_message_len":4}"#,
            &["final_message\""]
        )
        .is_ok());
    }

    #[test]
    fn deny_reason_labels_are_a_closed_owner_free_vocabulary() {
        assert_eq!(
            deny_reason_label(AnswerDenyReason::NoOwnerPrincipal),
            "no_owner_principal"
        );
        assert_eq!(
            deny_reason_label(AnswerDenyReason::AnonymousCaller),
            "anonymous_caller"
        );
        assert_eq!(
            deny_reason_label(AnswerDenyReason::PrincipalMismatch),
            "principal_mismatch"
        );
    }

    /// NORMAL same-commit deploy: the DB is at exactly `hub_code_max()` (what `open_hub`
    /// migrates to), so the read bin OPENS and SERVES the owner's body — byte-identical to
    /// before the guard. The schema-version guard NEVER fires on the equal case.
    #[test]
    fn equal_schema_version_serves_normally() {
        let db = seed("equal", "run-1", Some(OWNER), BODY);
        // The seeded DB is at exactly the binary's code_max.
        {
            let opened = Db::open_hub_readonly(&db).unwrap();
            assert_eq!(opened.version().unwrap(), friday_storage::hub_code_max());
        }
        let rendered = run_with(&db, "run-1", OWNER).unwrap();
        let v: Value = from_str(&rendered).unwrap();
        assert_eq!(v["outcome"], "delivered");
        assert_eq!(v["answer"], BODY);
    }

    /// STALE binary vs a forward-migrated DB: the on-disk version is `code_max + 1`, so the
    /// read bin FAILS CLOSED with the distinct `schema_too_new` kind and serves NO data — it
    /// does NOT misread the newer schema. (Today this collapsed into the opaque `open_failed`;
    /// the guard always fired, but the skew was un-diagnosable — the 13:40-vs-19:04 incident.)
    #[test]
    fn newer_on_disk_schema_fails_closed_with_named_skew() {
        let path = tmp("too-new");
        {
            // Seed a valid run, then forge a strictly-newer on-disk schema version to
            // simulate a DB written by a NEWER deploy than this (stale) binary.
            let db = Db::open_hub(&path).unwrap();
            let result = RunResult::new("finished", BODY, Some("audit-skew".to_string()))
                .with_owner_principal(OWNER);
            persist_run_result(db.conn(), "run-1", &result, 7000).unwrap();
            db.conn()
                .execute(
                    "UPDATE schema_version SET version = ?1 WHERE id = 1",
                    [friday_storage::hub_code_max() + 1],
                )
                .unwrap();
            drop(db);
        }
        // The owner — who WOULD be served on an equal-version DB — gets fail-closed instead.
        let err = match run_with(&path, "run-1", OWNER) {
            Ok(rendered) => panic!("a stale bin must NOT serve a forward-migrated DB: {rendered}"),
            Err(e) => e,
        };
        assert_eq!(
            err.kind, "schema_too_new",
            "the fail-closed kind must NAME the version skew, not the opaque open_failed"
        );
        // The owner's body must never have been read/served under the skew.
    }
}
