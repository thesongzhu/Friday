//! Prod Hub schema migration leg with an explicit online backup.
//!
//! This is deliberately narrower than the dev-only mutation bins:
//! - default mode is dry-run/read-only;
//! - apply mode requires an explicit ACK env var and `--expected-from`;
//! - every real migration first takes a SQLite online backup and verifies it;
//! - it never starts, stops, restarts, signs, enrolls, or flips flags.

use std::env;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use friday_storage::{hub_code_max, hub_migrations, Db, StorageError, HUB_BUSY_TIMEOUT_MS};
use rusqlite::{backup::Backup, Connection, DatabaseName, OpenFlags};
use serde_json::json;

const APPLY_ACK_ENV: &str = "FRIDAY_HUB_SCHEMA_MIGRATE_ACK";
const APPLY_ACK_VALUE: &str = "backup-then-migrate-live-hub-db";

struct Args {
    db_path: String,
    backup_dir: Option<String>,
    apply: bool,
    expected_from: Option<i64>,
    json: bool,
    help: bool,
}

#[derive(Debug)]
struct BinError {
    kind: &'static str,
    detail: String,
}

impl BinError {
    fn new(kind: &'static str, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }
}

fn main() {
    match run() {
        Ok(rendered) => println!("{rendered}"),
        Err(err) => {
            let payload = json!({
                "truth_label": "hub_schema_migration_backup_first_no_restart_no_signature",
                "ok": false,
                "error_kind": err.kind,
            });
            println!("{payload}");
            eprintln!(
                "hub_schema_migrate_unavailable: {}: {}",
                err.kind, err.detail
            );
            std::process::exit(2);
        }
    }
}

fn run() -> Result<String, BinError> {
    let args = parse_args(env::args().collect::<Vec<_>>().as_slice())?;
    if args.help {
        return Ok(usage());
    }
    if args.db_path.is_empty() {
        return Err(BinError::new("bad_args", "--db is required"));
    }
    let db_path = PathBuf::from(&args.db_path);
    if !db_path.is_file() {
        return Err(BinError::new("db_not_found", "Hub DB path is not a file"));
    }

    let from_version = read_schema_version(&db_path)?;
    let code_max = hub_code_max();
    if from_version > code_max {
        return Err(BinError::new(
            "schema_too_new",
            format!("disk version {from_version} > code version {code_max}"),
        ));
    }

    let pending = pending_versions(from_version);
    if !args.apply {
        return Ok(render_report(
            json!({
                "truth_label": "hub_schema_migration_dry_run_read_only_no_restart_no_signature",
                "ok": from_version <= code_max,
                "mode": "dry_run",
                "dbPath": db_path.to_string_lossy(),
                "fromVersion": from_version,
                "toVersion": code_max,
                "pendingVersions": pending,
                "status": if from_version == code_max { "schema_current" } else { "needs_migration" },
                "caveat": "Dry-run only: no backup, migration, restart, signing, enrollment, flag flip, or adoption claim happened.",
            }),
            args.json,
        ));
    }

    require_apply_ack()?;
    let expected_from = args
        .expected_from
        .ok_or_else(|| BinError::new("bad_args", "apply requires --expected-from"))?;
    if expected_from != from_version {
        return Err(BinError::new(
            "expected_from_mismatch",
            format!("expected {expected_from}, found {from_version}"),
        ));
    }

    if from_version == code_max {
        return Ok(render_report(
            json!({
                "truth_label": "hub_schema_migration_apply_noop_no_restart_no_signature",
                "ok": true,
                "mode": "apply",
                "dbPath": db_path.to_string_lossy(),
                "fromVersion": from_version,
                "toVersion": code_max,
                "pendingVersions": [],
                "backupPath": null,
                "status": "schema_current_noop",
                "caveat": "Schema already current; no backup, migration, restart, signing, enrollment, flag flip, or adoption claim happened.",
            }),
            args.json,
        ));
    }

    let backup_dir = args
        .backup_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| default_backup_dir(&db_path));
    let backup_path = backup_hub_db(&db_path, &backup_dir, from_version, code_max)?;
    verify_backup(&backup_path, from_version)?;

