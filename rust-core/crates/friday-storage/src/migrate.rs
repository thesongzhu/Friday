//! Forward-only migration framework with a destructive-migration backup guard
//! (gate 21 §2.2 / §2.3).
//!
//! Rules:
//! - Migrations are numbered and forward-only; each runs in one transaction and
//!   bumps `schema_version` in the **same** transaction (apply + bump atomic).
//! - If the on-disk version is newer than the code's max, we refuse to open.
//! - Before any migration flagged `destructive`, the DB file is copied to
//!   `<dir>/backups/v<version>-<ts>-<unique>.sqlite` and the backup is verified openable
//!   (PRAGMA integrity_check == "ok") before the destructive step proceeds.
//!
//! Concurrency note: the foundation uses the default (rollback-journal) mode and
//! a single connection, so the file copy is consistent when no write txn is
//! open. WAL + multi-connection concurrency is deferred to the Hub runtime
//! (Unit 4); this framework does not claim concurrent-writer safety.

use crate::error::{Result, StorageError};
use rusqlite::{Connection, Transaction};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub type MigrationFn = fn(&Transaction) -> rusqlite::Result<()>;

static BACKUP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub destructive: bool,
    pub up: MigrationFn,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct MigrationReport {
    pub from_version: i64,
    pub to_version: i64,
    pub applied: Vec<i64>,
    /// Backup file paths created for destructive migrations.
    pub backups: Vec<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Read the current on-disk schema version, creating the `schema_version`
/// singleton (at version 0) if it does not yet exist.
pub fn current_version(conn: &Connection) -> rusqlite::Result<i64> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_version (
            id         INTEGER PRIMARY KEY CHECK (id = 1),
            version    INTEGER NOT NULL,
            applied_at INTEGER NOT NULL,
            app_build  TEXT
        );",
    )?;
    let has_row: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM schema_version WHERE id = 1)",
        [],
        |r| r.get(0),
    )?;
    if !has_row {
        conn.execute(
            "INSERT INTO schema_version (id, version, applied_at, app_build) VALUES (1, 0, 0, NULL)",
            [],
        )?;
    }
    conn.query_row("SELECT version FROM schema_version WHERE id = 1", [], |r| {
        r.get(0)
    })
}

pub fn apply_migrations(
    conn: &mut Connection,
    db_path: &str,
    migrations: &[Migration],
    app_build: &str,
) -> Result<MigrationReport> {
    let from = current_version(conn)?;
    let code_max = migrations.iter().map(|m| m.version).max().unwrap_or(0);
    if from > code_max {
        return Err(StorageError::SchemaTooNew {
            disk: from,
            code: code_max,
        });
    }

    let mut pending: Vec<&Migration> = migrations.iter().filter(|m| m.version > from).collect();
    pending.sort_by_key(|m| m.version);

    let mut report = MigrationReport {
        from_version: from,
        to_version: from,
        applied: Vec::new(),
        backups: Vec::new(),
    };

    for m in pending {
        if m.destructive {
            let backup = backup_db(db_path, m.version)?;
            verify_backup(&backup)?;
            report.backups.push(backup);
        }
        let tx = conn.transaction()?;
        (m.up)(&tx)?;
        tx.execute(
            "UPDATE schema_version SET version = ?1, applied_at = ?2, app_build = ?3 WHERE id = 1",
            rusqlite::params![m.version, now_ms(), app_build],
        )?;
        tx.commit()?;
        report.applied.push(m.version);
        report.to_version = m.version;
    }

    Ok(report)
}

/// Copy the live DB file to `<dir>/backups/v<version>-<ts>-<unique>.sqlite`.
fn backup_db(db_path: &str, version: i64) -> Result<String> {
    if db_path == ":memory:" || db_path.is_empty() {
        return Err(StorageError::BackupVerify(
            "cannot back up an in-memory database before a destructive migration".into(),
        ));
    }
    let src = Path::new(db_path);
    let dir = src.parent().unwrap_or_else(|| Path::new("."));
    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups)?;
    let dest = backups.join(format!("v{}-{}.sqlite", version, backup_stamp()));
    std::fs::copy(src, &dest)?;
    Ok(dest.to_string_lossy().to_string())
}

fn backup_stamp() -> String {
    let seq = BACKUP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{nanos}-{}-{seq}", now_ms(), std::process::id())
}

/// Confirm the backup is a healthy, openable SQLite file before proceeding.
fn verify_backup(path: &str) -> Result<()> {
    let conn = Connection::open(path)?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| StorageError::BackupVerify(format!("integrity_check failed: {e}")))?;
    if integrity != "ok" {
        return Err(StorageError::BackupVerify(format!(
            "integrity_check returned {integrity:?}"
        )));
    }
    // Must be able to read the schema catalog.
    let _: i64 = conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))?;
    Ok(())
}
