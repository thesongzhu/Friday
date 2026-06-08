//! Durable Hub-side ANSWER STORE keyed by `run_id` (D1-substrate). Hub-only.
//!
//! Today a Rust agent run (`HubRuntime::run_task`) durably persists run rows +
//! the event log + audit, and S2's [`crate::agent_run_read`] projects that event
//! log refs-only — but the run's RESULT/ANSWER (S1.1's finish message, which lives
//! only in the in-memory `LoopOutcome`) is NOT durably stored keyed by `run_id`
//! for later retrieval. This module adds that missing piece: a `run_result` row
//! per run so the answer can be read back later by the future production route, UI
//! live-data, and device proof-capture.
//!
//! ## Three reads, one boundary (the refs-only wire contract is UNCHANGED)
//! The store holds the answer TEXT Hub-side, but exposes THREE distinct reads —
//! the security boundary is which one a surface is allowed to call:
//!
//! * [`get_run_result`] returns the full [`StoredRunResult`] INCLUDING the answer
//!   body. This is **Hub-internal only** — for a Hub-side path entitled to the body.
//!   It must never be piped to the `hub_run_readback` bin or any TS-facing surface.
//! * [`get_run_result_ref`] returns the refs-only [`RunResultRef`] — `status` +
//!   `answer_sha256` + `answer_len` (+ created/audit refs), and **NO answer body**
//!   (and **no owner principal**). This is the **(a) refs-only proof projection** the
//!   public / unauthenticated readback consumes, exactly like
//!   [`crate::agent_run_read::get_run_summary`] omits the run `task` body. UNCHANGED.
//! * [`get_run_answer_for_principal`] (D1-Q1) is the **(b) authenticated answer-body
//!   projection**: it returns the body ONLY to a caller whose principal matches the
//!   run's bound OWNER principal (recorded in the `owner_principal` column), and
//!   FAILS CLOSED otherwise (no owner / anonymous owner / anonymous caller / wrong
//!   principal all DENY — body withheld). The denying / not-found outcomes carry
//!   neither the body nor the owner id. The transport that authenticates the caller
//!   and supplies a trusted `caller_principal` is a later slice (D1-Q4).
//!
//! Whether an answer body is EVER transported off-Hub is a PRIVACY decision the
//! operator owns; D1-Q1 admits exactly ONE off-Hub path — to the authenticated
//! OWNER — while the wire's proof surface still gets only fingerprints (sha256 +
//! length + status), never the body and never the owner principal.
//!
//! ## Fingerprint cannot drift from the body
//! `answer_sha256` + `answer_len` are DERIVED from the answer bytes at the persist
//! boundary (not caller-supplied), so a stored fingerprint always matches the
//! stored body — no writer can persist a divergent sha/len. (Mirrors the
//! `token_ledger` "invariant enforced at the insert chokepoint" discipline.)
//!
//! ## Idempotency (immutable result)
//! `persist_run_result` is idempotent on `run_id`: re-persisting the IDENTICAL
//! answer (same sha256) is a benign no-op ([`PersistRunResultOutcome::DuplicateIdentical`]),
//! while re-persisting a DIFFERENT answer for an already-stored `run_id` is a
//! fail-closed `Err` — a run's persisted result is immutable and never silently
//! overwritten.
//!
//! Truth label: durable Hub answer store keyed by `run_id` (refs-only readback);
//! this is the STORAGE substrate + API + tests only. It is NOT wired into the
//! loop's write path (that call from `run_task` lives in friday-hub, a tiny
//! follow-up owned by the agent-core lane), and the production route / UI / device
//! capture are NOT wired (later tracks). PROOF-ONLY; NOT a v1 GO.

use crate::error::{Result, StorageError};
use friday_core::gate::{is_anonymous_principal, Actor, ActorKind};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

