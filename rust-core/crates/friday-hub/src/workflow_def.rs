//! S8 — the Rust workflow DEFINITION layer: versioned serde definition format
//! (LINEAR-only) + the loader that turns a stored definition into the exact
//! executable form the EXISTING [`crate::workflow_exec`] engine consumes +
//! definition CRUD over [`friday_storage::workflow_def`].
//!
//! ## Scope and truth labels (DARK substrate)
//! - This is the DEFINITION layer only. It registers NO production route, NO
//!   scheduler/trigger/daemon (that is S10, operator-gated), and changes NO TS
//!   runtime file. Workflow execution remains fenced in TS and is NOT
//!   product-replaced; NOT v1 GO.
//! - There is NO second executor here: [`load_definition`] produces a
//!   [`crate::planner::WorkflowDefinition`] — the SAME type
//!   [`crate::workflow_exec::run_workflow`] already executes through the
//!   planner + gate chokepoints. The step vocabulary is the planner's
//!   ([`crate::planner::WorkflowStep`]); this module adds serde + storage on
//!   top, never a parallel vocabulary.
//!
//! ## The stored format: `schema_version`-tagged, linear-only, fail-closed
//! [`StoredWorkflowDefV1`] is the JSON body persisted in
//! `workflow_definition.definition_json`. It is an ORDERED list of steps —
//! linearity is structural (there is no edges/branches field to mis-parse).
//! Parsing is fail-closed twice over:
//! - an unknown/missing `schema_version` is an explicit
//!   [`WorkflowDefError::UnsupportedSchemaVersion`] (a future v2 body never
//!   half-parses), and
//! - `deny_unknown_fields` rejects any body carrying fields this version does
//!   not model (e.g. a DAG-shaped document with `edges`), so an unsupported
//!   shape can never silently load as a linear workflow.
//!
//! The loader additionally re-validates the parsed definition (non-empty
//! steps, unique non-empty step ids, non-empty actions) and cross-checks the
//! stored row's `name` column against the body's `name` (a hand-edited
//! divergent pair fails closed; the storage layer already fails closed on a
//! checksum mismatch).

use crate::planner::{WorkflowDefinition, WorkflowStep};
use friday_storage::workflow_def::{
    create_definition as store_create, get_definition as store_get,
    get_published_definition as store_get_published, set_published as store_set_published,
    DefinitionSource, NewWorkflowDefinition, WorkflowDefinitionRow,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// The definition-format version this build reads and writes.
pub const WORKFLOW_DEF_SCHEMA_VERSION: u32 = 1;

/// One stored step — the serde twin of [`crate::planner::WorkflowStep`] (same
/// fields, same semantics; the planner/gate floors still decide disposition at
/// run time, so nothing in this format can mark a mutating step "safe").
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredWorkflowStepV1 {
    pub id: String,
    /// The Rust [`crate::ToolRegistry`] action name (e.g. `read_file`). An
    /// unknown action is NOT rejected here — the planner fail-closes it to an
    /// `Unclassifiable` checkpoint and the gate refuses to dispatch it, the
    /// same path every other unknown action takes.
    pub action: String,
    #[serde(default)]
    pub params: Vec<(String, String)>,
    /// Template checkpoint policy — may only NARROW (add a checkpoint), never
    /// widen; the planner enforces that (`crate::planner::plan_step`).
    #[serde(default)]
    pub force_checkpoint: bool,
    #[serde(default)]
    pub evidence_required: bool,
}

/// A versioned, LINEAR-only stored workflow definition (see module docs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StoredWorkflowDefV1 {
    /// Must equal [`WORKFLOW_DEF_SCHEMA_VERSION`]; checked BEFORE strict
    /// parsing so a future format yields an honest version error.
    pub schema_version: u32,
    pub name: String,
    /// Ordered steps — executed first-to-last by `workflow_exec`. Linearity is
    /// structural: there is no edge/branch/parallel field in this format.
    pub steps: Vec<StoredWorkflowStepV1>,
}

/// Fail-closed errors of the definition layer.
#[derive(Debug, thiserror::Error)]
pub enum WorkflowDefError {
    #[error("workflow definition JSON failed to parse: {0}")]
    Parse(String),
    #[error(
        "unsupported workflow definition schema_version {found} \
         (this build supports exactly {supported})"
    )]
    UnsupportedSchemaVersion { found: u32, supported: u32 },
    #[error("workflow definition invalid: {0}")]
    Invalid(String),
    #[error("workflow definition not found: {0}")]
    NotFound(String),
    #[error("storage error: {0}")]
    Storage(#[from] friday_storage::StorageError),
}

