//! Session state machine for the first-slice `friday_ask` kind (gate 21 §2.1).

use crate::error::CoreError;

/// Lifecycle of an Ask-Friday session.
///
/// ```text
/// Created ──> AwaitingResponse ──> Streaming ──> Done
///    │               │                 │
///    └───────────────┴─────────────────┴──────> Failed
/// ```
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionState {
    Created,
    AwaitingResponse,
    Streaming,
    Done,
    Failed,
}

impl SessionState {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionState::Created => "created",
            SessionState::AwaitingResponse => "awaiting_response",
            SessionState::Streaming => "streaming",
            SessionState::Done => "done",
            SessionState::Failed => "failed",
        }
    }

    /// Terminal states accept no further transitions.
    pub fn is_terminal(&self) -> bool {
        matches!(self, SessionState::Done | SessionState::Failed)
    }

    pub fn can_transition_to(&self, next: SessionState) -> bool {
        use SessionState::*;
        matches!(
            (self, next),
            (Created, AwaitingResponse)
                | (Created, Failed)
                | (AwaitingResponse, Streaming)
                | (AwaitingResponse, Failed)
                | (Streaming, Done)
                | (Streaming, Failed)
        )
    }

    pub fn try_transition(self, next: SessionState) -> Result<SessionState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "session",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SessionState::*;
    use super::*;

    #[test]
    fn happy_path_transitions() {
        let s = Created
            .try_transition(AwaitingResponse)
            .unwrap()
            .try_transition(Streaming)
            .unwrap()
            .try_transition(Done)
            .unwrap();
        assert_eq!(s, Done);
        assert!(s.is_terminal());
    }

    #[test]
    fn cannot_skip_to_done() {
        let err = Created.try_transition(Done).unwrap_err();
        assert_eq!(
            err,
            CoreError::InvalidTransition {
                entity: "session",
                from: "created",
                to: "done"
            }
        );
    }

    #[test]
    fn terminal_states_are_frozen() {
        assert!(Done.try_transition(Streaming).is_err());
        assert!(Failed.try_transition(AwaitingResponse).is_err());
    }

    #[test]
    fn failure_reachable_from_every_non_terminal() {
        for s in [Created, AwaitingResponse, Streaming] {
            assert!(s.try_transition(Failed).is_ok(), "{s:?} -> Failed");
        }
    }
}
