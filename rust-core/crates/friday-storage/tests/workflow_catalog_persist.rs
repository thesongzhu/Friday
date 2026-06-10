//! R3 workflow-catalog persistence tests (DARK substrate): created birth state,
//! derived + bound etag, slug uniqueness, optimistic-concurrency conflict,
//! fail-closed mutations on missing/archived entries, the deploy pointer, and the
//! additive v24→v25 forward migration. Mirrors the S8 `workflow_def_persist`
//! style.

mod common;

use common::temp_db_path;
use friday_storage::workflow_catalog::{
    archive_entry, create_entry, get_entry, list_entries, set_deployed_version, update_entry,
    NewWorkflowCatalogEntry, WorkflowCatalogUpdate,
};
use friday_storage::{hub_migrations, Db, Profile, StorageError};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn entry<'a>(workflow_id: &'a str, slug: &'a str) -> NewWorkflowCatalogEntry<'a> {
    NewWorkflowCatalogEntry {
        workflow_id,
        slug,
        name: "Workflow",
        description: None,
        tags_json: None,
    }
}

#[test]
fn create_births_revision_1_unarchived_with_derived_etag() {
    let db = Db::open_hub(&temp_db_path("wfcat-create")).unwrap();
    let etag = create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();
    assert_eq!(etag.len(), 64, "sha256 lowercase hex etag");

    let row = get_entry(db.conn(), "wf1").unwrap().unwrap();
    assert_eq!(row.workflow_id, "wf1");
    assert_eq!(row.slug, "slug-1");
    assert_eq!(row.name, "Workflow");
    assert_eq!(row.tags_json, "[]", "tags default to empty array");
    assert!(!row.is_archived, "born unarchived");
    assert_eq!(row.revision, 1, "born at revision 1");
    assert_eq!(row.etag, etag);
    assert_eq!(row.deployed_version, None, "born with no deploy pointer");
    assert_eq!(row.created_at, 100);
    assert_eq!(row.updated_at, 100);

    // missing entry reads back as None (not an error).
    assert!(get_entry(db.conn(), "ghost").unwrap().is_none());
}

#[test]
fn slug_uniqueness_is_db_enforced() {
    let db = Db::open_hub(&temp_db_path("wfcat-slug")).unwrap();
    create_entry(db.conn(), &entry("wf1", "shared"), 100).unwrap();
    // a second entry with the SAME slug fails closed (unique index).
    let err = create_entry(db.conn(), &entry("wf2", "shared"), 200).unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("unique"),
        "duplicate slug must violate the unique index: {err}"
    );
    // a different slug inserts fine.
    create_entry(db.conn(), &entry("wf2", "other"), 200).unwrap();
    // a duplicate workflow_id (PK) also fails closed.
    assert!(create_entry(db.conn(), &entry("wf1", "fresh"), 300).is_err());
}

