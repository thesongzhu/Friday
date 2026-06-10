//! S9 read-only workflow-run projection helpers (`workflow_read`): refs-only
//! summaries of `workflow_run` + `workflow_step` for the readback bridge. The
//! discriminating property: the `evidence_ref` TEXT is structurally
//! unselectable — only its presence (`has_evidence`) is projected.

mod common;

use common::temp_db_path;
use friday_core::WorkflowRunState;
use friday_storage::workflow_read::{get_workflow_run_summary, list_workflow_step_summaries};
use friday_storage::{workflow, Db};

#[test]
fn run_summary_projects_labels_and_is_none_for_an_unknown_run() {
    let db = Db::open_hub(&temp_db_path("wfread-run")).unwrap();
    workflow::create_run(db.conn(), "r1", "research", 100).unwrap();
    workflow::set_run_state(db.conn(), "r1", WorkflowRunState::Running, 200).unwrap();

    let s = get_workflow_run_summary(db.conn(), "r1").unwrap().unwrap();
    assert_eq!(s.run_id, "r1");
    assert_eq!(s.name, "research");
    assert_eq!(s.state, "running");
    assert_eq!(s.created_at, 100);
    assert_eq!(s.updated_at, 200);

    assert!(get_workflow_run_summary(db.conn(), "ghost")
        .unwrap()
        .is_none());
}

#[test]
fn step_summaries_are_seq_ordered_and_project_evidence_presence_never_its_text() {
    let db = Db::open_hub(&temp_db_path("wfread-steps")).unwrap();
    workflow::create_run(db.conn(), "r1", "qa", 1).unwrap();

    // s0: side-effect step verified WITH evidence (the ref text embeds a
    // relative filename, exactly what the engine's tool receipts store).
    workflow::add_step(db.conn(), "r1:s0", "r1", 0, true, 1).unwrap();
    workflow::complete_step(
        db.conn(),
        "r1:s0",
        Some("read 14 bytes from notes.txt"),
        true,
        2,
    )
    .unwrap();
    // s1: pending checkpoint (no evidence).
    workflow::add_step(db.conn(), "r1:s1", "r1", 1, true, 3).unwrap();

    let steps = list_workflow_step_summaries(db.conn(), "r1").unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[0].step_id, "r1:s0");
    assert_eq!(steps[0].seq, 0);
    assert!(steps[0].has_side_effect);
    assert_eq!(steps[0].status, "verified");
    assert!(steps[0].has_evidence, "evidence presence IS projected");
    assert_eq!(steps[1].step_id, "r1:s1");
    assert_eq!(steps[1].status, "pending");
    assert!(!steps[1].has_evidence);

    // The refs-only property: the summary type has no evidence-text field, so
    // the stored filename cannot travel through this projection. (Compile-time
    // structural; asserted here over the debug rendering as a belt-and-braces
    // canary.)
    let rendered = format!("{steps:?}");
    assert!(
        !rendered.contains("notes.txt") && !rendered.contains("bytes from"),
        "evidence text must be unselectable through workflow_read: {rendered}"
    );

    // An unknown run projects an empty list (not an error — the run-existence
    // decision belongs to the run-summary lookup).
    assert!(list_workflow_step_summaries(db.conn(), "ghost")
        .unwrap()
        .is_empty());
}