impl StoredWorkflowDefV1 {
    /// Build the stored form from the planner's executable form (identity
    /// mapping plus the schema tag).
    pub fn from_executable(def: &WorkflowDefinition) -> Self {
        StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: def.name.clone(),
            steps: def
                .steps
                .iter()
                .map(|s| StoredWorkflowStepV1 {
                    id: s.id.clone(),
                    action: s.action.clone(),
                    params: s.params.clone(),
                    force_checkpoint: s.force_checkpoint,
                    evidence_required: s.evidence_required,
                })
                .collect(),
        }
    }

    /// Produce the executable form the EXISTING engine
    /// ([`crate::workflow_exec::run_workflow`]) consumes. Pure mapping — the
    /// planner + gate still decide every step's disposition at run time.
    pub fn to_executable(&self) -> WorkflowDefinition {
        WorkflowDefinition {
            name: self.name.clone(),
            steps: self
                .steps
                .iter()
                .map(|s| WorkflowStep {
                    id: s.id.clone(),
                    action: s.action.clone(),
                    params: s.params.clone(),
                    force_checkpoint: s.force_checkpoint,
                    evidence_required: s.evidence_required,
                })
                .collect(),
        }
    }

    /// Structural validation (beyond serde): version tag, non-empty name,
    /// non-empty step list, unique non-empty step ids, non-empty actions.
    pub fn validate(&self) -> Result<(), WorkflowDefError> {
        if self.schema_version != WORKFLOW_DEF_SCHEMA_VERSION {
            return Err(WorkflowDefError::UnsupportedSchemaVersion {
                found: self.schema_version,
                supported: WORKFLOW_DEF_SCHEMA_VERSION,
            });
        }
        if self.name.trim().is_empty() {
            return Err(WorkflowDefError::Invalid("name must be non-empty".into()));
        }
        if self.steps.is_empty() {
            return Err(WorkflowDefError::Invalid(
                "a definition must have at least one step (an empty workflow would \
                 complete vacuously)"
                    .into(),
            ));
        }
        let mut seen = std::collections::HashSet::new();
        for (i, step) in self.steps.iter().enumerate() {
            if step.id.trim().is_empty() {
                return Err(WorkflowDefError::Invalid(format!(
                    "steps[{i}] has an empty id"
                )));
            }
            if !seen.insert(step.id.as_str()) {
                return Err(WorkflowDefError::Invalid(format!(
                    "duplicate step id '{}'",
                    step.id
                )));
            }
            if step.action.trim().is_empty() {
                return Err(WorkflowDefError::Invalid(format!(
                    "steps[{i}] ('{}') has an empty action",
                    step.id
                )));
            }
        }
        Ok(())
    }
}

/// Serialize a validated definition to its canonical stored JSON.
pub fn definition_to_json(def: &StoredWorkflowDefV1) -> Result<String, WorkflowDefError> {
    def.validate()?;
    serde_json::to_string(def).map_err(|e| WorkflowDefError::Parse(e.to_string()))
}

/// Parse + validate a stored definition body. Fail-closed: the version tag is
/// probed FIRST (honest error for foreign versions), then the strict
/// (`deny_unknown_fields`) parse rejects any unsupported shape, then
/// [`StoredWorkflowDefV1::validate`] re-checks structure.
pub fn parse_definition_json(json: &str) -> Result<StoredWorkflowDefV1, WorkflowDefError> {
    #[derive(Deserialize)]
    struct VersionProbe {
        schema_version: Option<u32>,
    }
    let probe: VersionProbe =
        serde_json::from_str(json).map_err(|e| WorkflowDefError::Parse(e.to_string()))?;
    match probe.schema_version {
        Some(v) if v == WORKFLOW_DEF_SCHEMA_VERSION => {}
        Some(v) => {
            return Err(WorkflowDefError::UnsupportedSchemaVersion {
                found: v,
                supported: WORKFLOW_DEF_SCHEMA_VERSION,
            })
        }
        None => {
            return Err(WorkflowDefError::Invalid(
                "missing schema_version tag".into(),
            ))
        }
    }
    let def: StoredWorkflowDefV1 =
        serde_json::from_str(json).map_err(|e| WorkflowDefError::Parse(e.to_string()))?;
    def.validate()?;
    Ok(def)
}

