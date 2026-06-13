//! Friday Rust Core — pure domain types and state machines.
//!
//! This crate has **no I/O** (no SQL, no network, no FFI). It is the shared
//! foundation linked by both the Hub and the phone-side FFI library, so the
//! domain types cannot drift between processes (architecture gate 21 §1).
//!
//! Domain coverage grows by unit: device/session identity, session/activity/
//! offline-queue/connection state machines (the offline-queue invariant is that
//! an *ack is not completion*), the token/model ledger entry shape (Unit 2);
//! workflow run with evidence-gated step completion and Needs-Me aggregation
//! (Unit 9); memory trust (no silent long-term writes; candidates/inferred are
//! not facts), conflict choice-cards, and Context Passport transfer gating
//! (Unit 10). Provider adapters and the wire protocol live in their own crates.

mod activity;
mod conn;
mod error;
/// Canonical mutating-action gate decision core (PR-3a). Public module (rather than
/// flat re-export) so the generically-named `gate::evaluate` is unambiguous.
pub mod gate;
mod global_work_graph;
mod identity;
mod ledger;
mod mechanism_matrix;
mod memory;
mod mission;
mod offline;
mod pairing;
mod pathsafe;
mod planning;
mod process_registry;
mod provider_session;
mod session;
mod skill;
mod skill_catalog;
mod tool_policy;
mod workflow;

pub use activity::{ActivityState, ActivityType};
pub use conn::ConnState;
pub use error::CoreError;
pub use global_work_graph::{
    AdoptionCommandResult, AdoptionCommandStatus, AdoptionProposal, AdoptionProposalStatus,
    AdvisorPreflight, AdvisorRecommendation, GlobalWorkGraphSnapshot, WorkGraphConflict,
    WorkGraphConflictKind, WorkGraphConflictSeverity, WorkGraphNode, WorkGraphNodeKind,
    WorkGraphTruthLabel,
};
pub use identity::{DeviceIdentity, DeviceRole};
pub use ledger::{LedgerEntry, ProviderKind};
pub use mechanism_matrix::{
    friday_v1_mechanism_matrix, friday_v1_no_go_blockers, MechanismOwner, MechanismRow,
    MechanismStatus,
};
pub use memory::{
    decide_candidate, gate_transfer, memory_review_needs_me, redact_passport_for_projection,
    resolve_conflict, Confidence, ConflictResolution, MemoryScope, MemoryState, PassportItem,
    PassportItemKind, RedactedPassportItem, MEMORY_REVIEW_PRIORITY,
};
pub use mission::{
    find_duplicate_mission, find_duplicate_work_item, requires_context_passport,
    validate_friday_conversation_id, ApprovalState, FridayConversation, HandoffJudgmentMemory,
    Mission, MissionLink, MissionLinkKind, MissionSpineError, MissionStatus,
    MissionSurfaceProjection, RouteDecisionCard, RouteDecisionProjection, SurfaceEvent,
    SurfaceEventKind, SurfaceKind, SurfaceThread, TruthStatus, VisibilityPolicy, WorkItem,
    WorkItemStatus, WorkLane,
};
pub use offline::OfflineQueueState;
pub use pairing::{
    FridayPairPayload, FridayPairProjection, PairAuthority, PairTransportHint, PairTransportKind,
    PairingSecret, TrustedDeviceProjection, CURRENT_PAIR_PAYLOAD_VERSION,
};
pub use pathsafe::{contained, PathError};
pub use planning::{classify_kind, PlanState, PlanningKind};
pub use process_registry::{
    ClaimState, LeaseState, OwnershipStatus, ProcessKind, ProcessLease, ProcessObservation,
    WorkspaceClaim, WorkspaceClaimKind,
};
pub use provider_session::{
    ProviderSessionEvent, ProviderSessionLink, ProviderSessionProjection, SyncMode, ALL_SYNC_MODES,
};
pub use session::SessionState;
pub use skill::SkillState;
pub use skill_catalog::{
    advise_skill, SkillAdvisorDecision, SkillAdvisorRecommendationKind, SkillAdvisorRequest,
    SkillCatalogEntry, SkillCatalogSnapshot, SkillCatalogSource,
};
pub use tool_policy::{
    contains_blocked_shell_char, contains_sensitive_assignment, contains_sensitive_material,
    is_destructive_request, shell_risk, touches_protected_artifact, Risk, ShellRisk,
};
pub use workflow::{
    aggregate_needs_me, resolve_step_completion, run_is_complete, NeedsMeItem, StepStatus,
    StepView, WorkflowRunState,
};
