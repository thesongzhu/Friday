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

    /// A WebAuthn assertion verified cryptographically but its authenticator
    /// sign-count did NOT strictly increase over the stored value. A
    /// non-increasing (≤) sign-count is the W3C-defined signal that the
    /// authenticator may be CLONED — at least two copies of the credential
    /// private key in parallel use. We REJECT (fail-closed) rather than score-
    /// and-continue. (Synced passkeys legitimately keep a 0 counter and are
    /// exempt from this check by spec; see [`crate::real`].)
    #[error("possible cloned authenticator: sign-count regression (non-increasing)")]
    ClonedAuthenticator,

    /// A WebAuthn ceremony challenge id was presented that the server never
    /// issued, or was already consumed. Challenges are single-use and server-
    /// issued; an unknown/replayed challenge is REFUSED (fail-closed).
    #[error("unknown or already-consumed ceremony challenge: {0}")]
    UnknownCeremony(String),

    /// Registration was attempted without an operator-authorized owner trust
    /// root. The first-device bootstrap posture is "an already-trusted operator
    /// authorizes the registration" — registration is NOT self-authorizing. A
    /// registration whose owner principal is not in the authorized set is
    /// REFUSED. See [`crate::real`] (FLAGGED bootstrap posture).
    #[error("registration not authorized for owner '{0}' (no operator trust root)")]
    RegistrationNotAuthorized(String),

    /// The relying-party identity (rp_id / origin) supplied to build the real
    /// verifier was malformed (e.g. origin is not a valid URL). Fail-closed: a
    /// verifier with an ambiguous RP identity is never constructed.
    #[error("invalid relying-party identity: {0}")]
    InvalidRelyingParty(String),

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
