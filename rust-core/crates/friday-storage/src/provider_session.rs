//! Provider session link + event mirror persistence (PNS-001). Hub-only.

use crate::error::{Result, StorageError};
use friday_core::{ProviderSessionEvent, ProviderSessionLink, ProviderSessionProjection, SyncMode};
use rusqlite::{params, Connection, OptionalExtension};

fn require_non_empty(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(StorageError::Unsupported(format!(
            "provider session {field} must not be empty"
        )))
    } else {
        Ok(())
    }
}

fn parse_sync_mode(value: String) -> Result<SyncMode> {
    SyncMode::parse(&value).ok_or_else(|| {
        StorageError::Unsupported(format!("unknown provider session sync_mode '{value}'"))
    })
}

pub fn upsert_link(conn: &Connection, link: &ProviderSessionLink) -> Result<()> {
    require_non_empty(&link.friday_session_id, "friday_session_id")?;
    require_non_empty(&link.provider, "provider")?;
    require_non_empty(&link.account_key_hash, "account_key_hash")?;
    require_non_empty(&link.workspace_id, "workspace_id")?;
    require_non_empty(&link.truth_label, "truth_label")?;

    conn.execute(
        "INSERT INTO provider_session_link
            (friday_session_id, provider, account_key_hash, workspace_id, cwd,
             external_session_id, external_thread_id, external_url, sync_mode,
             capability_snapshot, last_provider_seen_at, last_friday_event_id, truth_label)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(friday_session_id) DO UPDATE SET
            provider = excluded.provider,
            account_key_hash = excluded.account_key_hash,
            workspace_id = excluded.workspace_id,
            cwd = excluded.cwd,
            external_session_id = excluded.external_session_id,
            external_thread_id = excluded.external_thread_id,
            external_url = excluded.external_url,
            sync_mode = excluded.sync_mode,
            capability_snapshot = excluded.capability_snapshot,
            last_provider_seen_at = excluded.last_provider_seen_at,
            last_friday_event_id = excluded.last_friday_event_id,
            truth_label = excluded.truth_label",
        params![
            link.friday_session_id,
            link.provider,
            link.account_key_hash,
            link.workspace_id,
            link.cwd,
            link.external_session_id,
            link.external_thread_id,
            link.external_url,
            link.sync_mode.as_str(),
            link.capability_snapshot,
            link.last_provider_seen_at,
            link.last_friday_event_id,
            link.truth_label,
        ],
    )?;
    Ok(())
}

pub fn get_link(conn: &Connection, friday_session_id: &str) -> Result<Option<ProviderSessionLink>> {
    conn.query_row(
        "SELECT friday_session_id, provider, account_key_hash, workspace_id, cwd,
                external_session_id, external_thread_id, external_url, sync_mode,
                capability_snapshot, last_provider_seen_at, last_friday_event_id, truth_label
         FROM provider_session_link
         WHERE friday_session_id = ?1",
        [friday_session_id],
        |r| {
            let sync_mode: String = r.get(8)?;
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                sync_mode,
                r.get::<_, String>(9)?,
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, Option<String>>(11)?,
                r.get::<_, String>(12)?,
            ))
        },
    )
    .optional()?
    .map(
        |(
            friday_session_id,
            provider,
            account_key_hash,
            workspace_id,
            cwd,
            external_session_id,
            external_thread_id,
            external_url,
            sync_mode,
            capability_snapshot,
            last_provider_seen_at,
            last_friday_event_id,
            truth_label,
        )| {
            Ok(ProviderSessionLink {
                friday_session_id,
                provider,
                account_key_hash,
                workspace_id,
                cwd,
                external_session_id,
                external_thread_id,
                external_url,
                sync_mode: parse_sync_mode(sync_mode)?,
                capability_snapshot,
                last_provider_seen_at,
                last_friday_event_id,
                truth_label,
            })
        },
    )
    .transpose()
}

pub fn list_projections(conn: &Connection) -> Result<Vec<ProviderSessionProjection>> {
    let mut stmt = conn.prepare(
        "SELECT friday_session_id, provider, workspace_id, sync_mode,
                capability_snapshot, last_provider_seen_at, last_friday_event_id, truth_label
         FROM provider_session_link
         ORDER BY COALESCE(last_provider_seen_at, 0) DESC, friday_session_id",
    )?;
    let rows = stmt.query_map([], |r| {
        let sync_mode: String = r.get(3)?;
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            sync_mode,
            r.get::<_, String>(4)?,
            r.get::<_, Option<i64>>(5)?,
            r.get::<_, Option<String>>(6)?,
            r.get::<_, String>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (
            friday_session_id,
            provider,
            workspace_id,
            sync_mode,
            capability_snapshot,
            last_provider_seen_at,
            last_friday_event_id,
            truth_label,
        ) = row?;
        out.push(ProviderSessionProjection {
            friday_session_id,
            provider,
            workspace_id,
            sync_mode: parse_sync_mode(sync_mode)?,
            capability_snapshot,
            last_provider_seen_at,
            last_friday_event_id,
            truth_label,
        });
    }
    Ok(out)
}

pub fn append_event(conn: &Connection, event: &ProviderSessionEvent) -> Result<()> {
    require_non_empty(&event.friday_session_id, "event.friday_session_id")?;
    require_non_empty(&event.provider_event_id, "event.provider_event_id")?;
    require_non_empty(&event.provider, "event.provider")?;
    require_non_empty(&event.event_kind, "event.event_kind")?;
    require_non_empty(&event.transcript_item_kind, "event.transcript_item_kind")?;
    require_non_empty(&event.redaction_level, "event.redaction_level")?;

    conn.execute(
        "INSERT INTO provider_session_event
            (friday_session_id, provider_event_id, provider, event_kind, transcript_item_kind,
             body_ref, redaction_level, token_ledger_ref, approval_ref, audit_receipt_ref, observed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            event.friday_session_id,
            event.provider_event_id,
            event.provider,
            event.event_kind,
            event.transcript_item_kind,
            event.body_ref,
            event.redaction_level,
            event.token_ledger_ref,
            event.approval_ref,
            event.audit_receipt_ref,
            event.observed_at,
        ],
    )?;
    Ok(())
}

pub fn list_events(
    conn: &Connection,
    friday_session_id: &str,
) -> Result<Vec<ProviderSessionEvent>> {
    let mut stmt = conn.prepare(
        "SELECT friday_session_id, provider_event_id, provider, event_kind, transcript_item_kind,
                body_ref, redaction_level, token_ledger_ref, approval_ref, audit_receipt_ref,
                observed_at
         FROM provider_session_event
         WHERE friday_session_id = ?1
         ORDER BY observed_at, provider_event_id",
    )?;
    let rows = stmt.query_map([friday_session_id], |r| {
        Ok(ProviderSessionEvent {
            friday_session_id: r.get(0)?,
            provider_event_id: r.get(1)?,
            provider: r.get(2)?,
            event_kind: r.get(3)?,
            transcript_item_kind: r.get(4)?,
            body_ref: r.get(5)?,
            redaction_level: r.get(6)?,
            token_ledger_ref: r.get(7)?,
            approval_ref: r.get(8)?,
            audit_receipt_ref: r.get(9)?,
            observed_at: r.get(10)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(StorageError::from)
}
