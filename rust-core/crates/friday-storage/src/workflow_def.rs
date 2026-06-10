//! Workflow DEFINITION persistence (S8; Hub-only). DARK substrate.
//!
//! Storage previously persisted workflow RUNS/STEPS only ([`crate::workflow`]);
//! this module adds the versioned DEFINITION layer underneath them. It is the
//! storage half of the S8 slice: `friday-hub::workflow_def` owns the definition
//! JSON format (serde, schema_version-tagged, linear-only) and the loader that
//! turns a stored row into the executable form the EXISTING `workflow_exec`
//! engine consumes; this module owns only rows + invariants:
//!
//! * **Versioned + immutable**: one row per `(workflow_id, version)` (PK); the
//!   API offers create / read / publish-flip / delete — never an UPDATE of the
//!   definition body. A duplicate version is a fail-closed insert (PK
//!   violation), mirroring the TS `workflow_versions` published-version model.
//! * **Derived checksum**: `checksum` is the sha256 of `definition_json`,
//!   computed HERE (the single insert chokepoint, like
//!   `run_result.answer_sha256`), and re-derived + compared on every body read —
//!   a hand-edited/tampered body fails CLOSED instead of loading.
//! * **At most one published version** per `workflow_id`, enforced at THREE
//!   layers: a partial UNIQUE index in the schema makes a second published row
//!   unrepresentable even via raw SQL; [`set_published`] is a transaction that
//!   clears siblings and sets the target atomically (a missing/concurrently
//!   deleted target rolls back — the current published version is never
//!   unpublished as a side effect, and a crash mid-call can never leave the
//!   clear committed without the set); and [`get_published_definition`] fails
//!   CLOSED if it ever observes more than one published row (defense in depth).
//! * **Fail-closed deletes**: deleting the published version is refused
//!   (publish a different version first), so a published pointer can never
//!   dangle. [`delete_definition`] runs its published-check and DELETE in one
//!   transaction, so a concurrent publish cannot slip between them.
//! * **Refs-only listing**: [`list_definitions`] returns summaries WITHOUT the
//!   `definition_json` / `source_meta` bodies, so projections/readbacks built on
//!   it are refs-only by construction.
//!
//! Truth label: DARK substrate — no production route or scheduler consumes
//! this; workflow execution remains fenced in TS and is NOT product-replaced;
//! NOT v1 GO.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha2::{Digest, Sha256};

/// Open a write transaction on a shared `&Connection` (the module API takes
/// `&Connection`, so the checked `Connection::transaction` is unavailable).
/// IMMEDIATE acquires the write lock at BEGIN, so the read-then-write sequences
/// below cannot interleave with another writer's between their statements.
fn write_tx(conn: &Connection) -> Result<Transaction<'_>> {
    Ok(Transaction::new_unchecked(
        conn,
        TransactionBehavior::Immediate,
    )?)
}

/// Provenance of a stored workflow definition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DefinitionSource {
    /// Authored directly against the Rust definition types.
    RustNative,
    /// Ingested from a TS published-version graph by the LINEAR-ONLY translator
    /// (`friday-hub::workflow_ts_translate`); `source_meta` preserves refs-only
    /// provenance.
    TsTranslated,
}

impl DefinitionSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            DefinitionSource::RustNative => "rust_native",
            DefinitionSource::TsTranslated => "ts_translated",
        }
    }

    /// Parse a stored label. Unknown labels fail CLOSED (a definition whose
    /// provenance cannot be named is never silently defaulted).
    fn parse(s: &str) -> Result<Self> {
        match s {
            "rust_native" => Ok(DefinitionSource::RustNative),
            "ts_translated" => Ok(DefinitionSource::TsTranslated),
            other => Err(StorageError::Unsupported(format!(
                "workflow_definition has unknown source label '{other}' (fail-closed)"
            ))),
        }
    }
}

/// The full stored row (body-bearing; Hub-side only — never project this shape
/// over a refs-only readback).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowDefinitionRow {
    pub workflow_id: String,
    pub version: i64,
    pub name: String,
    pub definition_json: String,
    pub checksum: String,
    pub source: DefinitionSource,
    pub source_meta: Option<String>,
    pub is_published: bool,
    pub created_at: i64,
}