/// The result of a run, as supplied to [`persist_run_result`]. Deliberately lean:
/// `run_id` and `created_at` come from the function arguments, and `answer_sha256`
/// / `answer_len` are DERIVED from `answer` at persist time (never supplied here),
/// so a caller cannot inject a fingerprint that disagrees with the body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunResult {
    /// A coarse, safe status LABEL for the run's outcome (e.g. the `LoopStatus`
    /// string `finished` / `errored` / `bounded`). Not a body.
    pub status: String,
    /// The run's final answer/result text. Stored Hub-side; NEVER crosses the
    /// refs-only readback ([`RunResultRef`] carries only its sha256 + length).
    /// An answer-less outcome (e.g. a run that finished with no final message)
    /// stores the empty string (`answer_len = 0`).
    pub answer: String,
    /// Optional soft link to the audit-ledger receipt for this run (a `TEXT` ref,
    /// no FK — matches the established `*_ref` soft-link convention).
    pub audit_ref: Option<String>,
    /// D1-Q1: the run's bound OWNER principal — WHO is entitled to read the answer
    /// BODY back via the authenticated projection ([`get_run_answer_for_principal`]).
    /// `None` (the default) means NO owner is recorded, which FAILS CLOSED on the
    /// body read (an unowned answer is never released to anyone). S4 binds this
    /// principal at runtime into the gate `Actor`/digest; a persist caller that
    /// knows the run's principal records it here via [`RunResult::with_owner_principal`]
    /// so the authenticated readback can enforce `caller == owner`.
    pub owner_principal: Option<String>,
}

impl RunResult {
    /// Convenience constructor. The owner principal defaults to `None`
    /// (fail-closed: no authenticated body read until an owner is recorded via
    /// [`RunResult::with_owner_principal`]). This signature is deliberately
    /// unchanged so existing callers compile untouched.
    pub fn new(
        status: impl Into<String>,
        answer: impl Into<String>,
        audit_ref: Option<String>,
    ) -> Self {
        RunResult {
            status: status.into(),
            answer: answer.into(),
            audit_ref,
            owner_principal: None,
        }
    }

    /// Record the run's bound OWNER principal (D1-Q1). This is the principal the
    /// authenticated answer-body read ([`get_run_answer_for_principal`]) matches
    /// `caller_principal` against; without it the body read fails closed.
    #[must_use]
    pub fn with_owner_principal(mut self, owner_principal: impl Into<String>) -> Self {
        self.owner_principal = Some(owner_principal.into());
        self
    }
}

/// A full Hub-side run-result record, INCLUDING the answer body. Returned by
/// [`get_run_result`] for Hub-internal callers only — never the wire. Also the
/// payload of an ownership-GRANTED authenticated read ([`RunAnswerAccess::Granted`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredRunResult {
    pub run_id: String,
    pub status: String,
    /// The answer body (Hub-side only).
    pub answer: String,
    /// Lowercase-hex SHA-256 of the answer bytes.
    pub answer_sha256: String,
    /// Byte length of the answer.
    pub answer_len: i64,
    pub audit_ref: Option<String>,
    pub created_at: i64,
    /// D1-Q1: the run's bound OWNER principal (the axis the authenticated body read
    /// keys on). `None` ⇒ no owner recorded ⇒ fail-closed on the body read.
    pub owner_principal: Option<String>,
}

/// A REFS-ONLY projection of a run result: status + the answer fingerprint
/// (sha256 + length) + created/audit refs, and crucially NO answer body. This is
/// the only run-result shape intended for a TS-facing/over-the-wire readback
/// (mirrors [`crate::agent_run_read::AgentRunSummary`] omitting the `task` body).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunResultRef {
    pub run_id: String,
    pub status: String,
    /// Lowercase-hex SHA-256 of the answer bytes (the refs-only fingerprint).
    pub answer_sha256: String,
    /// Byte length of the answer (refs-only).
    pub answer_len: i64,
    pub audit_ref: Option<String>,
    pub created_at: i64,
}

/// Outcome of [`persist_run_result`]: a fresh result was stored, or an identical
/// result (same `run_id`, same answer fingerprint) was already present and the
/// re-persist was a benign idempotent no-op (nothing written a second time).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PersistRunResultOutcome {
    Persisted,
    DuplicateIdentical,
}

