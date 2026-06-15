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
pub mod agent_run_read;
pub mod agent_session;
pub mod audit;
pub mod authorize;
pub mod authorize_ed25519;
pub mod blob;
pub mod channel;
mod error;
pub mod memory;
mod migrate;
pub mod mission;
pub mod offline;
pub mod pairing;
pub mod passport;
pub mod pending_request;
pub mod process_registry;
pub mod provider_session;
pub mod provider_timeline_store;
pub mod run_result;
pub mod schedule;
mod schema;
pub mod session_lifecycle;
pub mod system_intent;
pub mod trust_grant;
pub mod workflow;
pub mod workflow_catalog;
pub mod workflow_def;
pub mod workflow_read;

pub use agent_session::{
    append_session_message, archive_session_for_owner, ensure_session, ensure_session_with_owner,
    fork_session_for_owner, list_sessions_for_owner, load_session_messages, load_session_owner,
    open_session_for_owner, session_exists, session_forked_from, session_message_count,
    session_message_count_for_owner, ArchiveOutcome, ForkOutcome, SessionListItem, SessionMessage,
    SessionOwner, StoredSessionMessage,
};
pub use authorize::authorize_mutating_action;
pub use authorize_ed25519::{authorize_mutating_action_ed25519, Ed25519VerifyOnlyPolicy};
pub use error::{Result, StorageError};
pub use migrate::{
    apply_migrations, current_version, now_ms, Migration, MigrationFn, MigrationReport,
};
pub use passport::{get_context_passport, list_for_mission, upsert_context_passport};
pub use pending_request::{
    get_pending_request, insert_pending_approval_activity, list_pending_requests_for_run,
    persist_pending_request, set_pending_status, PendingApprovalRequest,
};
pub use provider_timeline_store::{
    load_events, load_pending, load_timeline_by_session, load_timeline_state, persist_event,
    persist_timeline, timeline_exists, upsert_pending, PendingActionRow, PersistEventOutcome,
    StoredPendingAction, StoredTimeline, StoredTimelineEvent, TimelineEventRow, TimelineState,
};
pub use run_result::{
    get_run_answer_for_principal, get_run_result, get_run_result_ref, persist_run_result,
    AnswerDenyReason, PersistRunResultOutcome, RunAnswerAccess, RunResult, RunResultRef,
    StoredRunResult,
};
pub use schema::{hub_migrations, phone_migrations, HUB_ONLY_TABLES, PHONE_ONLY_TABLES};
pub use session_lifecycle::{sweep_lifecycle, SweepOutcome};
pub use trust_grant::{
    active_grant, authorize_agent_action, grant_trust, latest_grant_any_state, revoke_trust,
    AgentActionContext,
};

use friday_core::{
    ActivityState, ActivityType, ContextPassport, DeviceIdentity, FridayConversation,
    FridayPairPayload, LedgerEntry, Mission, MissionLink, MissionSurfaceProjection,
    ProviderSessionEvent, ProviderSessionLink, ProviderSessionProjection, RouteDecisionCard,
    RouteDecisionProjection, SessionState, SurfaceEvent, SurfaceThread, TrustedDeviceProjection,
    WorkItem,
};
use friday_core::{ProcessLease, ProcessObservation, WorkspaceClaim};
use rusqlite::{Connection, ErrorCode, OpenFlags};

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

/// (C2) A RUN-SCOPED token-ledger row — the read projection the routed-parity proof needs
/// to assert, PER FLOW, that exactly the model calls of a given run were billed to the
/// expected provider. It surfaces the two fields a UI summary omits but a provider-parity
/// proof requires: `base_url_host` (so a Claude call's `api.anthropic.com` host is
/// verifiable, not just its `provider_kind`) and `ledger_id` (so the per-turn row ids are
/// inspectable). The `fallback` flag is always surfaced. The run-attribution column is
/// `session_id` (a loop run has no separate session; `bill_model_call` stamps `run_id`
/// there — see the `idx_ledger_session_created` index), so this filters on it.
#[derive(Clone, Debug, PartialEq)]
pub struct RunTokenUsageRow {
    pub ledger_id: String,
    pub provider_kind: String,
    pub model: String,
    pub base_url_host: String,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
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

/// Outcome of [`Db::record_event`]: a fresh event was recorded, or a replay (same
/// `activity_id`) was refused idempotently — nothing written (no second activity, no
/// second audit).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RecordEventOutcome {
    Recorded,
    Duplicate,
}

pub struct Db {
    conn: Connection,
    path: String,
    profile: Profile,
}

/// The per-connection SQLite busy timeout (ms) every Hub opener sets so a
/// contended open/read/write RETRIES for up to this long instead of failing
/// IMMEDIATELY with `SQLITE_BUSY` (the `busy_timeout=0` default). Used uniformly
/// by both the writable ([`Db::open_hub`]) and read-only ([`Db::open_hub_readonly`])
/// Hub openers so no opener is left racing on a zero timeout.
pub const HUB_BUSY_TIMEOUT_MS: i64 = 5000;

/// The SHORT busy_timeout (ms) set on the connection BEFORE the one-time WAL flip.
///
/// `PRAGMA journal_mode = WAL` performs a one-time DELETE→WAL file conversion that
/// needs a brief EXCLUSIVE lock. EMPIRICALLY the flip HONORS whatever `busy_timeout`
/// is in effect WHEN IT RUNS (0ms ⇒ BUSY in ~20µs; 250ms ⇒ waits ~250ms then BUSY).
/// The earlier bug set `busy_timeout` only AFTER the flip, so the flip inherited
/// SQLite's ~5s compiled-in default and stalled the boot multi-seconds per attempt.
/// Setting a small timeout FIRST lets the flip absorb a transient contender quickly,
/// then the bounded outer retry covers a longer one — so the boot fails CLOSED
/// promptly instead of stalling. (The full [`HUB_BUSY_TIMEOUT_MS`] is RESTORED right
/// after the flip for the long-lived writer connection.)
const HUB_FLIP_BUSY_TIMEOUT_MS: i64 = 250;

