//! Friday Rust Core — SQLite storage foundation (gate 21 §2).
//!
//! Provides the `Db` handle (Hub or Phone profile), forward migrations with a
//! destructive-backup guard, the hash-chained audit ledger, the token/model
//! ledger, the encrypted blob store, and the atomic multi-table write that a
//! model call performs (`token_ledger` + `activity_item` + `audit_ledger` all
//! or nothing).
//!
//! Unit 2 scope: the foundation tables + writers the first slice needs. Full
//! repositories for every domain are deferred to their owning units (gate 21 §9).

pub mod agent_run;
pub mod audit;
pub mod authorize;
pub mod blob;
mod error;
pub mod memory;
mod migrate;
pub mod offline;
pub mod pairing;
mod schema;
pub mod workflow;

pub use authorize::authorize_mutating_action;
pub use error::{Result, StorageError};
pub use migrate::{
    apply_migrations, current_version, now_ms, Migration, MigrationFn, MigrationReport,
};
pub use schema::{hub_migrations, phone_migrations, HUB_ONLY_TABLES, PHONE_ONLY_TABLES};

use friday_core::{ActivityState, ActivityType, DeviceIdentity, LedgerEntry, SessionState};
use rusqlite::Connection;

/// Which process this database belongs to. Determines the schema (a phone DB
/// omits the secret-/sensitive-bearing tables, gate 21 §2/§3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Hub,
    Phone,
}

/// A foundation activity row (mirrors `activity_item`).
#[derive(Clone, Debug)]
pub struct ActivityRow {
    pub activity_id: String,
    pub session_id: Option<String>,
    pub kind: ActivityType,
    pub state: ActivityState,
    pub summary: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deep_link: Option<String>,
}

/// A UI-facing token/cost summary (a read projection of `token_ledger`). The
/// `fallback` flag is always surfaced — a fallback is never hidden (`02` §13).
#[derive(Clone, Debug, PartialEq)]
pub struct TokenUsageRow {
    pub provider_kind: String,
    pub model: String,
    pub total_tokens: i64,
    pub cost_estimate: Option<f64>,
    pub fallback: bool,
    pub created_at: i64,
}

/// A UI-facing activity summary (a read projection of `activity_item`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ActivitySummary {
    pub activity_id: String,
    pub kind: String,
    pub state: String,
    pub summary: String,
    pub created_at: i64,
}

/// One auditable event (mirrors the inputs to `audit::append_audit`).
#[derive(Clone, Debug)]
pub struct AuditEvent {
    pub audit_id: String,
    pub actor: String,
    pub action: String,
    pub payload_ref: Option<String>,
    pub created_at: i64,
}

pub struct Db {
    conn: Connection,
    path: String,
    profile: Profile,
}

impl Db {
    /// Open (and migrate) a Hub database.
    pub fn open_hub(path: &str) -> Result<Db> {
        Db::open(
            path,
            Profile::Hub,
            &schema::hub_migrations(),
            "unit2-foundation",
        )
    }

    /// Open (and migrate) a phone-profile database.
    pub fn open_phone(path: &str) -> Result<Db> {
        Db::open(
            path,
            Profile::Phone,
            &schema::phone_migrations(),
            "unit2-foundation",
        )
    }

    /// Open with an explicit migration set (used by tests to drive a custom
    /// destructive migration through the backup guard).
    pub fn open(
        path: &str,
        profile: Profile,
        migrations: &[Migration],
        app_build: &str,
    ) -> Result<Db> {
        let mut conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        apply_migrations(&mut conn, path, migrations, app_build)?;
        Ok(Db {
            conn,
            path: path.to_string(),
            profile,
        })
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }
    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
    pub fn profile(&self) -> Profile {
        self.profile
    }
    pub fn path(&self) -> &str {
        &self.path
    }

    pub fn version(&self) -> Result<i64> {
        Ok(current_version(&self.conn)?)
    }

    /// Names of all user tables (excluding sqlite internals), sorted.
    pub fn table_names(&self) -> Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT name FROM sqlite_master
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Row count for a (trusted, code-supplied) table name. For tests/inspection.
    pub fn count(&self, table: &str) -> Result<i64> {
        let table_ident = quote_existing_table(&self.conn, table)?;
        Ok(self
            .conn
            .query_row(&format!("SELECT count(*) FROM {table_ident}"), [], |r| {
                r.get(0)
            })?)
    }

