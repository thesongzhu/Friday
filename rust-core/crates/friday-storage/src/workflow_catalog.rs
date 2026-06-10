//! Workflow CATALOG persistence (R3; Hub-only). DARK substrate.
//!
//! The S8 [`crate::workflow_def`] layer stores versioned, immutable DEFINITION
//! bodies keyed by `(workflow_id, version)` plus the single-published flip. This
//! module adds the per-WORKFLOW catalog ENTRY that the TS `workflows.*` mutation
//! surface operates over (`workflows.create / update / archive / publish /
//! deploy`): the catalog row carries the workflow's identity (slug/name), its
//! soft-delete state (`is_archived`), an optimistic-concurrency `(revision,
//! etag)` pair, and the R3 DEPLOY pointer (`deployed_version`). It is the
//! storage half of R3; the catalog-CRUD + deploy DOMAIN orchestration (delegate
//! publish to S8, fail-closed-on-archived, version-existence validation) lives
//! ABOVE this layer in `friday-hub::workflow_catalog`, exactly as the linear-only
//! semantic gate lives above `workflow_def`'s row CHECKs.
//!
//! Invariants this module owns:
//!
//! * **Single source of published truth stays in S8.** The catalog deliberately
//!   does NOT persist "which version is published" — that is `workflow_definition
//!   .is_published`, protected by the S8 partial-unique index + atomic
//!   `set_published`. Duplicating it here would create a dual-write atomicity
//!   hazard and a second place the at-most-one invariant could drift. The catalog
//!   row's only version pointer is [`WorkflowCatalogRow::deployed_version`] (the
//!   R3 deploy pointer), set by the hub deploy op AFTER it confirms a published
//!   version exists.
//! * **Optimistic concurrency.** Every mutation carries an `expected_revision`;
//!   a stale value fails CLOSED ([`StorageError::Unsupported`] "revision
//!   conflict") rather than clobbering a concurrent edit. The check-then-write
//!   runs in one IMMEDIATE transaction so a concurrent writer cannot slip between
//!   the read and the UPDATE (the TOCTOU is closed), and a successful mutation
//!   BUMPS `revision` and re-derives `etag`.
//! * **`etag` is derived, never caller-supplied.** It is the sha256 of the
//!   identity-bearing fields + revision, computed at the single write chokepoint
//!   (like `workflow_def.checksum`), so a divergent `(state, etag)` pair is
//!   unrepresentable through the typed API.
//! * **Slug uniqueness** is DB-enforced (UNIQUE index): two catalog entries can
//!   never share a slug (a duplicate insert fails closed).
//! * **No FK to `workflow_definition`.** The catalog row is additive and
//!   independent — a catalog entry can exist before any version is created
//!   (mirroring `workflows.create` which mints the entry), and the existing S8
//!   definition tests create definitions with no catalog row. Cross-table
//!   consistency (publish/deploy require a version) is enforced by the HUB layer
//!   querying both, not by a schema FK that would couple the layers.
//!
//! Truth label: DARK substrate — no production route or scheduler consumes this;
//! the live TS `workflows.*` routes are NOT flipped; workflow execution remains
//! fenced in TS and is NOT product-replaced; NOT v1 GO.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};

/// Open an IMMEDIATE write transaction on a shared `&Connection`. IMMEDIATE
/// acquires the write lock at BEGIN, so the read-then-write (optimistic
/// concurrency) sequences below cannot interleave with another writer between
/// their statements (mirrors `workflow_def::write_tx` / `schedule::write_tx`).
fn write_tx(conn: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        conn,
        TransactionBehavior::Immediate,
    )?)
}