/// The outcome of an OWNERSHIP-GATED answer-body read ([`get_run_answer_for_principal`]).
///
/// This is the **(b) authenticated answer-body projection** — distinct from the
/// **(a) refs-only proof projection** ([`get_run_result_ref`]). The answer BODY is
/// released ONLY in [`RunAnswerAccess::Granted`]; every other variant is BODY-free
/// AND OWNER-ID-free, so a denied (non-owner / anonymous) caller learns nothing
/// about the answer or who owns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RunAnswerAccess {
    /// The caller's principal matched the run's bound owner principal: the full
    /// [`StoredRunResult`] (INCLUDING the answer body) is released to this
    /// authenticated owner.
    Granted(StoredRunResult),
    /// Access denied — the answer body is WITHHELD. Carries only a coarse,
    /// body-free, owner-id-free [`AnswerDenyReason`]; never the answer or the owner.
    Denied(AnswerDenyReason),
    /// No stored result exists for this `run_id` (nothing to read).
    NotFound,
}

/// Why an ownership-gated answer-body read was denied. Deliberately PAYLOAD-FREE:
/// it carries neither the answer body nor the run's owner principal, so a denied
/// caller learns nothing beyond "denied, for this coarse reason".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerDenyReason {
    /// The run has NO bound owner principal (NULL / empty / `public` / `public:default`).
    /// Fail-closed: an answer with no real owner is released to NO ONE (no anonymous
    /// body access).
    NoOwnerPrincipal,
    /// The CALLER's principal is anonymous / public / empty — a public caller never
    /// reads an answer body.
    AnonymousCaller,
    /// The caller is a known, non-anonymous principal but is NOT the run's owner.
    PrincipalMismatch,
}

/// True if `principal` is anonymous / public / empty under the SAME sentinel set
/// the gate uses ([`friday_core::gate::is_anonymous_principal`]), so `""`, `"public"`,
/// and `"public:default"` all fail closed. The actor `kind`/`id` are irrelevant to
/// that check (it inspects only `principal_id`); we pass a placeholder.
fn is_anonymous_principal_str(principal: &str) -> bool {
    is_anonymous_principal(&Actor {
        kind: ActorKind::Owner,
        id: String::new(),
        principal_id: Some(principal.to_string()),
    })
}

/// Lowercase-hex SHA-256 of `bytes`.
fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        out.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        out.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    out
}

/// Persist a run's result, keyed by `run_id`. Atomic and idempotent on `run_id`.
///
/// The `answer_sha256` + `answer_len` are computed HERE from `result.answer`, so
/// the stored fingerprint always matches the stored body. The check-then-insert
/// runs in one transaction, so the idempotency decision is race-free:
///
/// * no existing row → INSERT, returns [`PersistRunResultOutcome::Persisted`];
/// * existing row with the SAME `answer_sha256` → no write, returns
///   [`PersistRunResultOutcome::DuplicateIdentical`] (benign replay);
/// * existing row with a DIFFERENT `answer_sha256` → fail-closed `Err` (a run's
///   persisted result is immutable; it is never silently overwritten).
pub fn persist_run_result(
    conn: &Connection,
    run_id: &str,
    result: &RunResult,
    now_ms: i64,
) -> Result<PersistRunResultOutcome> {
    let answer_bytes = result.answer.as_bytes();
    let answer_sha256 = sha256_hex(answer_bytes);
    let answer_len = answer_bytes.len() as i64;

    let tx = conn.unchecked_transaction()?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT answer_sha256 FROM run_result WHERE run_id = ?1",
            [run_id],
            |r| r.get(0),
        )
        .optional()?;
    let outcome = match existing {
        Some(prev_sha) if prev_sha == answer_sha256 => PersistRunResultOutcome::DuplicateIdentical,
        Some(_) => {
            return Err(StorageError::Unsupported(format!(
                "run_result for '{run_id}' already persisted with a different answer; \
                 refusing to overwrite (a run's result is immutable)"
            )));
        }
        None => {
            tx.execute(
                "INSERT INTO run_result
                    (run_id, status, answer, answer_sha256, answer_len, audit_ref, created_at,
                     owner_principal)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    run_id,
                    result.status,
                    result.answer,
                    answer_sha256,
                    answer_len,
                    result.audit_ref,
                    now_ms,
                    result.owner_principal,
                ],
            )?;
            PersistRunResultOutcome::Persisted
        }
    };
    tx.commit()?;
    Ok(outcome)
}

