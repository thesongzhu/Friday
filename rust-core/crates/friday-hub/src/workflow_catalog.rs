//! R3 — the Rust workflow CATALOG mutation + deploy DOMAIN layer (DARK).
//!
//! The S8 [`crate::workflow_def`] layer is the DEFINITION layer (versioned
//! immutable bodies + the single-published flip). This module is the per-WORKFLOW
//! CATALOG layer the TS `workflows.*` mutation surface maps to —
//! `workflows.create / update / archive / publish / deploy` — orchestrating
//! [`friday_storage::workflow_catalog`] (the entry row) and
//! [`crate::workflow_def`] (the version bodies) into the five catalog operations.
//!
//! ## Scope and truth labels (DARK substrate)
//! - This is the catalog-MUTATION layer only. It registers NO production route,
//!   NO scheduler/trigger/daemon (that is R2/S10, operator-gated), and changes NO
//!   TS runtime file. The live TS `workflows.*` routes stay fail-closed/retired;
//!   workflow execution remains fenced in TS and is NOT product-replaced; NOT v1 GO.
//! - There is NO runtime trigger here: [`deploy`] sets the catalog DEPLOY POINTER
//!   (`deployed_version`) to a PUBLISHED version after confirming it is published
//!   in S8 — it does NOT start a run, register a schedule, or fire a trigger.
//!   "Deployable state at the storage/domain level" is the explicit R3 boundary;
//!   wiring a runtime trigger is R2/S10 (gated).
//!
//! ## The single source of published truth stays in S8
//! `publish` delegates to [`friday_storage::workflow_def::set_published`] — the
//! catalog NEVER persists "which version is published" (that is the
//! `workflow_definition.is_published` flag, protected by the S8 partial-unique
//! index + atomic flip). The catalog's only version pointer is the R3 deploy
//! pointer, which `deploy` sets only AFTER reading back the S8-published version.
//! This keeps the at-most-one-published invariant in exactly one place.
//!
//! ## Fail-closed posture
//! Every op fail-closes: a missing entry, a stale `expected_revision` (optimistic
//! concurrency), an invalid definition body, publishing/deploying a non-existent
//! version, deploying a version that is not the published one, or mutating an
//! archived entry. No `unwrap`/`expect` on caller input; no panics.

use crate::workflow_def::{
    create_definition as def_create, get_parsed_definition as def_get_parsed, StoredWorkflowDefV1,
    WorkflowDefError,
};
use friday_storage::workflow_catalog::{
    archive_entry as cat_archive, create_entry as cat_create, get_entry as cat_get,
    list_entries as cat_list, set_deployed_version as cat_set_deployed, update_entry as cat_update,
    NewWorkflowCatalogEntry, WorkflowCatalogRow, WorkflowCatalogUpdate,
};
use friday_storage::workflow_def::{
    get_definition as def_get, get_published_definition as def_get_published,
    set_published as def_set_published, DefinitionSource,
};
use rusqlite::Connection;

/// The maximum slug length the catalog accepts (mirrors the TS
/// `workflows.create` `slug` bound).
pub const MAX_SLUG_LEN: usize = 128;
/// The maximum name length the catalog accepts (mirrors the TS `name` bound).
pub const MAX_NAME_LEN: usize = 255;