/// Refs-only summary (no `definition_json`, no `source_meta`): safe for
/// projections/readbacks.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowDefinitionSummary {
    pub workflow_id: String,
    pub version: i64,
    pub name: String,
    pub checksum: String,
    pub source: DefinitionSource,
    pub is_published: bool,
    pub created_at: i64,
}

/// Input to [`create_definition`]. `checksum` is intentionally absent — it is
/// DERIVED from `definition_json` at the insert chokepoint, so a divergent
/// `(body, fingerprint)` pair is unrepresentable through the API.
#[derive(Clone, Copy, Debug)]
pub struct NewWorkflowDefinition<'a> {
    pub workflow_id: &'a str,
    pub version: i64,
    pub name: &'a str,
    pub definition_json: &'a str,
    pub source: DefinitionSource,
    /// Refs-only provenance for a translated definition (ids/counts/labels —
    /// never raw node configs/prompts/secrets). The caller (hub layer) owns
    /// that discipline; storage persists it opaquely.
    pub source_meta: Option<&'a str>,
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

/// Create a new (unpublished) definition version. Returns the derived checksum.
/// A duplicate `(workflow_id, version)` fails closed (PK violation) — a stored
/// version is immutable and can never be silently overwritten.
pub fn create_definition(
    conn: &Connection,
    def: &NewWorkflowDefinition<'_>,
    now: i64,
) -> Result<String> {
    let checksum = sha256_hex(def.definition_json);
    conn.execute(
        "INSERT INTO workflow_definition
            (workflow_id, version, name, definition_json, checksum, source,
             source_meta, is_published, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8)",
        params![
            def.workflow_id,
            def.version,
            def.name,
            def.definition_json,
            checksum,
            def.source.as_str(),
            def.source_meta,
            now
        ],
    )?;
    Ok(checksum)
}

fn row_from_sql(r: &rusqlite::Row<'_>) -> rusqlite::Result<(WorkflowDefinitionRow, String)> {
    let source_label: String = r.get(5)?;
    Ok((
        WorkflowDefinitionRow {
            workflow_id: r.get(0)?,
            version: r.get(1)?,
            name: r.get(2)?,
            definition_json: r.get(3)?,
            checksum: r.get(4)?,
            // placeholder; parsed (fail-closed) by the caller from `source_label`
            source: DefinitionSource::RustNative,
            source_meta: r.get(6)?,
            is_published: r.get::<_, i64>(7)? != 0,
            created_at: r.get(8)?,
        },
        source_label,
    ))
}

/// Integrity gate shared by the body-bearing readers: re-derive the checksum
/// from the stored body and fail CLOSED on mismatch (tampered/hand-edited row).
fn verify_row(mut row: WorkflowDefinitionRow, source_label: &str) -> Result<WorkflowDefinitionRow> {
    row.source = DefinitionSource::parse(source_label)?;
    let derived = sha256_hex(&row.definition_json);
    if derived != row.checksum {
        return Err(StorageError::Unsupported(format!(
            "workflow_definition '{}' v{} failed its checksum integrity check (stored fingerprint \
             does not match the stored body); refusing to load",
            row.workflow_id, row.version
        )));
    }
    Ok(row)
}

const SELECT_COLUMNS: &str = "workflow_id, version, name, definition_json, checksum, source,
     source_meta, is_published, created_at";

/// Read one definition version (checksum-verified, fail-closed).
pub fn get_definition(
    conn: &Connection,
    workflow_id: &str,
    version: i64,
) -> Result<Option<WorkflowDefinitionRow>> {
    let got = conn
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM workflow_definition
                 WHERE workflow_id = ?1 AND version = ?2"
            ),
            params![workflow_id, version],
            row_from_sql,
        )
        .optional()?;
    match got {
        Some((row, label)) => Ok(Some(verify_row(row, &label)?)),
        None => Ok(None),
    }
}