/// Read a run's FULL result by `run_id`, INCLUDING the answer body. `None` if the
/// run has no stored result.
///
/// HUB-INTERNAL ONLY: this returns the answer body and must never be piped to the
/// `hub_run_readback` bin or any TS-facing/over-the-wire surface. The refs-only
/// readback is [`get_run_result_ref`].
pub fn get_run_result(conn: &Connection, run_id: &str) -> Result<Option<StoredRunResult>> {
    let row = conn
        .query_row(
            "SELECT run_id, status, answer, answer_sha256, answer_len, audit_ref, created_at,
                    owner_principal
             FROM run_result WHERE run_id = ?1",
            [run_id],
            |r| {
                Ok(StoredRunResult {
                    run_id: r.get(0)?,
                    status: r.get(1)?,
                    answer: r.get(2)?,
                    answer_sha256: r.get(3)?,
                    answer_len: r.get(4)?,
                    audit_ref: r.get(5)?,
                    created_at: r.get(6)?,
                    owner_principal: r.get(7)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Read a run's REFS-ONLY result projection by `run_id` (the S2-style readback).
/// Returns the answer's sha256 + length + status — but NEVER the answer body.
/// `None` if the run has no stored result.
///
/// This is the only run-result read intended for a TS-facing/over-the-wire path:
/// the `answer` column is deliberately NOT selected, so no body can leak through it.
pub fn get_run_result_ref(conn: &Connection, run_id: &str) -> Result<Option<RunResultRef>> {
    let row = conn
        .query_row(
            "SELECT run_id, status, answer_sha256, answer_len, audit_ref, created_at
             FROM run_result WHERE run_id = ?1",
            [run_id],
            |r| {
                Ok(RunResultRef {
                    run_id: r.get(0)?,
                    status: r.get(1)?,
                    answer_sha256: r.get(2)?,
                    answer_len: r.get(3)?,
                    audit_ref: r.get(4)?,
                    created_at: r.get(5)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// AUTHENTICATED, ownership-gated read of a run's answer BODY by `run_id`.
///
/// This is the **(b) authenticated answer-body projection** (D1-Q1). It releases the
/// answer body ONLY when `caller_principal` matches the run's bound OWNER principal
/// (the `owner_principal` recorded at persist time). The **(a) refs-only proof
/// projection** is [`get_run_result_ref`] (unchanged — body-free AND owner-free, for
/// public / unauthenticated proof surfaces).
///
/// Fail-closed on every ambiguity (an over-deny is safe; releasing a body is not):
/// * no stored result for `run_id` → [`RunAnswerAccess::NotFound`];
/// * stored result has NO / empty / `public` / `public:default` owner →
///   [`RunAnswerAccess::Denied`]`(`[`AnswerDenyReason::NoOwnerPrincipal`]`)` — an
///   unowned answer is released to NO ONE (no anonymous body access);
/// * `caller_principal` is empty / `public` / `public:default` →
///   [`AnswerDenyReason::AnonymousCaller`] (a public caller never reads a body);
/// * a real owner exists but `caller_principal` != owner →
///   [`AnswerDenyReason::PrincipalMismatch`].
///
/// The body is returned ONLY inside [`RunAnswerAccess::Granted`]. This function never
/// logs or prints the body (or the owner principal), and the `Denied` / `NotFound`
/// variants carry neither. The transport that AUTHENTICATES the caller and supplies a
/// TRUSTED `caller_principal` is a later slice (D1-Q4); this projection takes
/// `caller_principal` as a trusted argument and enforces only the ownership match.
pub fn get_run_answer_for_principal(
    conn: &Connection,
    run_id: &str,
    caller_principal: &str,
) -> Result<RunAnswerAccess> {
    // Read the full record Hub-side; the body never leaves this function except via Granted.
    let stored = match get_run_result(conn, run_id)? {
        Some(s) => s,
        None => return Ok(RunAnswerAccess::NotFound),
    };

    // Fail-closed: a run with no real (non-anonymous) bound owner releases its body to
    // NO ONE. A NULL/empty/`public` owner is treated identically — no anonymous owner.
    let owner = match stored.owner_principal.as_deref() {
        Some(o) if !is_anonymous_principal_str(o) => o.to_string(),
        _ => return Ok(RunAnswerAccess::Denied(AnswerDenyReason::NoOwnerPrincipal)),
    };

    // Fail-closed: an anonymous / public / empty caller never reads an answer body,
    // even if (pathologically) a stored owner string compared equal.
    if is_anonymous_principal_str(caller_principal) {
        return Ok(RunAnswerAccess::Denied(AnswerDenyReason::AnonymousCaller));
    }

    // The ownership match: exact principal equality. A mismatch (including incidental
    // whitespace) over-denies, which is the safe direction.
    if caller_principal == owner {
        Ok(RunAnswerAccess::Granted(stored))
    } else {
        Ok(RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-run-result-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        // SHA-256("") — the canonical empty-input digest.
        assert_eq!(
            sha256_hex(b""),
            // Not a secret: the canonical SHA-256 of the empty input (a public test vector).
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" // pragma: allowlist secret
        );
        assert_eq!(sha256_hex(b"").len(), 64);
        assert!(sha256_hex(b"abc").bytes().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn persist_then_get_round_trips_with_matching_fingerprint() {
        let db = Db::open_hub(&tmp("roundtrip")).unwrap();
        let answer = "the durable final answer for run-1";
        let result = RunResult::new("finished", answer, Some("audit-9".to_string()));
        let outcome = persist_run_result(db.conn(), "run-1", &result, 1700).unwrap();
        assert_eq!(outcome, PersistRunResultOutcome::Persisted);

        let stored = get_run_result(db.conn(), "run-1").unwrap().unwrap();
        assert_eq!(stored.run_id, "run-1");
        assert_eq!(stored.status, "finished");
        assert_eq!(stored.answer, answer);
        assert_eq!(stored.audit_ref.as_deref(), Some("audit-9"));
        assert_eq!(stored.created_at, 1700);
        // The fingerprint was derived from the body and matches it exactly.
        assert_eq!(stored.answer_sha256, sha256_hex(answer.as_bytes()));
        assert_eq!(stored.answer_len, answer.len() as i64);
        assert_eq!(stored.answer_sha256.len(), 64);
    }

    #[test]
    fn refs_only_projection_carries_no_answer_body() {
        let db = Db::open_hub(&tmp("refsonly")).unwrap();
        let answer = "BODY-SECRET-never-crosses-the-refs-only-readback";
        let result = RunResult::new("finished", answer, None);
        persist_run_result(db.conn(), "run-2", &result, 2000).unwrap();

        // The body DOES live Hub-side (retrievable via the Hub-internal read)...
        let stored = get_run_result(db.conn(), "run-2").unwrap().unwrap();
        assert_eq!(stored.answer, answer);

        // ...but the refs-only projection exposes ONLY sha + len + status, no body.
        let refs = get_run_result_ref(db.conn(), "run-2").unwrap().unwrap();
        assert_eq!(refs.run_id, "run-2");
        assert_eq!(refs.status, "finished");
        assert_eq!(refs.answer_sha256, stored.answer_sha256);
        assert_eq!(refs.answer_len, answer.len() as i64);
        assert_eq!(refs.created_at, 2000);
        // No field carries the body, and the Debug rendering never echoes it
        // (defense against an accidental future field that smuggles the answer).
        assert!(
            !format!("{refs:?}").contains("BODY-SECRET"),
            "the refs-only projection must never carry the answer body"
        );
    }

    #[test]
    fn empty_answer_is_stored_honestly() {
        let db = Db::open_hub(&tmp("empty")).unwrap();
        let result = RunResult::new("errored", "", None);
        persist_run_result(db.conn(), "run-3", &result, 3000).unwrap();
        let stored = get_run_result(db.conn(), "run-3").unwrap().unwrap();
        assert_eq!(stored.answer, "");
        assert_eq!(stored.answer_len, 0);
        assert_eq!(
            stored.answer_sha256,
            // Not a secret: the canonical SHA-256 of the empty input (a public test vector).
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" // pragma: allowlist secret
        );
    }

    #[test]
    fn re_persist_identical_answer_is_idempotent_noop() {
        let db = Db::open_hub(&tmp("idem")).unwrap();
        let result = RunResult::new("finished", "same answer", Some("a1".to_string()));
        assert_eq!(
            persist_run_result(db.conn(), "run-4", &result, 10).unwrap(),
            PersistRunResultOutcome::Persisted
        );
        // A second persist of the SAME answer is a benign no-op (status/audit/time
        // differences do not re-write the immutable row; the answer is what matters).
        let replay = RunResult::new("finished", "same answer", Some("a2-different".to_string()));
        assert_eq!(
            persist_run_result(db.conn(), "run-4", &replay, 99).unwrap(),
            PersistRunResultOutcome::DuplicateIdentical
        );
        // The original row is untouched.
        let stored = get_run_result(db.conn(), "run-4").unwrap().unwrap();
        assert_eq!(stored.answer, "same answer");
        assert_eq!(stored.audit_ref.as_deref(), Some("a1"));
        assert_eq!(stored.created_at, 10);
        assert_eq!(db.count("run_result").unwrap(), 1);
    }

    #[test]
    fn re_persist_different_answer_fails_closed() {
        let db = Db::open_hub(&tmp("conflict")).unwrap();
        persist_run_result(
            db.conn(),
            "run-5",
            &RunResult::new("finished", "original answer", None),
            10,
        )
        .unwrap();
        // A re-persist with a DIFFERENT answer for the same run_id is refused.
        let err = persist_run_result(
            db.conn(),
            "run-5",
            &RunResult::new("finished", "TAMPERED answer", None),
            20,
        );
        assert!(err.is_err(), "a conflicting re-persist must fail closed");
        // The original answer is preserved (never overwritten).
        let stored = get_run_result(db.conn(), "run-5").unwrap().unwrap();
        assert_eq!(stored.answer, "original answer");
        assert_eq!(db.count("run_result").unwrap(), 1);
    }

    #[test]
    fn get_is_none_for_unknown_run() {
        let db = Db::open_hub(&tmp("missing")).unwrap();
        assert!(get_run_result(db.conn(), "nope").unwrap().is_none());
        assert!(get_run_result_ref(db.conn(), "nope").unwrap().is_none());
    }

    // --- D1-Q1: authenticated (ownership-gated) answer-body projection ----------

    const Q1_BODY: &str = "ANSWER-BODY-CANARY-only-the-owner-may-read-this";
    const Q1_OWNER: &str = "principal:alice";
    const Q1_OTHER: &str = "principal:bob";

    /// Persist a run owned by `owner` (or unowned when `owner` is `None`) and return the db.
    fn seed_owned(tag: &str, run_id: &str, owner: Option<&str>) -> Db {
        let db = Db::open_hub(&tmp(tag)).unwrap();
        let mut result = RunResult::new("finished", Q1_BODY, Some("audit-q1".to_string()));
        if let Some(o) = owner {
            result = result.with_owner_principal(o);
        }
        persist_run_result(db.conn(), run_id, &result, 4242).unwrap();
        db
    }

    #[test]
    fn owner_principal_reads_its_own_answer_body() {
        let db = seed_owned("q1-grant", "run-q1", Some(Q1_OWNER));
        match get_run_answer_for_principal(db.conn(), "run-q1", Q1_OWNER).unwrap() {
            RunAnswerAccess::Granted(stored) => {
                assert_eq!(
                    stored.answer, Q1_BODY,
                    "the owner must receive the real body"
                );
                assert_eq!(stored.owner_principal.as_deref(), Some(Q1_OWNER));
                assert_eq!(stored.answer_sha256, sha256_hex(Q1_BODY.as_bytes()));
            }
            other => panic!("owner must be Granted the body, got {other:?}"),
        }
    }

    #[test]
    fn different_principal_is_denied_and_gets_no_body_or_owner() {
        let db = seed_owned("q1-mismatch", "run-q1", Some(Q1_OWNER));
        let access = get_run_answer_for_principal(db.conn(), "run-q1", Q1_OTHER).unwrap();
        assert_eq!(
            access,
            RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch)
        );
        // Canary: a denied (non-owner) caller learns NEITHER the answer body NOR who owns it.
        let rendered = format!("{access:?}");
        assert!(
            !rendered.contains(Q1_BODY),
            "a deny result must never carry the answer body: {rendered}"
        );
        assert!(
            !rendered.contains(Q1_OWNER),
            "a deny result must never leak the owner principal: {rendered}"
        );
    }

    #[test]
    fn run_with_no_owner_fails_closed_no_anonymous_body() {
        // The run was persisted via the unchanged 3-arg `new` -> owner_principal = None.
        let db = seed_owned("q1-noowner", "run-q1", None);
        // Even the (correct) status etc. is stored, but the body is released to NO ONE,
        // including a caller that supplies a perfectly valid-looking principal.
        let access = get_run_answer_for_principal(db.conn(), "run-q1", Q1_OWNER).unwrap();
        assert_eq!(
            access,
            RunAnswerAccess::Denied(AnswerDenyReason::NoOwnerPrincipal)
        );
        assert!(
            !format!("{access:?}").contains(Q1_BODY),
            "the no-owner fail-closed deny must never carry the body"
        );
        // ...and the body genuinely IS still stored Hub-side (the Hub-internal read sees it),
        // proving the deny is an AUTHORIZATION decision, not missing data.
        assert_eq!(
            get_run_result(db.conn(), "run-q1").unwrap().unwrap().answer,
            Q1_BODY
        );
    }

    #[test]
    fn anonymous_or_public_caller_is_denied_even_for_an_owned_run() {
        let db = seed_owned("q1-anoncaller", "run-q1", Some(Q1_OWNER));
        for anon in ["", "   ", "public", "public:default", "PUBLIC"] {
            let access = get_run_answer_for_principal(db.conn(), "run-q1", anon).unwrap();
            assert_eq!(
                access,
                RunAnswerAccess::Denied(AnswerDenyReason::AnonymousCaller),
                "anonymous/public caller '{anon}' must be denied"
            );
            assert!(
                !format!("{access:?}").contains(Q1_BODY),
                "an anonymous-caller deny must never carry the body (caller '{anon}')"
            );
        }
    }

    #[test]
    fn owner_recorded_as_public_is_treated_as_no_owner() {
        // A run whose recorded owner is itself an anonymous/public sentinel must NOT be
        // readable by a caller passing that same sentinel — it is still NO real owner.
        let db = seed_owned("q1-pubowner", "run-q1", Some("public"));
        let access = get_run_answer_for_principal(db.conn(), "run-q1", "public").unwrap();
        // Caller-anonymity is checked, but no-owner is the governing fail-closed reason here;
        // either way the body is withheld. We assert the body never escapes.
        assert!(
            matches!(access, RunAnswerAccess::Denied(_)),
            "got {access:?}"
        );
        assert!(!format!("{access:?}").contains(Q1_BODY));
    }

    #[test]
    fn unknown_run_is_not_found_not_a_silent_grant() {
        let db = Db::open_hub(&tmp("q1-missing")).unwrap();
        assert_eq!(
            get_run_answer_for_principal(db.conn(), "nope", Q1_OWNER).unwrap(),
            RunAnswerAccess::NotFound
        );
    }

    #[test]
    fn refs_only_projection_still_carries_no_body_and_no_owner() {
        // Regression: the refs-only proof projection is UNCHANGED — no body, and it
        // must not leak the new owner_principal column either.
        let db = seed_owned("q1-refs", "run-q1", Some(Q1_OWNER));
        let refs = get_run_result_ref(db.conn(), "run-q1").unwrap().unwrap();
        let rendered = format!("{refs:?}");
        assert!(
            !rendered.contains(Q1_BODY),
            "refs-only must never carry the answer body: {rendered}"
        );
        assert!(
            !rendered.contains(Q1_OWNER),
            "refs-only must never carry the owner principal: {rendered}"
        );
        // It does still expose the body-free fingerprint.
        assert_eq!(refs.answer_sha256, sha256_hex(Q1_BODY.as_bytes()));
    }
}
