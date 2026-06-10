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
//! * **At most one published version** per `workflow_id` ([`set_published`]
//!   clears siblings in the same call; the target is pre-checked so a missing
//!   version can never unpublish the current one as a side effect).
//! * **Fail-closed deletes**: deleting the published version is refused
//!   (publish a different version first), so a published pointer can never
//!   dangle.
//! * **Refs-only listing**: [`list_definitions`] returns summaries WITHOUT the
//!   `definition_json` / `source_meta` bodies, so projections/readbacks built on
//!   it are refs-only by construction.
//!
//! Truth label: DARK substrate — no production route or scheduler consumes
//! this; workflow execution remains fenced in TS and is NOT product-replaced;
//! NOT v1 GO.

use crate::error::{Result, StorageError};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};

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
pub fn get_published_definition(
    conn: &Connection,
    workflow_id: &str,
) -> Result<Option<WorkflowDefinitionRow>> {
    let got = conn
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM workflow_definition
                 WHERE workflow_id = ?1 AND is_published = 1"
            ),
            params![workflow_id],
            row_from_sql,
        )
        .optional()?;
    match got {
        Some((row, label)) => Ok(Some(verify_row(row, &label)?)),
        None => Ok(None),
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
/// flag in the same call). The target is pre-checked so publishing a missing
/// version is a fail-closed `NotFound` that leaves the current published
/// version UNTOUCHED (the unpublish never runs without a valid target).
pub fn set_published(conn: &Connection, workflow_id: &str, version: i64) -> Result<()> {
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM workflow_definition WHERE workflow_id = ?1 AND version = ?2)",
        params![workflow_id, version],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(StorageError::NotFound(format!(
            "workflow_definition '{workflow_id}' v{version} (cannot publish a missing version)"
        )));
    }
    conn.execute(
        "UPDATE workflow_definition SET is_published = 0
         WHERE workflow_id = ?1 AND is_published = 1",
        params![workflow_id],
    )?;
    conn.execute(
        "UPDATE workflow_definition SET is_published = 1
         WHERE workflow_id = ?1 AND version = ?2",
        params![workflow_id, version],
    )?;
    Ok(())
}

/// Delete one definition version. Fail-closed rules: a missing version is
/// `NotFound` (never a silent no-op success), and the PUBLISHED version is
/// refused (publish a different version first) so the published pointer can
/// never dangle.
pub fn delete_definition(conn: &Connection, workflow_id: &str, version: i64) -> Result<()> {
    let published: Option<i64> = conn
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
            conn.execute(
                "DELETE FROM workflow_definition WHERE workflow_id = ?1 AND version = ?2",
                params![workflow_id, version],
            )?;
            Ok(())
        }
    }
}
