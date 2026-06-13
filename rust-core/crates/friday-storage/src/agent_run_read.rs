//! Read-only projection helpers for `agent_run` + `agent_run_event` (S2 readback).
//!
//! Additive, READ-ONLY sibling of the write path in [`crate::agent_run`]. These
//! helpers exist so a refs-only projection (the `hub_run_readback` dev bin) can
//! read back a completed run's result by `run_id` WITHOUT touching any write
//! path. Nothing here mutates state; every function only `SELECT`s.
//!
//! ## Refs-only / no-body discipline
//! [`AgentRunSummary`] deliberately OMITS the run `task` text — the run's task is
//! a body, and the S2 readback is refs-only (it never transports bodies). The
//! event `kind` strings ARE returned, but a `tool.executed:` kind can embed a
//! (relative) filename, so the caller MUST run them through an output guard
//! before emitting them off-process.

use crate::error::Result;
use rusqlite::{Connection, OptionalExtension};

/// A read-only summary of an `agent_run` row.
///
/// Deliberately OMITS the run `task` text (a body) — the S2 readback is refs-only
/// and never transports bodies. `state` is the persisted `PlanState` string
/// (a safe label, e.g. `awaiting_clarification`); the timestamps are ints.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentRunSummary {
    pub run_id: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// DB-wide token totals summed over `token_ledger`.
///
/// HONEST SCOPE: these are **DB-wide**, NOT run-attributable — every ledger row
/// across all runs and the single-shot ask path. As of S1.2 the agent loop DOES
/// write `token_ledger` rows (each carries the owning `run_id`); for per-run cost
/// use [`run_token_totals`], not this. For a run-only Hub DB with no model calls
/// these are still `0`. Surfaced anyway so the readback shape is stable, but the
/// caller must label them as DB-wide, never as one run's cost.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct DbWideTokenTotals {
    pub prompt: i64,
    pub completion: i64,
    pub total: i64,
}

