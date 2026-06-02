//! Foundation schema + migration sets (gate 21 §2.1).
//!
//! Two profiles. **Location = which process the table physically exists in.**
//! The phone profile OMITS the secret-/sensitive-bearing tables entirely
//! (`trusted_device`, `audit_ledger`, `memory_item`), so "what is never on the
//! phone" is partly enforced by those tables simply not existing there
//! (gate 21 §2 / §3). No table in *either* profile stores a provider secret —
//! provider creds live only on the Hub via OS secure storage, never in SQLite.

use crate::migrate::Migration;
use rusqlite::Transaction;

/// Tables present only on the Hub (never created on a phone). Workflow runs are
/// Hub-coordinated (gate 21 §9 / `08`), so they are Hub-only too.
pub const HUB_ONLY_TABLES: &[&str] = &[
    "trusted_device",
    "audit_ledger",
    "memory_item",
    "workflow_run",
    "workflow_step",
    "consumed_approval",
];

/// Tables present only on a phone (never created on the Hub).
pub const PHONE_ONLY_TABLES: &[&str] = &["offline_queue"];

pub fn hub_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            name: "init_hub",
            destructive: false,
            up: m0001_init_hub,
        },
        // Unit 9: workflow runs + steps (additive forward migration over v1).
        Migration {
            version: 2,
            name: "workflow",
            destructive: false,
            up: m0002_workflow,
        },
        // Unit 10: memory lifecycle `state` column (additive; backfills existing
        // confirmed rows so a confirmed memory is never silently demoted).
        Migration {
            version: 3,
            name: "memory_state",
            destructive: false,
            up: m0003_memory_state,
        },
        // PR-3b: single-use canonical-approval replay store (additive). The
        // `use_key` PRIMARY KEY makes a replayed approval an INSERT uniqueness
        // violation — double-spend is unrepresentable, not a check-then-consume race.
        Migration {
            version: 4,
            name: "consumed_approval",
            destructive: false,
            up: m0004_consumed_approval,
        },
    ]
}

pub fn phone_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        name: "init_phone",
        destructive: false,
        up: m0001_init_phone,
    }]
}

// --- shared table fragments -------------------------------------------------

const DDL_DEVICE_IDENTITY: &str = "
CREATE TABLE device_identity (
    device_id    TEXT PRIMARY KEY,
    role         TEXT NOT NULL,
    public_key   BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    display_name TEXT NOT NULL DEFAULT ''
);";

const DDL_SESSION: &str = "
CREATE TABLE session (
    session_id TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    source     TEXT NOT NULL DEFAULT 'mac_live'
);
CREATE INDEX idx_session_updated ON session(updated_at);";

const DDL_ACTIVITY_ITEM: &str = "
CREATE TABLE activity_item (
    activity_id TEXT PRIMARY KEY,
    session_id  TEXT,
    type        TEXT NOT NULL,
    state       TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    deep_link   TEXT
);
CREATE INDEX idx_activity_state_updated ON activity_item(state, updated_at);
CREATE INDEX idx_activity_session ON activity_item(session_id);";

const DDL_TOKEN_LEDGER: &str = "
CREATE TABLE token_ledger (
    ledger_id        TEXT PRIMARY KEY,
    session_id       TEXT,
    activity_id      TEXT,
    provider_kind    TEXT NOT NULL,
    model            TEXT NOT NULL,
    base_url_host    TEXT NOT NULL,
    prompt_tokens    INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    total_tokens     INTEGER NOT NULL,
    cost_estimate    REAL,
    fallback         INTEGER NOT NULL,
    result_link      TEXT,
    created_at       INTEGER NOT NULL
);
CREATE INDEX idx_ledger_session_created ON token_ledger(session_id, created_at);
CREATE INDEX idx_ledger_created ON token_ledger(created_at);";

const DDL_BLOB: &str = "
CREATE TABLE blob_index (
    blob_id       TEXT PRIMARY KEY,
    kind          TEXT NOT NULL,
    enc_alg       TEXT NOT NULL,
    nonce         BLOB NOT NULL,
    size          INTEGER NOT NULL,
    access_policy TEXT NOT NULL DEFAULT 'hub_only',
    created_at    INTEGER NOT NULL,
    path_or_ref   TEXT
);
CREATE INDEX idx_blob_kind ON blob_index(kind);
-- SQLite-backed ciphertext store (foundation backend; the index above holds
-- metadata + access policy only, gate 21 §2.1).
CREATE TABLE blob_store (
    blob_id    TEXT PRIMARY KEY,
    ciphertext BLOB NOT NULL
);";

// --- Hub-only fragments -----------------------------------------------------

const DDL_TRUSTED_DEVICE: &str = "
CREATE TABLE trusted_device (
    device_id      TEXT PRIMARY KEY,
    public_key     BLOB NOT NULL,
    paired_at      INTEGER NOT NULL,
    revoked_at     INTEGER,
    key_rotated_at INTEGER,
    sealed_key_ref TEXT,            -- OS-secure-storage key id; never plaintext
    label          TEXT NOT NULL DEFAULT ''
);";

