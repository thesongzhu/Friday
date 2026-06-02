//! Connection state for the phone<->Hub link (gate 21 §5 `ConnState`).

use crate::error::CoreError;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConnState {
    Disconnected,
    Connecting,
    /// Direct LAN/Tailscale/SSH transport (02 §15 preferred path).
    Direct,
    /// E2E relay transport (supported secondary path, not a downgrade).
    Relay,
    /// Was connected; data may be stale (offline/stale label must show).
    Stale,
}

impl ConnState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConnState::Disconnected => "disconnected",
            ConnState::Connecting => "connecting",
            ConnState::Direct => "direct",
            ConnState::Relay => "relay",
            ConnState::Stale => "stale",
        }
    }

    /// A live, usable link.
    pub fn is_online(&self) -> bool {
        matches!(self, ConnState::Direct | ConnState::Relay)
    }

    /// Whether the UI must show a stale/offline truth label (05 §10).
    pub fn is_stale_or_offline(&self) -> bool {
        matches!(self, ConnState::Stale | ConnState::Disconnected)
    }

    pub fn can_transition_to(&self, next: ConnState) -> bool {
        use ConnState::*;
        match (self, next) {
            // Must dial before connecting; cannot jump straight to a transport.
            (Disconnected, Connecting) => true,
            (Connecting, Direct) | (Connecting, Relay) | (Connecting, Disconnected) => true,
            // A live transport can drop to stale or fully disconnect, or
            // migrate between direct/relay without a full re-dial.
            (Direct, Relay) | (Relay, Direct) => true,
            (Direct, Stale) | (Relay, Stale) => true,
            (Direct, Disconnected) | (Relay, Disconnected) => true,
            // Recover from stale.
            (Stale, Connecting) | (Stale, Disconnected) => true,
            (Stale, Direct) | (Stale, Relay) => true,
            _ => false,
        }
    }

    pub fn try_transition(self, next: ConnState) -> Result<ConnState, CoreError> {
        if self.can_transition_to(next) {
            Ok(next)
        } else {
            Err(CoreError::InvalidTransition {
                entity: "conn",
                from: self.as_str(),
                to: next.as_str(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ConnState::*;

    #[test]
    fn must_dial_before_transport() {
        assert!(Disconnected.try_transition(Direct).is_err());
        assert!(Disconnected.try_transition(Relay).is_err());
        assert!(Disconnected.try_transition(Connecting).is_ok());
    }

    #[test]
    fn online_and_stale_predicates() {
        assert!(Direct.is_online());
        assert!(Relay.is_online());
        assert!(!Stale.is_online());
        assert!(Stale.is_stale_or_offline());
        assert!(Disconnected.is_stale_or_offline());
        assert!(!Direct.is_stale_or_offline());
    }

    #[test]
    fn transport_can_degrade_to_stale_then_recover() {
        let s = Disconnected
            .try_transition(Connecting)
            .unwrap()
            .try_transition(Direct)
            .unwrap()
            .try_transition(Stale)
            .unwrap()
            .try_transition(Connecting)
            .unwrap();
        assert_eq!(s, Connecting);
    }
}