    /// All activity items as a UI-facing summary projection, oldest first. The
    /// `kind`/`state` are the stored string forms (already validated on write).
    pub fn list_activity(&self) -> Result<Vec<ActivitySummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT activity_id, type, state, summary, created_at
             FROM activity_item ORDER BY created_at, activity_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ActivitySummary {
                activity_id: r.get(0)?,
                kind: r.get(1)?,
                state: r.get(2)?,
                summary: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Token/cost usage rows (read projection of `token_ledger`), oldest-first.
    /// Surfaces the `fallback` flag so a fallback is never hidden (`02` §13).
    pub fn list_token_usage(&self) -> Result<Vec<TokenUsageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT provider_kind, model, total_tokens, cost_estimate, fallback, created_at
             FROM token_ledger ORDER BY created_at, ledger_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(TokenUsageRow {
                provider_kind: r.get(0)?,
                model: r.get(1)?,
                total_tokens: r.get(2)?,
                cost_estimate: r.get(3)?,
                fallback: r.get::<_, i64>(4)? != 0,
                created_at: r.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Mark an activity item `Done` (a real persisted state write). Returns
    /// `true` if a row was updated, `false` if the id is unknown.
    pub fn mark_activity_done(&self, activity_id: &str, now: i64) -> Result<bool> {
        let n = self.conn.execute(
            "UPDATE activity_item SET state = ?1, updated_at = ?2 WHERE activity_id = ?3",
            rusqlite::params![ActivityState::Done.as_str(), now, activity_id],
        )?;
        Ok(n > 0)
    }

    // --- writers ------------------------------------------------------------

    pub fn insert_device(&self, d: &DeviceIdentity) -> Result<()> {
        self.conn.execute(
            "INSERT INTO device_identity (device_id, role, public_key, created_at, display_name)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                d.device_id,
                d.role.as_str(),
                d.public_key,
                d.created_at,
                d.display_name
            ],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_session(
        &self,
        session_id: &str,
        kind: &str,
        title: &str,
        state: SessionState,
        created_at: i64,
        updated_at: i64,
        source: &str,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO session (session_id, kind, title, state, created_at, updated_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                session_id,
                kind,
                title,
                state.as_str(),
                created_at,
                updated_at,
                source
            ],
        )?;
        Ok(())
    }

    pub fn insert_activity(&self, a: &ActivityRow) -> Result<()> {
        insert_activity_conn(&self.conn, a)?;
        Ok(())
    }

    pub fn insert_token_ledger(&self, e: &LedgerEntry) -> Result<()> {
        insert_token_ledger_conn(&self.conn, e)?;
        Ok(())
    }

    /// Atomic write performed by a model call: writes `token_ledger`,
    /// `activity_item`, and `audit_ledger` in one transaction. If any insert
    /// fails, none persist (gate 21 §2.3). Hub-only (the audit ledger does not
    /// exist on a phone).
    pub fn record_model_call(
        &mut self,
        entry: &LedgerEntry,
        activity: &ActivityRow,
        audit: &AuditEvent,
    ) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "record_model_call requires the Hub profile (audit_ledger is Hub-only)".into(),
            ));
        }
        let tx = self.conn.transaction()?;
        insert_token_ledger_conn(&tx, entry)?;
        insert_activity_conn(&tx, activity)?;
        audit::append_audit(
            &tx,
            &audit.audit_id,
            &audit.actor,
            &audit.action,
            audit.payload_ref.as_deref(),
            audit.created_at,
        )?;
        tx.commit()?;
        Ok(())
    }
}

fn quote_existing_table(conn: &Connection, table: &str) -> Result<String> {
    if table.is_empty()
        || !table
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(StorageError::Unsupported(format!(
            "invalid table identifier {table:?}"
        )));
    }
    let exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = ?1 AND name NOT LIKE 'sqlite_%'
        )",
        [table],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(StorageError::Unsupported(format!(
            "unknown table identifier {table:?}"
        )));
    }
    Ok(format!("\"{}\"", table.replace('"', "\"\"")))
}

// Free fns so the same insert logic runs against either a Connection or a
// Transaction (Transaction derefs to Connection).

fn insert_token_ledger_conn(conn: &Connection, e: &LedgerEntry) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO token_ledger
            (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
             prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
             result_link, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            e.ledger_id,
            e.session_id,
            e.activity_id,
            e.provider_kind.as_str(),
            e.model,
            e.base_url_host,
            e.prompt_tokens,
            e.completion_tokens,
            e.total_tokens,
            e.cost_estimate,
            e.fallback as i64,
            e.result_link,
            e.created_at
        ],
    )?;
    Ok(())
}

fn insert_activity_conn(conn: &Connection, a: &ActivityRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO activity_item
            (activity_id, session_id, type, state, summary, created_at, updated_at, deep_link)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            a.activity_id,
            a.session_id,
            a.kind.as_str(),
            a.state.as_str(),
            a.summary,
            a.created_at,
            a.updated_at,
            a.deep_link
        ],
    )?;
    Ok(())
}