/// CREATE: persist a validated definition as a new immutable version
/// (unpublished). Returns the derived checksum. A duplicate
/// `(workflow_id, version)` fails closed at the storage PK.
pub fn create_definition(
    conn: &Connection,
    workflow_id: &str,
    version: i64,
    def: &StoredWorkflowDefV1,
    source: DefinitionSource,
    source_meta: Option<&str>,
    now_ms: i64,
) -> Result<String, WorkflowDefError> {
    let json = definition_to_json(def)?;
    Ok(store_create(
        conn,
        &NewWorkflowDefinition {
            workflow_id,
            version,
            name: &def.name,
            definition_json: &json,
            source,
            source_meta,
        },
        now_ms,
    )?)
}

/// CREATE + PUBLISH in one call — the "store-published-version" entry that
/// mirrors ingesting a TS published version. Returns the derived checksum.
pub fn store_published_version(
    conn: &Connection,
    workflow_id: &str,
    version: i64,
    def: &StoredWorkflowDefV1,
    source: DefinitionSource,
    source_meta: Option<&str>,
    now_ms: i64,
) -> Result<String, WorkflowDefError> {
    let checksum = create_definition(conn, workflow_id, version, def, source, source_meta, now_ms)?;
    store_set_published(conn, workflow_id, version)?;
    Ok(checksum)
}

/// GET (parsed): read one stored version and parse its body fail-closed.
pub fn get_parsed_definition(
    conn: &Connection,
    workflow_id: &str,
    version: i64,
) -> Result<StoredWorkflowDefV1, WorkflowDefError> {
    let row = store_get(conn, workflow_id, version)?
        .ok_or_else(|| WorkflowDefError::NotFound(format!("'{workflow_id}' v{version}")))?;
    parse_row(row)
}

/// LOADER: load a stored definition by id/version and produce the executable
/// [`WorkflowDefinition`] the EXISTING [`crate::workflow_exec`] engine consumes.
pub fn load_definition(
    conn: &Connection,
    workflow_id: &str,
    version: i64,
) -> Result<WorkflowDefinition, WorkflowDefError> {
    Ok(get_parsed_definition(conn, workflow_id, version)?.to_executable())
}

/// LOADER (published): load the PUBLISHED version of a workflow into the
/// executable form. Fail-closed when no version is published.
pub fn load_published_definition(
    conn: &Connection,
    workflow_id: &str,
) -> Result<WorkflowDefinition, WorkflowDefError> {
    let row = store_get_published(conn, workflow_id)?.ok_or_else(|| {
        WorkflowDefError::NotFound(format!("'{workflow_id}' (no published version)"))
    })?;
    Ok(parse_row(row)?.to_executable())
}

