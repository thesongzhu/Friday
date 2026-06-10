//! S8 workflow-definition persistence tests (DARK substrate): versioned
//! immutable rows, derived + verified checksum, single-published invariant,
//! fail-closed deletes, refs-only listing, and the additive v21→v22 forward
//! migration.

mod common;

use common::temp_db_path;
use friday_storage::workflow_def::{
    create_definition, delete_definition, get_definition, get_published_definition,
    list_definitions, set_published, DefinitionSource, NewWorkflowDefinition,
};
use friday_storage::{hub_migrations, Db, Profile, StorageError};

fn hub_max_version() -> i64 {
    hub_migrations().iter().map(|m| m.version).max().unwrap()
}

fn def<'a>(workflow_id: &'a str, version: i64, json: &'a str) -> NewWorkflowDefinition<'a> {
    NewWorkflowDefinition {
        workflow_id,
        version,
        name: "research",
        definition_json: json,
        source: DefinitionSource::RustNative,
        source_meta: None,
    }
}

const JSON_V1: &str = r#"{"schema_version":1,"name":"research","steps":[]}"#;
const JSON_V2: &str = r#"{"schema_version":1,"name":"research","steps":[{"id":"a"}]}"#;

#[test]
fn create_get_roundtrip_with_derived_checksum() {
    let db = Db::open_hub(&temp_db_path("wfdef-roundtrip")).unwrap();
    let checksum = create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    assert_eq!(checksum.len(), 64, "sha256 lowercase hex");

    let row = get_definition(db.conn(), "wf1", 1).unwrap().unwrap();
    assert_eq!(row.workflow_id, "wf1");
    assert_eq!(row.version, 1);
    assert_eq!(row.name, "research");
    assert_eq!(row.definition_json, JSON_V1);
    assert_eq!(row.checksum, checksum);
    assert_eq!(row.source, DefinitionSource::RustNative);
    assert!(!row.is_published, "a new version starts unpublished");
    assert_eq!(row.created_at, 100);

    // missing version reads back as None (not an error).
    assert!(get_definition(db.conn(), "wf1", 99).unwrap().is_none());
}

