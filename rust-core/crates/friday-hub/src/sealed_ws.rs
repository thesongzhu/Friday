//! **S-R0** — the SHARED sealed-WS transport/auth SUBSTRATE.
//!
//! This module is the SINGLE SOURCE OF TRUTH for the cryptographic handshake + peer authentication
//! that BOTH the live agent-run WRITE server (`bin/hub_agent_run_server.rs`) and the new DARK
//! read-projection server (`bin/hub_read_projection_server.rs`) use. Factoring it here means the two
//! servers cannot DRIFT: there is one `establish_session`, one peer-pubkey-allowlist boot chain, one
//! low-order-point check, one sealed-proof codec, and (in `hub_server.rs`) one
//! `authenticate_forwarded`. A crypto/auth bug fixed here is fixed for both; a parity gap is
//! impossible by construction.
//!
//! ## What is factored here (the PRIMITIVES, not the serve loop)
//! Deliberately, the per-message SERVE loop is NOT factored — the write loop is saturated with
//! write-only concerns (agent dispatch, run-control, pause-detect, owner-sealed body delivery) and
//! the read loop has its own (refs-only projection dispatch). Genericizing the serve loop would be
//! the single most likely way to break the write path's byte-identical behavior. So each server
//! keeps its OWN loop and shares only:
//! * [`establish_session`] — the cleartext preamble (peer pubkey in → S-F peer-allowlist gate →
//!   low-order check → server pubkey out → fresh CSPRNG nonce out → WS upgrade) and the ECDH-derived
//!   session key. IDENTICAL bytes on the wire for both servers.
//! * the S-F peer-pubkey-allowlist boot chain ([`load_peer_allowlist`] / [`peer_is_allowlisted`] /
//!   [`enforce_single_peer`] / [`PeerAllowlistError`]).
//! * [`is_low_order_x25519`] + the [`LOW_ORDER_X25519_POINTS`] table.
//! * the sealed-proof wire codec ([`encode_sealed_proof`] / [`decode_sealed_proof`]).
//! * [`SESSION_NONCE_LEN`].
//! * `AuthedPrincipal::authenticate_forwarded` (in `hub_server.rs`), generalized in S-R0 to bind an
//!   OPAQUE `bound_context: &[u8]` (the write path passes `run_id.as_bytes()`; a read passes its own
//!   per-request id) — so reads keep the IDENTICAL nonce-bound + owner-allowlisted +
//!   possession-of-session guarantee with no run.
//!
//! ## Byte-identical for writes (the deploy-safety invariant)
//! This is a PURE REFACTOR for the write path: the write bin re-expresses its existing behavior
//! through these shared fns with the SAME constant bytes (`SESSION_AAD` / `AUTH_CHALLENGE`), the SAME
//! preamble framing, and `bound_context = run_id.as_bytes()` (so the auth AAD is byte-unchanged). No
//! production caller, no LaunchAgent change. The proof: the write bin's full real-handshake test
//! suite (dispatch round-trip + forged/replay/low-order/peer-allowlist rejection) stays green, AND
//! the frozen-AAD KAT in `hub_server.rs` pins the write-path AAD bytes.
//!
//! ## DARK
//! S-R0 is a pure refactor; it ships no new running surface. The read server that consumes it
//! (S-R1) is itself DARK (no LaunchAgent, no production caller). Nothing here moves a UI needle.

use std::io::{Read, Write};

use friday_crypto::{generate_approval_nonce, DataKey, DeviceKeypair, Sealed, SecureStore};
use friday_hub_pubkey_len::X25519_PUBKEY_LEN;
use friday_transport::{read_frame, write_frame, ws_accept, TransportError, WireWebSocket};

// Re-export the canonical pubkey width from `key_source` (the single source of truth shared with the
// enroll CLI) under a stable local path. A local copy would let a future edit silently desync the
// width from the enroll CLI / the write bin — the same MED-1 hazard the write bin already calls out.
mod friday_hub_pubkey_len {
    pub use crate::key_source::X25519_PUBKEY_LEN;
}

