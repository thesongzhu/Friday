//! Mission context resolver for live call sites.
//!
//! This is the Hub-side boundary that future provider/channel/workflow entries
//! should use before dispatch. It resolves a surface/work-item hint into the
//! canonical `FridayConversation -> Mission -> WorkItem` context and fails closed
//! on ambiguity instead of letting detached provider/channel work proceed.

use friday_core::{RouteDecisionCard, SurfaceThread, WorkItem};
use friday_storage::{Db, StorageError};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MissionContextLookup {
    pub friday_conversation_id: Option<String>,
    pub mission_id: Option<String>,
    pub work_item_id: Option<String>,
    pub surface_thread_id: Option<String>,
}

impl MissionContextLookup {
    /// Build a lookup from a FIRST-CLASS Mission handle `{friday_conversation_id, mission_id,
    /// work_item_id}` (NS45-PR1 / M-4: the canonical resolution source, replacing the provisional
    /// surface-thread shim for run mission resolution). The three ids are the SAME shape the
    /// `MissionWorkItemContextWire` carries on the wire and the `MissionIntakeResult` emits.
    pub fn by_mission_work_item(
        friday_conversation_id: impl Into<String>,
        mission_id: impl Into<String>,
        work_item_id: impl Into<String>,
    ) -> Self {
        Self {
            friday_conversation_id: Some(friday_conversation_id.into()),
            mission_id: Some(mission_id.into()),
            work_item_id: Some(work_item_id.into()),
            surface_thread_id: None,
        }
    }

    /// Back-compat alias for [`Self::by_mission_work_item`], retained so the existing in-crate
    /// call sites (`provider_dispatch` + the runtime/mission_runtime tests) compile UNCHANGED —
    /// NS45-PR1 only needed to NAME the first-class handle constructor, not churn callers in
    /// files outside its scope (keeping `runtime.rs` untouched preserves the Wave-2 file
    /// disjointness with TP-PR2). Delegates verbatim.
    pub fn by_work_item(
        friday_conversation_id: impl Into<String>,
        mission_id: impl Into<String>,
        work_item_id: impl Into<String>,
    ) -> Self {
        Self::by_mission_work_item(friday_conversation_id, mission_id, work_item_id)
    }