    let migrated = Db::open_hub(&db_path.to_string_lossy())
        .map_err(|err| map_storage_error("migrate_failed", err))?;
    let to_version = migrated
        .version()
        .map_err(|err| map_storage_error("verify_version_failed", err))?;
    if to_version != code_max {
        return Err(BinError::new(
            "post_migrate_version_mismatch",
            format!("expected {code_max}, found {to_version}"),
        ));
    }

    Ok(render_report(
        json!({
            "truth_label": "hub_schema_migration_backup_first_no_restart_no_signature",
            "ok": true,
            "mode": "apply",
            "dbPath": db_path.to_string_lossy(),
            "fromVersion": from_version,
            "toVersion": to_version,
            "pendingVersions": pending,
            "backupPath": backup_path.to_string_lossy(),
            "status": "schema_migrated",
            "caveat": "This migrated only the Hub DB schema after a verified online backup. It did not restart services, sign, enroll, flip flags, prove clients, claim END-BAR, GO-LIVE, or adoption.",
        }),
        args.json,
    ))
}

fn parse_args(argv: &[String]) -> Result<Args, BinError> {
    let mut args = Args {
        db_path: String::new(),
        backup_dir: None,
        apply: false,
        expected_from: None,
        json: false,
        help: false,
    };
    let mut i = 1;
    while i < argv.len() {
        match argv[i].as_str() {
            "--db" => {
                i += 1;
                args.db_path = argv.get(i).cloned().unwrap_or_default();
            }
            "--backup-dir" => {
                i += 1;
                args.backup_dir = argv.get(i).cloned();
            }
            "--expected-from" => {
                i += 1;
                let raw = argv
                    .get(i)
                    .ok_or_else(|| BinError::new("bad_args", "--expected-from requires a value"))?;
                args.expected_from = Some(
                    raw.parse::<i64>()
                        .map_err(|_| BinError::new("bad_args", "bad --expected-from"))?,
                );
            }
            "--apply" => args.apply = true,
            "--json" => args.json = true,
            "-h" | "--help" => args.help = true,
            other => {
                return Err(BinError::new(
                    "bad_args",
                    format!("unknown argument: {other}"),
                ))
            }
        }
        i += 1;
    }
    Ok(args)
}

fn usage() -> String {
    format!(
        "Friday Hub schema migration leg\n\nUSAGE:\n  hub_schema_migrate --db <hub.sqlite> [--json]\n  {APPLY_ACK_ENV}={APPLY_ACK_VALUE} hub_schema_migrate --db <hub.sqlite> --apply --expected-from <n> [--backup-dir <dir>] [--json]\n\nDefault mode is read-only dry-run. Apply mode backs up first, verifies the backup, then opens Db::open_hub to apply migrations. It never restarts services, signs, enrolls, or flips flags."
    )
}

fn require_apply_ack() -> Result<(), BinError> {
    match env::var(APPLY_ACK_ENV) {
        Ok(value) if value == APPLY_ACK_VALUE => Ok(()),
        _ => Err(BinError::new(
            "missing_apply_ack",
            format!("{APPLY_ACK_ENV} must equal {APPLY_ACK_VALUE}"),
        )),
    }
}

fn pending_versions(from_version: i64) -> Vec<i64> {
    let mut versions = hub_migrations()
        .iter()
        .filter_map(|m| (m.version > from_version).then_some(m.version))
        .collect::<Vec<_>>();
    versions.sort_unstable();
    versions
}

fn read_schema_version(path: &Path) -> Result<i64, BinError> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| BinError::new("open_readonly_failed", err.to_string()))?;
    conn.pragma_update(None, "busy_timeout", HUB_BUSY_TIMEOUT_MS)
        .map_err(|err| BinError::new("busy_timeout_failed", err.to_string()))?;
    conn.query_row(
        "SELECT version FROM schema_version WHERE id = 1",
        [],
        |row| row.get::<_, i64>(0),
    )
    .map_err(|err| BinError::new("schema_version_unavailable", err.to_string()))
}

fn default_backup_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("backups")
        .join("hub-schema-migrate")
}

