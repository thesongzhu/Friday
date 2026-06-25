//! Context Passport persistence (Hub-only; loop closure commit 2).
//!
//! Persists the destination-bound [`ContextPassport`] object + its item set, and
//! reloads it by REBUILDING through [`build_context_passport`] — so a stored row only
//! becomes a usable passport if it RE-CLEARS the transfer gate. A directly-INSERTed
//! secret/raw-token item (bypassing the typed `upsert`) therefore fails to rebuild and
//! the loader returns the gate error / treats the passport as absent: the gate is
//! never satisfied by trusting a raw DB row.
//!
//! `PassportItem` / `PassportItemKind` live in the FROZEN parallel memory lane
//! (`friday-core::memory`), which is serde-free and has no string conversion for the
//! kind. So the kind<->string map lives HERE (the storage boundary), not in core.

use crate::error::{Result, StorageError};
use friday_core::{
    build_context_passport, ContextPassport, PassportItem, PassportItemKind, WorkLane,
};
use rusqlite::{params, Connection, OptionalExtension};

fn unsupported(message: impl Into<String>) -> StorageError {
    StorageError::Unsupported(message.into())
}

fn lane_as_str(lane: WorkLane) -> &'static str {
    lane.as_str()
}

fn parse_lane(value: &str) -> Result<WorkLane> {
    match value {
        "friday_hub" => Ok(WorkLane::FridayHub),
        "codex" => Ok(WorkLane::Codex),
        "claude" => Ok(WorkLane::Claude),
        "deepseek" => Ok(WorkLane::DeepSeek),
        "workflow" => Ok(WorkLane::Workflow),
        "channel" => Ok(WorkLane::Channel),
        "human" => Ok(WorkLane::Human),
        "future_api" => Ok(WorkLane::FutureApi),
        other => Err(unsupported(format!("unknown work lane '{other}'"))),
    }
}

fn kind_as_str(kind: PassportItemKind) -> &'static str {
    match kind {
        PassportItemKind::MemorySnippet => "memory_snippet",
        PassportItemKind::Summary => "summary",
        PassportItemKind::File => "file",
        PassportItemKind::Screenshot => "screenshot",
        PassportItemKind::Attachment => "attachment",
        PassportItemKind::ProviderSecret => "provider_secret", // pragma: allowlist secret
        PassportItemKind::RawToken => "raw_token",
    }
}

fn parse_kind(value: &str) -> Result<PassportItemKind> {
    match value {
        "memory_snippet" => Ok(PassportItemKind::MemorySnippet),
        "summary" => Ok(PassportItemKind::Summary),
        "file" => Ok(PassportItemKind::File),
        "screenshot" => Ok(PassportItemKind::Screenshot),
        "attachment" => Ok(PassportItemKind::Attachment),
        "provider_secret" => Ok(PassportItemKind::ProviderSecret),
        "raw_token" => Ok(PassportItemKind::RawToken),
        other => Err(unsupported(format!("unknown passport item kind '{other}'"))),
    }
}

/// Persist a built Context Passport + its item set in ONE transaction (parent +
/// children commit together). The passport is ALREADY gated by construction (it is a
/// [`ContextPassport`] value, which only `build_context_passport` produces), so the
/// upsert does not re-gate — but the loader does, defending against a direct INSERT.
pub fn upsert_context_passport(conn: &Connection, passport: &ContextPassport) -> Result<()> {
    if passport.passport_id.trim().is_empty() {
        return Err(unsupported(
            "context_passport passport_id must not be empty",
        ));
    }
    if passport.mission_id.trim().is_empty() {
        return Err(unsupported("context_passport mission_id must not be empty"));
    }
    let tx = conn.unchecked_transaction()?;
    upsert_context_passport_in(&tx, passport)?;
    tx.commit()?;
    Ok(())
}

