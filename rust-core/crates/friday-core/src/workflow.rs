//! Workflow run + step completion + Needs-Me aggregation (`08`, `10` §6).
//!
//! Load-bearing invariant (`08` §6, `10` §6, `00` §2): a **side-effect** step's
//! completion requires deterministic evidence. A model self-claim alone does
//! **not** mark a side-effect step verified; with no evidence it is
//! `ProofPending`. Only steps that have no external side effect may complete on
//! a model result. This is the Rust-core encoding of "side-effect completion
//! needs evidence; missing evidence is `proof_pending`; no model self-claim
//! marks a side-effect verified."

use crate::error::CoreError;

/// Lifecycle of a workflow run. Checkpoints requiring user action pause the run
/// in `AwaitingCheckpoint` (those go to Activity, `08` §1/§4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkflowRunState {
    Pending,
    Running,
    AwaitingCheckpoint,
    Done,
    Failed,
}

impl WorkflowRunState {
    pub fn as_str(&self) -> &'static str {
        match self {
            WorkflowRunState::Pending => "pending",
            WorkflowRunState::Running => "running",
            WorkflowRunState::AwaitingCheckpoint => "awaiting_checkpoint",
            WorkflowRunState::Done => "done",
            WorkflowRunState::Failed => "failed",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, WorkflowRunState::Done | WorkflowRunState::Failed)
    }

    pub fn can_transition_to(&self, next: WorkflowRunState) -> bool {
        use WorkflowRunState::*;
        matches!(
            (self, next),
            (Pending, Running)
                | (Pending, Failed)
                | (Running, AwaitingCheckpoint)
                | (Running, Done)
                | (Running, Failed)
                | (AwaitingCheckpoint, Running)
                | (AwaitingCheckpoint, Failed)
        )
    }

    pub fn try_transition(self, next: WorkflowRunState) -> Result<WorkflowRunState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "workflow_run",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

/// Verification status of a workflow step.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepStatus {
    Pending,
    Running,
    /// Side-effect step whose deterministic evidence has not arrived. NOT complete.
    ProofPending,
    /// Completion is backed by deterministic evidence (or it had no side effect).
    Verified,
    Failed,
}

impl StepStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            StepStatus::Pending => "pending",
            StepStatus::Running => "running",
            StepStatus::ProofPending => "proof_pending",
            StepStatus::Verified => "verified",
            StepStatus::Failed => "failed",
        }
    }

    /// Only `Verified` counts as complete. `ProofPending` is explicitly not.
    pub fn is_complete(&self) -> bool {
        matches!(self, StepStatus::Verified)
    }

    /// A terminal step cannot be re-completed. `ProofPending` is **not** terminal
    /// — its deterministic evidence may still arrive and verify it later.
    pub fn is_terminal(&self) -> bool {
        matches!(self, StepStatus::Verified | StepStatus::Failed)
    }
}

/// Resolve a step's completion status.
///
/// - A **side-effect** step is `Verified` only with deterministic evidence;
///   otherwise `ProofPending` — *even if the model claimed it was done*.
/// - A step with **no side effect** (e.g. analysis/summary) may be `Verified`
///   on a model result; without one it is still `Running`.
pub fn resolve_step_completion(
    has_side_effect: bool,
    has_evidence: bool,
    model_claimed_done: bool,
) -> StepStatus {
    if has_side_effect {
        if has_evidence {
            StepStatus::Verified
        } else {
            StepStatus::ProofPending
        }
    } else if model_claimed_done {
        StepStatus::Verified
    } else {
        StepStatus::Running
    }
}

/// A read-only projection of a workflow step for the run-completion gate: the
/// only two facts the gate needs are whether the step has an external side effect
/// and its current verification status. (`08` §6, `10` §6, `32` deferral.)
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepView {
    pub has_side_effect: bool,
    pub status: StepStatus,
}

/// The run-completion gate (`08` §6 / `10` §6; closes the `32` deferral).
///
/// A run is complete **only** when every side-effect step is `Verified`. The
/// per-step evidence-gating invariant (`resolve_step_completion`) guarantees a
/// side-effect step reaches `Verified` only with deterministic evidence; this
/// function lifts that invariant from the step to the **run**: a run with a
/// `ProofPending` (evidence not yet arrived) **or** `Failed` side-effect step is
/// NOT complete — the `Failed` case must route the run to `Failed`, never `Done`.
///
/// Non-side-effect steps do not gate completion here: they may legitimately
/// complete on a model result (`resolve_step_completion(false, ..)`), and a run
/// can be `Done` while a non-side-effect step is still in flight only if the
/// engine has otherwise finished it — the engine, not this predicate, decides
/// when all *work* is done. This predicate answers exactly one question: "is it
/// safe to call this run complete given its side effects?"
///
/// CAUTION — this is a **safety floor, not a readiness signal**. It is `true`
/// whenever every *side-effect* step is `Verified`, even if a non-side-effect
/// step is still `Pending`/`Running`. Use it ONLY as a guard ("refuse `Done`
/// when `!run_is_complete`"), never as the completion trigger: a future engine
/// that does `if run_is_complete(steps) { mark_done() }` would mark a run `Done`
/// with unfinished analysis work. The engine must separately confirm all steps
/// (side-effect *and* pure) are finished before driving the run to `Done`; this
/// function only forbids the unsafe case.
pub fn run_is_complete(steps: &[StepView]) -> bool {
    steps
        .iter()
        .filter(|s| s.has_side_effect)
        .all(|s| s.status == StepStatus::Verified)
}

