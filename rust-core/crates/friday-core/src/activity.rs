//! Activity item type + state machine (gate 21 §2.1).

use crate::error::CoreError;

/// First-slice activity item kinds: the status/receipt surface of the slice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityType {
    AskStatus,
    AskReceipt,
    OfflineQueued,
    OfflineResult,
    /// A verified channel-origin inbound recorded as a Hub event (Channels track A-PR4).
    ChannelInbound,
    /// A pending memory candidate surfaced for the user's explicit review
    /// (confirm/reject/edit) — the Memory-confirmation loop (`07` §6/§7). A
    /// candidate is never auto-confirmed; surfacing it for review is how the
    /// "no silent long-term write" invariant reaches the user.
    MemoryReview,
}

impl ActivityType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActivityType::AskStatus => "ask_status",
            ActivityType::AskReceipt => "ask_receipt",
            ActivityType::OfflineQueued => "offline_queued",
            ActivityType::OfflineResult => "offline_result",
            ActivityType::ChannelInbound => "channel_inbound",
            ActivityType::MemoryReview => "memory_review",
        }
    }
}

/// Lifecycle of an activity item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActivityState {
    Pending,
    Running,
    Done,
    Failed,
}

impl ActivityState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActivityState::Pending => "pending",
            ActivityState::Running => "running",
            ActivityState::Done => "done",
            ActivityState::Failed => "failed",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, ActivityState::Done | ActivityState::Failed)
    }

    pub fn can_transition_to(&self, next: ActivityState) -> bool {
        use ActivityState::*;
        matches!(
            (self, next),
            (Pending, Running)
                | (Pending, Done)
                | (Pending, Failed)
                | (Running, Done)
                | (Running, Failed)
        )
    }

    pub fn try_transition(self, next: ActivityState) -> Result<ActivityState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "activity",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ActivityState::*;
    use super::*;

    #[test]
    fn type_strings() {
        assert_eq!(ActivityType::AskReceipt.as_str(), "ask_receipt");
        assert_eq!(ActivityType::OfflineResult.as_str(), "offline_result");
        assert_eq!(ActivityType::ChannelInbound.as_str(), "channel_inbound");
        assert_eq!(ActivityType::MemoryReview.as_str(), "memory_review");
    }

    #[test]
    fn pending_can_finish_fast_or_run_first() {
        assert!(Pending.try_transition(Done).is_ok());
        assert!(Pending.try_transition(Running).is_ok());
        assert!(Running.try_transition(Failed).is_ok());
    }

    #[test]
    fn done_is_frozen() {
        assert!(Done.try_transition(Running).is_err());
        assert!(Done.is_terminal());
    }
}