/// S-E anti-replay: the byte length of the fresh per-handshake nonce the server generates and sends
/// in cleartext. [`generate_approval_nonce`] returns 32 CSPRNG bytes hex-encoded = 64 lowercase-hex
/// ASCII chars; both servers bind those 64 fixed-width bytes (a fixed length keeps the
/// `challenge || nonce` concat unambiguous). A malformed nonce frame of any other length is a
/// fail-closed handshake error (no session). MUST equal `hub_server::SESSION_NONCE_LEN` (the
/// verifier's self-enforcement width) — they are the prover and verifier of the same nonce.
pub const SESSION_NONCE_LEN: usize = 64;

/// The canonical low-order X25519 points (the libsodium `has_small_order` set), stored in their
/// **bit-255-masked** canonical form. A peer public key that decodes to one of these drives an
/// all-zero shared secret — i.e. a NON-CONTRIBUTORY agreement that `was_contributory()` would
/// reject. Because `agree()` discards that signal, [`establish_session`] rejects these points BEFORE
/// deriving the session key, via [`is_low_order_x25519`] which **masks byte 31's high bit before
/// comparing** (RFC 7748 `decodeUCoordinate` ignores bit 255, so a blacklisted point with the high
/// bit flipped decodes to the SAME degenerate point and MUST also be rejected). Pure byte-comparison
/// (no new crypto dep) — the standard mitigation.
pub const LOW_ORDER_X25519_POINTS: [[u8; 32]; 7] = [
    // 0 (the identity / all-zero point).
    [0u8; 32],
    // 1.
    [
        0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0,
    ],
    // 325606250916557431795983626356110631294008115727848805560023387167927233504 (order 8).
    [
        0xe0, 0xeb, 0x7a, 0x7c, 0x3b, 0x41, 0xb8, 0xae, 0x16, 0x56, 0xe3, 0xfa, 0xf1, 0x9f, 0xc4,
        0x6a, 0xda, 0x09, 0x8d, 0xeb, 0x9c, 0x32, 0xb1, 0xfd, 0x86, 0x62, 0x05, 0x16, 0x5f, 0x49,
        0xb8, 0x00,
    ],
    // 39382357235489614581723060781553021112529911719440698176882885853963445705823 (order 8).
    [
        0x5f, 0x9c, 0x95, 0xbc, 0xa3, 0x50, 0x8c, 0x24, 0xb1, 0xd0, 0xb1, 0x55, 0x9c, 0x83, 0xef,
        0x5b, 0x04, 0x44, 0x5c, 0xc4, 0x58, 0x1c, 0x8e, 0x86, 0xd8, 0x22, 0x4e, 0xdd, 0xd0, 0x9f,
        0x11, 0x57,
    ],
    // p-1 (= 2^255 - 20).
    [
        0xec, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // p (= 2^255 - 19).
    [
        0xed, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
    // p+1 (= 2^255 - 18).
    [
        0xee, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0x7f,
    ],
];

/// True if `peer_pub` DECODES to a known low-order / non-contributory X25519 point that must be
/// rejected before a session is derived. **Masks byte 31's high bit** before comparing because
/// X25519 (RFC 7748 `decodeUCoordinate`) ignores bit 255 — so a blacklisted point with the high bit
/// flipped decodes to the SAME degenerate point and would otherwise sail past an exact-match table
/// (an auth bypass: the all-zero shared secret is attacker-predictable, independent of the server's
/// private key). Constant-time-ness is NOT required (the pubkey is public).
pub fn is_low_order_x25519(peer_pub: &[u8; 32]) -> bool {
    let mut p = *peer_pub;
    p[31] &= 0x7f;
    LOW_ORDER_X25519_POINTS.contains(&p)
}

/// Why a SecureStore peer-pubkey allowlist load failed. Coarse + non-leaking: it names the failure
/// CATEGORY only, never the (would-be) pubkey bytes.
#[derive(Debug, PartialEq, Eq)]
pub enum PeerAllowlistError {
    /// No allowlist entry exists in the SecureStore (a MISSING entry — never "open").
    Missing,
    /// The entry exists but is malformed: empty, or not a NONZERO multiple of [`X25519_PUBKEY_LEN`].
    Invalid,
    /// The entry parsed cleanly but holds MORE THAN ONE pubkey (or, defensively, zero). Refused
    /// until the multi-principal bindings land — see [`enforce_single_peer`].
    MultiPeer,
}

/// Load + validate the authorized peer-pubkey allowlist from the [`SecureStore`] (S-F). The stored
/// value is a concatenation of raw 32-byte X25519 public keys.
///
/// FAIL-CLOSED contract — there is NO "open"/empty-allowlist fallthrough:
/// * a MISSING entry (`get` ⇒ `None`)            ⇒ [`PeerAllowlistError::Missing`];
/// * an EMPTY value (zero bytes)                  ⇒ [`PeerAllowlistError::Invalid`];
/// * a value whose length is not a multiple of 32 ⇒ [`PeerAllowlistError::Invalid`].
///
/// On success returns the non-empty `Vec<[u8; 32]>` of allowlisted pubkeys. The raw bytes are
/// returned to the caller but the bins NEVER log/print them (only a count is reported).
pub fn load_peer_allowlist(
    store: &dyn SecureStore,
    id: &str,
) -> Result<Vec<[u8; X25519_PUBKEY_LEN]>, PeerAllowlistError> {
    let bytes = store.get(id).ok_or(PeerAllowlistError::Missing)?;
    if bytes.is_empty() || bytes.len() % X25519_PUBKEY_LEN != 0 {
        return Err(PeerAllowlistError::Invalid);
    }
    let allowlist: Vec<[u8; X25519_PUBKEY_LEN]> = bytes
        .chunks_exact(X25519_PUBKEY_LEN)
        .map(|c| {
            let mut k = [0u8; X25519_PUBKEY_LEN];
            k.copy_from_slice(c);
            k
        })
        .collect();
    // `chunks_exact` on a nonzero-multiple length yields ≥1 chunk and no remainder, so this is
    // guaranteed non-empty — but assert the invariant rather than trust it (fail closed).
    if allowlist.is_empty() {
        return Err(PeerAllowlistError::Invalid);
    }
    Ok(allowlist)
}

/// True iff `peer_pub` is one of the authorized peer pubkeys. Plain byte-equality over the raw
/// 32-byte keys — constant-time-ness is NOT required (a public key is not secret), and the value is
/// fixed-width so there is no length oracle. This is the S-F PEER gate, shared by both servers.
pub fn peer_is_allowlisted(allowlist: &[[u8; X25519_PUBKEY_LEN]], peer_pub: &[u8; 32]) -> bool {
    allowlist.contains(peer_pub)
}

/// Fail closed unless the allowlist holds EXACTLY ONE peer pubkey.
///
/// [`load_peer_allowlist`] is intentionally a multi-key PARSER (any nonzero multiple of 32 bytes →
/// N keys), so the single-peer guarantee is otherwise only the enroll CLI's CONVENTION — the parser
/// would happily admit N. This guard converts that convention into a SERVER invariant for BOTH
/// servers. Multi-peer is gated behind the (currently unbuilt) multi-principal bindings (bind the
/// authenticated caller to the matched pubkey; a tamper-evident pubkey→principal map) — until those
/// land, `len() != 1` is refused. `!= 1` (not `> 1`) also catches an impossible-0 list fail-closed.
pub fn enforce_single_peer(
    allowlist: &[[u8; X25519_PUBKEY_LEN]],
) -> Result<(), PeerAllowlistError> {
    if allowlist.len() != 1 {
        return Err(PeerAllowlistError::MultiPeer);
    }
    Ok(())
}

/// (J2) Fail closed unless the allowlist holds AT LEAST ONE peer pubkey — the MULTI-PEER sibling of
/// [`enforce_single_peer`], for the READ seam ONLY.
///
/// The read-projection server removes the single-peer eviction trap: a desktop master-derived peer
/// AND a distinct mobile device key can BOTH be enrolled concurrently, so the read server admits a
/// non-empty multi-peer allowlist. The per-handshake S-F PEER gate ([`peer_is_allowlisted`]) already
/// checks the presented pubkey against EVERY enrolled key (`contains`), so a 2-key allowlist admits
/// either real peer with no eviction — that is the whole point of this guard.
///
/// [`load_peer_allowlist`] already rejects a MISSING (`Missing`) or non-32-multiple/empty
/// (`Invalid`) value, so by the time this guard runs the only residual fail-closed case is
/// `len() == 0` (defensive — `load_peer_allowlist` cannot return it, but assert it rather than trust
/// it). `len() >= 1` ⇒ `Ok`. This guard does NOT, and must not, touch the WRITE server: the live
/// write bin still calls [`enforce_single_peer`] on `PEER_PUBKEY_ALLOWLIST_ID` and still refuses a
/// >1 list — the two guards + two ids keep the seams independent.
///
/// HONEST CEILING (the same as the write path's): per-PRINCIPAL isolation — binding the
/// AUTHENTICATED caller to the MATCHED pubkey so peer A cannot read peer B's owner-scoped data via a
/// valid session — is the (still UNBUILT) tamper-evident pubkey→principal binding, DEFERRED. v1
/// remains single-configured-owner: every enrolled read peer authenticates as the SAME owner, so
/// multi-peer here means "more than one DEVICE for the one owner", not multi-tenant.
pub fn enforce_peer_allowlist_nonempty(
    allowlist: &[[u8; X25519_PUBKEY_LEN]],
) -> Result<(), PeerAllowlistError> {
    if allowlist.is_empty() {
        return Err(PeerAllowlistError::Invalid);
    }
    Ok(())
}

/// On-wire form for a `Sealed`: `[nonce_len: u8][nonce][ciphertext]`. Mirrors the transport's
/// internal `encode_sealed` (kept here — the transport does not expose it). Carries no key. Shared
/// so the read server's owner-sealed body and the write server's auth_proof / owner-sealed body use
/// the IDENTICAL framing the TS reference client speaks.
pub fn encode_sealed_proof(s: &Sealed) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + s.nonce.len() + s.ciphertext.len());
    out.push(s.nonce.len() as u8);
    out.extend_from_slice(&s.nonce);
    out.extend_from_slice(&s.ciphertext);
    out
}