fn backup_hub_db(
    db_path: &Path,
    backup_dir: &Path,
    from_version: i64,
    code_max: i64,
) -> Result<PathBuf, BinError> {
    std::fs::create_dir_all(backup_dir)
        .map_err(|err| BinError::new("backup_dir_failed", err.to_string()))?;
    let backup_path = backup_dir.join(format!(
        "rust-hub-v{from_version}-to-v{code_max}-{}.sqlite",
        backup_stamp()
    ));
    if backup_path.exists() {
        return Err(BinError::new("backup_exists", "backup path already exists"));
    }
    let source = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|err| BinError::new("backup_open_source_failed", err.to_string()))?;
    source
        .pragma_update(None, "busy_timeout", HUB_BUSY_TIMEOUT_MS)
        .map_err(|err| BinError::new("backup_busy_timeout_failed", err.to_string()))?;
    let mut destination = Connection::open(&backup_path)
        .map_err(|err| BinError::new("backup_open_destination_failed", err.to_string()))?;
    let backup = Backup::new_with_names(
        &source,
        DatabaseName::Main,
        &mut destination,
        DatabaseName::Main,
    )
    .map_err(|err| BinError::new("backup_start_failed", err.to_string()))?;
    backup
        .run_to_completion(100, std::time::Duration::from_millis(50), None)
        .map_err(|err| BinError::new("backup_failed", err.to_string()))?;
    Ok(backup_path)
}

fn verify_backup(path: &Path, expected_version: i64) -> Result<(), BinError> {
    // The backup file is a fresh artifact this tool just created. Open it normally
    // for verification: SQLite's `integrity_check` may need scratch writes while
    // validating FTS5 shadow structures, and a read-only verification connection
    // returns "attempt to write a readonly database" for an otherwise healthy file.
    let conn = Connection::open(path)
        .map_err(|err| BinError::new("backup_verify_open_failed", err.to_string()))?;
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(|err| BinError::new("backup_integrity_failed", err.to_string()))?;
    if integrity != "ok" {
        return Err(BinError::new(
            "backup_integrity_failed",
            format!("integrity_check returned {integrity}"),
        ));
    }
    let version: i64 = conn
        .query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|err| BinError::new("backup_version_failed", err.to_string()))?;
    if version != expected_version {
        return Err(BinError::new(
            "backup_version_mismatch",
            format!("expected {expected_version}, found {version}"),
        ));
    }
    Ok(())
}

fn backup_stamp() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis}-{}", std::process::id())
}

fn map_storage_error(kind: &'static str, err: StorageError) -> BinError {
    BinError::new(kind, format!("{err:?}"))
}

fn render_report(payload: serde_json::Value, json_only: bool) -> String {
    if json_only {
        serde_json::to_string_pretty(&payload).unwrap_or_else(|_| payload.to_string())
    } else {
        let status = payload
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let from = payload
            .get("fromVersion")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let to = payload
            .get("toVersion")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let backup = payload
            .get("backupPath")
            .and_then(|v| v.as_str())
            .unwrap_or("none");
        format!(
            "status={status}\nfrom_version={from} to_version={to}\nbackup_path={backup}\ntruth_label={}",
            payload
                .get("truth_label")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path(name: &str) -> PathBuf {
        let mut path = env::temp_dir();
        path.push(format!(
            "friday-hub-schema-migrate-{name}-{}-{}.sqlite",
            std::process::id(),
            backup_stamp()
        ));
        path
    }

    #[test]
    fn apply_requires_expected_from() {
        let argv = vec![
            "hub_schema_migrate".to_string(),
            "--db".to_string(),
            "/tmp/example.sqlite".to_string(),
            "--apply".to_string(),
        ];
        let args = parse_args(&argv).unwrap();
        assert!(args.apply);
        assert_eq!(args.expected_from, None);
    }

    #[test]
    fn backup_verifies_same_schema_version() {
        let db_path = temp_path("source");
        let backup_dir = env::temp_dir().join(format!(
            "friday-hub-schema-migrate-backups-{}",
            backup_stamp()
        ));
        let db = Db::open_hub(&db_path.to_string_lossy()).unwrap();
        let from_version = db.version().unwrap();
        drop(db);

        let backup_path =
            backup_hub_db(&db_path, &backup_dir, from_version, hub_code_max()).unwrap();
        verify_backup(&backup_path, from_version).unwrap();

        let _ = std::fs::remove_file(&db_path);
        let _ = std::fs::remove_file(&backup_path);
        let _ = std::fs::remove_dir_all(&backup_dir);
    }
}
