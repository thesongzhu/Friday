//! Error type for the R5 `system.remote.*` foundation.
//!
//! Every variant is a CLOSED rejection: there is no "soft accept" path. In
//! particular [`RemoteError::WebAuthnVerifierNotWired`] is the fail-closed signal
//! the deferred verifier stub returns — it is an `Err`, never a panic, so a
//! caller that has not wired a real verifier is REFUSED rather than crashing.

use thiserror::Error;

/// The closed set of reasons a `system.remote.*` operation can be rejected.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RemoteError {
    /// A WebAuthn ceremony could not be advanced because no real attestation /
    /// assertion verifier has been wired yet. This is the DELIBERATE deferred
    /// stub's response — it FAILS CLOSED (an unverified ceremony is rejected,
    /// never accepted). See [`crate::webauthn`].
    #[error("webauthn verifier not wired: refusing to accept an unverified ceremony (deferred)")]
    WebAuthnVerifierNotWired,

    /// A real verifier was wired but rejected the attestation/assertion (bad
    /// signature, challenge mismatch, unknown credential, etc.).
    #[error("webauthn verification failed: {0}")]
    WebAuthnRejected(String),

    /// The presented credential id does not match the challenge's expected
    /// credential, or the device for an assertion is not registered.
    #[error("unknown or mismatched credential")]
    UnknownCredential,

    /// A ceremony was advanced out of order (e.g. verifying before a challenge
    /// was issued). The typed states make most of these unrepresentable; this
    /// covers the residual runtime cases.
    #[error("webauthn ceremony out of order: {0}")]
    CeremonyOutOfOrder(String),

    /// A device with this id is already registered. Registration is not an
    /// upsert — a re-register must go through an explicit rotation slice (not in
    /// this slice).
    #[error("device already registered: {0}")]
    DeviceAlreadyRegistered(String),

    /// No device with this id is registered.
    #[error("device not found: {0}")]
    DeviceNotFound(String),

    /// No remote session with this id exists.
    #[error("remote session not found: {0}")]
    SessionNotFound(String),

    /// The caller's owner principal does not match the row's owner. Cross-owner
    /// access is REFUSED (never silently scoped away or treated as not-found in
    /// a way that leaks existence beyond the owner check).
    #[error("owner mismatch: principal not authorized for this resource")]
    OwnerMismatch,

    /// The remote session has expired. An expired session is DEAD — it cannot be
    /// heartbeated back to life, only deleted. Fail-closed.
    #[error("remote session expired")]
    SessionExpired,

    /// A bound input was malformed (empty id, non-positive ttl, etc.). Inputs are
    /// validated rather than silently coerced.
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

/// Crate result alias.
pub type Result<T> = std::result::Result<T, RemoteError>;