const DDL_AUDIT_LEDGER: &str = "
CREATE TABLE audit_ledger (
    audit_id    TEXT PRIMARY KEY,
    prev_hash   BLOB NOT NULL,
    entry_hash  BLOB NOT NULL,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    payload_ref TEXT,
    created_at  INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_ledger(created_at);";

const DDL_MEMORY_ITEM: &str = "
CREATE TABLE memory_item (
    memory_id    TEXT PRIMARY KEY,
    scope        TEXT NOT NULL,
    content_ref  TEXT,
    confidence   TEXT,
    created_at   INTEGER NOT NULL,
    confirmed_at INTEGER
);";

// --- phone-only fragments ---------------------------------------------------

const DDL_OFFLINE_QUEUE: &str = "
CREATE TABLE offline_queue (
    queue_id           TEXT PRIMARY KEY,
    action_kind        TEXT NOT NULL,
    payload_ref        TEXT,
    msg_id             TEXT NOT NULL,
    approval_scope_ref TEXT,
    state              TEXT NOT NULL,
    created_at         INTEGER NOT NULL
);
CREATE INDEX idx_offline_state_created ON offline_queue(state, created_at);";

// --- Unit-9 workflow fragments (Hub-only) -----------------------------------

const DDL_WORKFLOW: &str = "
CREATE TABLE workflow_run (
    run_id     TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    state      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX idx_workflow_run_state ON workflow_run(state, updated_at);
CREATE TABLE workflow_step (
    step_id         TEXT PRIMARY KEY,
    run_id          TEXT NOT NULL,
    seq             INTEGER NOT NULL,
    has_side_effect INTEGER NOT NULL,
    status          TEXT NOT NULL,
    evidence_ref    TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_workflow_step_run ON workflow_step(run_id, seq);";

// --- migration bodies -------------------------------------------------------

fn m0001_init_hub(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_DEVICE_IDENTITY)?;
    tx.execute_batch(DDL_TRUSTED_DEVICE)?;
    tx.execute_batch(DDL_SESSION)?;
    tx.execute_batch(DDL_ACTIVITY_ITEM)?;
    tx.execute_batch(DDL_TOKEN_LEDGER)?;
    tx.execute_batch(DDL_AUDIT_LEDGER)?;
    tx.execute_batch(DDL_MEMORY_ITEM)?;
    tx.execute_batch(DDL_BLOB)?;
    Ok(())
}

fn m0001_init_phone(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_DEVICE_IDENTITY)?;
    tx.execute_batch(DDL_SESSION)?;
    tx.execute_batch(DDL_ACTIVITY_ITEM)?;
    tx.execute_batch(DDL_TOKEN_LEDGER)?;
    tx.execute_batch(DDL_OFFLINE_QUEUE)?;
    tx.execute_batch(DDL_BLOB)?;
    Ok(())
}

// Unit 9: additive forward migration (v1 -> v2) adding the Hub workflow tables.
fn m0002_workflow(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(DDL_WORKFLOW)?;
    Ok(())
}

// Unit 10: additive forward migration (v2 -> v3) adding the memory lifecycle
// `state` column. SQLite `ADD COLUMN ... DEFAULT 'candidate'` sets EVERY existing
// row to the default, so we backfill in the SAME transaction — otherwise an
// already-confirmed memory (`confirmed_at` set) would be silently demoted to a
// candidate (a data-correctness regression). `confirmed_at` is the authoritative
// pre-migration signal of "the user confirmed this".
//
// The migration is the ONLY writer of these columns besides the typed repo, so it
// must uphold the same `(confidence, state)` consistency the repo guarantees —
// otherwise it could mint the very divergent pair the repo makes unrepresentable
// (`memory_item` has existed since v1 with a nullable, repo-unenforced
// `confidence`). So we also normalize `confidence`: a confirmed row gets
// `confidence='confirmed'`; a non-confirmed row never keeps a `confirmed` (or
// NULL) confidence. Post-migration: `confidence='confirmed'` IFF
// `state='confirmed'` IFF `confirmed_at IS NOT NULL`, and `confidence` is never NULL.
fn m0003_memory_state(tx: &Transaction) -> rusqlite::Result<()> {
    tx.execute_batch(
        "ALTER TABLE memory_item ADD COLUMN state TEXT NOT NULL DEFAULT 'candidate';
         UPDATE memory_item
            SET state = 'confirmed', confidence = 'confirmed'
            WHERE confirmed_at IS NOT NULL;
         UPDATE memory_item
            SET confidence = 'candidate'
            WHERE confirmed_at IS NULL AND (confidence IS NULL OR confidence = 'confirmed');",
    )
}

fn m0004_consumed_approval(tx: &Transaction) -> rusqlite::Result<()> {
    // `use_key` PRIMARY KEY: a single approval is spendable exactly once — a second
    // grant attempt collides on the PK (INSERT-as-grant), so replay is unrepresentable.
    tx.execute_batch(
        "CREATE TABLE consumed_approval (
            use_key       TEXT PRIMARY KEY,
            approval_id   TEXT NOT NULL,
            action_digest TEXT NOT NULL,
            consumed_at   INTEGER NOT NULL
         );",
    )
}