/// A cross-source action item the user must act on (`08` §2). Needs-Me preserves
/// the underlying provider detail; missing detail must be truth-labeled, not
/// silently dropped (so `reason`/`destination` are always carried).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NeedsMeItem {
    pub source: String,
    pub id: String,
    pub reason: String,
    /// Higher = more urgent.
    pub priority: u8,
    pub destination: String,
}

/// Urgency-first aggregation (`08` §1, `02` §9): highest priority first, stable
/// within equal priority (preserves arrival order).
pub fn aggregate_needs_me(mut items: Vec<NeedsMeItem>) -> Vec<NeedsMeItem> {
    // Stable sort, highest priority first (Reverse keeps equal-priority arrival order).
    items.sort_by_key(|i| std::cmp::Reverse(i.priority));
    items
}

#[cfg(test)]
mod tests {
    use super::WorkflowRunState::*;
    use super::*;

    #[test]
    fn run_state_machine() {
        let s = Pending
            .try_transition(Running)
            .unwrap()
            .try_transition(AwaitingCheckpoint)
            .unwrap()
            .try_transition(Running)
            .unwrap()
            .try_transition(Done)
            .unwrap();
        assert!(s.is_terminal());
        assert!(Pending.try_transition(Done).is_err()); // must run first
        assert!(Done.try_transition(Running).is_err()); // terminal
    }

    #[test]
    fn side_effect_step_needs_evidence_not_a_model_claim() {
        // The load-bearing invariant: model says "done", side effect, NO evidence
        // -> ProofPending, NOT Verified.
        assert_eq!(
            resolve_step_completion(true, false, true),
            StepStatus::ProofPending
        );
        assert!(!resolve_step_completion(true, false, true).is_complete());
        // Side effect WITH evidence -> Verified.
        assert_eq!(
            resolve_step_completion(true, true, false),
            StepStatus::Verified
        );
    }

    #[test]
    fn step_terminality_lets_proof_pending_verify_later() {
        // ProofPending is NOT terminal: late-arriving evidence can still verify it.
        assert!(!StepStatus::ProofPending.is_terminal());
        assert!(!StepStatus::Pending.is_terminal());
        assert!(!StepStatus::Running.is_terminal());
        // Verified/Failed are terminal (no re-completion / no downgrade).
        assert!(StepStatus::Verified.is_terminal());
        assert!(StepStatus::Failed.is_terminal());
    }

    #[test]
    fn non_side_effect_step_may_complete_on_model_result() {
        assert_eq!(
            resolve_step_completion(false, false, true),
            StepStatus::Verified
        );
        assert_eq!(
            resolve_step_completion(false, false, false),
            StepStatus::Running
        );
    }

    #[test]
    fn run_completion_gate_requires_every_side_effect_verified() {
        let se = |status| StepView {
            has_side_effect: true,
            status,
        };
        let pure = |status| StepView {
            has_side_effect: false,
            status,
        };

        // All side-effect steps Verified -> complete (non-side-effect steps don't gate).
        assert!(run_is_complete(&[
            se(StepStatus::Verified),
            se(StepStatus::Verified),
            pure(StepStatus::Verified),
        ]));
        // A run with no steps at all is trivially complete (no side effect to verify).
        assert!(run_is_complete(&[]));
        // A run whose only steps have no side effect is complete regardless of their status.
        assert!(run_is_complete(&[
            pure(StepStatus::Running),
            pure(StepStatus::Pending)
        ]));

        // A ProofPending side-effect step (evidence not yet arrived) blocks completion.
        assert!(!run_is_complete(&[
            se(StepStatus::Verified),
            se(StepStatus::ProofPending),
        ]));
        // A Failed side-effect step blocks completion (the run must go Failed, not Done).
        assert!(!run_is_complete(&[
            se(StepStatus::Verified),
            se(StepStatus::Failed),
        ]));
        // Pending/Running side-effect steps also block completion.
        assert!(!run_is_complete(&[se(StepStatus::Pending)]));
        assert!(!run_is_complete(&[se(StepStatus::Running)]));
    }

    #[test]
    fn needs_me_is_urgency_first_and_stable() {
        let items = vec![
            NeedsMeItem {
                source: "codex".into(),
                id: "a".into(),
                reason: "approval".into(),
                priority: 5,
                destination: "session/a".into(),
            },
            NeedsMeItem {
                source: "claude".into(),
                id: "b".into(),
                reason: "question".into(),
                priority: 9,
                destination: "session/b".into(),
            },
            NeedsMeItem {
                source: "workflow".into(),
                id: "c".into(),
                reason: "checkpoint".into(),
                priority: 5,
                destination: "wf/c".into(),
            },
        ];
        let sorted = aggregate_needs_me(items);
        assert_eq!(sorted[0].id, "b"); // priority 9 first
                                       // equal priority (5) keeps arrival order: a before c
        assert_eq!(sorted[1].id, "a");
        assert_eq!(sorted[2].id, "c");
    }
}