/// Read the published version of a workflow (checksum-verified, fail-closed),
/// or `None` if the workflow has no published version.
///
/// Fail-closed on AMBIGUITY: if more than one published row matches (a state
/// the partial unique index makes unrepresentable, but a hand-rebuilt DB could
/// carry), this refuses to load rather than silently returning an arbitrary
/// row — consistent with the tamper posture of the checksum/name gates.
pub fn get_published_definition(
    conn: &Connection,
    workflow_id: &str,
) -> Result<Option<WorkflowDefinitionRow>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SELECT_COLUMNS} FROM workflow_definition
         WHERE workflow_id = ?1 AND is_published = 1"
    ))?;
    let mut rows: Vec<(WorkflowDefinitionRow, String)> = stmt
        .query_map(params![workflow_id], row_from_sql)?
        .collect::<rusqlite::Result<_>>()?;
    match rows.len() {
        0 => Ok(None),
        1 => {
            let (row, label) = rows.pop().expect("len checked");
            Ok(Some(verify_row(row, &label)?))
        }
        n => Err(StorageError::Unsupported(format!(
            "workflow_definition '{workflow_id}' has {n} published versions (the at-most-one \
             invariant is violated — tampered/hand-rebuilt DB?); refusing to pick one"
        ))),
    }
}

/// Refs-only listing of every stored definition version (no bodies), newest
/// first within a workflow.
pub fn list_definitions(conn: &Connection) -> Result<Vec<WorkflowDefinitionSummary>> {
    let mut stmt = conn.prepare(
        "SELECT workflow_id, version, name, checksum, source, is_published, created_at
         FROM workflow_definition
         ORDER BY workflow_id, version DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            WorkflowDefinitionSummary {
                workflow_id: r.get(0)?,
                version: r.get(1)?,
                name: r.get(2)?,
                checksum: r.get(3)?,
                source: DefinitionSource::RustNative, // parsed below, fail-closed
                is_published: r.get::<_, i64>(5)? != 0,
                created_at: r.get(6)?,
            },
            r.get::<_, String>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        let (mut summary, label) = r?;
        summary.source = DefinitionSource::parse(&label)?;
        out.push(summary);
    }
    Ok(out)
}

/// Mark exactly one version of `workflow_id` published (clearing any sibling's
/// flag in the same transaction).
///
/// ATOMIC + fail-closed: both UPDATEs run in one IMMEDIATE transaction, and the
/// set-UPDATE's changed-row count is checked — publishing a missing (or
/// concurrently deleted) version is `NotFound` and ROLLS BACK the clear, so the
/// current published version is never unpublished as a side effect, a crash
/// mid-call can never commit the clear without the set, and a 0-row target can
/// never return a silent `Ok`. The schema's partial unique index independently
/// makes a double-published end state unrepresentable.
pub fn set_published(conn: &Connection, workflow_id: &str, version: i64) -> Result<()> {
    let tx = write_tx(conn)?;
    tx.execute(
        "UPDATE workflow_definition SET is_published = 0
         WHERE workflow_id = ?1 AND is_published = 1",
        params![workflow_id],
    )?;
    let set = tx.execute(
        "UPDATE workflow_definition SET is_published = 1
         WHERE workflow_id = ?1 AND version = ?2",
        params![workflow_id, version],
    )?;
    if set != 1 {
        // drop(tx) rolls back the clear: the previous published row survives.
        return Err(StorageError::NotFound(format!(
            "workflow_definition '{workflow_id}' v{version} (cannot publish a missing version)"
        )));
    }
    tx.commit()?;
    Ok(())
}

/// Delete one definition version. Fail-closed rules: a missing version is
/// `NotFound` (never a silent no-op success), and the PUBLISHED version is
/// refused (publish a different version first) so the published pointer can
/// never dangle. The published-check and the DELETE run in one IMMEDIATE
/// transaction, so a concurrent `set_published` of this version cannot land
/// between them (the check-then-delete TOCTOU is closed).
pub fn delete_definition(conn: &Connection, workflow_id: &str, version: i64) -> Result<()> {
    let tx = write_tx(conn)?;
    let published: Option<i64> = tx
        .query_row(
            "SELECT is_published FROM workflow_definition
             WHERE workflow_id = ?1 AND version = ?2",
            params![workflow_id, version],
            |r| r.get(0),
        )
        .optional()?;
    match published {
        None => Err(StorageError::NotFound(format!(
            "workflow_definition '{workflow_id}' v{version}"
        ))),
        Some(p) if p != 0 => Err(StorageError::Unsupported(format!(
            "workflow_definition '{workflow_id}' v{version} is the PUBLISHED version; refusing to \
             delete it (publish a different version first)"
        ))),
        Some(_) => {
            tx.execute(
                "DELETE FROM workflow_definition WHERE workflow_id = ?1 AND version = ?2",
                params![workflow_id, version],
            )?;
            tx.commit()?;
            Ok(())
        }
    }
}