#[test]
fn update_bumps_revision_rederives_etag_and_partial_patches() {
    let db = Db::open_hub(&temp_db_path("wfcat-update")).unwrap();
    let e0 = create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();

    // PATCH name only (description/tags untouched).
    let (rev, etag) = update_entry(
        db.conn(),
        "wf1",
        1,
        &WorkflowCatalogUpdate {
            name: Some("Renamed"),
            description: None,
            tags_json: None,
        },
        200,
    )
    .unwrap();
    assert_eq!(rev, 2, "revision bumps on update");
    assert_ne!(etag, e0, "etag re-derived");
    let row = get_entry(db.conn(), "wf1").unwrap().unwrap();
    assert_eq!(row.name, "Renamed");
    assert_eq!(row.description, None);
    assert_eq!(row.etag, etag);
    assert_eq!(row.updated_at, 200);

    // set description, then clear it (Some(None) clears to NULL).
    update_entry(
        db.conn(),
        "wf1",
        2,
        &WorkflowCatalogUpdate {
            name: None,
            description: Some(Some("desc")),
            tags_json: Some(r#"["x"]"#),
        },
        300,
    )
    .unwrap();
    let row = get_entry(db.conn(), "wf1").unwrap().unwrap();
    assert_eq!(row.description.as_deref(), Some("desc"));
    assert_eq!(row.tags_json, r#"["x"]"#);

    update_entry(
        db.conn(),
        "wf1",
        3,
        &WorkflowCatalogUpdate {
            name: None,
            description: Some(None),
            tags_json: None,
        },
        400,
    )
    .unwrap();
    assert_eq!(
        get_entry(db.conn(), "wf1").unwrap().unwrap().description,
        None
    );
}

#[test]
fn stale_revision_fails_closed_and_writes_nothing() {
    let db = Db::open_hub(&temp_db_path("wfcat-stale")).unwrap();
    create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();
    // expected revision 99 != stored 1 → conflict, no write.
    let err = update_entry(
        db.conn(),
        "wf1",
        99,
        &WorkflowCatalogUpdate {
            name: Some("Renamed"),
            ..Default::default()
        },
        200,
    )
    .unwrap_err();
    assert!(matches!(err, StorageError::Unsupported(_)));
    assert!(err.to_string().contains("revision conflict"));
    let row = get_entry(db.conn(), "wf1").unwrap().unwrap();
    assert_eq!(row.name, "Workflow", "stale update wrote nothing");
    assert_eq!(row.revision, 1);
}

#[test]
fn mutations_on_missing_entries_are_notfound() {
    let db = Db::open_hub(&temp_db_path("wfcat-missing")).unwrap();
    assert!(matches!(
        update_entry(db.conn(), "ghost", 1, &WorkflowCatalogUpdate::default(), 1),
        Err(StorageError::NotFound(_))
    ));
    assert!(matches!(
        archive_entry(db.conn(), "ghost", 1, 1),
        Err(StorageError::NotFound(_))
    ));
    assert!(matches!(
        set_deployed_version(db.conn(), "ghost", 1, 1, 1),
        Err(StorageError::NotFound(_))
    ));
}

#[test]
fn archive_is_soft_state_and_makes_the_entry_read_only() {
    let db = Db::open_hub(&temp_db_path("wfcat-archive")).unwrap();
    create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();
    let (rev, _) = archive_entry(db.conn(), "wf1", 1, 200).unwrap();
    assert_eq!(rev, 2);
    let row = get_entry(db.conn(), "wf1").unwrap().unwrap();
    assert!(row.is_archived, "soft-deleted, row still present");

    // an archived entry refuses update / deploy / re-archive (fail-closed).
    assert!(matches!(
        update_entry(
            db.conn(),
            "wf1",
            2,
            &WorkflowCatalogUpdate {
                name: Some("x"),
                ..Default::default()
            },
            300
        ),
        Err(StorageError::Unsupported(_))
    ));
    assert!(matches!(
        set_deployed_version(db.conn(), "wf1", 2, 1, 300),
        Err(StorageError::Unsupported(_))
    ));
    assert!(matches!(
        archive_entry(db.conn(), "wf1", 2, 300),
        Err(StorageError::Unsupported(_))
    ));
}

#[test]
fn set_deployed_version_records_the_pointer_under_concurrency() {
    let db = Db::open_hub(&temp_db_path("wfcat-deploy")).unwrap();
    create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();
    let (rev, etag) = set_deployed_version(db.conn(), "wf1", 1, 3, 200).unwrap();
    assert_eq!(rev, 2);
    let row = get_entry(db.conn(), "wf1").unwrap().unwrap();
    assert_eq!(row.deployed_version, Some(3));
    assert_eq!(row.etag, etag);
    // a non-positive version is unrepresentable (the row CHECK rejects < 1).
    let err = set_deployed_version(db.conn(), "wf1", 2, 0, 300).unwrap_err();
    assert!(matches!(err, StorageError::Sqlite(_)));
}

#[test]
fn list_is_refs_only_and_newest_created_first() {
    let db = Db::open_hub(&temp_db_path("wfcat-list")).unwrap();
    create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();
    create_entry(db.conn(), &entry("wf2", "slug-2"), 200).unwrap();
    create_entry(db.conn(), &entry("wf3", "slug-3"), 300).unwrap();
    let all = list_entries(db.conn()).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(
        all.iter()
            .map(|r| r.workflow_id.as_str())
            .collect::<Vec<_>>(),
        vec!["wf3", "wf2", "wf1"],
        "newest-created first"
    );
}

#[test]
fn forward_migration_v24_to_v25_adds_workflow_catalog_table() {
    let p = temp_db_path("wfcat-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 24);
        let db = Db::open(&p, Profile::Hub, &migs, "v24").unwrap();
        assert_eq!(db.version().unwrap(), 24);
        assert!(
            !db.table_names()
                .unwrap()
                .iter()
                .any(|t| t == "workflow_catalog"),
            "pre-v25 DB must not have workflow_catalog"
        );
    }
    // Re-open with the full set: the additive migration applies and the table works.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    create_entry(db.conn(), &entry("wf1", "slug-1"), 100).unwrap();
    assert!(get_entry(db.conn(), "wf1").unwrap().is_some());
    // The migrated DB carries the unique slug index.
    let idx: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'index'
             AND name = 'idx_workflow_catalog_slug'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        idx, 1,
        "v24→v25 migration must create the slug unique index"
    );
}