/// Bounded retry budget for the writable Hub open (the one-time WAL flip).
///
/// If a peer holds a write txn LONGER than [`HUB_FLIP_BUSY_TIMEOUT_MS`] at the flip
/// instant, the flip still returns `SQLITE_BUSY`/`SQLITE_LOCKED`. Un-retried, that is
/// the WS-server `init_failed` boundary: the first post-deploy opener racing a
/// still-running writer ⇒ [`HubInitError::Storage`] ⇒ `ServerError::Init` ⇒ crash. So
/// the writable open is wrapped in a SHORT bounded retry that re-attempts ONLY a
/// busy/locked open. Once the file is in WAL, reopens are cheap no-ops that never
/// re-trigger the flip, so this budget is paid at most once per file lifetime. The
/// deploy procedure additionally mandates an UNCONTENDED first conversion, so this
/// retry is a belt-and-suspenders backstop, not the primary defense.
const HUB_OPEN_RETRY_ATTEMPTS: u32 = 5;

/// Backoff between writable-open retry attempts. Total worst-case added latency is
/// `(HUB_OPEN_RETRY_ATTEMPTS - 1) * HUB_OPEN_RETRY_BACKOFF` — kept small so a genuine
/// contender (a mid-write peer at the flip instant) clears without a perceptible
/// boot stall, while a never-clearing lock still fails closed promptly.
const HUB_OPEN_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_millis(200);