/// Decode a wire `auth_proof` (`[nonce_len][nonce][ciphertext]`) back into a `Sealed` for the
/// session-key open. Returns `None` on any malformed input (treated as an auth failure upstream,
/// never a panic).
pub fn decode_sealed_proof(wire: &[u8]) -> Option<Sealed> {
    if wire.is_empty() {
        return None;
    }
    let nlen = wire[0] as usize;
    if wire.len() < 1 + nlen {
        return None;
    }
    Some(Sealed {
        nonce: wire[1..1 + nlen].to_vec(),
        ciphertext: wire[1 + nlen..].to_vec(),
    })
}

/// Establish the sealed session for one connection — the SHARED handshake for both the write and
/// read servers.
///
/// **Key-source abstraction:** the server holds its OWN `server_kp`; the EXTERNAL peer's public key
/// is read from the wire as a cleartext length-prefixed preamble BEFORE the WS upgrade. The server
/// then ECDHs `server_kp.agree(peer_pub)` → the per-session [`DataKey`].
///
/// FAIL-CLOSED gates BEFORE the session is derived (in order):
/// * a peer-pubkey frame that is not exactly 32 bytes (a malformed preamble can never yield a
///   session);
/// * **S-F PEER AUTH:** the peer pubkey is NOT in the SecureStore-derived allowlist — runs FIRST,
///   before we send our own pubkey/nonce, so a non-allowlisted peer learns NOTHING; and
/// * a known low-order / NON-CONTRIBUTORY X25519 point — see [`is_low_order_x25519`].
///
/// **S-E anti-replay — per-handshake nonce.** After the low-order check and AFTER sending our own
/// pubkey, but BEFORE the WS upgrade, the server generates a FRESH CSPRNG nonce and sends it
/// cleartext. The nonce is returned with the session key and threaded into
/// `AuthedPrincipal::authenticate_forwarded`. The low-order-check-BEFORE-agree ordering is preserved.
///
/// The returned tuple `(ws, session_key, session_nonce)` is IDENTICAL in shape and byte-behavior to
/// the write bin's prior inline `establish_session` — that is the byte-identical-for-writes claim
/// at the handshake layer.
pub fn establish_session<S: Read + Write>(
    mut stream: S,
    server_kp: &DeviceKeypair,
    peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
) -> Result<(WireWebSocket<S>, DataKey, Vec<u8>), TransportError> {
    // (a) Receive the peer's X25519 public key (cleartext preamble). The peer pubkey is ALWAYS an
    // input read from the wire — the server never fabricates the peer's ECDH half.
    let peer_pub_bytes = read_frame(&mut stream)?;
    let peer_pub: [u8; 32] = peer_pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| TransportError::Protocol("peer pubkey must be 32 bytes".into()))?;

    // (a') S-F PEER AUTH (the FORGERY gate — FIRST, before any other check). A non-allowlisted
    // pubkey ⇒ NO session: we return BEFORE sending our own pubkey or the nonce and BEFORE the
    // `agree()`, so a fresh local keypair cannot establish a session and the peer learns nothing.
    if !peer_is_allowlisted(peer_allowlist, &peer_pub) {
        return Err(TransportError::Protocol(
            "peer pubkey not in SecureStore allowlist".into(),
        ));
    }

    // HARDENING: reject a non-contributory (known low-order) peer key BEFORE deriving the session —
    // such a key would yield an all-zero shared secret a peer never has to "prove".
    if is_low_order_x25519(&peer_pub) {
        return Err(TransportError::Protocol(
            "non-contributory (low-order) peer key rejected".into(),
        ));
    }

    // (b) Send our OWN public key so the peer can derive the same session key.
    write_frame(&mut stream, &server_kp.public_bytes())?;

    // (b') S-E: generate + send a FRESH per-handshake CSPRNG nonce (cleartext; not a secret). The
    // peer must seal `AUTH_CHALLENGE || session_nonce` in its `auth_proof`.
    let session_nonce = generate_approval_nonce().into_bytes();
    if session_nonce.len() != SESSION_NONCE_LEN {
        return Err(TransportError::Protocol(
            "session nonce has unexpected length".into(),
        ));
    }
    write_frame(&mut stream, &session_nonce)?;

    // (c) WS upgrade over the (now preamble-consumed) stream, then derive the sealed session key.
    let ws = ws_accept(stream)?;
    let session_key = server_kp.agree(&peer_pub);
    Ok((ws, session_key, session_nonce))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::InMemorySecureStore;

    #[test]
    fn load_peer_allowlist_missing_is_fail_closed() {
        let store = InMemorySecureStore::new();
        assert_eq!(
            load_peer_allowlist(&store, "absent-id"),
            Err(PeerAllowlistError::Missing)
        );
    }

    #[test]
    fn load_peer_allowlist_non_multiple_of_32_is_invalid() {
        let mut store = InMemorySecureStore::new();
        store.put("id", &[1u8; 33]);
        assert_eq!(
            load_peer_allowlist(&store, "id"),
            Err(PeerAllowlistError::Invalid)
        );
    }

    #[test]
    fn load_peer_allowlist_parses_one_key_and_enforce_single_peer_passes() {
        let mut store = InMemorySecureStore::new();
        let key = [9u8; X25519_PUBKEY_LEN];
        store.put("id", &key);
        let allowlist = load_peer_allowlist(&store, "id").unwrap();
        assert_eq!(allowlist, vec![key]);
        assert!(enforce_single_peer(&allowlist).is_ok());
        assert!(peer_is_allowlisted(&allowlist, &key));
        assert!(!peer_is_allowlisted(&allowlist, &[1u8; 32]));
    }

    #[test]
    fn enforce_single_peer_refuses_two_keys() {
        let two = vec![[1u8; X25519_PUBKEY_LEN], [2u8; X25519_PUBKEY_LEN]];
        assert_eq!(
            enforce_single_peer(&two),
            Err(PeerAllowlistError::MultiPeer)
        );
    }

    /// (J2 KAT) The READ-seam nonempty guard accepts ONE or TWO peers (Ok) and refuses only an
    /// EMPTY list (Err::Invalid) — removing the single-peer eviction trap for the read seam.
    #[test]
    fn enforce_peer_allowlist_nonempty_accepts_one_and_two_refuses_zero() {
        let one = vec![[1u8; X25519_PUBKEY_LEN]];
        let two = vec![[1u8; X25519_PUBKEY_LEN], [2u8; X25519_PUBKEY_LEN]];
        let none: Vec<[u8; X25519_PUBKEY_LEN]> = vec![];
        assert!(enforce_peer_allowlist_nonempty(&one).is_ok());
        assert!(enforce_peer_allowlist_nonempty(&two).is_ok());
        assert_eq!(
            enforce_peer_allowlist_nonempty(&none),
            Err(PeerAllowlistError::Invalid)
        );
    }

    /// (J2 KAT — anti-regression) The WRITE-seam guard [`enforce_single_peer`] is BYTE-UNCHANGED: it
    /// MUST still reject a 2-key list. The read seam relaxing single-peer must NOT relax the write
    /// seam — proven side-by-side on the SAME two-key list the read guard now accepts.
    #[test]
    fn enforce_single_peer_still_refuses_two_keys_after_read_seam_relax() {
        let two = vec![[3u8; X25519_PUBKEY_LEN], [4u8; X25519_PUBKEY_LEN]];
        // The read seam admits this list…
        assert!(enforce_peer_allowlist_nonempty(&two).is_ok());
        // …but the WRITE seam still refuses it, unchanged.
        assert_eq!(
            enforce_single_peer(&two),
            Err(PeerAllowlistError::MultiPeer)
        );
    }

    #[test]
    fn low_order_points_are_rejected_with_or_without_high_bit() {
        // The all-zero identity point and its high-bit-flipped form both decode to a degenerate
        // point and must be rejected.
        assert!(is_low_order_x25519(&[0u8; 32]));
        let mut flipped = [0u8; 32];
        flipped[31] = 0x80;
        assert!(is_low_order_x25519(&flipped));
        // A fresh real pubkey is overwhelmingly not low-order.
        let kp = DeviceKeypair::generate();
        assert!(!is_low_order_x25519(&kp.public_bytes()));
    }

    #[test]
    fn sealed_proof_codec_round_trips() {
        let s = Sealed {
            nonce: vec![1, 2, 3, 4, 5],
            ciphertext: vec![9, 8, 7, 6],
        };
        let wire = encode_sealed_proof(&s);
        let back = decode_sealed_proof(&wire).expect("round-trips");
        assert_eq!(back.nonce, s.nonce);
        assert_eq!(back.ciphertext, s.ciphertext);
        // Malformed (truncated) wire is a None, never a panic.
        assert!(decode_sealed_proof(&[]).is_none());
        assert!(decode_sealed_proof(&[200, 1, 2]).is_none());
    }
}