#[test]
fn duplicate_version_fails_closed_immutable() {
    let db = Db::open_hub(&temp_db_path("wfdef-dup")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    // The same (workflow_id, version) can never be overwritten (PK violation).
    assert!(create_definition(db.conn(), &def("wf1", 1, JSON_V2), 200).is_err());
    // ...but a NEW version and a different workflow both insert fine.
    create_definition(db.conn(), &def("wf1", 2, JSON_V2), 200).unwrap();
    create_definition(db.conn(), &def("wf2", 1, JSON_V1), 300).unwrap();
}

#[test]
fn tampered_body_fails_closed_on_read() {
    let db = Db::open_hub(&temp_db_path("wfdef-tamper")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    // Hand-edit the body OUTSIDE the typed API (checksum now stale).
    db.conn()
        .execute(
            "UPDATE workflow_definition SET definition_json = ?1 WHERE workflow_id = 'wf1'",
            [JSON_V2],
        )
        .unwrap();
    let err = get_definition(db.conn(), "wf1", 1).unwrap_err();
    assert!(
        err.to_string().contains("integrity"),
        "tampered row must fail closed: {err}"
    );
}

#[test]
fn publish_is_exclusive_and_publish_missing_version_changes_nothing() {
    let db = Db::open_hub(&temp_db_path("wfdef-publish")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    create_definition(db.conn(), &def("wf1", 2, JSON_V2), 200).unwrap();

    // no published version yet.
    assert!(get_published_definition(db.conn(), "wf1")
        .unwrap()
        .is_none());

    set_published(db.conn(), "wf1", 1).unwrap();
    assert_eq!(
        get_published_definition(db.conn(), "wf1")
            .unwrap()
            .unwrap()
            .version,
        1
    );

    // publishing v2 unpublishes v1 in the same call (at most ONE published).
    set_published(db.conn(), "wf1", 2).unwrap();
    let published = get_published_definition(db.conn(), "wf1").unwrap().unwrap();
    assert_eq!(published.version, 2);
    let flags: Vec<bool> = list_definitions(db.conn())
        .unwrap()
        .into_iter()
        .map(|s| s.is_published)
        .collect();
    assert_eq!(
        flags.iter().filter(|p| **p).count(),
        1,
        "exactly one published version"
    );

    // publishing a MISSING version is fail-closed AND leaves v2 published
    // (the unpublish never runs without a valid target).
    assert!(matches!(
        set_published(db.conn(), "wf1", 99),
        Err(StorageError::NotFound(_))
    ));
    assert_eq!(
        get_published_definition(db.conn(), "wf1")
            .unwrap()
            .unwrap()
            .version,
        2,
        "failed publish must not unpublish the current version"
    );
}

#[test]
fn double_publish_end_state_is_unrepresentable_at_the_db_layer() {
    // Review finding (PR #623 panel): the single-published invariant was
    // app-layer only — an interleaved second writer (or raw SQL) could leave
    // TWO is_published=1 rows. The partial UNIQUE index in m0022 makes that end
    // state unrepresentable even OUTSIDE the typed API.
    let db = Db::open_hub(&temp_db_path("wfdef-unique")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    create_definition(db.conn(), &def("wf1", 2, JSON_V2), 200).unwrap();
    set_published(db.conn(), "wf1", 1).unwrap();

    // The raw-SQL equivalent of the interleaved second publisher's final SET.
    let err = db
        .conn()
        .execute(
            "UPDATE workflow_definition SET is_published = 1
             WHERE workflow_id = 'wf1' AND version = 2",
            [],
        )
        .unwrap_err();
    assert!(
        err.to_string().to_lowercase().contains("unique"),
        "second published row must violate the partial unique index: {err}"
    );
    // ...while a DIFFERENT workflow's published row coexists fine.
    create_definition(db.conn(), &def("wf2", 1, JSON_V1), 300).unwrap();
    set_published(db.conn(), "wf2", 1).unwrap();
}

#[test]
fn get_published_fails_closed_on_an_ambiguous_multi_published_state() {
    // Defense in depth: even if the unique index is gone (hand-rebuilt DB), the
    // reader must refuse an ambiguous state instead of returning an arbitrary row.
    let db = Db::open_hub(&temp_db_path("wfdef-ambiguous")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    create_definition(db.conn(), &def("wf1", 2, JSON_V2), 200).unwrap();
    db.conn()
        .execute_batch(
            "DROP INDEX idx_workflow_definition_one_published;
             UPDATE workflow_definition SET is_published = 1 WHERE workflow_id = 'wf1';",
        )
        .unwrap();
    let err = get_published_definition(db.conn(), "wf1").unwrap_err();
    assert!(
        err.to_string().contains("2 published versions"),
        "ambiguous published state must fail closed, never resolve silently: {err}"
    );
}

#[test]
fn set_published_is_transactional_failed_target_rolls_back_the_clear() {
    // Review finding: the clear-UPDATE and set-UPDATE used to be separate
    // autocommit statements (crash window → ZERO published; deleted target →
    // silent Ok). Now: one transaction + changed-row check, so a 0-row target
    // rolls the clear back and the previous published version SURVIVES.
    let db = Db::open_hub(&temp_db_path("wfdef-atomic")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    set_published(db.conn(), "wf1", 1).unwrap();

    assert!(matches!(
        set_published(db.conn(), "wf1", 99),
        Err(StorageError::NotFound(_))
    ));
    assert_eq!(
        get_published_definition(db.conn(), "wf1")
            .unwrap()
            .unwrap()
            .version,
        1,
        "the failed publish must roll back its sibling-clear (v1 stays published)"
    );
}

#[test]
fn delete_is_fail_closed_for_missing_and_published_versions() {
    let db = Db::open_hub(&temp_db_path("wfdef-delete")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    create_definition(db.conn(), &def("wf1", 2, JSON_V2), 200).unwrap();
    set_published(db.conn(), "wf1", 2).unwrap();

    // deleting a missing version is NotFound, never a silent success.
    assert!(matches!(
        delete_definition(db.conn(), "wf1", 99),
        Err(StorageError::NotFound(_))
    ));
    // deleting the PUBLISHED version is refused (the pointer can never dangle).
    assert!(delete_definition(db.conn(), "wf1", 2).is_err());
    assert!(get_published_definition(db.conn(), "wf1")
        .unwrap()
        .is_some());

    // deleting an unpublished version works.
    delete_definition(db.conn(), "wf1", 1).unwrap();
    assert!(get_definition(db.conn(), "wf1", 1).unwrap().is_none());
    assert!(get_definition(db.conn(), "wf1", 2).unwrap().is_some());
}

#[test]
fn list_is_refs_only_summary_and_ordered() {
    let db = Db::open_hub(&temp_db_path("wfdef-list")).unwrap();
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    create_definition(db.conn(), &def("wf1", 2, JSON_V2), 200).unwrap();
    create_definition(
        db.conn(),
        &NewWorkflowDefinition {
            workflow_id: "wf2",
            version: 1,
            name: "ship",
            definition_json: JSON_V1,
            source: DefinitionSource::TsTranslated,
            source_meta: Some(r#"{"node_count":3}"#),
        },
        300,
    )
    .unwrap();

    let all = list_definitions(db.conn()).unwrap();
    assert_eq!(all.len(), 3);
    // ordered by workflow_id, then newest version first.
    assert_eq!(
        all.iter()
            .map(|s| (s.workflow_id.as_str(), s.version))
            .collect::<Vec<_>>(),
        vec![("wf1", 2), ("wf1", 1), ("wf2", 1)]
    );
    assert_eq!(all[2].source, DefinitionSource::TsTranslated);
    assert_eq!(all[2].name, "ship");
    // The summary type carries NO body fields — enforced at compile time by the
    // struct shape; here we assert the checksum is the only body-derived field.
    assert_eq!(all[0].checksum.len(), 64);
}

#[test]
fn forward_migration_v21_to_v22_adds_workflow_definition_table() {
    let p = temp_db_path("wfdef-mig");
    {
        let mut migs = hub_migrations();
        migs.retain(|m| m.version <= 21);
        let db = Db::open(&p, Profile::Hub, &migs, "v21").unwrap();
        assert_eq!(db.version().unwrap(), 21);
        assert!(
            !db.table_names()
                .unwrap()
                .iter()
                .any(|t| t == "workflow_definition"),
            "pre-v22 DB must not have workflow_definition"
        );
    }
    // Re-open with the full set: the additive migration applies and the table works.
    let db = Db::open_hub(&p).unwrap();
    assert_eq!(db.version().unwrap(), hub_max_version());
    create_definition(db.conn(), &def("wf1", 1, JSON_V1), 100).unwrap();
    assert!(get_definition(db.conn(), "wf1", 1).unwrap().is_some());
    // The MIGRATED DB carries the single-published partial unique index too
    // (m0022 was amended pre-ship; forward-only migrations make a later fix a v23).
    let idx: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'index'
             AND name = 'idx_workflow_definition_one_published'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        idx, 1,
        "v21→v22 migration must create the partial unique index"
    );
}
