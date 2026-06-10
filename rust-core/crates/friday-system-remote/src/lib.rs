//! `friday-system-remote` — R5 `system.remote.*` foundation (DARK, slice 1).
//!
//! Roadmap ref: `TS_RECON_TRUTH_ROADMAP_20260610.md` §3 R5 (`system.remote.*` ×11
//! — WebAuthn register/assert, passkey, device register/delete, remote sessions
//! create/heartbeat/delete). Substrate before this slice = NONE; this is the
//! first slice.
//!
//! # Truth label — DARK, NOT v1 GO
//! This crate is FULLY DARK:
//! * NO friday-hub wiring. `friday-hub/src/lib.rs` and all hub routing/bootstrap
//!   are UNTOUCHED. There is no production caller, no route, no FFI export.
//! * NOTHING is replaced. The R5 capability does not exist in production today;
//!   this slice neither replaces a TS surface nor moves the live product.
//! * It is a self-contained foundation that other slices build on. It is NOT a
//!   v1 GO of device/sync; it is the typed skeleton + fail-closed seams.
//!
//! # What this slice BUILDS (real)
//! * [`webauthn`] — the two WebAuthn ceremonies (registration / assertion) as
//!   TYPED state machines, plus the verification SEAM ([`webauthn::WebAuthnVerifier`]).
//! * [`device`] — `RegisteredDevice` model + in-memory `DeviceStore`
//!   (register/lookup/list/touch/delete), owner-scoped.
//! * [`session`] — `RemoteSession` model + in-memory `SessionStore`
//!   (create/heartbeat/delete) with monotonic-expiry, fail-closed lifecycle.
//!
//! # What is STUB / DEFERRED (explicit)
//! 1. **Real WebAuthn cryptographic verification.** [`webauthn::DeferredVerifier`]
//!    FAILS CLOSED (`Err(WebAuthnVerifierNotWired)`) for every ceremony. COSE key
//!    parsing, attestation-statement validation, signature/sign-count/origin/
//!    rp-id/challenge checks are NOT implemented — a future slice wires a real
//!    `WebAuthnVerifier` (e.g. over `webauthn-rs`). Until then NO device can be
//!    registered and NO verified-path session can be opened.
//! 2. **Persistence.** Both stores are IN-MEMORY. A `friday-storage` migration
//!    (`m00NN`) registering `remote_device` / `remote_session` in
//!    `HUB_ONLY_TABLES` + a forward-migration KAT is DEFERRED. Rationale: that
//!    migration edits the shared `friday-storage::schema` file (the
//!    `hub_migrations()` vector + `HUB_ONLY_TABLES` + a new `m00NN` fn) — the
//!    single highest-contention merge point for ANY concurrent migration lane
//!    (m0024 just landed). Keeping storage in-crate keeps this dark lane
//!    collision-free, per the slice brief's escape hatch.
//! 3. **Hub route wiring.** Binding these stores/ceremonies to the 11
//!    `system.remote.*` routes, principal/gate integration, challenge issuance
//!    via a CSPRNG, and FFI exposure are all DEFERRED (later slices, operator-gated).
//! 4. **Passkey-specific flows** (discoverable credentials / resident keys /
//!    user-verification policy) beyond the shared register/assert shape.
//!
//! # Fail-closed seams (summary)
//! * WebAuthn: only a [`webauthn::WebAuthnVerifier`] result can mint a
//!   `VerifiedAttestation`/`VerifiedAssertion` (typestate); the deferred verifier
//!   rejects; `device::DeviceStore::register` accepts ONLY a verified attestation.
//! * Sessions: heartbeat on an expired session is REFUSED (an expired session is
//!   dead, not revivable); cross-owner device/session ops are REFUSED.
//! * No `unwrap`/`expect` on external input; empty/negative inputs are rejected.

pub mod device;
pub mod error;
pub mod session;
pub mod webauthn;

pub use device::{DeviceStore, RegisteredDevice};
pub use error::{RemoteError, Result};
pub use session::{RemoteSession, SessionState, SessionStore};
pub use webauthn::{
    begin_assertion, begin_registration, AssertionChallenge, AssertionResponse,
    AttestationResponse, Bytes, DeferredVerifier, RegistrationChallenge, VerifiedAssertion,
    VerifiedAttestation, WebAuthnVerifier,
};