/// True iff `e` is a SQLite busy/locked failure — the ONLY class the writable-open
/// retry self-heals. Matched on the STRUCTURED `ErrorCode` (never the message string,
/// which is locale/version-fragile) so a real init error — `SchemaTooNew`, a migration
/// failure, an IO error — is NEVER masked as "retryable" and propagates immediately.
/// Reaches through the `StorageError::Sqlite` wrapper so a busy surfaced from the WAL
/// flip pragma OR from the migration write-txn is recognised identically.
fn is_storage_busy(e: &StorageError) -> bool {
    matches!(
        e,
        StorageError::Sqlite(rusqlite::Error::SqliteFailure(err, _))
            if matches!(err.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

/// Run a writable-Hub open closure with a SHORT bounded retry on SQLite busy/locked.
/// Each attempt re-runs `open` from scratch (a fresh `Connection` carries no partial
/// state, and the WAL flip is atomic — a BUSY means the conversion did NOT happen — so
/// a retry can never compound a half-converted file). Only the busy/locked case
/// retries: every other error propagates on the FIRST attempt with zero delay (never
/// mask a real init failure). After the final attempt the last busy error is returned
/// so the caller still fails closed.
fn open_hub_with_busy_retry(mut open: impl FnMut() -> Result<Db>) -> Result<Db> {
    let mut attempt: u32 = 0;
    loop {
        match open() {
            Ok(db) => return Ok(db),
            Err(e) if is_storage_busy(&e) && attempt + 1 < HUB_OPEN_RETRY_ATTEMPTS => {
                attempt += 1;
                std::thread::sleep(HUB_OPEN_RETRY_BACKOFF);
            }
            Err(e) => return Err(e),
        }
    }
}

impl Db {
    /// Open (and migrate) a Hub database — concurrency-safe.
    ///
    /// The `rust-hub.sqlite` Hub DB is opened CONCURRENTLY by multiple production
    /// processes (the agent-run WS server's [`crate::Db`]-holding runtime, the
    /// answer-readback bin opening it read-only, the resume/extract/workflow bins,
    /// the future scheduler daemon). With the SQLite default
    /// (`journal_mode=delete` + `busy_timeout=0`) a writer takes an exclusive lock
    /// that blocks all readers, and ANY contended open/read returns `SQLITE_BUSY`
    /// IMMEDIATELY (no retry) — which surfaced as the 503-after-billing readback
    /// failure and the WS-server `init_failed` crash-loop. So EVERY Hub opener is
    /// WAL + a non-zero busy timeout: this is just [`Db::open_hub_concurrent`].
    pub fn open_hub(path: &str) -> Result<Db> {
        Db::open_hub_concurrent(path)
    }

    /// Open (and migrate) a Hub database in WAL (shared-reader/single-writer)
    /// concurrent mode. This is the canonical Hub WRITABLE opener — [`Db::open_hub`]
    /// delegates here so EVERY production caller is uniformly concurrency-safe.
    ///
    /// On the connection it opens it sets:
    /// * `PRAGMA journal_mode = WAL` — so a second process (the answer-readback
    ///   bin, a read adapter) can read while the WS server writes, instead of being
    ///   blocked by the writer's exclusive rollback-journal lock;
    /// * `PRAGMA busy_timeout = `[`HUB_BUSY_TIMEOUT_MS`] — so a contended
    ///   open/write retries instead of failing immediately with `SQLITE_BUSY`.
    ///
    /// Both pragmas are set BEFORE `apply_migrations`, so the migration's own write
    /// txn also benefits (it never races another opener onto an immediate BUSY).
    ///
    /// FLIP CONTENTION — the one-time `journal_mode = WAL` conversion needs a brief
    /// EXCLUSIVE lock. It HONORS the `busy_timeout` in effect when it runs, so a SHORT
    /// timeout ([`HUB_FLIP_BUSY_TIMEOUT_MS`]) is set BEFORE the flip (and the full
    /// [`HUB_BUSY_TIMEOUT_MS`] RESTORED right after, for the long-lived writer). A peer
    /// that holds a write txn LONGER than that short timeout still BUSYs the flip, so
    /// the whole open is wrapped in a small bounded retry ([`open_hub_with_busy_retry`],
    /// [`HUB_OPEN_RETRY_ATTEMPTS`]) that re-attempts ONLY a busy/locked open. Once the
    /// file is WAL the flip is a no-op, so the retry budget is paid at most once per
    /// file lifetime. The deploy procedure additionally mandates an UNCONTENDED first
    /// conversion (stop all writers, then convert), so this retry is belt-and-suspenders,
    /// not the primary defense.
    ///
    /// `journal_mode = WAL` is a PERSISTENT file-mode change the instant a
    /// connection runs it on a file DB (it spawns the `-wal`/`-shm` sidecars); it
    /// is a no-op (`journal_mode` reads back `"memory"`) on an in-memory DB. The
    /// production `rust-hub.sqlite` is converted to WAL the first time any post-deploy
    /// opener runs — see the PR's deploy notes (backups must include the `-wal`/`-shm`
    /// sidecars or checkpoint first; an existing `-journal` is resolved by SQLite on the
    /// first WAL open).
    pub fn open_hub_concurrent(path: &str) -> Result<Db> {
        // BOUNDED RETRY on busy/locked: the one-time WAL flip below honors the SHORT
        // busy_timeout set just before it, but a peer holding the lock LONGER than that
        // still BUSYs the flip. Without a retry, the first post-deploy WS-server open
        // racing a still-running writer would crash with `init_failed` and never
        // self-heal. Each attempt opens a FRESH connection, so no partial state carries
        // across; once the file is WAL the flip is a no-op, so the budget is paid at
        // most once per file lifetime.
        open_hub_with_busy_retry(|| {
            let mut conn = Connection::open(path)?;
            conn.pragma_update(None, "foreign_keys", true)?;
            // CRITICAL ORDERING: set a SHORT busy_timeout BEFORE the WAL flip. The
            // `journal_mode = WAL` conversion HONORS the busy_timeout that is in effect
            // WHEN IT RUNS (empirically: 0ms ⇒ fail in ~20µs, 250ms ⇒ wait ~250ms). The
            // earlier bug set busy_timeout AFTER the flip, so the flip ran on SQLite's
            // ~5s compiled-in default and stalled the whole boot. A small pre-flip
            // timeout lets the flip wait briefly for a transient contender, then the
            // bounded outer retry ([`open_hub_with_busy_retry`]) covers a contender that
            // outlasts it — fast fail-closed instead of a multi-second per-attempt stall.
            conn.pragma_update(None, "busy_timeout", HUB_FLIP_BUSY_TIMEOUT_MS)?;
            // WAL is a no-op (returns "memory") on an in-memory DB; on a file DB it
            // converts the journal mode persistently.
            conn.pragma_update(None, "journal_mode", "WAL")?;
            // RESTORE the full per-connection busy_timeout for the LONG-LIVED writer
            // connection: this is the connection the WS-server runtime holds, and a
            // contended write/read on it must retry for up to HUB_BUSY_TIMEOUT_MS (the
            // original readback-503 fix) — not the short flip timeout. It is also set
            // BEFORE `apply_migrations` so the migrate write-txn gets the full timeout.
            conn.pragma_update(None, "busy_timeout", HUB_BUSY_TIMEOUT_MS)?;
            apply_migrations(
                &mut conn,
                path,
                &schema::hub_migrations(),
                "unit2-foundation",
            )?;
            Ok(Db {
                conn,
                path: path.to_string(),
                profile: Profile::Hub,
            })
        })
    }

    /// Open a Hub database for pure-read projections without applying migrations.
    ///
    /// GET/read-model adapters + the answer-readback bin use this so a projection
    /// route can never mutate an operator DB just because a caller asks. The DB must
    /// already be at the current Hub schema version; older/newer versions fail closed.
    ///
    /// CONCURRENCY: this read-only connection sets `PRAGMA busy_timeout =`
    /// [`HUB_BUSY_TIMEOUT_MS`] so a read CONTENDED by the writable WS-server
    /// connection RETRIES instead of failing immediately with `SQLITE_BUSY` (the bug
    /// the readback 503 rode). A read-only connection CANNOT change `journal_mode`,
    /// so it does not set WAL — but it reads a WAL-mode DB correctly (the writable
    /// opener already converted the file). It does still benefit from WAL: under WAL a
    /// reader does not block on the writer at all.
    pub fn open_hub_readonly(path: &str) -> Result<Db> {
        Db::open_readonly(path, Profile::Hub, &schema::hub_migrations())
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

    fn open_readonly(path: &str, profile: Profile, migrations: &[Migration]) -> Result<Db> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.pragma_update(None, "foreign_keys", true)?;
        // A read-only connection cannot change `journal_mode` (it reads a WAL-mode DB
        // fine), but it MUST set a non-zero busy_timeout so a read contended by the
        // writable WS-server connection RETRIES instead of returning `SQLITE_BUSY`
        // immediately (the readback-503 mechanism). `open_readonly` is reached ONLY via
        // the Hub `open_hub_readonly` opener, so this is the same Hub timeout as the
        // writable path — uniform across every Hub opener.
        conn.pragma_update(None, "busy_timeout", HUB_BUSY_TIMEOUT_MS)?;
        let disk_version = conn.query_row(
            "SELECT version FROM schema_version WHERE id = 1",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        let code_version = migrations.iter().map(|m| m.version).max().unwrap_or(0);
        if disk_version > code_version {
            return Err(StorageError::SchemaTooNew {
                disk: disk_version,
                code: code_version,
            });
        }
        if disk_version < code_version {
            return Err(StorageError::Unsupported(format!(
                "database schema is older than this Friday build: disk version {disk_version}, code version {code_version}"
            )));
        }
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

    /// (C2) RUN-SCOPED token-ledger read: every billable model call attributed to `run_id`,
    /// oldest-first. The loop biller (`bill_model_call`) stamps the owning run into the
    /// ledger's `session_id` column (a loop run has no separate session; the run id IS the
    /// attribution key), so filtering on `session_id = ?` returns exactly THIS run's rows —
    /// N turns ⇒ N rows. Surfaces `base_url_host` + `ledger_id` (which the UI-facing
    /// [`Db::list_token_usage`] omits) so the routed provider-parity proof can assert, per
    /// flow, that a Claude turn was billed to `provider_kind="anthropic"` /
    /// `api.anthropic.com` — never mis-attributed. An empty result is honest (no model call
    /// was billed for that run), never a fabricated row.
    pub fn list_run_token_usage(&self, run_id: &str) -> Result<Vec<RunTokenUsageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT ledger_id, provider_kind, model, base_url_host, prompt_tokens, \
                    completion_tokens, total_tokens, fallback, created_at
             FROM token_ledger WHERE session_id = ?1 ORDER BY created_at, ledger_id",
        )?;
        let rows = stmt.query_map([run_id], |r| {
            Ok(RunTokenUsageRow {
                ledger_id: r.get(0)?,
                provider_kind: r.get(1)?,
                model: r.get(2)?,
                base_url_host: r.get(3)?,
                prompt_tokens: r.get(4)?,
                completion_tokens: r.get(5)?,
                total_tokens: r.get(6)?,
                fallback: r.get::<_, i64>(7)? != 0,
                created_at: r.get(8)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub fn upsert_provider_session_link(&self, link: &ProviderSessionLink) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "provider session links are Hub-only".into(),
            ));
        }
        provider_session::upsert_link(&self.conn, link)
    }

    pub fn get_provider_session_link(
        &self,
        friday_session_id: &str,
    ) -> Result<Option<ProviderSessionLink>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "provider session links are Hub-only".into(),
            ));
        }
        provider_session::get_link(&self.conn, friday_session_id)
    }

    pub fn list_provider_session_projections(&self) -> Result<Vec<ProviderSessionProjection>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "provider session projections are Hub-only".into(),
            ));
        }
        provider_session::list_projections(&self.conn)
    }

    pub fn append_provider_session_event(&self, event: &ProviderSessionEvent) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "provider session events are Hub-only".into(),
            ));
        }
        provider_session::append_event(&self.conn, event)
    }

    pub fn list_provider_session_events(
        &self,
        friday_session_id: &str,
    ) -> Result<Vec<ProviderSessionEvent>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "provider session events are Hub-only".into(),
            ));
        }
        provider_session::list_events(&self.conn, friday_session_id)
    }

    pub fn upsert_friday_conversation(&self, conversation: &FridayConversation) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Friday conversations are Hub-only".into(),
            ));
        }
        mission::upsert_conversation(&self.conn, conversation)
    }

    pub fn get_friday_conversation(
        &self,
        friday_conversation_id: &str,
    ) -> Result<Option<FridayConversation>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Friday conversations are Hub-only".into(),
            ));
        }
        mission::get_conversation(&self.conn, friday_conversation_id)
    }

    pub fn upsert_mission(&self, item: &Mission) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("Missions are Hub-only".into()));
        }
        mission::upsert_mission(&self.conn, item)
    }

    pub fn get_mission(&self, mission_id: &str) -> Result<Option<Mission>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("Missions are Hub-only".into()));
        }
        mission::get_mission(&self.conn, mission_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition_mission_status(
        &self,
        friday_conversation_id: &str,
        mission_id: &str,
        next_status: friday_core::MissionStatus,
        actor_ref: &str,
        reason: &str,
        proof_ref: Option<&str>,
        merged_into_mission_id: Option<&str>,
        now_ms: i64,
    ) -> Result<(Mission, friday_core::MissionStatus, Vec<String>)> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("Missions are Hub-only".into()));
        }
        mission::transition_mission_status(
            &self.conn,
            friday_conversation_id,
            mission_id,
            next_status,
            actor_ref,
            reason,
            proof_ref,
            merged_into_mission_id,
            now_ms,
        )
    }

    pub fn list_missions_for_conversation(
        &self,
        friday_conversation_id: &str,
    ) -> Result<Vec<Mission>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("Missions are Hub-only".into()));
        }
        mission::list_missions_for_conversation(&self.conn, friday_conversation_id)
    }

    pub fn list_active_missions(&self) -> Result<Vec<Mission>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("Missions are Hub-only".into()));
        }
        mission::list_active_missions(&self.conn)
    }

    pub fn find_duplicate_mission(&self, candidate: &Mission) -> Result<Option<Mission>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("Missions are Hub-only".into()));
        }
        mission::find_duplicate_mission(&self.conn, candidate)
    }

    pub fn upsert_work_item(&self, item: &WorkItem) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("WorkItems are Hub-only".into()));
        }
        mission::upsert_work_item(&self.conn, item)
    }

    pub fn get_work_item(&self, work_item_id: &str) -> Result<Option<WorkItem>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("WorkItems are Hub-only".into()));
        }
        mission::get_work_item(&self.conn, work_item_id)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn transition_work_item_status(
        &self,
        work_item_id: &str,
        next_status: friday_core::WorkItemStatus,
        actor_ref: &str,
        reason: &str,
        proof_receipt: Option<&str>,
        now_ms: i64,
    ) -> Result<(WorkItem, friday_core::WorkItemStatus)> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("WorkItems are Hub-only".into()));
        }
        mission::transition_work_item_status(
            &self.conn,
            work_item_id,
            next_status,
            actor_ref,
            reason,
            proof_receipt,
            now_ms,
        )
    }

    pub fn list_work_items_for_mission(&self, mission_id: &str) -> Result<Vec<WorkItem>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("WorkItems are Hub-only".into()));
        }
        mission::list_work_items_for_mission(&self.conn, mission_id)
    }

    pub fn list_active_work_items(&self) -> Result<Vec<WorkItem>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("WorkItems are Hub-only".into()));
        }
        mission::list_active_work_items(&self.conn)
    }

    pub fn find_duplicate_work_item(&self, candidate: &WorkItem) -> Result<Option<WorkItem>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported("WorkItems are Hub-only".into()));
        }
        mission::find_duplicate_work_item(&self.conn, candidate)
    }

    pub fn upsert_context_passport(&self, passport: &ContextPassport) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Context Passports are Hub-only".into(),
            ));
        }
        passport::upsert_context_passport(&self.conn, passport)
    }

    pub fn get_context_passport(&self, passport_id: &str) -> Result<Option<ContextPassport>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Context Passports are Hub-only".into(),
            ));
        }
        passport::get_context_passport(&self.conn, passport_id)
    }

    pub fn list_context_passports_for_mission(
        &self,
        mission_id: &str,
    ) -> Result<Vec<ContextPassport>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Context Passports are Hub-only".into(),
            ));
        }
        passport::list_for_mission(&self.conn, mission_id)
    }

    pub fn upsert_surface_thread(&self, surface_thread: &SurfaceThread) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "SurfaceThread records are Hub-only".into(),
            ));
        }
        mission::upsert_surface_thread(&self.conn, surface_thread)
    }

    pub fn get_surface_thread(&self, surface_thread_id: &str) -> Result<Option<SurfaceThread>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "SurfaceThread records are Hub-only".into(),
            ));
        }
        mission::get_surface_thread(&self.conn, surface_thread_id)
    }

    pub fn list_surface_threads_for_mission(&self, mission_id: &str) -> Result<Vec<SurfaceThread>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "SurfaceThread records are Hub-only".into(),
            ));
        }
        mission::list_surface_threads_for_mission(&self.conn, mission_id)
    }

    pub fn upsert_surface_event(&self, event: &SurfaceEvent) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "SurfaceEvent records are Hub-only".into(),
            ));
        }
        mission::upsert_surface_event(&self.conn, event)
    }

    pub fn list_surface_events_for_mission(&self, mission_id: &str) -> Result<Vec<SurfaceEvent>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "SurfaceEvent records are Hub-only".into(),
            ));
        }
        mission::list_surface_events_for_mission(&self.conn, mission_id)
    }

    pub fn list_surface_events_for_conversation(
        &self,
        friday_conversation_id: &str,
    ) -> Result<Vec<SurfaceEvent>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "SurfaceEvent records are Hub-only".into(),
            ));
        }
        mission::list_surface_events_for_conversation(&self.conn, friday_conversation_id)
    }

    pub fn upsert_mission_link(&self, link: &MissionLink) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Mission links are Hub-only".into(),
            ));
        }
        mission::upsert_mission_link(&self.conn, link)
    }

    pub fn list_mission_links(&self, mission_id: &str) -> Result<Vec<MissionLink>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Mission links are Hub-only".into(),
            ));
        }
        mission::list_mission_links(&self.conn, mission_id)
    }

    /// Resolve the SINGLE `provider_timeline` [`MissionLink`] whose `target_ref` encodes EXACTLY
    /// this `run_id` as its trailing `#`-segment (the agent-loop pause-time binding). The run's OWN
    /// binding — carries the bound `mission_id` + `work_item_id` directly — so a resume-completion
    /// leg never trusts a wire-supplied work_item_id. Fail-closed (`Ok(None)`) on zero or ambiguous
    /// (>1) matches. See [`mission::find_provider_timeline_link_by_run_id`].
    pub fn find_provider_timeline_link_by_run_id(
        &self,
        run_id: &str,
    ) -> Result<Option<MissionLink>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Mission links are Hub-only".into(),
            ));
        }
        mission::find_provider_timeline_link_by_run_id(&self.conn, run_id)
    }

    pub fn upsert_route_decision(&self, card: &RouteDecisionCard) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Route decisions are Hub-only".into(),
            ));
        }
        mission::upsert_route_decision(&self.conn, card)
    }

    pub fn get_route_decision(&self, decision_id: &str) -> Result<Option<RouteDecisionCard>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Route decisions are Hub-only".into(),
            ));
        }
        mission::get_route_decision(&self.conn, decision_id)
    }

    pub fn list_route_decisions_for_mission(
        &self,
        mission_id: &str,
    ) -> Result<Vec<RouteDecisionCard>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Route decisions are Hub-only".into(),
            ));
        }
        mission::list_route_decisions_for_mission(&self.conn, mission_id)
    }

    pub fn list_route_decision_projections_for_mission(
        &self,
        mission_id: &str,
    ) -> Result<Vec<RouteDecisionProjection>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Route decision projections are Hub-only".into(),
            ));
        }
        mission::list_route_decision_projections_for_mission(&self.conn, mission_id)
    }

    pub fn list_mission_surface_projections(
        &self,
        friday_conversation_id: &str,
    ) -> Result<Vec<MissionSurfaceProjection>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Mission surface projections are Hub-only".into(),
            ));
        }
        mission::list_mission_surface_projections(&self.conn, friday_conversation_id)
    }

    pub fn upsert_workspace_claim(&self, claim: &WorkspaceClaim) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Workspace claims are Hub-only".into(),
            ));
        }
        process_registry::upsert_workspace_claim(&self.conn, claim)
    }

    pub fn get_workspace_claim(&self, claim_id: &str) -> Result<Option<WorkspaceClaim>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Workspace claims are Hub-only".into(),
            ));
        }
        process_registry::get_workspace_claim(&self.conn, claim_id)
    }

    pub fn list_active_workspace_claims(&self) -> Result<Vec<WorkspaceClaim>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Workspace claims are Hub-only".into(),
            ));
        }
        process_registry::list_active_workspace_claims(&self.conn)
    }

    pub fn find_active_workspace_conflict(
        &self,
        workspace_ref: &str,
    ) -> Result<Option<WorkspaceClaim>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Workspace claims are Hub-only".into(),
            ));
        }
        process_registry::find_active_workspace_conflict(&self.conn, workspace_ref)
    }

    pub fn upsert_process_lease(&self, lease: &ProcessLease) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process leases are Hub-only".into(),
            ));
        }
        process_registry::upsert_process_lease(&self.conn, lease)
    }

    pub fn get_process_lease(&self, lease_id: &str) -> Result<Option<ProcessLease>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process leases are Hub-only".into(),
            ));
        }
        process_registry::get_process_lease(&self.conn, lease_id)
    }

    pub fn list_active_process_leases(&self) -> Result<Vec<ProcessLease>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process leases are Hub-only".into(),
            ));
        }
        process_registry::list_active_process_leases(&self.conn)
    }

    pub fn find_active_port_conflict(&self, port_binding: &str) -> Result<Option<ProcessLease>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process leases are Hub-only".into(),
            ));
        }
        process_registry::find_active_port_conflict(&self.conn, port_binding)
    }

    pub fn upsert_process_observation(&self, observation: &ProcessObservation) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process observations are Hub-only".into(),
            ));
        }
        process_registry::upsert_process_observation(&self.conn, observation)
    }

    pub fn get_process_observation(
        &self,
        observation_id: &str,
    ) -> Result<Option<ProcessObservation>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process observations are Hub-only".into(),
            ));
        }
        process_registry::get_process_observation(&self.conn, observation_id)
    }

    pub fn list_process_observations(&self) -> Result<Vec<ProcessObservation>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "Process observations are Hub-only".into(),
            ));
        }
        process_registry::list_process_observations(&self.conn)
    }

    pub fn list_trusted_device_projections(&self) -> Result<Vec<TrustedDeviceProjection>> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "trusted device projections are Hub-only".into(),
            ));
        }
        pairing::list_trusted_device_projections(&self.conn)
    }

    pub fn complete_qr_pairing(
        &mut self,
        payload: &FridayPairPayload,
        device_id: &str,
        device_pubkey: &[u8],
        pairing_proof: &[u8],
        paired_at: i64,
        audit_id: &str,
    ) -> Result<()> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "QR pairing completion is Hub-only".into(),
            ));
        }
        payload.validate_at(paired_at)?;
        pairing::pair_device(
            &mut self.conn,
            payload.pairing_secret.expose_for_qr().as_bytes(),
            device_id,
            device_pubkey,
            pairing_proof,
            paired_at,
            audit_id,
        )
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
        // No run attribution on the raw single-row insert (the run-scoped loop path is
        // `record_run_model_call`); the row's `run_id` is NULL.
        insert_token_ledger_conn(&self.conn, e, None)?;
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
        // Ask path: DB-wide ledger row (no owning run) — `run_id` is NULL.
        insert_token_ledger_conn(&tx, entry, None)?;
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

    /// Atomically record a Hub EVENT: one `activity_item` + one hash-chained `audit_ledger`
    /// row in a single transaction (Hub-only). IDEMPOTENT on `activity.activity_id` (the
    /// PK): a replay (same id) writes NOTHING — no second activity AND no second audit —
    /// and returns [`RecordEventOutcome::Duplicate`]. A genuine storage error is never
    /// misread as a duplicate: ONLY a UNIQUE-constraint violation maps to `Duplicate`.
    pub fn record_event(
        &mut self,
        activity: &ActivityRow,
        audit: &AuditEvent,
    ) -> Result<RecordEventOutcome> {
        if self.profile != Profile::Hub {
            return Err(StorageError::Unsupported(
                "record_event requires the Hub profile (audit_ledger is Hub-only)".into(),
            ));
        }
        let tx = self.conn.transaction()?;
        match insert_activity_conn(&tx, activity) {
            Ok(()) => {}
            // ONLY a UNIQUE-constraint violation on the activity_id PK is a benign replay.
            Err(rusqlite::Error::SqliteFailure(e, _))
                if e.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                // Drop the tx (rollback): no activity row, and crucially NO audit row.
                return Ok(RecordEventOutcome::Duplicate);
            }
            // Any other storage error is surfaced, never misclassified as a duplicate.
            Err(e) => return Err(e.into()),
        }
        audit::append_audit(
            &tx,
            &audit.audit_id,
            &audit.actor,
            &audit.action,
            audit.payload_ref.as_deref(),
            audit.created_at,
        )?;
        tx.commit()?;
        Ok(RecordEventOutcome::Recorded)
    }
}