/// Shared row→definition path: parse the body (version-probed, strict,
/// validated) and cross-check the row's `name` column against the body (a
/// divergent hand-edited pair fails closed — the column is derived from the
/// body at create time, so they can only diverge outside the typed API).
fn parse_row(row: WorkflowDefinitionRow) -> Result<StoredWorkflowDefV1, WorkflowDefError> {
    let def = parse_definition_json(&row.definition_json)?;
    if def.name != row.name {
        return Err(WorkflowDefError::Invalid(format!(
            "stored row name '{}' diverges from definition body name '{}' for '{}' v{} \
             (refusing to load)",
            row.name, def.name, row.workflow_id, row.version
        )));
    }
    Ok(def)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ExecError, ToolExecutor, ToolReceipt};
    use friday_core::gate::{CanonicalApproval, MutatingActionRequest};
    use friday_storage::workflow_def::{delete_definition, list_definitions};
    use friday_storage::Db;
    use std::cell::Cell;
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);
    fn tmp(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-wfdef-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn step(id: &str, action: &str, params: &[(&str, &str)]) -> StoredWorkflowStepV1 {
        StoredWorkflowStepV1 {
            id: id.to_string(),
            action: action.to_string(),
            params: params
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            force_checkpoint: false,
            evidence_required: false,
        }
    }

    fn linear_def() -> StoredWorkflowDefV1 {
        StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: "research".into(),
            steps: vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step("scan", "search", &[("query", "TODO")]),
            ],
        }
    }

    #[test]
    fn serde_roundtrip_preserves_the_definition_exactly() {
        let def = linear_def();
        let json = definition_to_json(&def).unwrap();
        let back = parse_definition_json(&json).unwrap();
        assert_eq!(back, def);
    }

    #[test]
    fn unknown_schema_version_fails_closed_with_an_honest_error() {
        let json = r#"{"schema_version":2,"name":"x","steps":[],"edges":[]}"#;
        match parse_definition_json(json) {
            Err(WorkflowDefError::UnsupportedSchemaVersion { found, supported }) => {
                assert_eq!(found, 2);
                assert_eq!(supported, WORKFLOW_DEF_SCHEMA_VERSION);
            }
            other => panic!("expected UnsupportedSchemaVersion, got {other:?}"),
        }
        // a missing tag is also fail-closed (never defaulted to v1).
        assert!(matches!(
            parse_definition_json(r#"{"name":"x","steps":[]}"#),
            Err(WorkflowDefError::Invalid(_))
        ));
    }

    #[test]
    fn unknown_fields_fail_closed_a_dag_shaped_body_never_loads_as_linear() {
        // A v1-tagged body smuggling DAG fields must be rejected by the strict parse.
        let json = r#"{"schema_version":1,"name":"x",
            "steps":[{"id":"a","action":"read_file"}],
            "edges":[{"from":"a","to":"b"}]}"#;
        assert!(matches!(
            parse_definition_json(json),
            Err(WorkflowDefError::Parse(_))
        ));
        // unknown STEP fields are rejected too (e.g. a per-step branch target).
        let json = r#"{"schema_version":1,"name":"x",
            "steps":[{"id":"a","action":"read_file","on_failure":"b"}]}"#;
        assert!(matches!(
            parse_definition_json(json),
            Err(WorkflowDefError::Parse(_))
        ));
    }

    #[test]
    fn validation_rejects_empty_and_duplicate_shapes() {
        let mut def = linear_def();
        def.steps.clear();
        assert!(matches!(def.validate(), Err(WorkflowDefError::Invalid(_))));

        let mut def = linear_def();
        def.steps[1].id = "read".into(); // duplicate
        assert!(matches!(def.validate(), Err(WorkflowDefError::Invalid(_))));

        let mut def = linear_def();
        def.steps[0].action = "  ".into();
        assert!(matches!(def.validate(), Err(WorkflowDefError::Invalid(_))));

        let mut def = linear_def();
        def.name = "".into();
        assert!(matches!(def.validate(), Err(WorkflowDefError::Invalid(_))));
    }

    #[test]
    fn create_load_roundtrip_produces_the_executable_planner_form() {
        let db = Db::open_hub(&tmp("load")).unwrap();
        create_definition(
            db.conn(),
            "wf1",
            1,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let exec_def = load_definition(db.conn(), "wf1", 1).unwrap();
        assert_eq!(exec_def, linear_def().to_executable());
        assert_eq!(exec_def.name, "research");
        assert_eq!(exec_def.steps.len(), 2);
        assert_eq!(exec_def.steps[0].action, "read_file");
        // loading a missing definition is fail-closed.
        assert!(matches!(
            load_definition(db.conn(), "wf1", 9),
            Err(WorkflowDefError::NotFound(_))
        ));
    }

    #[test]
    fn store_published_version_is_loadable_via_the_published_loader() {
        let db = Db::open_hub(&tmp("published")).unwrap();
        // v1 unpublished, v2 stored-as-published.
        create_definition(
            db.conn(),
            "wf1",
            1,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let mut v2 = linear_def();
        v2.steps.pop();
        store_published_version(
            db.conn(),
            "wf1",
            2,
            &v2,
            DefinitionSource::RustNative,
            None,
            200,
        )
        .unwrap();

        let loaded = load_published_definition(db.conn(), "wf1").unwrap();
        assert_eq!(loaded.steps.len(), 1, "published v2 (one step) loads");
        // a workflow with no published version is fail-closed.
        create_definition(
            db.conn(),
            "wf2",
            1,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            300,
        )
        .unwrap();
        assert!(matches!(
            load_published_definition(db.conn(), "wf2"),
            Err(WorkflowDefError::NotFound(_))
        ));
    }

    #[test]
    fn row_name_divergence_fails_closed_on_load() {
        let db = Db::open_hub(&tmp("name-diverge")).unwrap();
        create_definition(
            db.conn(),
            "wf1",
            1,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        // Hand-edit ONLY the name column (body + checksum still consistent).
        db.conn()
            .execute(
                "UPDATE workflow_definition SET name = 'imposter' WHERE workflow_id = 'wf1'",
                [],
            )
            .unwrap();
        assert!(matches!(
            load_definition(db.conn(), "wf1", 1),
            Err(WorkflowDefError::Invalid(_))
        ));
    }

    // --- the load-bearing seam test: stored definition → EXISTING engine ------

    struct CountingExec {
        calls: Cell<usize>,
    }
    impl ToolExecutor for CountingExec {
        fn execute(
            &self,
            action: &str,
            _params: &[(String, String)],
        ) -> Result<ToolReceipt, ExecError> {
            self.calls.set(self.calls.get() + 1);
            Ok(ToolReceipt {
                action: action.to_string(),
                summary: format!("ran {action}"),
                content: None,
            })
        }
    }

    fn deny_all(_r: &MutatingActionRequest) -> Option<CanonicalApproval> {
        None
    }

    const SECRET: &[u8] = b"wf-def-secret-0123456789abcdef";

    #[test]
    fn loaded_definition_runs_through_the_existing_workflow_exec_engine() {
        // Store → load → run through the UNMODIFIED `workflow_exec::run_workflow`:
        // proves the loader's output IS the engine's input (no second executor,
        // no adapter shim). Both read-only steps auto-advance; the run completes.
        let db = Db::open_hub(&tmp("e2e")).unwrap();
        store_published_version(
            db.conn(),
            "wf1",
            1,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let def = load_published_definition(db.conn(), "wf1").unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let out = crate::workflow_exec::run_workflow(
            &def,
            &exec,
            db.conn(),
            "run1",
            SECRET,
            &deny_all,
            200,
        )
        .unwrap();
        assert_eq!(
            out.status,
            crate::workflow_exec::WorkflowRunStatus::Completed
        );
        assert_eq!(out.executed_steps, 2);
        assert_eq!(exec.calls.get(), 2);
    }

    #[test]
    fn loaded_mutating_step_still_pauses_at_the_gate_floor() {
        // The stored format cannot weaken the floors: a stored write_file step
        // loaded from the DB still checkpoints (planner Mutating) and is NOT
        // executed without approval.
        let db = Db::open_hub(&tmp("e2e-pause")).unwrap();
        let def = StoredWorkflowDefV1 {
            schema_version: WORKFLOW_DEF_SCHEMA_VERSION,
            name: "ship".into(),
            steps: vec![
                step("read", "read_file", &[("path", "notes.txt")]),
                step("write", "write_file", &[("path", "o"), ("content", "y")]),
            ],
        };
        create_definition(
            db.conn(),
            "wf1",
            1,
            &def,
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        let loaded = load_definition(db.conn(), "wf1", 1).unwrap();
        let exec = CountingExec {
            calls: Cell::new(0),
        };
        let out = crate::workflow_exec::run_workflow(
            &loaded,
            &exec,
            db.conn(),
            "run1",
            SECRET,
            &deny_all,
            200,
        )
        .unwrap();
        assert!(matches!(
            out.status,
            crate::workflow_exec::WorkflowRunStatus::AwaitingCheckpoint { .. }
        ));
        assert_eq!(
            exec.calls.get(),
            1,
            "the mutating step must NOT execute without approval"
        );
    }

    #[test]
    fn crud_list_and_delete_compose_with_the_hub_wrappers() {
        let db = Db::open_hub(&tmp("crud")).unwrap();
        create_definition(
            db.conn(),
            "wf1",
            1,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            100,
        )
        .unwrap();
        store_published_version(
            db.conn(),
            "wf1",
            2,
            &linear_def(),
            DefinitionSource::RustNative,
            None,
            200,
        )
        .unwrap();
        let all = list_definitions(db.conn()).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().any(|s| s.version == 2 && s.is_published));
        // delete the unpublished v1; the published v2 stays loadable.
        delete_definition(db.conn(), "wf1", 1).unwrap();
        assert!(load_published_definition(db.conn(), "wf1").is_ok());
        assert!(matches!(
            get_parsed_definition(db.conn(), "wf1", 1),
            Err(WorkflowDefError::NotFound(_))
        ));
    }
}