    pub fn by_surface_thread(surface_thread_id: impl Into<String>) -> Self {
        Self {
            surface_thread_id: Some(surface_thread_id.into()),
            ..Self::default()
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedMissionContext {
    pub friday_conversation_id: String,
    pub mission_id: String,
    pub work_item_id: String,
    pub surface_thread_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MissionContextResolution {
    Resolved(ResolvedMissionContext),
    Blocked { blockers: Vec<String> },
}

impl MissionContextResolution {
    pub fn is_resolved(&self) -> bool {
        matches!(self, MissionContextResolution::Resolved(_))
    }

    fn blocked(blocker: impl Into<String>) -> Self {
        MissionContextResolution::Blocked {
            blockers: vec![blocker.into()],
        }
    }
}

pub fn resolve_mission_context(
    db: &Db,
    lookup: MissionContextLookup,
) -> Result<MissionContextResolution, StorageError> {
    if lookup.friday_conversation_id.is_none()
        && lookup.mission_id.is_none()
        && lookup.work_item_id.is_none()
        && lookup.surface_thread_id.is_none()
    {
        return Ok(MissionContextResolution::blocked(
            "mission_context_lookup_required",
        ));
    }

    let mut blockers = Vec::new();
    let surface = resolve_surface(db, lookup.surface_thread_id.as_deref(), &mut blockers)?;
    let explicit_work_item = resolve_work_item(db, lookup.work_item_id.as_deref(), &mut blockers)?;

    let mut mission_id = lookup.mission_id.clone();
    if let Some(surface) = surface.as_ref() {
        match surface.mission_id.as_ref() {
            Some(surface_mission_id) => merge_expected(
                &mut mission_id,
                surface_mission_id,
                "surface_thread_mission_mismatch",
                &mut blockers,
            ),
            None => blockers.push("surface_thread_has_no_mission".to_string()),
        }
    }
    if let Some(work_item) = explicit_work_item.as_ref() {
        merge_expected(
            &mut mission_id,
            &work_item.mission_id,
            "work_item_mission_mismatch",
            &mut blockers,
        );
    }

    let Some(mission_id) = mission_id else {
        blockers.push("mission_id_required".to_string());
        return Ok(MissionContextResolution::Blocked { blockers });
    };
    let Some(mission) = db.get_mission(&mission_id)? else {
        blockers.push("unknown_mission".to_string());
        return Ok(MissionContextResolution::Blocked { blockers });
    };

    let work_item = match explicit_work_item {
        Some(work_item) => work_item,
        None => match single_active_work_item_for_mission(db, &mission_id)? {
            SingleActiveWorkItem::One(work_item) => *work_item,
            SingleActiveWorkItem::None => {
                blockers.push("active_work_item_required".to_string());
                return Ok(MissionContextResolution::Blocked { blockers });
            }
            SingleActiveWorkItem::Many => {
                blockers.push("ambiguous_active_work_item".to_string());
                return Ok(MissionContextResolution::Blocked { blockers });
            }
        },
    };
    if work_item.mission_id != mission_id {
        blockers.push("work_item_mission_mismatch".to_string());
    }

    let mut friday_conversation_id = lookup.friday_conversation_id.clone();
    if let Some(surface) = surface.as_ref() {
        merge_expected(
            &mut friday_conversation_id,
            &surface.friday_conversation_id,
            "surface_thread_conversation_mismatch",
            &mut blockers,
        );
    }
    merge_expected(
        &mut friday_conversation_id,
        &mission.friday_conversation_id,
        "mission_conversation_mismatch",
        &mut blockers,
    );

    let Some(friday_conversation_id) = friday_conversation_id else {
        blockers.push("friday_conversation_id_required".to_string());
        return Ok(MissionContextResolution::Blocked { blockers });
    };
    if friday_core::validate_friday_conversation_id(&friday_conversation_id).is_err() {
        blockers.push("non_canonical_friday_conversation_id".to_string());
    }
    if db
        .get_friday_conversation(&friday_conversation_id)?
        .is_none()
    {
        blockers.push("unknown_friday_conversation".to_string());
    }

    if blockers.is_empty() {
        Ok(MissionContextResolution::Resolved(ResolvedMissionContext {
            friday_conversation_id,
            mission_id,
            work_item_id: work_item.work_item_id,
            surface_thread_id: surface.map(|s| s.surface_thread_id),
        }))
    } else {
        Ok(MissionContextResolution::Blocked { blockers })
    }
}

pub fn route_decision_card_for_context(
    db: &Db,
    context: &ResolvedMissionContext,
    decision_id: String,
    trace_refs: Vec<String>,
    now_ms: i64,
    expires_at_ms: Option<i64>,
) -> Result<RouteDecisionCard, StorageError> {
    let action_list_enabled = crate::d20_action_list_from(
        std::env::var(crate::FRIDAY_D20_ACTION_LIST_ENABLED)
            .ok()
            .as_deref(),
    );
    route_decision_card_for_context_flagged(
        db,
        context,
        decision_id,
        trace_refs,
        now_ms,
        expires_at_ms,
        action_list_enabled,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn route_decision_card_for_context_flagged(
    db: &Db,
    context: &ResolvedMissionContext,
    decision_id: String,
    trace_refs: Vec<String>,
    now_ms: i64,
    expires_at_ms: Option<i64>,
    action_list_enabled: bool,
) -> Result<RouteDecisionCard, StorageError> {
    let Some(work_item) = db.get_work_item(&context.work_item_id)? else {
        return Err(StorageError::Unsupported(
            "resolved Mission context points to unknown WorkItem".into(),
        ));
    };
    if work_item.mission_id != context.mission_id {
        return Err(StorageError::Unsupported(
            "resolved Mission context WorkItem/Mission mismatch".into(),
        ));
    }
    let card = RouteDecisionCard::from_work_item_flagged(
        decision_id,
        &work_item,
        trace_refs,
        now_ms,
        expires_at_ms,
        action_list_enabled,
    );
    card.validate()
        .map_err(|e| StorageError::Unsupported(e.to_string()))?;
    Ok(card)
}

fn resolve_surface(
    db: &Db,
    surface_thread_id: Option<&str>,
    blockers: &mut Vec<String>,
) -> Result<Option<SurfaceThread>, StorageError> {
    let Some(surface_thread_id) = surface_thread_id else {
        return Ok(None);
    };
    match db.get_surface_thread(surface_thread_id)? {
        Some(surface) => Ok(Some(surface)),
        None => {
            blockers.push("unknown_surface_thread".to_string());
            Ok(None)
        }
    }
}

fn resolve_work_item(
    db: &Db,
    work_item_id: Option<&str>,
    blockers: &mut Vec<String>,
) -> Result<Option<WorkItem>, StorageError> {
    let Some(work_item_id) = work_item_id else {
        return Ok(None);
    };
    match db.get_work_item(work_item_id)? {
        Some(work_item) => Ok(Some(work_item)),
        None => {
            blockers.push("unknown_work_item".to_string());
            Ok(None)
        }
    }
}

enum SingleActiveWorkItem {
    None,
    One(Box<WorkItem>),
    Many,
}

fn single_active_work_item_for_mission(
    db: &Db,
    mission_id: &str,
) -> Result<SingleActiveWorkItem, StorageError> {
    let mut active = db
        .list_work_items_for_mission(mission_id)?
        .into_iter()
        .filter(|item| item.is_active_like());
    let Some(first) = active.next() else {
        return Ok(SingleActiveWorkItem::None);
    };
    if active.next().is_some() {
        Ok(SingleActiveWorkItem::Many)
    } else {
        Ok(SingleActiveWorkItem::One(Box::new(first)))
    }
}

fn merge_expected(
    existing: &mut Option<String>,
    candidate: &str,
    mismatch_blocker: &str,
    blockers: &mut Vec<String>,
) {
    match existing {
        Some(value) if value != candidate => blockers.push(mismatch_blocker.to_string()),
        Some(_) => {}
        None => *existing = Some(candidate.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
        SurfaceKind, TruthStatus, VisibilityPolicy, WorkItem, WorkItemStatus, WorkLane,
    };
    use std::sync::atomic::{AtomicU64, Ordering};

    static C: AtomicU64 = AtomicU64::new(0);

    fn tmp() -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-mission-context-{}-{}.sqlite",
                std::process::id(),
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    fn seed(db: &Db, work_items: Vec<WorkItem>) {
        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: "fconv_resolver".into(),
            owner_principal: "operator:jarvis".into(),
            title: "Friday resolver".into(),
            current_focus_summary: "Resolve live inputs into Mission context".into(),
            active_mission_ids: vec!["mission-resolver".into()],
            surface_thread_ids: vec!["surface-mobile".into()],
            memory_scope_ref: None,
            truth_status: TruthStatus::WiredRegistry,
            proof_refs: vec!["proof://mission-context-test".into()],
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: "mission-resolver".into(),
            friday_conversation_id: "fconv_resolver".into(),
            title: "Resolve Mission context".into(),
            intent: "prevent detached provider/channel/workflow work".into(),
            status: MissionStatus::Active,
            why_now: "live call sites must not guess user intent".into(),
            decision_path_summary: "surface/work refs resolve to one WorkItem or block".into(),
            considered_options: vec!["detached dispatch".into()],
            deferred_options: vec!["native UI consumption".into()],
            known_pitfalls: vec!["ambiguous WorkItems create task debt".into()],
            handoff_inheritance: vec!["carry route judgment".into()],
            work_item_ids: work_items.iter().map(|w| w.work_item_id.clone()).collect(),
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission-context-test".into()],
            created_at_ms: 2,
            updated_at_ms: 2,
        })
        .unwrap();
        db.upsert_surface_thread(&friday_core::SurfaceThread {
            surface_thread_id: "surface-mobile".into(),
            friday_conversation_id: "fconv_resolver".into(),
            mission_id: Some("mission-resolver".into()),
            surface_kind: SurfaceKind::Mobile,
            channel_binding_id: None,
            delivery_route: "mobile:needs-me".into(),
            visibility_policy: VisibilityPolicy::Compact,
            allowed_actions: vec!["open_mission".into()],
            last_seen_at_ms: Some(3),
            last_delivered_event_seq: Some(1),
            created_at_ms: 3,
            updated_at_ms: 3,
        })
        .unwrap();
        for work_item in work_items {
            db.upsert_work_item(&work_item).unwrap();
        }
    }

    fn judgment() -> HandoffJudgmentMemory {
        HandoffJudgmentMemory {
            task: "Route live request through Mission context".into(),
            current_blocker: None,
            target_lane_thread_agent_provider: "codex".into(),
            read_first_files: vec!["rust-core/crates/friday-hub/src/mission_context.rs".into()],
            required_output: "Mission-bound route decision".into(),
            done_criteria: vec!["detached work is blocked".into()],
            red_lines: vec!["do not guess on ambiguous active WorkItems".into()],
            why_this_route: "Codex owns the implementation lane; Friday owns the Mission.".into(),
            considered_options: vec!["let provider thread be product id".into()],
            deferred_options: vec!["independent route_decision table".into()],
            previous_pitfalls: vec!["task facts handed off without judgment".into()],
            inheritable_context: vec!["Mission Spine is canonical".into()],
            proof_requirements: vec!["mission_context tests".into()],
            ownership_claim_ids: Vec::new(),
        }
    }

    fn work_item(work_item_id: &str) -> WorkItem {
        WorkItem {
            work_item_id: work_item_id.into(),
            mission_id: "mission-resolver".into(),
            lane: WorkLane::Codex,
            target_provider_or_agent: Some("codex".into()),
            status: WorkItemStatus::ReadyToDispatch,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("mission.context.resolve".into()),
            risk_level: friday_core::Risk::Medium,
            approval_state: ApprovalState::NotRequired,
            blocking_reason: None,
            input_refs: vec!["input://surface".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["route decision proof".into()],
            proof_receipts: Vec::new(),
            judgment_memory: judgment(),
            created_at_ms: 4,
            updated_at_ms: 4,
        }
    }

    #[test]
    fn surface_lookup_resolves_one_active_work_item_and_route_decision() {
        let db = Db::open_hub(&tmp()).unwrap();
        seed(&db, vec![work_item("work-1")]);

        let resolved = resolve_mission_context(
            &db,
            MissionContextLookup::by_surface_thread("surface-mobile"),
        )
        .unwrap();
        let MissionContextResolution::Resolved(context) = resolved else {
            panic!("expected resolved context");
        };
        assert_eq!(context.friday_conversation_id, "fconv_resolver");
        assert_eq!(context.mission_id, "mission-resolver");
        assert_eq!(context.work_item_id, "work-1");

        let card = route_decision_card_for_context(
            &db,
            &context,
            "route-decision-1".into(),
            vec!["friday://trace/route-decision-1".into()],
            10,
            None,
        )
        .unwrap();
        assert_eq!(card.selected_lane, WorkLane::Codex);
        assert_eq!(
            card.why_this_route,
            "Codex owns the implementation lane; Friday owns the Mission."
        );
        assert_eq!(
            card.previous_pitfalls,
            vec!["task facts handed off without judgment"]
        );
    }

    #[test]
    fn surface_lookup_blocks_ambiguous_active_work_items() {
        let db = Db::open_hub(&tmp()).unwrap();
        seed(&db, vec![work_item("work-1"), work_item("work-2")]);

        let resolved = resolve_mission_context(
            &db,
            MissionContextLookup::by_surface_thread("surface-mobile"),
        )
        .unwrap();
        assert_eq!(
            resolved,
            MissionContextResolution::Blocked {
                blockers: vec!["ambiguous_active_work_item".into()]
            }
        );
    }

    #[test]
    fn explicit_lookup_blocks_mismatched_work_item() {
        let db = Db::open_hub(&tmp()).unwrap();
        let mut wrong = work_item("work-wrong");
        wrong.mission_id = "mission-other".into();
        seed(&db, vec![work_item("work-1")]);
        db.upsert_mission(&Mission {
            mission_id: "mission-other".into(),
            friday_conversation_id: "fconv_resolver".into(),
            title: "Other mission".into(),
            intent: "wrong mission".into(),
            status: MissionStatus::Active,
            why_now: "test mismatch".into(),
            decision_path_summary: "do not merge mismatched refs".into(),
            considered_options: vec!["accept mismatch".into()],
            deferred_options: vec!["none".into()],
            known_pitfalls: vec!["detached work".into()],
            handoff_inheritance: vec!["block mismatch".into()],
            work_item_ids: vec!["work-wrong".into()],
            memory_candidate_refs: Vec::new(),
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://other".into()],
            created_at_ms: 5,
            updated_at_ms: 5,
        })
        .unwrap();
        db.upsert_work_item(&wrong).unwrap();

        let resolved = resolve_mission_context(
            &db,
            MissionContextLookup::by_work_item("fconv_resolver", "mission-resolver", "work-wrong"),
        )
        .unwrap();
        let MissionContextResolution::Blocked { blockers } = resolved else {
            panic!("expected blocked context");
        };
        assert!(blockers
            .iter()
            .any(|blocker| blocker == "work_item_mission_mismatch"));
    }
}