/// Atomic write performed by ONE agent-loop model call — the run-attributed sibling of
/// [`Db::record_model_call`] (the ask path). Writes a `token_ledger` row (with the owning
/// `run_id`, S1.2 attribution), an `activity_item` receipt, and a hash-chained
/// `audit_ledger` event in ONE transaction; if any insert fails, none persist (gate 21
/// §2.3), so the loop can never half-bill a turn.
///
/// It takes a bare `&Connection` (not `&mut Db`) because the agent loop holds the Hub
/// connection by shared reference — so it opens an `unchecked_transaction` (the same
/// mechanism `run_loop`'s receipt writes already use). Reuses the SAME insert chokepoints
/// as the ask path (`insert_token_ledger_conn`/`insert_activity_conn`/`append_audit`), so
/// the loop's billing can never drift from the single-shot path's invariants
/// (total==prompt+completion, non-negative tokens, the audit hash chain).
///
/// Hub-only: `audit_ledger` does not exist on a phone, so a phone connection fails closed
/// on the audit insert. The agent loop runs only on a Hub DB by construction.
pub fn record_run_model_call(
    conn: &Connection,
    run_id: &str,
    entry: &LedgerEntry,
    activity: &ActivityRow,
    audit: &AuditEvent,
) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    insert_token_ledger_conn(&tx, entry, Some(run_id))?;
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

