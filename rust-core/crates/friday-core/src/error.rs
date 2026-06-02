use thiserror::Error;

/// Errors produced by pure-domain operations.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CoreError {
    /// A state machine was asked to make a transition that is not allowed.
    #[error("invalid {entity} transition: {from} -> {to}")]
    InvalidTransition {
        entity: &'static str,
        from: &'static str,
        to: &'static str,
    },

    /// A ledger entry failed validation (e.g. negative tokens).
    #[error("invalid ledger entry: {0}")]
    InvalidLedger(String),

    /// A Context Passport transfer was blocked (secret-kind, or unapproved
    /// sensitive item) — `07` §10 / `02` §7.
    #[error("blocked transfer: {0}")]
    BlockedTransfer(String),
}
