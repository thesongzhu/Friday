//! Offline-queue state machine (gate 21 §2.1 / §4.4, product decision 02 §15).
//!
//! Load-bearing invariant: **an ack is not completion.** A queued action that
//! the Hub has acknowledged (`Acked`) is *not* done; it becomes complete only
//! when an execution-proof result arrives (`Executed`). The state machine
//! forbids `Queued -> Executed` (no skipping the ack) and makes `is_complete`
//! true *only* for `Executed`, so no code path can treat an ack as a receipt.

use crate::error::CoreError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfflineQueueState {
    /// User-confirmed action waiting for the Hub to come back.
    Queued,
    /// Hub acknowledged receipt on reconnect. **Not** completion.
    Acked,
    /// Execution-proof result frame arrived. The only completion state.
    Executed,
    /// Action could not be accepted or executed.
    Failed,
}

impl OfflineQueueState {
    pub fn as_str(&self) -> &'static str {
        match self {
            OfflineQueueState::Queued => "queued",
            OfflineQueueState::Acked => "acked",
            OfflineQueueState::Executed => "executed",
            OfflineQueueState::Failed => "failed",
        }
    }

    /// True only for `Executed`. `Acked` is deliberately *not* complete.
    pub fn is_complete(&self) -> bool {
        matches!(self, OfflineQueueState::Executed)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            OfflineQueueState::Executed | OfflineQueueState::Failed
        )
    }

    pub fn can_transition_to(&self, next: OfflineQueueState) -> bool {
        use OfflineQueueState::*;
        matches!(
            (self, next),
            (Queued, Acked) | (Queued, Failed) | (Acked, Executed) | (Acked, Failed)
        )
    }

    pub fn try_transition(self, next: OfflineQueueState) -> Result<OfflineQueueState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "offline_queue",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::OfflineQueueState::*;

    #[test]
    fn ack_is_not_completion() {
        assert!(!Queued.is_complete());
        assert!(!Acked.is_complete());
        assert!(Executed.is_complete());
        assert!(!Failed.is_complete());
    }

    #[test]
    fn must_ack_before_execute() {
        // The whole point: a queued action cannot jump straight to executed.
        assert!(Queued.try_transition(Executed).is_err());
        // The legal path is Queued -> Acked -> Executed.
        let s = Queued
            .try_transition(Acked)
            .unwrap()
            .try_transition(Executed)
            .unwrap();
        assert!(s.is_complete());
    }

    #[test]
    fn cannot_resurrect_after_executed() {
        assert!(Executed.try_transition(Acked).is_err());
        assert!(Failed.try_transition(Executed).is_err());
    }
}