fn insert_token_ledger_conn(
    conn: &Connection,
    e: &LedgerEntry,
    run_id: Option<&str>,
) -> Result<()> {
    // Persistence-boundary invariant (audit 10A Q3 / finding 3c): REJECT any row whose
    // `total_tokens` is not exactly `prompt_tokens + completion_tokens`. The
    // `LedgerEntry` constructors already recompute the total, but the struct has `pub`
    // fields — a struct-literal / future writer could mint a divergent row. Enforcing
    // it HERE, at the single insert chokepoint used by both `insert_token_ledger` and
    // `record_model_call`, makes "ledger total == prompt + completion" a property no
    // writer can bypass, regardless of how the entry was constructed. (`fallback` is a
    // `bool`, already constrained to {0,1} by type.)
    //
    // Non-negativity (Reviewer audit-10A-Q3): negative token counts sum-consistently
    // (e.g. prompt=-100, completion=50, total=-50) and would slip past a `total==sum`
    // check while corrupting every downstream cost/usage projection. The `LedgerEntry`
    // constructor rejects negatives; mirror that at the persistence boundary so a
    // struct-literal writer cannot persist a sign-garbage row either.
    if e.prompt_tokens < 0 || e.completion_tokens < 0 {
        return Err(StorageError::Unsupported(format!(
            "token_ledger invariant: negative token count (prompt={}, completion={})",
            e.prompt_tokens, e.completion_tokens
        )));
    }
    let expected = e
        .prompt_tokens
        .checked_add(e.completion_tokens)
        .ok_or_else(|| {
            StorageError::Unsupported(format!(
                "token_ledger invariant: prompt+completion overflow ({} + {})",
                e.prompt_tokens, e.completion_tokens
            ))
        })?;
    if e.total_tokens != expected {
        return Err(StorageError::Unsupported(format!(
            "token_ledger invariant violated: total_tokens={} != prompt+completion={}",
            e.total_tokens, expected
        )));
    }
    // A negative or non-finite cost corrupts the same downstream cost projections this
    // boundary protects (Reviewer audit-10A-Q3 follow-up). Reject it here too.
    if let Some(cost) = e.cost_estimate {
        if cost < 0.0 || !cost.is_finite() {
            return Err(StorageError::Unsupported(format!(
                "token_ledger invariant: invalid cost_estimate ({cost})"
            )));
        }
    }
    conn.execute(
        "INSERT INTO token_ledger
            (ledger_id, session_id, activity_id, provider_kind, model, base_url_host,
             prompt_tokens, completion_tokens, total_tokens, cost_estimate, fallback,
             result_link, created_at, run_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
            e.created_at,
            run_id
        ],
    )?;
    Ok(())
}