/// Fetch a run's refs-only summary by id (read-only). `None` if the run is unknown.
pub fn get_run_summary(conn: &Connection, run_id: &str) -> Result<Option<AgentRunSummary>> {
    let row = conn
        .query_row(
            "SELECT run_id, state, created_at, updated_at FROM agent_run WHERE run_id = ?1",
            [run_id],
            |r| {
                Ok(AgentRunSummary {
                    run_id: r.get(0)?,
                    state: r.get(1)?,
                    created_at: r.get(2)?,
                    updated_at: r.get(3)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// The ordered (by `seq` ascending) list of an `agent_run`'s event `kind` strings.
///
/// These are safe labels (`plan.none`, `agent.finished`, `tool.blocked:...`) BUT a
/// `tool.executed:` kind can embed a (relative) filename, so the caller MUST run
/// them through an output guard before emitting them off-process.
pub fn list_event_kinds(conn: &Connection, run_id: &str) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT kind FROM agent_run_event WHERE run_id = ?1 ORDER BY seq ASC")?;
    let rows = stmt.query_map([run_id], |r| r.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

/// (C2-5) The ordered (by `seq` ascending) list of the FILE REFS a run's `read_file`
/// executions actually read, parsed out of the run's `tool.executed:read … bytes from <ref>`
/// event kinds.
///
/// ## Anchored to the REAL receipt, never a mirror
/// A `read_file` is a read-type tool the gate Allows directly inside the run loop, so an
/// Allowed+executed `read_file` records ONE `tool.executed:read {n} bytes from {path}` event
/// (`crate::agent_run::record_event`) in the SAME transaction as the hash-chained
/// `tool.executed:read_file` audit receipt. This fn reads THOSE run-keyed events — it is the
/// co-committed witness of the genuine receipt, not a synthesized/mirror file event. A
/// `read_file` that FAILED records `tool.exec_error:*` (not `tool.executed:`) and so is correctly
/// absent here (no receipt ⇒ no file ref).
///
/// ## Parsing
/// The receipt summary is `read {n} bytes from {path}`, so the file ref is the substring AFTER
/// the FIRST ` bytes from ` separator (split on that exact marker, not a bare ` from `, so a path
/// that itself contains ` from ` survives intact). Only `read_file`'s `read …` summary matches;
/// other read-type executions (`listed …`, `stat …`, `search matched …`) do NOT, so they never
/// leak in.
///
/// ## Refs-only
/// The returned strings are the RELATIVE workspace paths the model proposed (the loop's executor
/// never embeds an absolute path in the summary). The caller is still expected to run them through
/// an output guard before emitting them off-process — same discipline as [`list_event_kinds`].
pub fn list_read_file_refs(conn: &Connection, run_id: &str) -> Result<Vec<String>> {
    const READ_PREFIX: &str = "tool.executed:read ";
    const FROM_SEP: &str = " bytes from ";
    let mut out = Vec::new();
    for kind in list_event_kinds(conn, run_id)? {
        // Only `read_file`'s `read {n} bytes from {path}` receipt summary qualifies. A
        // `tool.executed:` event whose summary is NOT a `read …` line (a write/list/stat/etc.)
        // is skipped; an exec_error event never carries the `tool.executed:` prefix at all.
        if let Some(tail) = kind.strip_prefix(READ_PREFIX) {
            // `tail` = `{n} bytes from {path}`. Split on the FIRST ` bytes from ` only, so a
            // path containing the separator text survives in the ref.
            if let Some((_count, path)) = tail.split_once(FROM_SEP) {
                if !path.is_empty() {
                    out.push(path.to_string());
                }
            }
        }
    }
    Ok(out)
}

/// DB-wide token totals over `token_ledger` (see [`DbWideTokenTotals`] for the
/// honest-scope caveat). `COALESCE(..., 0)` so an empty ledger reads `0`, not NULL.
pub fn db_wide_token_totals(conn: &Connection) -> Result<DbWideTokenTotals> {
    let totals = conn.query_row(
        "SELECT COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(total_tokens), 0)
         FROM token_ledger",
        [],
        |r| {
            Ok(DbWideTokenTotals {
                prompt: r.get(0)?,
                completion: r.get(1)?,
                total: r.get(2)?,
            })
        },
    )?;
    Ok(totals)
}

/// Run-attributable token totals over `token_ledger` for a single `run_id` (S1.2).
///
/// Sums ONLY the rows the agent loop billed for this run (`WHERE run_id = ?1`), so —
/// unlike [`db_wide_token_totals`] — this IS this run's cost. Ask-path rows (NULL
/// `run_id`) are excluded. `COALESCE(..., 0)` so an unknown / not-yet-billed run reads
/// `0`, never NULL. Read-only.
pub fn run_token_totals(conn: &Connection, run_id: &str) -> Result<DbWideTokenTotals> {
    let totals = conn.query_row(
        "SELECT COALESCE(SUM(prompt_tokens), 0),
                COALESCE(SUM(completion_tokens), 0),
                COALESCE(SUM(total_tokens), 0)
         FROM token_ledger WHERE run_id = ?1",
        [run_id],
        |r| {
            Ok(DbWideTokenTotals {
                prompt: r.get(0)?,
                completion: r.get(1)?,
                total: r.get(2)?,
            })
        },
    )?;
    Ok(totals)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_run::{create_run, record_event};
    use crate::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-agent-run-read-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn get_run_summary_returns_refs_only_row_without_task_body() {
        let db = Db::open_hub(&tmp("summary")).unwrap();
        create_run(db.conn(), "run-1", "BODY-the-secret-task-text", 100).unwrap();

        let summary = get_run_summary(db.conn(), "run-1").unwrap().unwrap();
        assert_eq!(summary.run_id, "run-1");
        assert_eq!(summary.state, "awaiting_clarification");
        assert_eq!(summary.created_at, 100);
        assert_eq!(summary.updated_at, 100);
        // The struct has no field that could carry the task body — assert the
        // Debug rendering never echoes it (defense against an accidental future field).
        assert!(!format!("{summary:?}").contains("BODY-the-secret-task-text"));
    }

    #[test]
    fn get_run_summary_is_none_for_unknown_run() {
        let db = Db::open_hub(&tmp("missing")).unwrap();
        assert!(get_run_summary(db.conn(), "nope").unwrap().is_none());
    }

    #[test]
    fn list_event_kinds_is_ordered_by_seq() {
        let db = Db::open_hub(&tmp("events")).unwrap();
        create_run(db.conn(), "run-2", "task", 1).unwrap();
        record_event(db.conn(), "run-2:e0", "run-2", "plan.none", 2).unwrap();
        record_event(
            db.conn(),
            "run-2:e1",
            "run-2",
            "tool.executed:read 15 bytes from notes.md",
            3,
        )
        .unwrap();
        record_event(db.conn(), "run-2:e2", "run-2", "agent.finished", 4).unwrap();

        let kinds = list_event_kinds(db.conn(), "run-2").unwrap();
        assert_eq!(
            kinds,
            vec![
                "plan.none".to_string(),
                "tool.executed:read 15 bytes from notes.md".to_string(),
                "agent.finished".to_string(),
            ]
        );
    }

    #[test]
    fn list_event_kinds_is_empty_for_run_with_no_events() {
        let db = Db::open_hub(&tmp("noevents")).unwrap();
        create_run(db.conn(), "run-3", "task", 1).unwrap();
        assert!(list_event_kinds(db.conn(), "run-3").unwrap().is_empty());
    }

    #[test]
    fn list_read_file_refs_parses_only_read_file_receipts_run_scoped() {
        let db = Db::open_hub(&tmp("readrefs")).unwrap();
        create_run(db.conn(), "run-rf", "task", 1).unwrap();
        // A read_file receipt (qualifies) + a path that itself contains " from " (must survive).
        record_event(
            db.conn(),
            "run-rf:e0",
            "run-rf",
            "tool.executed:read 15 bytes from notes.md",
            2,
        )
        .unwrap();
        record_event(
            db.conn(),
            "run-rf:e1",
            "run-rf",
            "tool.executed:read 7 bytes from a from b.md",
            3,
        )
        .unwrap();
        // Non-read tool.executed events must NOT be parsed as file refs.
        record_event(
            db.conn(),
            "run-rf:e2",
            "run-rf",
            "tool.executed:wrote 4 bytes to out.txt",
            4,
        )
        .unwrap();
        record_event(
            db.conn(),
            "run-rf:e3",
            "run-rf",
            "tool.executed:listed 3 entries in .",
            5,
        )
        .unwrap();
        // A FAILED read records exec_error (no `tool.executed:` prefix) ⇒ no ref.
        record_event(
            db.conn(),
            "run-rf:e4",
            "run-rf",
            "tool.exec_error:not found: missing.md",
            6,
        )
        .unwrap();
        // A different run's read_file must never leak into this run's refs (run-scoped).
        create_run(db.conn(), "run-other", "task", 1).unwrap();
        record_event(
            db.conn(),
            "run-other:e0",
            "run-other",
            "tool.executed:read 9 bytes from other.md",
            7,
        )
        .unwrap();

        let refs = list_read_file_refs(db.conn(), "run-rf").unwrap();
        assert_eq!(
            refs,
            vec!["notes.md".to_string(), "a from b.md".to_string()],
            "only read_file receipts of THIS run, parsed on the FIRST ` bytes from ` separator"
        );
    }

    #[test]
    fn list_read_file_refs_is_empty_for_run_with_no_reads() {
        let db = Db::open_hub(&tmp("noreadrefs")).unwrap();
        create_run(db.conn(), "run-nr", "task", 1).unwrap();
        record_event(db.conn(), "run-nr:e0", "run-nr", "plan.none", 2).unwrap();
        record_event(db.conn(), "run-nr:e1", "run-nr", "agent.finished", 3).unwrap();
        assert!(list_read_file_refs(db.conn(), "run-nr").unwrap().is_empty());
    }

    #[test]
    fn db_wide_token_totals_is_zero_for_a_run_only_db() {
        // The agent loop does not ledger tokens, so a run-only DB has 0 totals.
        let db = Db::open_hub(&tmp("tokens")).unwrap();
        create_run(db.conn(), "run-4", "task", 1).unwrap();
        let totals = db_wide_token_totals(db.conn()).unwrap();
        assert_eq!(totals, DbWideTokenTotals::default());
        assert_eq!(totals.total, 0);
    }

    /// Reproducibility probe (mirrors `mission_workbench_projection`'s probe): when
    /// `FRIDAY_AGENT_RUN_READBACK_PROBE_DB` is set, write an isolated v-current hub
    /// DB with one `agent_run` (`run_id = readback_probe_run`) + a representative
    /// ordered event log, so `hub_run_readback --db <path> --run-id readback_probe_run`
    /// can be run to capture the real refs-only JSON. `#[ignore]`d so it never runs
    /// in CI; writes ONLY to the operator-supplied path.
    #[test]
    #[ignore = "writes an isolated probe DB only when FRIDAY_AGENT_RUN_READBACK_PROBE_DB is set"]
    fn write_agent_run_readback_probe_db() {
        let path = std::env::var("FRIDAY_AGENT_RUN_READBACK_PROBE_DB")
            .expect("FRIDAY_AGENT_RUN_READBACK_PROBE_DB required");
        let db = Db::open_hub(&path).unwrap();
        let run_id = "readback_probe_run";
        create_run(
            db.conn(),
            run_id,
            "read the file notes.md and summarize it",
            1000,
        )
        .unwrap();
        // A representative read-only run: plan -> tool.executed (embeds a RELATIVE
        // filename, which the readback guard accepts) -> finish.
        for (slot, kind, ts) in [
            ("t0:plan", "plan.none", 1001),
            (
                "t0:outcome",
                "tool.executed:read 15 bytes from notes.md",
                1002,
            ),
            ("t1:plan", "plan.none", 1003),
            ("t1:finish", "agent.finished", 1004),
        ] {
            record_event(db.conn(), &format!("{run_id}:{slot}"), run_id, kind, ts).unwrap();
        }
    }
}
