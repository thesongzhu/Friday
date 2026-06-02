//! Friday Rust Core — pure domain types and state machines.
//!
//! This crate has **no I/O** (no SQL, no network, no FFI). It is the shared
//! foundation linked by both the Hub and the phone-side FFI library, so the
//! domain types cannot drift between processes (architecture gate 21 §1).
//!
//! Unit 2 scope (foundation slice only): device/session identity, session and
//! activity state machines, the offline-queue state machine (whose key
//! invariant is that an *ack is not completion*), connection state, and the
//! token/model ledger entry shape. Everything else (provider adapters, wire
//! protocol, memory review, …) is deferred to later units per gate 21 §9.

mod activity;
mod conn;
mod error;
mod identity;
mod ledger;
mod offline;
mod session;
mod workflow;

pub use activity::{ActivityState, ActivityType};
pub use conn::ConnState;
pub use error::CoreError;
pub use identity::{DeviceIdentity, DeviceRole};
pub use ledger::{LedgerEntry, ProviderKind};
pub use offline::OfflineQueueState;
pub use session::SessionState;
pub use workflow::{
    aggregate_needs_me, resolve_step_completion, NeedsMeItem, StepStatus, WorkflowRunState,
};
