//! `Db::list_activity` read projection (used by the phone-side UI).

mod common;

use common::temp_db_path;
use friday_core::{ActivityState, ActivityType};
use friday_storage::{ActivityRow, Db};

#[test]
fn list_activity_returns_summaries_oldest_first() {
    let p = temp_db_path("list-activity");
    let db = Db::open_phone(&p).unwrap();
    assert!(db.list_activity().unwrap().is_empty());

    let row = |id: &str, t: i64| ActivityRow {
        activity_id: id.into(),
        session_id: None,
        kind: ActivityType::AskStatus,
        state: ActivityState::Pending,
        summary: format!("summary-{id}"),
        created_at: t,
        updated_at: t,
        deep_link: None,
    };
    // Insert out of order; list must come back oldest-first.
    db.insert_activity(&row("b", 2)).unwrap();
    db.insert_activity(&row("a", 1)).unwrap();

    let list = db.list_activity().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].activity_id, "a"); // created_at 1 first
    assert_eq!(list[0].kind, "ask_status"); // stored string form
    assert_eq!(list[0].state, "pending");
    assert_eq!(list[0].summary, "summary-a");
    assert_eq!(list[1].activity_id, "b");
}