/// Fail-closed errors of the catalog-mutation layer.
#[derive(Debug, thiserror::Error)]
pub enum WorkflowCatalogError {
    /// Caller input failed a fail-closed validation (empty/over-long slug or
    /// name, etc.) — never persisted.
    #[error("workflow catalog input invalid: {0}")]
    Invalid(String),
    /// A targeted catalog entry / version does not exist.
    #[error("workflow catalog not found: {0}")]
    NotFound(String),
    /// The version named for publish/deploy is not the workflow's PUBLISHED
    /// version (deploy requires a published target — fail-closed).
    #[error("workflow catalog conflict: {0}")]
    Conflict(String),
    /// The definition body failed the S8 definition-layer validation.
    #[error("workflow definition error: {0}")]
    Definition(#[from] WorkflowDefError),
    /// A storage-layer failure (incl. a stale-revision optimistic-concurrency
    /// conflict, a duplicate slug, or an archived-entry refusal — all surfaced
    /// fail-closed, never silently swallowed).
    #[error("storage error: {0}")]
    Storage(#[from] friday_storage::StorageError),
}

type Result<T> = std::result::Result<T, WorkflowCatalogError>;

/// The version number a freshly-created workflow's first definition gets.
pub const INITIAL_VERSION: i64 = 1;

/// What a catalog mutation returns: the new optimistic-concurrency token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogMutation {
    pub revision: i64,
    pub etag: String,
}

/// Fail-closed validation of the caller-facing identity fields shared by
/// create. Bounds mirror the TS `workflows.create` route guards.
fn validate_identity(slug: &str, name: &str) -> Result<()> {
    let s = slug.trim();
    if s.is_empty() {
        return Err(WorkflowCatalogError::Invalid(
            "slug is required and must be a non-empty string".into(),
        ));
    }
    if s.len() > MAX_SLUG_LEN {
        return Err(WorkflowCatalogError::Invalid(format!(
            "slug must be at most {MAX_SLUG_LEN} characters"
        )));
    }
    let n = name.trim();
    if n.is_empty() {
        return Err(WorkflowCatalogError::Invalid(
            "name is required and must be a non-empty string".into(),
        ));
    }
    if n.len() > MAX_NAME_LEN {
        return Err(WorkflowCatalogError::Invalid(format!(
            "name must be at most {MAX_NAME_LEN} characters"
        )));
    }
    Ok(())
}

/// CREATE: mint a new catalog entry AND its initial (unpublished) definition
/// version v1, in one transaction so a half-created workflow (entry without its
/// v1 body, or vice versa) can never persist — a duplicate id/slug rolls the
/// whole thing back.
///
/// Mirrors TS `workflows.create` (mints the entry + the first version). The
/// `def` body is validated by the S8 definition layer; a duplicate `workflow_id`
/// or `slug` fails closed at the storage layer. Returns the entry's birth
/// `(revision = 1, etag)`.
#[allow(clippy::too_many_arguments)]
pub fn create(
    conn: &Connection,
    workflow_id: &str,
    slug: &str,
    name: &str,
    description: Option<&str>,
    tags_json: Option<&str>,
    def: &StoredWorkflowDefV1,
    now_ms: i64,
) -> Result<CatalogMutation> {
    validate_identity(slug, name)?;
    if workflow_id.trim().is_empty() {
        return Err(WorkflowCatalogError::Invalid(
            "workflow_id must be a non-empty string".into(),
        ));
    }
    // The body's own schema/structure must validate BEFORE we touch the DB.
    def.validate()?;

    // One transaction over BOTH tables: the entry + its v1 body land together or
    // not at all (no half-created workflow). A duplicate workflow_id/slug rolls
    // the whole thing back (no dangling v1 body), and a concurrent create on the
    // same single connection cannot interleave between the two inserts.
    let tx = conn
        .unchecked_transaction()
        .map_err(friday_storage::StorageError::from)?;
    cat_create(
        &tx,
        &NewWorkflowCatalogEntry {
            workflow_id,
            slug,
            name,
            description,
            tags_json,
        },
        now_ms,
    )?;
    def_create(
        &tx,
        workflow_id,
        INITIAL_VERSION,
        def,
        DefinitionSource::RustNative,
        None,
        now_ms,
    )?;
    // The catalog `etag` is derived inside `cat_create`; re-read it back so the
    // returned token matches the persisted row exactly (no second derivation).
    let etag = read_etag(&tx, workflow_id)?;
    tx.commit().map_err(friday_storage::StorageError::from)?;
    Ok(CatalogMutation { revision: 1, etag })
}

/// Read the just-written etag inside a transaction (the catalog derived it; we
/// surface the persisted value rather than re-deriving it).
fn read_etag(conn: &Connection, workflow_id: &str) -> Result<String> {
    let row = cat_get(conn, workflow_id)?
        .ok_or_else(|| WorkflowCatalogError::NotFound(format!("'{workflow_id}'")))?;
    Ok(row.etag)
}

/// UPDATE catalog metadata (name / description / tags) under optimistic
/// concurrency. A `None` field is left unchanged; `description: Some(None)`
/// clears it. Fail-closed on missing entry, stale revision, archived entry, or
/// an invalid name. Returns the new `(revision, etag)`.
///
/// Per S8, a definition body is IMMUTABLE — "updating the workflow's steps" is a
/// NEW version via [`add_version`], not an in-place edit, so this op never
/// touches a definition body.
pub fn update(
    conn: &Connection,
    workflow_id: &str,
    expected_revision: i64,
    name: Option<&str>,
    description: Option<Option<&str>>,
    tags_json: Option<&str>,
    now_ms: i64,
) -> Result<CatalogMutation> {
    if let Some(n) = name {
        let t = n.trim();
        if t.is_empty() {
            return Err(WorkflowCatalogError::Invalid(
                "name must be a non-empty string".into(),
            ));
        }
        if t.len() > MAX_NAME_LEN {
            return Err(WorkflowCatalogError::Invalid(format!(
                "name must be at most {MAX_NAME_LEN} characters"
            )));
        }
    }
    let (revision, etag) = cat_update(
        conn,
        workflow_id,
        expected_revision,
        &WorkflowCatalogUpdate {
            name,
            description,
            tags_json,
        },
        now_ms,
    )?;
    Ok(CatalogMutation { revision, etag })
}

/// ADD a new immutable definition version to an existing (non-archived) catalog
/// entry. Definitions are immutable (S8), so "editing a workflow's steps" mints
/// a new version; publishing/deploying it are separate explicit ops. The
/// `version` must be unused (a duplicate fails closed at the S8 PK). The catalog
/// entry must exist and not be archived. This does NOT bump the catalog revision
/// (the catalog row's identity is unchanged; only a new version body is added).
pub fn add_version(
    conn: &Connection,
    workflow_id: &str,
    version: i64,
    def: &StoredWorkflowDefV1,
    now_ms: i64,
) -> Result<String> {
    require_active_entry(conn, workflow_id)?; // existence + non-archived
    Ok(def_create(
        conn,
        workflow_id,
        version,
        def,
        DefinitionSource::RustNative,
        None,
        now_ms,
    )?)
}

/// ARCHIVE (soft-delete) a catalog entry under optimistic concurrency. The entry
/// is never hard-deleted, so a deployed/published pointer can never dangle.
/// Fail-closed on missing entry, stale revision, or an already-archived entry.
/// Returns the new `(revision, etag)`.
pub fn archive(
    conn: &Connection,
    workflow_id: &str,
    expected_revision: i64,
    now_ms: i64,
) -> Result<CatalogMutation> {
    let (revision, etag) = cat_archive(conn, workflow_id, expected_revision, now_ms)?;
    Ok(CatalogMutation { revision, etag })
}

/// PUBLISH a specific definition version of a workflow. Delegates the
/// at-most-one-published flip to the S8 [`def_set_published`] (the single source
/// of truth — the catalog never records the published pointer). Fail-closed on a
/// missing entry, an archived entry, or a non-existent version (S8
/// `set_published` returns `NotFound`). Publishing does NOT touch the deploy
/// pointer (deploy is a separate explicit op) and does NOT bump the catalog
/// revision (the published flag lives in S8, not the catalog row).
pub fn publish(conn: &Connection, workflow_id: &str, version: i64) -> Result<()> {
    let _ = require_active_entry(conn, workflow_id)?;
    // The version must EXIST before we flip it (S8 `set_published` already
    // fail-closes a missing version, but we surface a catalog-shaped NotFound so
    // the caller sees a consistent error vocabulary).
    if def_get(conn, workflow_id, version)?.is_none() {
        return Err(WorkflowCatalogError::NotFound(format!(
            "'{workflow_id}' v{version} (cannot publish a version that does not exist)"
        )));
    }
    def_set_published(conn, workflow_id, version)?;
    Ok(())
}

/// DEPLOY (R3 boundary): set the catalog DEPLOY POINTER to the workflow's
/// currently-PUBLISHED version, after confirming a published version exists in
/// S8. This is "published def → deployable state at the storage/domain level"
/// and NOTHING more — it does NOT start a run, register a schedule, or fire a
/// runtime trigger (that is R2/S10, gated).
///
/// Fail-closed on a missing/archived entry or a workflow with NO published
/// version (`Conflict` — there is nothing deployable). The deploy pointer is set
/// to whatever S8 reports as published, so the catalog can never deploy an
/// unpublished version. Returns the new catalog `(revision, etag)`.
pub fn deploy(
    conn: &Connection,
    workflow_id: &str,
    expected_revision: i64,
    now_ms: i64,
) -> Result<CatalogMutation> {
    require_active_entry(conn, workflow_id)?;
    // The deployable target is the S8-PUBLISHED version (single source of truth).
    let published = def_get_published(conn, workflow_id)?.ok_or_else(|| {
        WorkflowCatalogError::Conflict(format!(
            "'{workflow_id}' has no published version; publish a version before deploying"
        ))
    })?;
    // Defense in depth: re-parse the published body through the S8 loader, which
    // fail-closes on a foreign/unparseable definition (an unsupported
    // `schema_version`, a smuggled DAG shape, or a row whose `name` column
    // diverges from the body). `get_published_definition` already checksum-verifies
    // the body, but a tampered row can carry a SELF-CONSISTENT foreign body (a
    // recomputed sha256 over a v2 document); this parse refuses to mark such a
    // body deployable — only a supported (linear, v1) definition reaches a
    // deployable state. Errors surface as `WorkflowCatalogError::Definition`.
    def_get_parsed(conn, workflow_id, published.version)?;
    let (revision, etag) = cat_set_deployed(
        conn,
        workflow_id,
        expected_revision,
        published.version,
        now_ms,
    )?;
    Ok(CatalogMutation { revision, etag })
}

/// READ one catalog entry (refs-only; no definition body). `None` if unknown.
pub fn get(conn: &Connection, workflow_id: &str) -> Result<Option<WorkflowCatalogRow>> {
    Ok(cat_get(conn, workflow_id)?)
}

/// LIST all catalog entries (refs-only), newest-created first.
pub fn list(conn: &Connection) -> Result<Vec<WorkflowCatalogRow>> {
    Ok(cat_list(conn)?)
}

/// Load a catalog entry and fail closed if it is missing or archived (the shared
/// precondition for publish/deploy/add_version — an archived workflow is
/// read-only).
fn require_active_entry(conn: &Connection, workflow_id: &str) -> Result<WorkflowCatalogRow> {
    let entry = cat_get(conn, workflow_id)?
        .ok_or_else(|| WorkflowCatalogError::NotFound(format!("'{workflow_id}'")))?;
    if entry.is_archived {
        return Err(WorkflowCatalogError::Conflict(format!(
            "'{workflow_id}' is archived (an archived workflow is read-only)"
        )));
    }
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_storage::Db;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-wfcat-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn step(id: &str, action: &str) -> crate::workflow_def::StoredWorkflowStepV1 {
        crate::workflow_def::StoredWorkflowStepV1 {
            id: id.to_string(),
            action: action.to_string(),
            params: vec![],
            force_checkpoint: false,
            evidence_required: false,
        }
    }

    fn def(name: &str) -> StoredWorkflowDefV1 {
        StoredWorkflowDefV1 {
            schema_version: crate::workflow_def::WORKFLOW_DEF_SCHEMA_VERSION,
            name: name.into(),
            steps: vec![step("read", "read_file"), step("scan", "search")],
        }
    }

    #[test]
    fn create_update_publish_archive_lifecycle() {
        let db = Db::open_hub(&tmp("lifecycle")).unwrap();
        let conn = db.conn();

        // CREATE: entry + v1 body land together; born revision 1, not archived.
        let created = create(
            conn,
            "wf1",
            "research-wf",
            "Research",
            Some("a research workflow"),
            None,
            &def("Research"),
            100,
        )
        .unwrap();
        assert_eq!(created.revision, 1);
        assert_eq!(created.etag.len(), 64);
        let entry = get(conn, "wf1").unwrap().unwrap();
        assert_eq!(entry.slug, "research-wf");
        assert!(!entry.is_archived);
        assert_eq!(entry.deployed_version, None);
        // The v1 definition body was created alongside the entry.
        assert!(def_get(conn, "wf1", 1).unwrap().is_some());

        // UPDATE metadata under optimistic concurrency (revision bumps to 2).
        let updated = update(
            conn,
            "wf1",
            1,
            Some("Research v2"),
            Some(Some("updated description")),
            Some(r#"["ai","research"]"#),
            200,
        )
        .unwrap();
        assert_eq!(updated.revision, 2);
        assert_ne!(updated.etag, created.etag);
        let entry = get(conn, "wf1").unwrap().unwrap();
        assert_eq!(entry.name, "Research v2");
        assert_eq!(entry.description.as_deref(), Some("updated description"));
        assert_eq!(entry.tags_json, r#"["ai","research"]"#);

        // PUBLISH v1 (delegates the flip to S8; catalog revision unchanged).
        publish(conn, "wf1", 1).unwrap();
        assert_eq!(def_get_published(conn, "wf1").unwrap().unwrap().version, 1);
        assert_eq!(
            get(conn, "wf1").unwrap().unwrap().revision,
            2,
            "publish does not bump the catalog revision (published flag lives in S8)"
        );

        // ARCHIVE under optimistic concurrency (revision bumps to 3).
        let archived = archive(conn, "wf1", 2, 300).unwrap();
        assert_eq!(archived.revision, 3);
        assert!(get(conn, "wf1").unwrap().unwrap().is_archived);
    }

    #[test]
    fn single_published_invariant_v2_unpublishes_v1() {
        let db = Db::open_hub(&tmp("single-pub")).unwrap();
        let conn = db.conn();
        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();
        add_version(conn, "wf1", 2, &def("WF"), 200).unwrap();

        publish(conn, "wf1", 1).unwrap();
        assert_eq!(def_get_published(conn, "wf1").unwrap().unwrap().version, 1);
        // Publishing v2 unpublishes v1 in the same S8 flip (at most ONE published).
        publish(conn, "wf1", 2).unwrap();
        assert_eq!(def_get_published(conn, "wf1").unwrap().unwrap().version, 2);
        let published_count = friday_storage::workflow_def::list_definitions(conn)
            .unwrap()
            .into_iter()
            .filter(|s| s.is_published)
            .count();
        assert_eq!(
            published_count, 1,
            "the S8 single-published invariant holds"
        );
    }

    #[test]
    fn deploy_of_a_published_def_sets_the_pointer() {
        let db = Db::open_hub(&tmp("deploy")).unwrap();
        let conn = db.conn();
        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();
        add_version(conn, "wf1", 2, &def("WF"), 150).unwrap();
        publish(conn, "wf1", 2).unwrap();

        // DEPLOY sets the pointer to whatever S8 reports as published (v2).
        let entry_before = get(conn, "wf1").unwrap().unwrap();
        let deployed = deploy(conn, "wf1", entry_before.revision, 200).unwrap();
        assert_eq!(deployed.revision, entry_before.revision + 1);
        let entry = get(conn, "wf1").unwrap().unwrap();
        assert_eq!(
            entry.deployed_version,
            Some(2),
            "deploy points at the S8-published version, never an arbitrary one"
        );

        // Re-publishing v1 then re-deploying moves the pointer to v1 (always the
        // published target, never a stale one).
        publish(conn, "wf1", 1).unwrap();
        let entry = get(conn, "wf1").unwrap().unwrap();
        deploy(conn, "wf1", entry.revision, 300).unwrap();
        assert_eq!(get(conn, "wf1").unwrap().unwrap().deployed_version, Some(1));
    }

    #[test]
    fn deploy_without_a_published_version_fails_closed() {
        let db = Db::open_hub(&tmp("deploy-nopub")).unwrap();
        let conn = db.conn();
        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();
        // No version published yet → nothing deployable.
        let rev = get(conn, "wf1").unwrap().unwrap().revision;
        assert!(matches!(
            deploy(conn, "wf1", rev, 200),
            Err(WorkflowCatalogError::Conflict(_))
        ));
        assert_eq!(get(conn, "wf1").unwrap().unwrap().deployed_version, None);
    }

    #[test]
    fn deploy_of_a_self_consistent_foreign_body_fails_closed() {
        // Defense in depth: a tampered row can carry a SELF-CONSISTENT foreign
        // body (a recomputed sha256 over an unsupported `schema_version=2`
        // document) that slips the S8 checksum gate. The deploy re-parse must
        // refuse to mark such a body deployable, and the pointer must stay None.
        use sha2::{Digest, Sha256};
        let db = Db::open_hub(&tmp("deploy-foreign")).unwrap();
        let conn = db.conn();
        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();
        publish(conn, "wf1", 1).unwrap();

        // Hand-edit the published v1 body to a FOREIGN (v2) document and recompute
        // its checksum so the S8 checksum gate passes (a tampered-but-consistent
        // row). `name` is kept so only the schema_version probe fails.
        let foreign = r#"{"schema_version":2,"name":"WF","steps":[],"edges":[]}"#;
        let mut h = Sha256::new();
        h.update(foreign.as_bytes());
        let checksum = h
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        conn.execute(
            "UPDATE workflow_definition SET definition_json = ?1, checksum = ?2
             WHERE workflow_id = 'wf1' AND version = 1",
            rusqlite::params![foreign, checksum],
        )
        .unwrap();

        let rev = get(conn, "wf1").unwrap().unwrap().revision;
        assert!(
            matches!(
                deploy(conn, "wf1", rev, 200),
                Err(WorkflowCatalogError::Definition(_))
            ),
            "a foreign published body must fail closed at the deploy re-parse"
        );
        assert_eq!(
            get(conn, "wf1").unwrap().unwrap().deployed_version,
            None,
            "deploy of a foreign body must not set the pointer"
        );
    }

    #[test]
    fn publish_nonexistent_version_fails_closed() {
        let db = Db::open_hub(&tmp("pub-missing")).unwrap();
        let conn = db.conn();
        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();
        assert!(matches!(
            publish(conn, "wf1", 99),
            Err(WorkflowCatalogError::NotFound(_))
        ));
        assert!(def_get_published(conn, "wf1").unwrap().is_none());
    }

    #[test]
    fn mutations_on_unknown_or_stale_or_archived_entries_fail_closed() {
        let db = Db::open_hub(&tmp("fail-closed")).unwrap();
        let conn = db.conn();

        // unknown entry → NotFound for every op that touches one.
        assert!(matches!(
            update(conn, "ghost", 1, Some("x"), None, None, 1),
            Err(WorkflowCatalogError::Storage(
                friday_storage::StorageError::NotFound(_)
            ))
        ));
        assert!(matches!(
            publish(conn, "ghost", 1),
            Err(WorkflowCatalogError::NotFound(_))
        ));
        assert!(matches!(
            deploy(conn, "ghost", 1, 1),
            Err(WorkflowCatalogError::NotFound(_))
        ));

        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();

        // STALE revision (optimistic concurrency) fails closed, no write.
        assert!(matches!(
            update(conn, "wf1", 99, Some("x"), None, None, 200),
            Err(WorkflowCatalogError::Storage(
                friday_storage::StorageError::Unsupported(_)
            ))
        ));
        assert_eq!(get(conn, "wf1").unwrap().unwrap().name, "WF", "no write");

        // duplicate slug fails closed.
        assert!(create(
            conn,
            "wf2",
            "wf",
            "Another",
            None,
            None,
            &def("Another"),
            300
        )
        .is_err());

        // ARCHIVED entry is read-only: update / publish / deploy / add_version all refuse.
        archive(conn, "wf1", 1, 400).unwrap();
        assert!(matches!(
            update(conn, "wf1", 2, Some("x"), None, None, 500),
            Err(WorkflowCatalogError::Storage(
                friday_storage::StorageError::Unsupported(_)
            ))
        ));
        assert!(matches!(
            publish(conn, "wf1", 1),
            Err(WorkflowCatalogError::Conflict(_))
        ));
        assert!(matches!(
            deploy(conn, "wf1", 2, 500),
            Err(WorkflowCatalogError::Conflict(_))
        ));
        assert!(matches!(
            add_version(conn, "wf1", 2, &def("WF"), 500),
            Err(WorkflowCatalogError::Conflict(_))
        ));
        // archiving twice fails closed.
        assert!(archive(conn, "wf1", 2, 600).is_err());
    }

    #[test]
    fn create_rejects_invalid_identity_and_body() {
        let db = Db::open_hub(&tmp("invalid")).unwrap();
        let conn = db.conn();
        // empty slug.
        assert!(matches!(
            create(conn, "wf1", "  ", "WF", None, None, &def("WF"), 1),
            Err(WorkflowCatalogError::Invalid(_))
        ));
        // over-long slug.
        let long = "s".repeat(MAX_SLUG_LEN + 1);
        assert!(matches!(
            create(conn, "wf1", &long, "WF", None, None, &def("WF"), 1),
            Err(WorkflowCatalogError::Invalid(_))
        ));
        // empty name.
        assert!(matches!(
            create(conn, "wf1", "wf", "  ", None, None, &def("WF"), 1),
            Err(WorkflowCatalogError::Invalid(_))
        ));
        // invalid body (no steps) → S8 definition error; nothing persists.
        let mut bad = def("WF");
        bad.steps.clear();
        assert!(matches!(
            create(conn, "wf1", "wf", "WF", None, None, &bad, 1),
            Err(WorkflowCatalogError::Definition(_))
        ));
        assert!(get(conn, "wf1").unwrap().is_none(), "no half-created entry");
    }

    #[test]
    fn create_is_atomic_entry_and_v1_body_land_together() {
        // A duplicate workflow_id on the SECOND create must not leave a dangling
        // v1 body, and the FIRST create's entry+body are both present.
        let db = Db::open_hub(&tmp("atomic")).unwrap();
        let conn = db.conn();
        create(conn, "wf1", "wf", "WF", None, None, &def("WF"), 100).unwrap();
        assert!(get(conn, "wf1").unwrap().is_some());
        assert!(def_get(conn, "wf1", 1).unwrap().is_some());
        // second create with same id (different slug) fails closed at the entry PK,
        // and rolls back so no spurious v1 body for a non-entry is left behind.
        assert!(create(conn, "wf1", "wf-other", "WF2", None, None, &def("WF2"), 200).is_err());
        // the original is intact.
        assert_eq!(get(conn, "wf1").unwrap().unwrap().name, "WF");
    }
}