/// Persist a built Context Passport + item set inside the caller's existing transaction.
///
/// This is for multi-table Hub writes that must commit the passport, mission link, and mission
/// ref atomically. It intentionally does not open its own transaction.
pub fn upsert_context_passport_in(conn: &Connection, passport: &ContextPassport) -> Result<()> {
    if passport.passport_id.trim().is_empty() {
        return Err(unsupported(
            "context_passport passport_id must not be empty",
        ));
    }
    if passport.mission_id.trim().is_empty() {
        return Err(unsupported("context_passport mission_id must not be empty"));
    }
    conn.execute(
        "INSERT INTO context_passport
            (passport_id, mission_id, work_item_id, destination_lane, destination_target,
             approved_sensitive, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(passport_id) DO UPDATE SET
            mission_id = excluded.mission_id,
            work_item_id = excluded.work_item_id,
            destination_lane = excluded.destination_lane,
            destination_target = excluded.destination_target,
            approved_sensitive = excluded.approved_sensitive,
            created_at_ms = excluded.created_at_ms",
        params![
            passport.passport_id,
            passport.mission_id,
            passport.work_item_id,
            lane_as_str(passport.destination_lane),
            passport.destination_target,
            i64::from(passport.approved_sensitive),
            passport.created_at_ms,
        ],
    )?;
    // Replace the child item set wholesale (an upsert of the parent re-states all items).
    conn.execute(
        "DELETE FROM context_passport_item WHERE passport_id = ?1",
        params![passport.passport_id],
    )?;
    for (seq, item) in passport.items.iter().enumerate() {
        conn.execute(
            "INSERT INTO context_passport_item
                (passport_id, seq, kind, label, included, sensitive)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                passport.passport_id,
                seq as i64,
                kind_as_str(item.kind),
                item.label,
                i64::from(item.included),
                i64::from(item.sensitive),
            ],
        )?;
    }
    Ok(())
}

/// The raw (pre-rebuild) parent row of a Context Passport.
struct ParentRow {
    mission_id: String,
    work_item_id: Option<String>,
    lane: String,
    target: Option<String>,
    approved_sensitive: i64,
    created_at_ms: i64,
}

/// Load a Context Passport BY REBUILDING through `build_context_passport`. A row whose
/// item set no longer clears the transfer gate (e.g. a directly-INSERTed secret item)
/// returns `Err(BlockedTransfer)` — it never silently becomes a usable passport. A
/// missing parent row returns `Ok(None)`.
pub fn get_context_passport(
    conn: &Connection,
    passport_id: &str,
) -> Result<Option<ContextPassport>> {
    let parent: Option<ParentRow> = conn
        .query_row(
            "SELECT mission_id, work_item_id, destination_lane, destination_target,
                    approved_sensitive, created_at_ms
             FROM context_passport WHERE passport_id = ?1",
            params![passport_id],
            |r| {
                Ok(ParentRow {
                    mission_id: r.get(0)?,
                    work_item_id: r.get(1)?,
                    lane: r.get(2)?,
                    target: r.get(3)?,
                    approved_sensitive: r.get(4)?,
                    created_at_ms: r.get(5)?,
                })
            },
        )
        .optional()?;
    let Some(parent) = parent else {
        return Ok(None);
    };

    let mut stmt = conn.prepare(
        "SELECT kind, label, included, sensitive
         FROM context_passport_item WHERE passport_id = ?1 ORDER BY seq",
    )?;
    let rows = stmt.query_map(params![passport_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    let mut items = Vec::new();
    for row in rows {
        let (kind, label, included, sensitive) = row?;
        items.push(PassportItem {
            kind: parse_kind(&kind)?,
            label,
            included: included != 0,
            sensitive: sensitive != 0,
        });
    }

    // REBUILD through the gated constructor: this re-runs `gate_transfer`, so a tampered
    // row (secret content / unapproved sensitive) fails closed here.
    let passport = build_context_passport(
        passport_id.to_string(),
        parent.mission_id,
        parent.work_item_id,
        parse_lane(&parent.lane)?,
        parent.target,
        items,
        parent.approved_sensitive != 0,
        parent.created_at_ms,
    )
    .map_err(|e| unsupported(e.to_string()))?;
    Ok(Some(passport))
}

/// List the passports minted for a Mission, newest first. Each is rebuilt-and-re-gated
/// (a tampered row surfaces its `BlockedTransfer` error rather than loading).
pub fn list_for_mission(conn: &Connection, mission_id: &str) -> Result<Vec<ContextPassport>> {
    let mut stmt = conn.prepare(
        "SELECT passport_id FROM context_passport
         WHERE mission_id = ?1 ORDER BY created_at_ms DESC, passport_id",
    )?;
    let ids: Vec<String> = stmt
        .query_map(params![mission_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(p) = get_context_passport(conn, &id)? {
            out.push(p);
        }
    }
    Ok(out)
}