/// A stored catalog entry. The catalog carries IDENTITY + soft-state +
/// concurrency token + the deploy pointer — never the definition body (that is
/// in `workflow_definition`) and never "which version is published" (that is the
/// S8 `is_published` flag, the single source of truth).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowCatalogRow {
    pub workflow_id: String,
    pub slug: String,
    pub name: String,
    pub description: Option<String>,
    /// Opaque JSON array of tag strings (the hub layer owns the shape). Never a
    /// secret/body — coarse labels only. Defaults to `"[]"`.
    pub tags_json: String,
    pub is_archived: bool,
    /// Optimistic-concurrency counter. Starts at 1 on create; every successful
    /// mutation bumps it by 1.
    pub revision: i64,
    /// Derived (sha256 of identity fields + revision) at the write chokepoint —
    /// never caller-supplied.
    pub etag: String,
    /// R3 DEPLOY pointer: the version number that was deployed (made the
    /// deployable target for a future R2/S10 runtime). `None` until the workflow
    /// is deployed. The deploy op sets this only after confirming the version is
    /// the S8-published one.
    pub deployed_version: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Input to [`create_entry`]. `revision` / `etag` / `deployed_version` /
/// `is_archived` are intentionally absent — a created entry is born at
/// `revision = 1`, `is_archived = 0`, `deployed_version = NULL`, with a derived
/// `etag`, so an inconsistent birth state is unrepresentable through the API.
#[derive(Clone, Copy, Debug)]
pub struct NewWorkflowCatalogEntry<'a> {
    pub workflow_id: &'a str,
    pub slug: &'a str,
    pub name: &'a str,
    pub description: Option<&'a str>,
    /// Opaque JSON tag array; pass `None` for the default empty array `"[]"`.
    pub tags_json: Option<&'a str>,
}

/// Mutable identity/metadata fields settable by [`update_entry`]. A `None` field
/// LEAVES the stored value unchanged (a partial PATCH, matching the TS
/// `workflows.update` optional-field shape). `slug` is intentionally NOT
/// mutable here — re-slugging a catalog entry is out of R3 scope and would
/// reopen the uniqueness window.
#[derive(Clone, Copy, Debug, Default)]
pub struct WorkflowCatalogUpdate<'a> {
    pub name: Option<&'a str>,
    /// `Some(Some(d))` sets the description; `Some(None)` clears it to NULL;
    /// `None` leaves it unchanged.
    pub description: Option<Option<&'a str>>,
    pub tags_json: Option<&'a str>,
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    let out = h.finalize();
    let mut hex = String::with_capacity(64);
    for b in out {
        use std::fmt::Write as _;
        let _ = write!(hex, "{b:02x}");
    }
    hex
}

/// The identity-bearing fields the etag is derived over (the full mutable
/// state + revision). Borrowed so both a [`WorkflowCatalogRow`] and the
/// birth-state in [`create_entry`] can derive without cloning.
struct EtagInput<'a> {
    workflow_id: &'a str,
    slug: &'a str,
    name: &'a str,
    description: Option<&'a str>,
    tags_json: &'a str,
    is_archived: bool,
    deployed_version: Option<i64>,
    revision: i64,
}

/// Derive the etag from the identity-bearing fields + revision. Field-separated
/// by a control char that cannot appear in the inputs we accept, so distinct
/// field tuples cannot collide by concatenation.
fn derive_etag(i: &EtagInput<'_>) -> String {
    let mut material = String::new();
    use std::fmt::Write as _;
    let _ = write!(
        material,
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        i.workflow_id,
        i.slug,
        i.name,
        i.description.unwrap_or("\u{0}"),
        i.tags_json,
        i.is_archived as i64,
        i.deployed_version
            .map(|v| v.to_string())
            .unwrap_or_default(),
        i.revision,
    );
    sha256_hex(&material)
}

