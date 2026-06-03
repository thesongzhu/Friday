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
mod identity;
mod ledger;
mod memory;
mod offline;
mod pathsafe;
mod planning;
mod provider_session;
mod session;
mod skill;
mod tool_policy;
mod workflow;

pub use activity::{ActivityState, ActivityType};
pub use conn::ConnState;
pub use error::CoreError;
pub use identity::{DeviceIdentity, DeviceRole};
pub use ledger::{LedgerEntry, ProviderKind};
pub use memory::{
    decide_candidate, gate_transfer, redact_passport_for_projection, resolve_conflict, Confidence,
    ConflictResolution, MemoryScope, MemoryState, PassportItem, PassportItemKind,
    RedactedPassportItem,
};
pub use offline::OfflineQueueState;
pub use pathsafe::{contained, PathError};
pub use planning::{classify_kind, PlanState, PlanningKind};
pub use provider_session::{
    ProviderSessionEvent, ProviderSessionLink, ProviderSessionProjection, SyncMode, ALL_SYNC_MODES,
};
pub use session::SessionState;
pub use skill::SkillState;
pub use tool_policy::{
    contains_blocked_shell_char, contains_sensitive_assignment, contains_sensitive_material,
    is_destructive_request, shell_risk, touches_protected_artifact, Risk, ShellRisk,
};
pub use workflow::{
    aggregate_needs_me, resolve_step_completion, run_is_complete, NeedsMeItem, StepStatus,
    StepView, WorkflowRunState,
};