pub(crate) fn insert_activity_conn(conn: &Connection, a: &ActivityRow) -> rusqlite::Result<()> {
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

#[cfg(test)]
mod busy_retry_tests {
    use super::{
        is_storage_busy, now_ms, open_hub_with_busy_retry, Db, Profile, StorageError,
        HUB_OPEN_RETRY_ATTEMPTS,
    };
    use std::cell::Cell;

    /// Build a synthetic busy/locked `StorageError` exactly as a contended SQLite open
    /// surfaces one — the structured `SqliteFailure(DatabaseBusy/LOCKED)` the retry must
    /// recognise (NOT a message-string match).
    fn busy_storage_error(code: i32) -> StorageError {
        StorageError::Sqlite(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(code),
            Some("database is locked".to_string()),
        ))
    }

    /// The predicate catches BOTH busy and locked on the structured code, and rejects a
    /// non-busy SQLite error AND a non-Sqlite StorageError — so the retry can never mask
    /// a real init failure (`SchemaTooNew`, IO, migration) as "retryable".
    #[test]
    fn predicate_matches_only_busy_or_locked() {
        assert!(is_storage_busy(&busy_storage_error(
            rusqlite::ffi::SQLITE_BUSY
        )));
        assert!(is_storage_busy(&busy_storage_error(
            rusqlite::ffi::SQLITE_LOCKED
        )));
        // A different SQLite failure (e.g. SQLITE_CORRUPT) is NOT retryable.
        assert!(!is_storage_busy(&busy_storage_error(
            rusqlite::ffi::SQLITE_CORRUPT
        )));
        // A non-Sqlite StorageError is NOT retryable (real init failure → propagate).
        assert!(!is_storage_busy(&StorageError::SchemaTooNew {
            disk: 99,
            code: 1
        }));
    }

    /// The loop retries a busy open and SUCCEEDS once the contender clears — modeled
    /// deterministically with an injected closure that is busy `attempts-1` times then
    /// returns Ok (no threads, no real DB).
    #[test]
    fn retries_busy_then_succeeds() {
        // A real on-disk Hub DB stands in for the recovered open (WAL/the backup guard
        // both need a file path — an in-memory DB is rejected by the destructive-backup
        // guard, so it can't model a successful Hub open).
        let mut path = std::env::temp_dir();
        path.push(format!(
            "friday-busy-retry-{}-{}.sqlite",
            std::process::id(),
            now_ms()
        ));
        let path_str = path.to_string_lossy().to_string();

        let calls = Cell::new(0u32);
        let busy_before_success = HUB_OPEN_RETRY_ATTEMPTS - 1;
        let db = open_hub_with_busy_retry(|| {
            let n = calls.get();
            calls.set(n + 1);
            if n < busy_before_success {
                Err(busy_storage_error(rusqlite::ffi::SQLITE_BUSY))
            } else {
                Db::open_hub_concurrent(&path_str)
            }
        })
        .expect("a busy open that later clears must succeed");
        assert_eq!(db.profile, Profile::Hub);
        assert_eq!(
            calls.get(),
            HUB_OPEN_RETRY_ATTEMPTS,
            "must attempt exactly the full budget when busy clears on the last try"
        );

        drop(db);
        let _ = std::fs::remove_file(&path_str);
        let _ = std::fs::remove_file(format!("{path_str}-wal"));
        let _ = std::fs::remove_file(format!("{path_str}-shm"));
    }

    /// A never-clearing busy open EXHAUSTS the bounded budget and FAILS CLOSED with the
    /// last busy error (no infinite loop) — the boundary that keeps `init_failed`
    /// deterministic rather than a hang.
    #[test]
    fn exhausts_budget_and_fails_closed_when_busy_never_clears() {
        let calls = Cell::new(0u32);
        let result = open_hub_with_busy_retry(|| {
            calls.set(calls.get() + 1);
            Err::<Db, _>(busy_storage_error(rusqlite::ffi::SQLITE_BUSY))
        });
        // `Db` is not `Debug`, so match instead of `expect_err`.
        let err = match result {
            Ok(_) => panic!("a never-clearing busy open must fail closed, not loop forever"),
            Err(e) => e,
        };
        assert!(
            is_storage_busy(&err),
            "the surfaced error stays the busy error"
        );
        assert_eq!(
            calls.get(),
            HUB_OPEN_RETRY_ATTEMPTS,
            "must attempt exactly the bounded budget, no more"
        );
    }

    /// A non-busy error propagates on the FIRST attempt with NO retry — proving a real
    /// init failure is never delayed or masked.
    #[test]
    fn non_busy_error_propagates_immediately_without_retry() {
        let calls = Cell::new(0u32);
        let result = open_hub_with_busy_retry(|| {
            calls.set(calls.get() + 1);
            Err::<Db, _>(StorageError::SchemaTooNew { disk: 99, code: 1 })
        });
        let err = match result {
            Ok(_) => panic!("a non-busy error must propagate"),
            Err(e) => e,
        };
        assert!(matches!(err, StorageError::SchemaTooNew { .. }));
        assert_eq!(calls.get(), 1, "a non-busy error must NOT be retried");
    }
}