/// CREATE a new catalog entry, born at `revision = 1`, `is_archived = 0`,
/// `deployed_version = NULL`, with a derived `etag`. Returns the derived etag.
/// A duplicate `workflow_id` (PK) or `slug` (UNIQUE) fails closed.
pub fn create_entry(
    conn: &Connection,
    entry: &NewWorkflowCatalogEntry<'_>,
    now: i64,
) -> Result<String> {
    let tags_json = entry.tags_json.unwrap_or("[]");
    let etag = derive_etag(&EtagInput {
        workflow_id: entry.workflow_id,
        slug: entry.slug,
        name: entry.name,
        description: entry.description,
        tags_json,
        is_archived: false,
        deployed_version: None,
        revision: 1,
    });
    conn.execute(
        "INSERT INTO workflow_catalog
            (workflow_id, slug, name, description, tags_json, is_archived,
             revision, etag, deployed_version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 0, 1, ?6, NULL, ?7, ?7)",
        params![
            entry.workflow_id,
            entry.slug,
            entry.name,
            entry.description,
            tags_json,
            etag,
            now
        ],
    )?;
    Ok(etag)
}

fn row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowCatalogRow> {
    Ok(WorkflowCatalogRow {
        workflow_id: r.get(0)?,
        slug: r.get(1)?,
        name: r.get(2)?,
        description: r.get(3)?,
        tags_json: r.get(4)?,
        is_archived: r.get::<_, i64>(5)? != 0,
        revision: r.get(6)?,
        etag: r.get(7)?,
        deployed_version: r.get(8)?,
        created_at: r.get(9)?,
        updated_at: r.get(10)?,
    })
}

const SELECT_COLUMNS: &str = "workflow_id, slug, name, description, tags_json, is_archived,
     revision, etag, deployed_version, created_at, updated_at";

/// READ one catalog entry by id. `None` if unknown (not an error).
pub fn get_entry(conn: &Connection, workflow_id: &str) -> Result<Option<WorkflowCatalogRow>> {
    Ok(conn
        .query_row(
            &format!("SELECT {SELECT_COLUMNS} FROM workflow_catalog WHERE workflow_id = ?1"),
            params![workflow_id],
            row_from_sql,
        )
        .optional()?)
}

/// LIST all catalog entries, newest-created first. The catalog carries no body,
/// so the listing is refs-only by construction (identity + state only).
pub fn list_entries(conn: &Connection) -> Result<Vec<WorkflowCatalogRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM workflow_catalog ORDER BY created_at DESC, workflow_id ASC"
    ))?;
    let rows = stmt.query_map([], row_from_sql)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Shared optimistic-concurrency read: load the current row inside the
/// transaction, fail CLOSED on a missing entry (`NotFound`) or a stale
/// `expected_revision` (`Unsupported` "revision conflict"). Returns the live row
/// so the caller can compute the next state.
fn load_for_mutation(
    tx: &Transaction<'_>,
    workflow_id: &str,
    expected_revision: i64,
) -> Result<WorkflowCatalogRow> {
    let row = tx
        .query_row(
            &format!("SELECT {SELECT_COLUMNS} FROM workflow_catalog WHERE workflow_id = ?1"),
            params![workflow_id],
            row_from_sql,
        )
        .optional()?
        .ok_or_else(|| StorageError::NotFound(format!("workflow_catalog '{workflow_id}'")))?;
    if row.revision != expected_revision {
        return Err(StorageError::Unsupported(format!(
            "workflow_catalog '{workflow_id}' revision conflict (expected {expected_revision}, \
             stored {}); refusing to overwrite a concurrent edit",
            row.revision
        )));
    }
    Ok(row)
}

/// Persist the next state of a row (revision-bumped, etag re-derived) inside an
/// open transaction. Shared by every mutating op so the bump + derive are a
/// single chokepoint.
fn write_next_state(tx: &Transaction<'_>, next: &WorkflowCatalogRow, now: i64) -> Result<()> {
    tx.execute(
        "UPDATE workflow_catalog
         SET name = ?2, description = ?3, tags_json = ?4, is_archived = ?5,
             revision = ?6, etag = ?7, deployed_version = ?8, updated_at = ?9
         WHERE workflow_id = ?1",
        params![
            next.workflow_id,
            next.name,
            next.description,
            next.tags_json,
            next.is_archived as i64,
            next.revision,
            next.etag,
            next.deployed_version,
            now
        ],
    )?;
    Ok(())
}

/// Recompute `etag` for a (mutated) row at its NEW revision and stamp it.
fn stamp(row: &mut WorkflowCatalogRow, next_revision: i64) {
    row.revision = next_revision;
    row.etag = derive_etag(&EtagInput {
        workflow_id: &row.workflow_id,
        slug: &row.slug,
        name: &row.name,
        description: row.description.as_deref(),
        tags_json: &row.tags_json,
        is_archived: row.is_archived,
        deployed_version: row.deployed_version,
        revision: next_revision,
    });
}

/// UPDATE catalog metadata (name / description / tags) under optimistic
/// concurrency. Fail-closed on missing entry, stale revision, or an ARCHIVED
/// entry (an archived workflow is read-only; un-archive is out of R3 scope).
/// Returns the new `(revision, etag)`.
pub fn update_entry(
    conn: &Connection,
    workflow_id: &str,
    expected_revision: i64,
    patch: &WorkflowCatalogUpdate<'_>,
    now: i64,
) -> Result<(i64, String)> {
    let tx = write_tx(conn)?;
    let mut row = load_for_mutation(&tx, workflow_id, expected_revision)?;
    if row.is_archived {
        return Err(StorageError::Unsupported(format!(
            "workflow_catalog '{workflow_id}' is archived; refusing to update an archived entry"
        )));
    }
    if let Some(name) = patch.name {
        row.name = name.to_string();
    }
    if let Some(desc) = patch.description {
        row.description = desc.map(|d| d.to_string());
    }
    if let Some(tags) = patch.tags_json {
        row.tags_json = tags.to_string();
    }
    let next_revision = row.revision + 1;
    stamp(&mut row, next_revision);
    write_next_state(&tx, &row, now)?;
    tx.commit()?;
    Ok((next_revision, row.etag))
}

/// ARCHIVE (soft-delete): flip `is_archived = 1` under optimistic concurrency.
/// Idempotent on the END STATE is NOT assumed — archiving an already-archived
/// entry fails closed (the caller should not re-issue). Fail-closed on missing
/// entry or stale revision. Returns the new `(revision, etag)`.
pub fn archive_entry(
    conn: &Connection,
    workflow_id: &str,
    expected_revision: i64,
    now: i64,
) -> Result<(i64, String)> {
    let tx = write_tx(conn)?;
    let mut row = load_for_mutation(&tx, workflow_id, expected_revision)?;
    if row.is_archived {
        return Err(StorageError::Unsupported(format!(
            "workflow_catalog '{workflow_id}' is already archived"
        )));
    }
    row.is_archived = true;
    let next_revision = row.revision + 1;
    stamp(&mut row, next_revision);
    write_next_state(&tx, &row, now)?;
    tx.commit()?;
    Ok((next_revision, row.etag))
}

/// Set the R3 DEPLOY pointer to `version` under optimistic concurrency.
///
/// Storage-level primitive: it records WHICH version is the deployed target on
/// the catalog row; the HUB deploy op is responsible for first confirming
/// (against [`crate::workflow_def`]) that `version` is the workflow's PUBLISHED
/// version — storage cannot cross-check S8 publish state without coupling the
/// layers (mirrors how `schedule::insert_schedule` trusts a hub-validated cron).
/// Fail-closed on missing entry, stale revision, or an ARCHIVED entry (an
/// archived workflow can never be deployed). Returns the new `(revision, etag)`.
pub fn set_deployed_version(
    conn: &Connection,
    workflow_id: &str,
    expected_revision: i64,
    version: i64,
    now: i64,
) -> Result<(i64, String)> {
    let tx = write_tx(conn)?;
    let mut row = load_for_mutation(&tx, workflow_id, expected_revision)?;
    if row.is_archived {
        return Err(StorageError::Unsupported(format!(
            "workflow_catalog '{workflow_id}' is archived; refusing to deploy an archived entry"
        )));
    }
    row.deployed_version = Some(version);
    let next_revision = row.revision + 1;
    stamp(&mut row, next_revision);
    write_next_state(&tx, &row, now)?;
    tx.commit()?;
    Ok((next_revision, row.etag))
}