#[cfg(test)]
mod run_token_usage_tests {
    use super::Db;

    fn tmp(tag: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "friday-run-token-usage-{}-{}-{tag}.sqlite",
            std::process::id(),
            super::now_ms()
        ));
        p.to_string_lossy().into_owned()
    }

    /// (C2) `list_run_token_usage(run_id)` returns EXACTLY the rows whose ledger `session_id`
    /// equals the run id (the loop biller stamps the run there), surfacing `base_url_host` so a
    /// Claude row's `api.anthropic.com` is verifiable — and it ISOLATES one run from another
    /// (an unrelated run's rows never leak in). An unknown run returns empty (honest, no
    /// fabricated row).
    #[test]
    fn list_run_token_usage_is_run_scoped_and_surfaces_host() {
        let db = Db::open_hub(&tmp("scoped")).unwrap();

        // Run A: one Anthropic turn (the C2 Claude leg) + one DeepSeek turn.
        db.insert_token_ledger(
            &friday_core::LedgerEntry::anthropic_route(
                "runA:t0:ledger",
                "runA",
                "runA:t0:askreceipt",
                "claude-opus-4-8",
                11,
                8,
                None,
                None,
                10,
            )
            .unwrap(),
        )
        .unwrap();
        db.insert_token_ledger(
            &friday_core::LedgerEntry::friday_route(
                "runA:t1:ledger",
                "runA",
                "runA:t1:askreceipt",
                "deepseek-v4-flash",
                5,
                3,
                None,
                None,
                20,
            )
            .unwrap(),
        )
        .unwrap();
        // Run B: a DIFFERENT run — must never leak into run A's scoped read.
        db.insert_token_ledger(
            &friday_core::LedgerEntry::anthropic_route(
                "runB:t0:ledger",
                "runB",
                "runB:t0:askreceipt",
                "claude-opus-4-8",
                7,
                2,
                None,
                None,
                30,
            )
            .unwrap(),
        )
        .unwrap();

        let a = db.list_run_token_usage("runA").unwrap();
        assert_eq!(a.len(), 2, "run A's two rows, oldest-first, no run-B leak");
        assert_eq!(a[0].provider_kind, "anthropic");
        assert_eq!(a[0].base_url_host, "api.anthropic.com");
        assert_eq!(a[0].model, "claude-opus-4-8");
        assert_eq!(a[0].total_tokens, 19, "11 + 8");
        assert!(!a[0].fallback);
        assert_eq!(a[1].provider_kind, "deepseek");
        assert_eq!(a[1].base_url_host, "api.deepseek.com");

        let b = db.list_run_token_usage("runB").unwrap();
        assert_eq!(b.len(), 1, "run B isolated from run A");
        assert_eq!(b[0].provider_kind, "anthropic");

        assert!(
            db.list_run_token_usage("no-such-run").unwrap().is_empty(),
            "an unknown run is empty, never a fabricated row"
        );
    }
}
