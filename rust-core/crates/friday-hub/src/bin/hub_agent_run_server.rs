//! WS substrate **S-C** + **S-E** + **S-F** — `hub_agent_run_server`: the long-lived loopback
//! agent-run WS server bin, with the authed agent-run DISPATCH arm (S-C) HARDENED against REPLAY
//! (S-E) and the connecting PEER authenticated against a SecureStore pubkey allowlist (S-F).
//!
//! ## S-F peer authentication (this revision — DARK, security-critical)
//! S-C/S-E authenticated the *channel* (a correct ECDH handshake) and the *forwarded principal*
//! (owner-allowlist), but NOT the *peer process*: a FRESH local keypair could complete the
//! handshake and forge an openable `auth_proof` for an allowlisted owner string (owner strings are
//! identifiers, not secrets). That is the **FORGERY** gap S-E explicitly deferred. S-F closes it by
//! authenticating the PEER itself:
//! * **SecureStore peer-pubkey allowlist.** At boot the server loads, from [`SecureStore`], an
//!   allowlist of authorized peer X25519 public keys (the production TS-API peer's pubkey[s]). On
//!   each connection, [`establish_session`] checks the peer's pubkey against that allowlist as the
//!   FIRST gate — BEFORE the low-order check, BEFORE sending the server pubkey/nonce, BEFORE any
//!   `agree()`. A non-allowlisted pubkey ⇒ NO session (fail closed; the connection ends and the
//!   peer learns nothing — no server pubkey, no nonce, no agree, no auth, no dispatch). A fresh
//!   local keypair that is NOT in the allowlist can no longer forge a session.
//! * **Fail-closed on a missing/invalid allowlist.** [`load_peer_allowlist`] treats a MISSING entry
//!   (None) and an INVALID entry (empty, or not a nonzero multiple of 32 bytes) as a boot failure:
//!   the server REFUSES TO START rather than falling open to "accept any peer". It never defaults
//!   to an empty/open allowlist.
//!
//! **Key-material boundary + the persistent store (execrun-enablement slice 3).** The allowlist
//! material is SecureStore-derived and stays OUTSIDE agent-readable surfaces — NEVER in the repo,
//! logs, artifacts, or any prompt-visible config; the server reports only presence/validity (bool)
//! plus a count, never the pubkey bytes. At boot the server now opens the PERSISTENT
//! [`FileSecureStore`] the `hub_agent_run_enroll` CLI provisions: it reads the master key via
//! [`friday_hub::key_source::read_master_key`] (env-or-file, **never auto-generated**), derives the
//! store KEK via [`friday_hub::key_source::derive_file_store_kek`] and DROPS the `Zeroizing` master
//! immediately, resolves the store dir (`--store-dir`, default
//! [`friday_hub::key_source::default_store_dir`]), and opens the store under that KEK to load the
//! allowlist. An UNPROVISIONED host (no master key, or no/empty/corrupt allowlist) makes the binary
//! REFUSE TO BOOT — it never falls open to "accept any peer", and there is NO `--peer-pubkey`
//! arg/env fallback (the SecureStore-derived decision is binding). This still lands DARK: nothing
//! connects to it in production (no production caller, no LaunchAgent entry) until the slice-6
//! live-flip. Tests provision a temp [`FileSecureStore`] / [`friday_crypto::InMemorySecureStore`]
//! fixture and drive `accept_one`/`establish_session`/`load_peer_allowlist` directly (NOT `run()`),
//! so no real production key material is required to build or test.
//!
//! S-F is ADDITIVE: the peer gate is a NEW check BEFORE the S-C/S-E gates (low-order check,
//! per-handshake nonce, owner-allowlist, possession-of-session, msg_id dedup), not a reorder of
//! them — all of those PRESERVE'd properties still hold and are still exercised through the real
//! `accept_one` path (the migrated tests allowlist the client pubkey so each pre-existing gate is
//! still the layer that rejects in its own test). `rust_wired` at best; NOT v1 GO; `executeRun` is
//! NOT replaced; the live forged-peer proof is the coordinator's at slice-6.
//!
//! ## S-E anti-replay (this revision — DARK, security-critical)
//! S-C's adversarial panel found a REAL replay hole: the auth challenge was a FIXED constant and
//! `server_kp` is stable-per-boot, so a captured sealed `auth_proof` RE-AUTHENTICATED verbatim on
//! a later connection (the attacker replays the public peer-pubkey preamble → same session key →
//! the stale proof opens). S-E kills replay-to-AUTHENTICATE two ways:
//! * **per-handshake nonce.** [`establish_session`] generates a FRESH CSPRNG nonce per connection
//!   ([`generate_approval_nonce`], OsRng) and sends it cleartext; the peer must seal
//!   `AUTH_CHALLENGE || session_nonce` in its `auth_proof`. A proof captured under nonce `N1`
//!   cannot verify on a new handshake (nonce `N2`) — the attacker cannot re-seal `…||N2` without
//!   the paired ECDH private half. The AAD also length-binds `(principal, run_id)` so a proof
//!   can't be LIFTED to a different pair.
//! * **per-session msg_id dedup.** [`serve_sealed_session`] wires a fresh [`IdempotencyTracker`]
//!   so a replayed `msg_id` WITHIN a session is rejected fail-closed.
//!
//! S-E closes REPLAY. It did NOT add PEER authentication — a FRESH local process completing the
//! CURRENT handshake and forging a proof for an allowlisted owner string. **S-F (this revision)
//! CLOSES that FORGERY gap** with the SecureStore peer-pubkey allowlist gate described above: only
//! an allowlisted peer pubkey establishes a session.
//!
//! ## What this slice is (DARK)
//! S-B stood up the SERVER plus per-session sealed key establishment (peer pubkey from the
//! wire, ECDH to a session key) and a fail-closed serve loop with **NO dispatch**. **S-C**
//! adds, on a sealed [`Message::AgentRunRequest`]: VERIFY the forwarded principal against the
//! established session (via `AuthedPrincipal::authenticate_forwarded`, which checks
//! possession-of-session, non-empty, non-anonymous, and owner-allowlist), then DISPATCH to the
//! Rust agent loop ([`run_authed_agent_loop`]) and return a REFS-ONLY
//! [`Message::AgentRunResult`] over the wire while delivering the answer BODY **sealed** back
//! over the same session (the owner-only channel).
//!
//! It STILL lands DARK: nothing connects to it in production (no production caller, no
//! LaunchAgent entry). A LATER sub-slice (S-F) wires a production caller behind a default-off
//! flag and runs the live forged-principal-fails-closed proof. Removing this file reverts S-C.
//!
//! ## Truth label
//! WS substrate **S-C + S-E**. Loopback-only. **Dev key-exchange** (the PRODUCTION key source —
//! loopback pairing handshake vs SecureStore — is a LATER decision, deferred; here both peers
//! hold their OWN keypair and ECDH at connect). The bound principal is
//! **TRUSTED-PEER-FORWARDED** (the in-TCB TS API resolved it from a validated bearer token and
//! forwarded it over the sealed session) — NOT a client-asserted string; the sealed session is
//! the basis of trust and the owner-allowlist is the final ceiling.
//!
//! **S-E closes REPLAY** (a captured `auth_proof` no longer re-authenticates across handshakes —
//! per-handshake nonce; a replayed `msg_id` within a session is rejected). **PEER-AUTH is STILL
//! DEFERRED to S-F**: a fresh local process completing the CURRENT handshake can still forge a
//! proof for an allowlisted owner string — only loopback + the dark / no-prod-caller posture
//! bounds it. **Wire-format change (for S-F / the dark S-D TS client):** the server now emits a
//! cleartext NONCE frame AFTER its pubkey and BEFORE the WS upgrade; any real peer MUST read that
//! frame or its WS handshake desyncs. (The S-D TS client is hermetic/refs-only and does NOT speak
//! this preamble, so it is unaffected; S-F's production caller must read the nonce.) Production
//! key-source + a supervisor are deferred (open-qs). `rust_wired` at best; NOT v1 GO; `executeRun`
//! is NOT replaced; the live forged-principal proof is the coordinator's at S-F.
//!
//! ## Why this is NOT the `hub_authed_run` ECDH anti-pattern
//! The proof bin `hub_authed_run` generates BOTH ECDH halves in-process and seals to itself — an
//! auth BYPASS acceptable only for an in-process one-shot proof. This server does NOT: it
//! generates exactly ONE keypair (its OWN, at boot), and the EXTERNAL peer's public key is read
//! FROM THE WIRE. The server can never fabricate the peer's half — a caller that does not hold
//! the matching private key derives a different session key and its sealed envelopes (including
//! `auth_proof`) will not open (fail-closed). **A session key alone is NOT authorization:** even
//! a correct-handshake peer is rejected unless its forwarded principal is allowlisted.
//!
//! ## Hardening preconditions (S-B adversarial verify — gated BEFORE dispatch)
//! * **Non-contributory peer key rejected.** `agree()` discards `was_contributory()`, so a peer
//!   that sends a known low-order X25519 point would drive an all-zero shared secret. We reject
//!   the canonical low-order points in [`establish_session`] BEFORE deriving the session key —
//!   no session, no dispatch.
//! * **Per-connection read timeout.** Each accepted connection gets a [`READ_TIMEOUT`] on its
//!   `TcpStream` BEFORE the preamble read, so a stalled/slow-loris peer cannot wedge the
//!   long-lived single-threaded accept loop before auth/dispatch.
//!
//! ## Live key
//! [`HubRuntime::live`] reads the DeepSeek key from the env (`DeepSeekClient::from_env`, never
//! logged). It only CONSTRUCTS the client (no network call); running an actual agent-run needs
//! `FRIDAY_DEEPSEEK_API_KEY` — the SEPARATE operator live-proof. CI only BUILDS this bin and the
//! tests drive a MOCK-transport runtime (never [`HubRuntime::live`]).

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use friday_crypto::{
    generate_approval_nonce, seal, DataKey, DeviceKeypair, FileSecureStore, Sealed, SecureStore,
};
use friday_deepseek::Transport;
use friday_hub::hub_server::{run_authed_agent_loop, AuthedPrincipal, ForwardedAuth};
use friday_hub::key_source::{PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN};
use friday_hub::runtime::{HubConfig, HubRuntime};
use friday_protocol::{Envelope, IdempotencyTracker, Message, Seen};
use friday_transport::{
    read_frame, write_frame, ws_accept, ws_recv_envelope, ws_send_envelope, TransportError,
    WireWebSocket,
};

/// The session AAD binding every sealed envelope on an S-C session to this protocol/version.
/// A fixed, public, non-secret constant (the confidentiality is in the session key, not the AAD).
const SESSION_AAD: &[u8] = b"friday:execrun:ws:s-c:agent-run-session:aad:v1";

/// The BASE authentication challenge the trusted peer seals (in `auth_proof`) to prove
/// possession of the session key. A fixed, public, non-secret constant — but as of S-E it is
/// NOT the sole binding: the peer seals `AUTH_CHALLENGE || session_nonce` (a FRESH per-handshake
/// CSPRNG nonce), and the AAD additionally binds the principal + run_id. The security against
/// REPLAY is in the per-handshake nonce (a captured proof sealed a DIFFERENT nonce and no longer
/// verifies); the security against forgery is still in possessing the session key.
const AUTH_CHALLENGE: &[u8] = b"friday:execrun:ws:s-c:authed-run:challenge:v1";

/// S-E anti-replay: the byte length of the fresh per-handshake nonce the server generates and
/// sends in cleartext. [`generate_approval_nonce`] returns 32 CSPRNG bytes hex-encoded = 64
/// lowercase-hex ASCII chars; we bind those 64 fixed-width bytes (a fixed length keeps the
/// `challenge || nonce` concat unambiguous). A malformed nonce frame of any other length is a
/// fail-closed handshake error (no session).
const SESSION_NONCE_LEN: usize = 64;

/// Per-connection read timeout: a stalled peer cannot wedge the long-lived accept loop before
/// auth/dispatch. Set on the `TcpStream` BEFORE the cleartext preamble read; it propagates
/// through the WS layer (the underlying stream is the same socket).
const READ_TIMEOUT: Duration = Duration::from_secs(30);

// S-F: the SecureStore allowlist id (`PEER_PUBKEY_ALLOWLIST_ID`) and the X25519 pubkey width
// (`X25519_PUBKEY_LEN`) are NOT redefined here — they are imported from `friday_hub::key_source`
// (the single source of truth shared with the enroll CLI). MED-1: a local copy would let a future
// edit silently desync the enroll-CLI's id/len from the server's, fail-closing the allowlist read
// at cutover. The server now redefines NONE of {the id, the pubkey length, the KEK derivation, the
// store-dir default} — all come from key_source.

/// The canonical low-order X25519 points (the libsodium `has_small_order` set), stored in their
/// **bit-255-masked** canonical form. A peer public key that decodes to one of these drives an
/// all-zero shared secret — i.e. a NON-CONTRIBUTORY agreement that `was_contributory()` would
/// reject. Because `agree()` discards that signal, we reject these points at
/// [`establish_session`] BEFORE deriving the session key, via [`is_low_order_x25519`] which
/// **masks byte 31's high bit before comparing** (RFC 7748 `decodeUCoordinate` ignores bit 255,
/// so a blacklisted point with the high bit flipped decodes to the SAME degenerate point and
/// MUST also be rejected). Pure byte-comparison (no new crypto dep) — the standard mitigation.
const LOW_ORDER_X25519_POINTS: [[u8; 32]; 7] = [
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
/// rejected before a session is derived. We **mask byte 31's high bit** before comparing because
/// X25519 (RFC 7748 `decodeUCoordinate`, which curve25519-dalek follows) ignores bit 255 — so a
/// blacklisted point with the high bit flipped decodes to the SAME degenerate point and would
/// otherwise sail past an exact-match table (an auth bypass: the all-zero shared secret is
/// attacker-predictable, independent of the server's private key). Masking is safe whether or
/// not the curve impl masks (if it didn't, the high-bit variant is a different point and the
/// mask is harmless). Constant-time-ness is NOT required (the pubkey is public).
fn is_low_order_x25519(peer_pub: &[u8; 32]) -> bool {
    let mut p = *peer_pub;
    p[31] &= 0x7f;
    LOW_ORDER_X25519_POINTS.contains(&p)
}

/// A boot-time failure category. Coarse + safe — the raw detail is NOT surfaced so a storage/init
/// error cannot leak a path or a key.
#[derive(Debug)]
enum ServerError {
    BadArgs,
    Bind,
    Init,
    /// S-F: the SecureStore peer-pubkey allowlist is MISSING or INVALID ⇒ FAIL CLOSED (the server
    /// refuses to start rather than accept any peer). The detail (which) is NOT surfaced.
    PeerAllowlist,
    /// FIX-Q3a (hardening): the allowlist loaded+parsed cleanly but holds MORE THAN ONE peer pubkey.
    /// Multi-peer is REFUSED until the multi-principal bindings land (FIX-Q2: bind exec owner to the
    /// authenticated caller; FIX-Q3b: a tamper-evident pubkey→principal map so the caller principal
    /// is DERIVED from the matched pubkey, not the wire-asserted `forwarded_principal`). Until then a
    /// 2nd enrolled pubkey + the client-asserted owner string would form a confidentiality-leaking
    /// chain (any enrolled peer forwards the single owner → receives the owner-sealed body). This
    /// turns the single-peer CLI convention into a SERVER invariant. The count is NOT surfaced.
    MultiPeerUnsupported,
    /// The master key (`FRIDAY_MASTER_KEY` / `~/.friday/master.key`) is absent or unreadable ⇒ the
    /// server REFUSES TO BOOT. An unprovisioned host has no service; it NEVER auto-generates a key
    /// (that would derive a KEK that cannot open the enroll CLI's store). The category only — never
    /// the key bytes or the file path.
    MasterKeyUnavailable,
    /// The persistent FileSecureStore cannot be resolved/opened (e.g. `$HOME` unset so the default
    /// store dir is unresolvable, or the open failed) ⇒ FAIL CLOSED. The category only — never the
    /// path (a path can carry the operator's home/username).
    StoreUnavailable,
}

/// Why a SecureStore peer-pubkey allowlist load failed. Coarse + non-leaking: it names the failure
/// CATEGORY only, never the (would-be) pubkey bytes.
#[derive(Debug, PartialEq, Eq)]
enum PeerAllowlistError {
    /// No allowlist entry exists in the SecureStore (a MISSING entry — never "open").
    Missing,
    /// The entry exists but is malformed: empty, or not a NONZERO multiple of [`X25519_PUBKEY_LEN`].
    Invalid,
    /// FIX-Q3a: the entry parsed cleanly but holds MORE THAN ONE pubkey (or, defensively, zero).
    /// Refused until the multi-principal bindings land — see [`enforce_single_peer`].
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
/// returned to the caller but NEVER logged/printed by this bin (only a count is reported).
fn load_peer_allowlist(
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
/// 32-byte keys — constant-time-ness is NOT required (a public key is not secret), and the value
/// is fixed-width so there is no length oracle. This is the S-F PEER gate.
fn peer_is_allowlisted(allowlist: &[[u8; X25519_PUBKEY_LEN]], peer_pub: &[u8; 32]) -> bool {
    allowlist.contains(peer_pub)
}

/// FIX-Q3a (hardening) — fail closed unless the allowlist holds EXACTLY ONE peer pubkey.
///
/// `load_peer_allowlist` is intentionally a multi-key PARSER (any nonzero multiple of 32 bytes →
/// N keys), so the single-peer guarantee was, until now, only the enroll CLI's CONVENTION — the
/// server would happily admit N. This guard converts that convention into a SERVER invariant.
///
/// Why refuse >1 today: there is no cryptographic pubkey↔principal binding (the run principal is the
/// client-asserted `forwarded_principal`, checked only against the `--owner` allowlist ceiling). A
/// SECOND enrolled pubkey + the single owner string therefore forms a confidentiality-leaking chain
/// — any enrolled peer can forward the owner principal, pass the ceiling, and receive the
/// owner-sealed body. Multi-peer is gated behind the (currently unbuilt) multi-principal bindings:
///   * FIX-Q2  — bind the exec owner to the AUTHENTICATED caller (not the static runtime config);
///   * FIX-Q3b — a tamper-evident pubkey→principal map so the caller principal is DERIVED from the
///     matched enrolled pubkey rather than trusted from the wire.
///
/// Until both land, `len() != 1` is refused. `!= 1` (not `> 1`) also catches an impossible-0 list
/// fail-closed; the parser guarantees ≥1, so this is purely belt-and-suspenders for the 0 case.
fn enforce_single_peer(allowlist: &[[u8; X25519_PUBKEY_LEN]]) -> Result<(), PeerAllowlistError> {
    if allowlist.len() != 1 {
        return Err(PeerAllowlistError::MultiPeer);
    }
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        let kind = match err {
            ServerError::BadArgs => "bad_args",
            ServerError::Bind => "bind_failed",
            ServerError::Init => "init_failed",
            // S-F: a missing/invalid SecureStore peer-pubkey allowlist fails the boot CLOSED. The
            // category only — never the (would-be) pubkey bytes.
            ServerError::PeerAllowlist => "peer_allowlist_unavailable",
            // FIX-Q3a: >1 enrolled peer pubkey is refused at boot (single-peer is now a code
            // invariant). The category only — never the count, never the pubkey bytes.
            ServerError::MultiPeerUnsupported => "peer_allowlist_multi_peer_unsupported",
            // Boot fail-closed reasons for the persistent store. NON-LEAKING: never the key bytes
            // and never the store path (which can carry the operator's home/username).
            ServerError::MasterKeyUnavailable => "master_key_unavailable",
            ServerError::StoreUnavailable => "secure_store_unavailable",
        };
        eprintln!("hub_agent_run_server_unavailable: {kind}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), ServerError> {
    let args: Vec<String> = env::args().collect();

    let workspace_root = arg_value(&args, "--workspace").ok_or(ServerError::BadArgs)?;
    let port: u16 = arg_value(&args, "--port")
        .map(|p| p.parse::<u16>().map_err(|_| ServerError::BadArgs))
        .transpose()?
        .unwrap_or(0);

    // The Hub OWNER allowlist (v1 = a single configured owner). HUB-SUPPLIED here (operator CLI
    // arg), NEVER client-controlled — it is the ceiling on which forwarded principals may run.
    // A blank/missing owner ⇒ an EMPTY allowlist ⇒ EVERY dispatch is rejected (fail-closed: a
    // server with no configured owner runs nothing).
    let owner_allowlist: Vec<String> = arg_value(&args, "--owner")
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .into_iter()
        .collect();

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let db_path = arg_value(&args, "--db").unwrap_or_else(|| {
        format!("{workspace_root}/.hub-agent-run-server-dev-{pid}-{nanos}.sqlite")
    });

    // (0) S-F PEER AUTH — open the PERSISTENT FileSecureStore the enroll CLI provisioned, then load
    // the authorized peer-pubkey allowlist from it BEFORE anything else, FAILING CLOSED at every
    // step. The store key material is sourced via `friday_hub::key_source` (the single source of
    // truth shared with the enroll CLI), NOT a CLI arg/env key:
    //   * read the master key fail-closed (env-or-file; NEVER auto-generated — a missing key means
    //     the host is UNPROVISIONED, so the server refuses to boot rather than mint a key that
    //     would derive a KEK the enroll CLI's store can't be opened under);
    //   * derive the FileSecureStore KEK and DROP the master immediately (it is `Zeroizing`, so the
    //     drop wipes it — the master never lives past the one derivation it is needed for);
    //   * resolve the store dir (`--store-dir`, default `key_source::default_store_dir()`, which is
    //     fail-closed if `$HOME` is unset) and open the store under the derived KEK.
    // An unprovisioned server (no master key, or no/empty/corrupt allowlist) REFUSES TO START — it
    // never falls open to "accept any peer". The store is only needed at boot to load the allowlist;
    // it is dropped immediately after (below) so the KEK does not sit in memory during the (long-
    // lived) serving loop. This STAYS DARK: nothing connects to it in production (no production
    // caller, no LaunchAgent entry) until the slice-6 live-flip. We report only the COUNT — never
    // the pubkey bytes, never the master, never the store path.
    let master = friday_hub::key_source::read_master_key().map_err(|_| {
        // The category is surfaced via the ServerError mapping; the key bytes are never touched.
        ServerError::MasterKeyUnavailable
    })?;
    let kek = friday_hub::key_source::derive_file_store_kek(&master);
    drop(master); // `Zeroizing` ⇒ the master is wiped now; only the KEK survives.
    let store_dir: PathBuf = match arg_value(&args, "--store-dir") {
        Some(d) => PathBuf::from(d),
        None => friday_hub::key_source::default_store_dir()
            .map_err(|_| ServerError::StoreUnavailable)?,
    };
    let secure_store =
        FileSecureStore::open(&store_dir, kek).map_err(|_| ServerError::StoreUnavailable)?;
    let peer_allowlist =
        load_peer_allowlist(&secure_store, PEER_PUBKEY_ALLOWLIST_ID).map_err(|_| {
            // The category is logged via the ServerError mapping; the bytes are never touched.
            ServerError::PeerAllowlist
        })?;
    // FIX-Q3a (hardening) — fail the BOOT closed unless EXACTLY ONE peer is enrolled. The loader is a
    // multi-key parser, so without this guard a 2nd enrolled pubkey would be silently admitted; with
    // no pubkey↔principal binding (FIX-Q3b) + config-sourced exec owner (FIX-Q2) that is a latent
    // confidentiality leak. A misconfigured (>1) store therefore never serves. DARK w.r.t. the
    // running bin: the live store has exactly 1 entry, so this is a no-op until a future redeploy.
    enforce_single_peer(&peer_allowlist).map_err(|_| ServerError::MultiPeerUnsupported)?;
    eprintln!(
        "hub_agent_run_server: peer-pubkey allowlist loaded from SecureStore (count={})",
        peer_allowlist.len()
    );
    // The KEK-holding store is no longer needed (the allowlist is in memory); drop it so the KEK
    // is wiped (Kek is ZeroizeOnDrop) rather than lingering for the lifetime of the serving loop.
    drop(secure_store);

    // (1) Build ONE HubRuntime at boot so the DeepSeek-client/DB cold-start is paid ONCE (not
    // per connection). S-C HOLDS this runtime and DISPATCHES into `run_task` for an authenticated
    // peer. The runtime is single-owner (v1): it is configured with the SAME principal the
    // allowlist admits, so owner-wiring records `owner == caller` and the body is releasable to
    // them. `HubRuntime::live` only CONSTRUCTS the provider client (no network call); an actual
    // run needs the env key — the separate operator live-proof.
    let runtime = HubRuntime::live(HubConfig {
        // Clone here so the `db_path` binding stays alive for the session-reaper tick below,
        // which opens its OWN connection to the SAME path (the accept-loop's runtime
        // connection is never shared across threads).
        db_path: db_path.clone(),
        workspace_root: PathBuf::from(&workspace_root),
        secret: ephemeral_dev_secret(pid, nanos),
        max_turns: 6,
        principal_id: owner_allowlist.first().cloned(),
        disabled_tools: vec![],
        read_only: false,
        operator_vk: None,
    })
    .map_err(|_| ServerError::Init)?;

    // (2) The server's OWN long-lived keypair (the ONLY `generate()` in non-test code). In
    // production this comes from SecureStore; the peer's public key arrives FROM THE PEER over
    // the wire — never fabricated here.
    let server_kp = DeviceKeypair::generate();

    let listener = AgentRunWsListener::bind_loopback(port).map_err(|_| ServerError::Bind)?;
    let addr = listener.local_addr().map_err(|_| ServerError::Bind)?;
    eprintln!(
        "hub_agent_run_server: listening (loopback-only) on {addr} — DARK (S-C: authed dispatch arm, no production caller)"
    );

    // (2b) Rust-owned session-lifecycle REAPER tick (DARK, DEFAULT-OFF). Spawn a background
    // thread that opens its OWN DB connection and runs `sweep_lifecycle` on an interval —
    // BUT ONLY when the operator has explicitly enabled it. The thread is spawned ONLY when
    // `FRIDAY_RUST_SESSION_REAPER_ENABLED` is "1"/"true"; unset/anything-else ⇒ NOT spawned
    // ⇒ no second DB connection, no reaping. This is what makes deploying the new binary
    // SAFE: the destructive reaper (it HARD-DELETES rows) does nothing until the flag is
    // flipped — wire-live = (rebuild bin + deploy + set the env flag) is a SEPARATE
    // operator-gated step. The reaper owns lifecycle on `agent_session` (the retired TS
    // `session-lifecycle-sweep` replacement).
    if reaper_enabled() {
        spawn_session_reaper(db_path.clone());
    } else {
        eprintln!(
            "hub_agent_run_server: session-lifecycle reaper DISABLED (set FRIDAY_RUST_SESSION_REAPER_ENABLED=1 to enable)"
        );
    }

    // (A1 run-controls) Read the run-control flag ONCE at boot (default-off). When false the
    // server emits/handles EXACTLY the pre-A1 wire (a paused run ⇒ `AgentRunResult{no_answer}`;
    // a control message ⇒ benign keepalive echo), so deploying a v13 binary changes NO live
    // behavior until the operator flips this SEPARATE flag.
    let run_control_enabled =
        agent_run_control_enabled_from(env::var(AGENT_RUN_CONTROL_ENABLED_ENV).ok().as_deref());
    if run_control_enabled {
        eprintln!(
            "hub_agent_run_server: on-wire run-CONTROL plane ENABLED (FRIDAY_AGENT_RUN_CONTROL_VIA_RUST)"
        );
    } else {
        eprintln!(
            "hub_agent_run_server: on-wire run-CONTROL plane DISABLED (set FRIDAY_AGENT_RUN_CONTROL_VIA_RUST=1 to enable)"
        );
    }

    // (3) Long-lived accept loop. Each accepted connection: set the read timeout, read the peer
    // pubkey preamble, REJECT a non-allowlisted peer pubkey (S-F, the FIRST gate), reject low-order
    // points, run the WS handshake, derive the sealed session key, and serve sealed envelopes
    // fail-closed — dispatching authed agent-runs.
    loop {
        match listener.accept_one(
            &server_kp,
            &runtime,
            &owner_allowlist,
            &peer_allowlist,
            run_control_enabled,
        ) {
            Ok(_served) => {}
            // A connection-level error ends THAT connection only; the server keeps listening.
            Err(_e) => continue,
        }
    }
}

/// The env flag that gates the session-lifecycle reaper tick. DEFAULT-OFF: the tick is
/// spawned ONLY when `FRIDAY_RUST_SESSION_REAPER_ENABLED` is exactly `"1"` or `"true"`
/// (case-insensitive). Unset — or any other value — leaves the reaper DISABLED, so the
/// new binary deploys DARK (the destructive sweep never runs until the operator flips it).
const SESSION_REAPER_ENABLED_ENV: &str = "FRIDAY_RUST_SESSION_REAPER_ENABLED";

/// The reaper sweep cadence (120s), matching the old TS sweep's interval.
const SESSION_REAPER_INTERVAL: Duration = Duration::from_secs(120);

/// (A1 run-controls) The env flag that gates the on-wire RUN-CONTROL protocol. DEFAULT-OFF: the
/// server emits `AgentRunPaused` (instead of the pre-A1 `AgentRunResult{no_answer}` for a paused
/// run) and handles `AgentRunResume`/`AgentRunCancel`/`AgentRunReject` ONLY when
/// `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` is exactly `"1"`/`"true"` (case-insensitive). Unset — or any
/// other value — leaves the control plane DARK: a paused run emits EXACTLY the pre-A1
/// `AgentRunResult{status:"no_answer"}` bytes, and a control message is treated as a benign
/// keepalive (echoed), so deploying a v13 binary changes NO live behavior. SEPARATE from
/// `FRIDAY_ROUTE_AGENT_RUN_VIA_RUST` (the run-START flag) — flipping THIS one is the run-CONTROL
/// live-flip, an operator DEPLOY-GO decision.
const AGENT_RUN_CONTROL_ENABLED_ENV: &str = "FRIDAY_AGENT_RUN_CONTROL_VIA_RUST";

/// Whether the operator has explicitly enabled the on-wire run-control plane. Fail-closed: only
/// the exact opt-in values enable it; everything else (including unset) is OFF.
fn agent_run_control_enabled_from(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true")
    )
}

/// Whether the operator has explicitly enabled the session-lifecycle reaper. Fail-closed:
/// only the exact opt-in values enable it; everything else (including unset) is OFF.
fn reaper_enabled() -> bool {
    reaper_enabled_from(env::var(SESSION_REAPER_ENABLED_ENV).ok().as_deref())
}

/// Pure flag-matcher (separated from the env read so it is testable without mutating the
/// process-global environment). DEFAULT-OFF: `None` (unset) ⇒ false; only the exact opt-in
/// values `"1"`/`"true"` (case-insensitive, trimmed) ⇒ true; everything else ⇒ false.
fn reaper_enabled_from(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1") | Some("true")
    )
}

/// Spawn the DARK session-lifecycle reaper tick on its OWN thread + OWN DB connection.
///
/// The thread opens a SEPARATE `Db::open_hub` connection (NOT the accept-loop's, never
/// shared across threads, and deliberately NOT `open_hub_concurrent` — that flips the prod
/// DB to WAL persistently, which is an operator live-flip, not a dark deploy) and calls
/// `sweep_lifecycle` every [`SESSION_REAPER_INTERVAL`]. Errors (a failed open, or a failed
/// sweep) are LOGGED and the loop continues — the reaper never panics the daemon. A
/// non-empty sweep logs its per-transition counts (refs-only: counts, never session bodies).
fn spawn_session_reaper(db_path: String) {
    thread::spawn(move || {
        // Open this thread's OWN connection. A failed open is logged and the reaper exits
        // (the daemon keeps serving); it does NOT crash the process.
        let db = match friday_storage::Db::open_hub(&db_path) {
            Ok(db) => db,
            Err(_e) => {
                // Category only — never the db_path (it can carry the operator's home/username).
                eprintln!(
                    "hub_agent_run_server: session reaper could not open its DB connection — reaper not running"
                );
                return;
            }
        };
        eprintln!(
            "hub_agent_run_server: session-lifecycle reaper ENABLED (interval={}s)",
            SESSION_REAPER_INTERVAL.as_secs()
        );
        loop {
            thread::sleep(SESSION_REAPER_INTERVAL);
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            match friday_storage::sweep_lifecycle(db.conn(), now_ms) {
                Ok(outcome) if !outcome.is_empty() => {
                    eprintln!(
                        "hub_agent_run_server: session sweep idled={} archived={} pruned={} hard_deleted={} messages_deleted={}",
                        outcome.idled,
                        outcome.archived,
                        outcome.pruned,
                        outcome.hard_deleted,
                        outcome.messages_deleted,
                    );
                }
                // An empty sweep is the common case — stay quiet to avoid log spam.
                Ok(_) => {}
                // A sweep error (e.g. a transient lock) is logged and the loop continues; the
                // reaper never crashes the daemon. Category only — never row contents.
                Err(_e) => {
                    eprintln!("hub_agent_run_server: session sweep failed (continuing)");
                }
            }
        }
    });
}

/// The loopback-only S-C WS listener. Owns the socket lifecycle; the session/serve/dispatch
/// semantics live in [`establish_session`] / [`serve_sealed_session`].
struct AgentRunWsListener {
    listener: TcpListener,
}

impl AgentRunWsListener {
    /// Bind a **loopback-only** listener on `127.0.0.1:<port>` (`port = 0` lets the OS assign).
    /// Binding [`Ipv4Addr::LOCALHOST`] (NEVER `0.0.0.0`/LAN) is the "this Mac only" guarantee:
    /// off-box reachability is zero.
    fn bind_loopback(port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        Ok(Self { listener })
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept exactly ONE connection, set the per-connection read timeout, establish the sealed
    /// session (peer pubkey from the wire; S-F: a NON-ALLOWLISTED peer pubkey is rejected FIRST;
    /// then low-order points rejected), and serve it fail-closed — dispatching authed agent-runs.
    /// Returns the count of envelopes processed on that session.
    fn accept_one<T: Transport>(
        &self,
        server_kp: &DeviceKeypair,
        runtime: &HubRuntime<T>,
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
        run_control_enabled: bool,
    ) -> Result<usize, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        // HARDENING: a per-connection read timeout BEFORE any read, so a stalled peer cannot
        // wedge the single-threaded accept loop before auth/dispatch.
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let (mut ws, session_key, session_nonce) =
            establish_session(stream, server_kp, peer_allowlist)?;
        serve_sealed_session(
            &mut ws,
            &session_key,
            &session_nonce,
            runtime,
            owner_allowlist,
            run_control_enabled,
        )
    }
}

/// Establish the sealed session for one connection.
///
/// **Key-source abstraction (dev/test exchange; prod source deferred):** the server holds its
/// OWN `server_kp`; the EXTERNAL peer's public key is read from the wire as a cleartext
/// length-prefixed preamble BEFORE the WS upgrade. The server then ECDHs
/// `server_kp.agree(peer_pub)` → the per-session [`DataKey`].
///
/// FAIL-CLOSED gates BEFORE the session is derived (in order):
/// * a peer-pubkey frame that is not exactly 32 bytes (a malformed preamble can never yield a
///   session);
/// * **S-F PEER AUTH:** the peer pubkey is NOT in the SecureStore-derived allowlist (a fresh local
///   keypair cannot forge a session — this is the FORGERY gate, and it runs FIRST, before we send
///   our own pubkey/nonce, so a non-allowlisted peer learns NOTHING); and
/// * a known low-order / NON-CONTRIBUTORY X25519 point (which would drive an all-zero shared
///   secret) — see [`is_low_order_x25519`].
///
/// **S-E anti-replay — per-handshake nonce.** After the low-order check and AFTER sending our own
/// pubkey, but BEFORE the WS upgrade (the cleartext preamble is the only place we can `write_frame`
/// raw bytes), the server generates a FRESH CSPRNG nonce ([`generate_approval_nonce`], the same
/// OsRng source used for keys/approval nonces) and sends it cleartext. A nonce is NOT a secret;
/// its job is to make the challenge the peer must seal UNIQUE per connection, so a captured
/// `auth_proof` from a prior handshake (a different nonce) cannot re-authenticate. The nonce is
/// returned with the session key and threaded into [`AuthedPrincipal::authenticate_forwarded`].
/// The low-order-check-BEFORE-agree ordering (an S-C property) is preserved.
fn establish_session<S: Read + Write>(
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

    // (a') S-F PEER AUTH (the FORGERY gate — FIRST, before any other check). Verify the peer pubkey
    // is in the SecureStore-derived allowlist. A non-allowlisted pubkey ⇒ NO session: we return
    // BEFORE sending our own pubkey or the nonce and BEFORE the `agree()`, so a fresh local keypair
    // (which can otherwise complete the handshake and forge an `auth_proof` for an allowlisted owner
    // string) cannot establish a session and the peer learns nothing. We do NOT log the rejected
    // pubkey (a public value, but kept out of logs on principle).
    if !peer_is_allowlisted(peer_allowlist, &peer_pub) {
        return Err(TransportError::Protocol(
            "peer pubkey not in SecureStore allowlist".into(),
        ));
    }

    // HARDENING: reject a non-contributory (known low-order) peer key BEFORE deriving the
    // session — such a key would yield an all-zero shared secret a peer never has to "prove".
    if is_low_order_x25519(&peer_pub) {
        return Err(TransportError::Protocol(
            "non-contributory (low-order) peer key rejected".into(),
        ));
    }

    // (b) Send our OWN public key so the peer can derive the same session key.
    write_frame(&mut stream, &server_kp.public_bytes())?;

    // (b') S-E: generate + send a FRESH per-handshake CSPRNG nonce (cleartext; not a secret). The
    // peer must seal `AUTH_CHALLENGE || session_nonce` in its `auth_proof`, so a proof captured
    // from a PRIOR handshake (a different nonce) cannot re-authenticate on THIS connection.
    let session_nonce = generate_approval_nonce().into_bytes();
    // Invariant guard (fail-closed): the CSPRNG nonce must be the expected fixed width, so the
    // `challenge || nonce` concat the peer seals is unambiguous. Any deviation aborts the
    // handshake (no session) rather than deriving a weak/ambiguous binding.
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

/// Serve sealed envelopes over ONE established session until the peer disconnects, sends an
/// envelope that fails to open under the session key, OR completes/fails an agent-run dispatch.
///
/// **S-C dispatch arm.** A sealed envelope that opens to [`Message::AgentRunRequest`] is the
/// dispatch path:
/// 1. [`AuthedPrincipal::authenticate_forwarded`] verifies the forwarded principal against the
///    session (possession-of-session proof + non-empty + non-anonymous + owner-allowlist).
/// 2. `Some(caller)` ⇒ [`run_authed_agent_loop`] runs the Rust loop AS the authed owner; a
///    REFS-ONLY [`Message::AgentRunResult`] (status + answer sha256/len — NEVER the body) is
///    sent over the wire, and the answer BODY is delivered SEALED back over the SAME session
///    (the owner-only channel) — never as a refs field.
/// 3. `None` (auth fail: forged / empty / anonymous / non-allowlisted principal, OR an
///    `auth_proof` that does not open) ⇒ **fail closed**: NO run, NO body, END the session.
///    Never a partial success.
///
/// Any other (benign) opened envelope is echoed sealed (a keepalive), as in S-B. An envelope
/// that fails to open under the session key ENDS the session (fail-closed) — no dispatch.
///
/// **S-E anti-replay — msg_id dedup.** A per-session [`IdempotencyTracker`] records each opened
/// envelope's `msg_id`; a REPLAYED `msg_id` within this session is rejected fail-closed (END the
/// session, no echo, no dispatch). The tracker is fresh per connection (it lives on the stack of
/// THIS call), so it defends WITHIN-session replay; CROSS-handshake replay is defeated separately
/// by the per-handshake `session_nonce` bound into the auth challenge.
///
/// Returns the number of envelopes processed before the session ended — `0` means the first
/// envelope failed to open OR failed auth (the fail-closed path: no echo, no dispatch).
fn serve_sealed_session<S: Read + Write, T: Transport>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    session_nonce: &[u8],
    runtime: &HubRuntime<T>,
    owner_allowlist: &[String],
    run_control_enabled: bool,
) -> Result<usize, TransportError> {
    let mut processed = 0usize;
    // S-E: per-session msg_id dedup. A reconnect mints a FRESH tracker (so it is not a
    // cross-connection store) — combined with the per-handshake nonce, a captured envelope is
    // useless both within a session (dedup) and across handshakes (nonce).
    let mut seen_ids = IdempotencyTracker::new();
    loop {
        let env = match ws_recv_envelope(ws, session_key, SESSION_AAD) {
            Ok(e) => e,
            // EOF / disconnect / un-openable seal (wrong key or tamper) → END the session.
            // No dispatch, no processing — fail closed.
            Err(_) => return Ok(processed),
        };
        // S-E: reject a REPLAYED msg_id within this session (fail-closed: END the session, no
        // echo, no dispatch). Checked BEFORE any branch so it covers dispatch AND keepalive.
        if let Seen::Replay = seen_ids.observe(&env.msg_id) {
            return Ok(processed);
        }
        match env.message {
            Message::AgentRunRequest {
                run_id,
                task,
                forwarded_principal,
                auth_proof,
                session_id,
                // (A1 run-controls) The per-run CONSTRAINTS the peer asserts. The wire SHAPE +
                // the pure mapping onto a per-run `RunPolicy`
                // ([`friday_hub::agent_run_control::effective_run_policy`]) are built + tested,
                // but APPLYING them on the live dispatch requires the runtime to accept a per-run
                // policy OVERRIDE (today `run_task` uses its OWN constructed `self.policy`).
                // Threading that through the just-fixed live run-START path is a DEFERRED sub-AC
                // (see the PR body) — so this slice does NOT apply the constraints on dispatch.
                // `_constraints` is captured (not `..`) so the destructure stays exhaustive and a
                // future field addition is a compile error, not a silent drop.
                constraints: _constraints,
            } => {
                // The dispatch arm: AUTH BEFORE ANY RUN. The `auth_proof` is the peer-sealed
                // challenge; reconstruct it as a `Sealed` for the session-key open. A malformed
                // proof that cannot decode is an auth failure (None below), not a panic. S-E: the
                // verifier binds THIS handshake's `session_nonce` into the challenge and the
                // `(principal, run_id)` into the AAD — a captured/lifted proof fails to verify.
                let caller = decode_sealed_proof(&auth_proof).and_then(|proof| {
                    AuthedPrincipal::authenticate_forwarded(
                        session_key,
                        SESSION_AAD,
                        AUTH_CHALLENGE,
                        ForwardedAuth {
                            auth_proof: &proof,
                            session_nonce,
                            run_id: &run_id,
                            forwarded_principal: &forwarded_principal,
                        },
                        owner_allowlist,
                    )
                });
                let Some(caller) = caller else {
                    // FAIL CLOSED: a correct-handshake peer with a forged / empty / anonymous /
                    // non-allowlisted principal (or an un-openable proof) is REJECTED. NO run,
                    // NO body, END the session — never a partial success.
                    return Ok(processed);
                };

                // AUTHENTICATED: run the Rust loop AS the bound owner. A route/provider failure
                // is a SAFE FAILURE (body-free NoAnswer) — never a panic, never a partial body.
                //
                // (A2a Phase 1) CONDITIONAL dispatch swap on the client-asserted `session_id`:
                //   * PRESENT (non-empty) ⇒ the SESSIONED entry [`HubRuntime::run_session_task`]
                //     (the EXISTING `run_session_loop` — reloads history, appends this turn), with
                //     the session OWNER = the AUTHENTICATED `caller` (NEVER `session_id`).
                //   * ABSENT (or blank) ⇒ the UNCHANGED sessionless [`run_authed_agent_loop`].
                // The swap is CONDITIONAL by design: `run_session_loop` runs ensure_session/
                // load_session_messages, so routing today's sessionless live path through it would
                // NOT be byte-identical. A blank/whitespace `session_id` is treated as ABSENT so a
                // degenerate value can never silently divert the sessionless path. Both arms then
                // share the IDENTICAL refs + owner-sealed-body emit below (the body is owner-gated
                // by `project_answer_for_authed` in BOTH), so the only difference is which loop ran.
                let now_ms = now_ms();
                let outcome = match session_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    Some(sid) => runtime.run_session_task(&caller, &run_id, sid, &task, now_ms),
                    None => run_authed_agent_loop(runtime, &caller, &run_id, &task, now_ms),
                };

                // (refs) REFS-ONLY terminal receipt over the wire: status + answer FINGERPRINT
                // (sha256/len) + (A1) the run COUNTS (turns / executed_tools) — NEVER the body.
                // Mirrors `AuthedAnswer::proof_refs_json`. Counts are metadata; token counts
                // are DEFERRED (`None`) — not on `LoopOutcome`. An absent count is omitted from
                // the wire (`skip_serializing_if`) ⇒ byte-identical to the pre-A1 result.
                let refs = result_refs(&outcome);
                // (observability) Structured, body-free log of the answer-return so a 503
                // can be traced to a leg (the run_id appeared in NO log for the
                // 503-after-billing event). We log the run_id + the refs `status` + whether
                // a body will be delivered — NEVER the answer body, sha, key, or task. The
                // `has_body` flag lets the next failure distinguish a delivered-eligible run
                // (DB row present, body to send) from a denied/no-answer one. `?` on the
                // sends below means a transport drop ends the session; this line records that
                // the refs leg was REACHED with the run_id, closing the diagnostic gap.
                let has_body = outcome.delivered_body().is_some();
                eprintln!(
                    "hub_agent_run_server_dispatch: run_id={run_id} leg=refs status={} has_body={has_body}",
                    refs.status
                );
                // (A1 run-controls) PAUSE-SURFACING — discriminate the NoAnswer black hole. When
                // the run produced NO body, it is EITHER a genuine no-answer OR a PAUSE (the loop
                // persisted a `pending_approval_request` before returning, and the server only
                // sees `NoAnswer`). FLAG-GATED + DARK: only when the run-control flag is ON do we
                // probe the DB for a live pending row and, if found, emit `AgentRunPaused` instead
                // of `AgentRunResult{no_answer}`. With the flag OFF this branch is never taken, so
                // a paused run emits EXACTLY the pre-A1 `AgentRunResult{status:"no_answer"}` bytes
                // (the deploy-safety invariant). The pause frame is REFS-ONLY (nonce + digest +
                // action-verb summary — never the tool body/args).
                let result = if run_control_enabled && !has_body {
                    match friday_hub::agent_run_control::detect_pause(runtime.db().conn(), &run_id)
                    {
                        Ok(Some(pause)) => {
                            eprintln!(
                                "hub_agent_run_server_dispatch: run_id={run_id} leg=paused (run-control enabled)"
                            );
                            Some(Envelope::new(
                                format!("agent-run-paused-{run_id}"),
                                now_ms,
                                Message::AgentRunPaused {
                                    run_id: run_id.clone(),
                                    nonce: pause.nonce,
                                    action_digest: pause.action_digest,
                                    summary: pause.summary,
                                },
                            ))
                        }
                        // No live pending row (genuine no-answer) ⇒ fall through to the unchanged
                        // refs result. A DB probe error is non-fatal: fail SAFE to the pre-A1 path
                        // (never panic, never fabricate a pause).
                        _ => None,
                    }
                } else {
                    None
                };
                let result = result
                    .unwrap_or_else(|| {
                        Envelope::new(
                            format!("agent-run-result-{run_id}"),
                            now_ms,
                            Message::AgentRunResult {
                                run_id: run_id.clone(),
                                status: refs.status,
                                answer_sha256: refs.answer_sha256,
                                answer_len: refs.answer_len,
                                turns: refs.turns,
                                executed_tools: refs.executed_tools,
                                prompt_tokens: None,
                                completion_tokens: None,
                            },
                        )
                    })
                    .with_correlation(env.msg_id.clone());
                if let Err(err) = ws_send_envelope(ws, session_key, &result, SESSION_AAD) {
                    // The refs frame could not be sent (transport closed). Log which leg
                    // failed (run_id + leg) before ending the session — this is the leg-A
                    // "closed-before-the-result" surface; the body is safely in the DB.
                    eprintln!(
                        "hub_agent_run_server_dispatch: run_id={run_id} leg=refs_send error=transport_closed"
                    );
                    return Err(err);
                }

                // (body) Deliver the answer BODY ONLY to the authed owner — SEALED back over the
                // SAME session (the owner-only channel). The body NEVER travels in the refs
                // result. We DOUBLY seal it: `seal(session_key, body)` first (so the body bytes
                // are owner-sealed ciphertext BEFORE they enter any Message), then the transport
                // seals the envelope again — so even a future plaintext log of the carrier never
                // exposes the body. The owner-sealed ciphertext rides the `AskFridayStream.chunk`
                // (the existing Friday-answer-to-owner channel) as hex, terminated by the refs
                // `AgentRunResult` already sent above. A non-delivered outcome (denied /
                // no-answer) sends NO body envelope. Reuses ONLY public protocol/transport items.
                if let Some(body) = outcome.delivered_body() {
                    let sealed_body = seal(session_key, body.as_bytes(), SESSION_AAD)?;
                    let body_env = Envelope::new(
                        format!("agent-run-body-{run_id}"),
                        now_ms,
                        Message::AskFridayStream {
                            seq: 0,
                            chunk: hex_encode(&encode_sealed_proof(&sealed_body)),
                        },
                    )
                    .with_correlation(env.msg_id.clone());
                    if let Err(err) = ws_send_envelope(ws, session_key, &body_env, SESSION_AAD) {
                        // The owner-sealed BODY frame could not be sent. This is the leg-A
                        // "closed-before-the-body" surface: the refs were sent + the answer is
                        // safely persisted in the DB, but the body frame dropped → the TS
                        // sealed client 503s post-billing. Log run_id + leg (NEVER the body)
                        // so the next occurrence is attributable. (See the deferred leg-A
                        // decouple in the PR body.)
                        eprintln!(
                            "hub_agent_run_server_dispatch: run_id={run_id} leg=body_send error=transport_closed"
                        );
                        return Err(err);
                    }
                    eprintln!(
                        "hub_agent_run_server_dispatch: run_id={run_id} leg=body_send status=delivered"
                    );
                }
                processed += 1;
            }
            // (A1 run-controls) RESUME — relay an operator's signed approval to the S6 spine.
            // FLAG-GATED: when the flag is OFF this is a benign keepalive (echoed), so deploying a
            // v13 binary changes no behavior; only when ON do we verify+execute. Resume is
            // SELF-authenticating (the operator's Ed25519 signature is the authority); it uses the
            // runtime's verify key + executor and pre-checks the reject/cancel coupling.
            Message::AgentRunResume {
                ref run_id,
                ref signed_blob,
            } if run_control_enabled => {
                let now_ms = now_ms();
                let outcome = match runtime.operator_vk() {
                    Some(vk) => friday_hub::agent_run_control::resume(
                        runtime.db().conn(),
                        runtime.executor(),
                        vk,
                        run_id,
                        signed_blob,
                        now_ms,
                    )
                    .unwrap_or_else(|_| {
                        // A storage error is a fail-closed refusal (never a panic / partial).
                        friday_hub::agent_run_control::ControlOutcome {
                            op: "resume",
                            accepted: false,
                            status: "storage_failed".to_string(),
                            audit_ref: None,
                        }
                    }),
                    // No operator key provisioned ⇒ cannot verify ⇒ fail-closed refusal.
                    None => friday_hub::agent_run_control::ControlOutcome {
                        op: "resume",
                        accepted: false,
                        status: "operator_vk_unprovisioned".to_string(),
                        audit_ref: None,
                    },
                };
                send_control_result(ws, session_key, &env.msg_id, run_id, &outcome, now_ms)?;
                processed += 1;
            }
            // (A1 run-controls) CANCEL — owner-authed terminal stop. FLAG-GATED (keepalive when
            // off). The forwarded principal is authenticated against the sealed session (the SAME
            // possession proof an AgentRunRequest carries, bound to this run_id), then the control
            // module requires that authenticated principal == the run's bound owner.
            Message::AgentRunCancel {
                ref run_id,
                ref forwarded_principal,
                ref auth_proof,
                ref reason,
            } if run_control_enabled => {
                let now_ms = now_ms();
                let outcome = match authenticate_control_caller(
                    session_key,
                    session_nonce,
                    owner_allowlist,
                    auth_proof,
                    run_id,
                    forwarded_principal,
                ) {
                    Some(caller) => friday_hub::agent_run_control::cancel(
                        runtime.db().conn(),
                        run_id,
                        caller.principal(),
                        reason.as_deref(),
                        now_ms,
                    )
                    .unwrap_or_else(|_| {
                        friday_hub::agent_run_control::ControlOutcome {
                            op: "cancel",
                            accepted: false,
                            status: "storage_failed".to_string(),
                            audit_ref: None,
                        }
                    }),
                    // Session auth failed (forged / non-allowlisted / un-openable proof) ⇒
                    // fail-closed refusal. We do NOT end the session (a control op is not a
                    // dispatch); we answer the refusal and keep serving.
                    None => friday_hub::agent_run_control::ControlOutcome {
                        op: "cancel",
                        accepted: false,
                        status: "auth_failed".to_string(),
                        audit_ref: None,
                    },
                };
                send_control_result(ws, session_key, &env.msg_id, run_id, &outcome, now_ms)?;
                processed += 1;
            }
            // (A1 run-controls) REJECT — owner-authed refusal of ONE pending tool-approval.
            // FLAG-GATED (keepalive when off). Same owner-auth as cancel.
            Message::AgentRunReject {
                ref run_id,
                ref approval_id,
                ref forwarded_principal,
                ref auth_proof,
            } if run_control_enabled => {
                let now_ms = now_ms();
                let outcome = match authenticate_control_caller(
                    session_key,
                    session_nonce,
                    owner_allowlist,
                    auth_proof,
                    run_id,
                    forwarded_principal,
                ) {
                    Some(caller) => friday_hub::agent_run_control::reject(
                        runtime.db().conn(),
                        run_id,
                        approval_id,
                        caller.principal(),
                        now_ms,
                    )
                    .unwrap_or_else(|_| {
                        friday_hub::agent_run_control::ControlOutcome {
                            op: "reject",
                            accepted: false,
                            status: "storage_failed".to_string(),
                            audit_ref: None,
                        }
                    }),
                    None => friday_hub::agent_run_control::ControlOutcome {
                        op: "reject",
                        accepted: false,
                        status: "auth_failed".to_string(),
                        audit_ref: None,
                    },
                };
                send_control_result(ws, session_key, &env.msg_id, run_id, &outcome, now_ms)?;
                processed += 1;
            }
            // Benign keepalive (S-B behaviour): echo the opened envelope back, sealed under the
            // SAME session key, correlated to the request. NO dispatch. This is ALSO where a
            // control message lands when the run-control flag is OFF (the guards above are not
            // met), so a v13 control message on a DARK server is a harmless echo — no handling.
            _ => {
                let reply = Envelope::new(env.msg_id.clone(), env.sent_at, env.message)
                    .with_correlation(env.msg_id.clone());
                ws_send_envelope(ws, session_key, &reply, SESSION_AAD)?;
                processed += 1;
            }
        }
    }
}

/// The current wall-clock in epoch-millis (best-effort; 0 on a pre-epoch clock).
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// (A1 run-controls) Authenticate an owner-authed control op's forwarded principal against the
/// sealed session — the SAME possession-of-session + nonce-bound-challenge + owner-allowlist chain
/// the `AgentRunRequest` dispatch arm uses, bound to THIS control op's `run_id`. Returns the bound
/// principal on success, `None` (fail-closed) on any failure (un-openable proof / forged / empty /
/// anonymous / non-allowlisted). The caller then matches this principal to the run's bound owner.
fn authenticate_control_caller(
    session_key: &DataKey,
    session_nonce: &[u8],
    owner_allowlist: &[String],
    auth_proof: &[u8],
    run_id: &str,
    forwarded_principal: &str,
) -> Option<AuthedPrincipal> {
    decode_sealed_proof(auth_proof).and_then(|proof| {
        AuthedPrincipal::authenticate_forwarded(
            session_key,
            SESSION_AAD,
            AUTH_CHALLENGE,
            ForwardedAuth {
                auth_proof: &proof,
                session_nonce,
                run_id,
                forwarded_principal,
            },
            owner_allowlist,
        )
    })
}

/// (A1 run-controls) Send the REFS-ONLY [`Message::AgentRunControlResult`] receipt for a control
/// op, sealed under the session and correlated to the request. Never a body — only the coarse
/// op/accepted/status + a soft audit ref.
fn send_control_result<S: Read + Write>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    correlation_msg_id: &str,
    run_id: &str,
    outcome: &friday_hub::agent_run_control::ControlOutcome,
    now_ms: i64,
) -> Result<(), TransportError> {
    eprintln!(
        "hub_agent_run_server_control: run_id={run_id} op={} accepted={} status={}",
        outcome.op, outcome.accepted, outcome.status
    );
    let result = Envelope::new(
        format!("agent-run-control-result-{run_id}"),
        now_ms,
        Message::AgentRunControlResult {
            run_id: run_id.to_string(),
            op: outcome.op.to_string(),
            accepted: outcome.accepted,
            status: outcome.status.clone(),
            audit_ref: outcome.audit_ref.clone(),
        },
    )
    .with_correlation(correlation_msg_id.to_string());
    ws_send_envelope(ws, session_key, &result, SESSION_AAD)
}

/// The REFS-ONLY terminal projection of a dispatch outcome: status + answer sha256/len +
/// (A1) the run COUNTS (turns / executed_tools). NEVER carries the body. Derived from the
/// `proof_refs_json` projection so the wire result and the proof surface agree on the same
/// numbers. Token counts are DEFERRED (not on `LoopOutcome`) ⇒ always `None` here.
struct ResultRefs {
    status: String,
    answer_sha256: Option<String>,
    answer_len: Option<u64>,
    /// (A1) REFS-surface run COUNTS — a COUNT only, never a turn body / tool name / args.
    turns: Option<u64>,
    executed_tools: Option<u64>,
}

/// Project a dispatch outcome to its REFS-ONLY terminal fields. NEVER returns the body.
fn result_refs(outcome: &friday_hub::hub_server::AuthedAnswer) -> ResultRefs {
    let refs = outcome.proof_refs_json();
    let status = refs
        .get("status")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| {
            refs.get("outcome")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
        })
        .to_string();
    let answer_sha256 = refs
        .get("answer_sha256")
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let answer_len = refs.get("answer_len").and_then(|v| v.as_u64());
    // (A1) The run COUNTS surface on `Delivered` only (null/absent otherwise).
    let turns = refs.get("turns").and_then(|v| v.as_u64());
    let executed_tools = refs.get("executed_tools").and_then(|v| v.as_u64());
    ResultRefs {
        status,
        answer_sha256,
        answer_len,
        turns,
        executed_tools,
    }
}

/// On-wire form for a `Sealed`: `[nonce_len: u8][nonce][ciphertext]`. Mirrors the transport's
/// internal `encode_sealed` (kept local — the transport does not expose it). Carries no key.
fn encode_sealed_proof(s: &Sealed) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + s.nonce.len() + s.ciphertext.len());
    out.push(s.nonce.len() as u8);
    out.extend_from_slice(&s.nonce);
    out.extend_from_slice(&s.ciphertext);
    out
}

/// Decode a wire `auth_proof` (`[nonce_len][nonce][ciphertext]`) back into a `Sealed` for the
/// session-key open. Returns `None` on any malformed input (treated as an auth failure upstream,
/// never a panic).
fn decode_sealed_proof(wire: &[u8]) -> Option<Sealed> {
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

fn arg_value(args: &[String], name: &str) -> Option<String> {
    args.windows(2)
        .find_map(|pair| (pair[0] == name).then(|| pair[1].clone()))
        .or_else(|| {
            let prefix = format!("{name}=");
            args.iter()
                .find_map(|arg| arg.strip_prefix(&prefix).map(str::to_string))
        })
}

/// Ephemeral, non-secret bytes for the boot-time runtime config (dormant under deny-all).
/// Derived, not read from any key store.
fn ephemeral_dev_secret(pid: u32, nanos: u128) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("hub-agent-run-server-dev:{pid}:{nanos}").as_bytes());
    hasher.finalize().to_vec()
}

/// Lowercase-hex encode (the owner-sealed body ciphertext rides `AskFridayStream.chunk`, a
/// `String`). No new dep — a trivial loop over the bytes.
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    // `InMemorySecureStore` is TEST-ONLY now (slice 3 moved `run()` to `FileSecureStore`), so its
    // import lives here — keeping it top-level would be an unused import in the non-test bin compile
    // (clippy `-D warnings`). `FileSecureStore` is imported via `use super::*` (run() uses it).
    use friday_crypto::open as crypto_open;
    use friday_crypto::InMemorySecureStore;
    use friday_deepseek::{DeepSeekClient, DeepSeekError};
    use friday_hub::hub_server::{auth_aad, nonce_bound_challenge};
    use friday_hub::runtime::DenyAllApprovals;
    use friday_hub::DeepSeekAgentLlmClient;
    use friday_transport::{ws_connect, ws_send_envelope};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    static C: AtomicU64 = AtomicU64::new(0);

    const OWNER: &str = "principal:owner-allowlisted";
    const BODY: &str = "S-C-DISPATCH-BODY-CANARY-owner-only";

    /// A FIXED non-secret test client secret scalar (small primes). Using a known secret lets a
    /// test compute the client's pubkey up-front (to put it in the S-F peer allowlist) AND
    /// reconstruct the SAME keypair inside a spawned thread (`DeviceKeypair` is not Clone/Send).
    /// This is a TEST FIXTURE, not real key material.
    const CLIENT_SECRET: [u8; 32] = [
        // pragma: allowlist secret
        7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101,
        103, 107, 109, 113, 127, 131, 137, 139, 149,
    ];

    /// Build a single-entry S-F peer allowlist from a peer pubkey (the common test case: the test's
    /// client is the authorized peer). Helper so the migrated S-C/S-E tests clear the peer gate and
    /// keep exercising their OWN gate (principal / proof / wrong-key / low-order), not the peer gate.
    fn allowlist_of(peer_pub: [u8; 32]) -> Vec<[u8; X25519_PUBKEY_LEN]> {
        vec![peer_pub]
    }

    /// A unique temp workspace dir (the agent loop's fs tools are contained to it).
    struct TempWs(PathBuf);
    impl TempWs {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "friday-execrun-sc-{}-{}-{}",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&p).unwrap();
            TempWs(p)
        }
    }
    impl Drop for TempWs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A MOCK transport that finishes the loop in one turn with `answer` as the final message —
    /// so the dispatch tests NEVER reach `HubRuntime::live` / a real DeepSeek key.
    struct FinishTransport {
        answer: String,
    }
    impl Transport for FinishTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            let content = format!("{{\"tool\":\"none\",\"answer\":\"{}\"}}", self.answer);
            Ok(json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
    }

    /// Build a MOCK-transport runtime configured with `principal` as the single owner.
    fn mock_runtime(tag: &str, principal: &str) -> (HubRuntime<FinishTransport>, TempWs) {
        let ws = TempWs::new(tag);
        let client = DeepSeekClient::with_transport(
            FinishTransport {
                answer: BODY.to_string(),
            },
            "k".into(), // pragma: allowlist secret
        );
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: std::env::temp_dir()
                    .join(format!(
                        "friday-execrun-sc-{}-{}-{}.sqlite",
                        std::process::id(),
                        tag,
                        C.fetch_add(1, Ordering::Relaxed)
                    ))
                    .to_string_lossy()
                    .into_owned(),
                workspace_root: ws.0.clone(),
                secret: b"execrun-sc-test-secret-0123456789ab".to_vec(), // pragma: allowlist secret
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    /// Drive the cleartext pubkey preamble from the CLIENT side, read the server pubkey AND the
    /// S-E per-handshake nonce, then run the WS upgrade and derive the client's view of the
    /// session key. The client keypair is generated HERE (test-only), never by the server.
    /// Returns `(ws, session_key, session_nonce)` — the nonce MUST be threaded into the proof.
    fn client_handshake(
        addr: SocketAddr,
        client_kp: &DeviceKeypair,
    ) -> (WireWebSocket<TcpStream>, DataKey, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).unwrap();
        write_frame(&mut stream, &client_kp.public_bytes()).unwrap();
        let server_pub_bytes = read_frame(&mut stream).unwrap();
        let server_pub: [u8; 32] = server_pub_bytes.as_slice().try_into().unwrap();
        // S-E: the server sends a fresh per-handshake nonce in cleartext AFTER its pubkey.
        let session_nonce = read_frame(&mut stream).unwrap();
        let ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let session = client_kp.agree(&server_pub);
        (ws, session, session_nonce)
    }

    /// Build a sealed `auth_proof` over the S-E nonce-bound challenge (`AUTH_CHALLENGE ||
    /// session_nonce`) under the client's session view, with the per-request auth AAD binding
    /// `(principal, run_id)`. This is what the trusted peer does post-handshake — the proof is
    /// NOT precomputable before the nonce is known.
    fn auth_proof_bytes(
        client_session: &DataKey,
        session_nonce: &[u8],
        principal: &str,
        run_id: &str,
    ) -> Vec<u8> {
        let challenge = nonce_bound_challenge(AUTH_CHALLENGE, session_nonce);
        let req_aad = auth_aad(SESSION_AAD, principal, run_id);
        let sealed = seal(client_session, &challenge, &req_aad).unwrap();
        encode_sealed_proof(&sealed)
    }

    /// An `AgentRunRequest` envelope for `run_id` forwarding `principal`, with an `auth_proof`
    /// sealed under `client_session` and bound to THIS handshake's `session_nonce` (the peer's
    /// possession-of-session-AND-this-handshake proof).
    fn agent_run_request(
        msg_id: &str,
        run_id: &str,
        principal: &str,
        client_session: &DataKey,
        session_nonce: &[u8],
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::AgentRunRequest {
                run_id: run_id.to_string(),
                task: "answer me".into(),
                forwarded_principal: principal.to_string(),
                auth_proof: auth_proof_bytes(client_session, session_nonce, principal, run_id),
                session_id: None,
                constraints: None,
            },
        )
    }

    /// (A2a Phase 1) A SESSIONED `AgentRunRequest` — identical to [`agent_run_request`] but
    /// carrying a non-empty `session_id`, so the server's dispatch arm branches into
    /// `run_session_task` (the existing `run_session_loop`) instead of `run_authed_agent_loop`.
    fn sessioned_agent_run_request(
        msg_id: &str,
        run_id: &str,
        principal: &str,
        session_id: &str,
        client_session: &DataKey,
        session_nonce: &[u8],
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::AgentRunRequest {
                run_id: run_id.to_string(),
                task: "answer me".into(),
                forwarded_principal: principal.to_string(),
                auth_proof: auth_proof_bytes(client_session, session_nonce, principal, run_id),
                session_id: Some(session_id.to_string()),
                constraints: None,
            },
        )
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let d = Sha256::digest(bytes);
        d.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The OWNER-side hex decode (mirrors what a real owner peer does to recover the sealed body
    /// ciphertext from the carrier chunk). `None` on non-hex / odd-length input.
    fn hex_decode(s: &str) -> Option<Vec<u8>> {
        if s.len() % 2 != 0 {
            return None;
        }
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(s.len() / 2);
        for pair in bytes.chunks_exact(2) {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
        }
        Some(out)
    }

    /// What the client peer observed on a dispatch exchange. `HubRuntime` is NOT `Send` (its
    /// `Box<dyn ApprovalPolicy>` is not), so the SERVER (holding the runtime) runs on the MAIN
    /// thread and the CLIENT runs in this spawned thread — the inverse of the S-B tests.
    struct ClientObservations {
        /// The refs-only `AgentRunResult` reply (None if the server failed closed with no reply).
        result: Option<Message>,
        /// The owner-sealed body chunk (hex of session-sealed ciphertext), if delivered.
        body_chunk: Option<String>,
    }

    /// Spawn the CLIENT peer: handshake (which reads the S-E per-handshake nonce), then call
    /// `build` with the derived `(session_key, session_nonce)` to construct the request POST-
    /// handshake (the auth_proof binds the nonce, so it CANNOT be precomputed). `build` returns
    /// `(req, seal_key, recv_key)` so a test can seal under a wrong key or recv under a different
    /// key. Reads up to two replies (refs result + owner-sealed body). The server runs on the
    /// caller's (main) thread via `accept_one`.
    fn spawn_client<F>(
        addr: SocketAddr,
        client_kp: DeviceKeypair,
        build: F,
    ) -> thread::JoinHandle<ClientObservations>
    where
        F: FnOnce(&DataKey, &[u8]) -> (Envelope, DataKey, DataKey) + Send + 'static,
    {
        thread::spawn(move || {
            let (mut ws, session, session_nonce) = client_handshake(addr, &client_kp);
            let (req, seal_key, recv_key) = build(&session, &session_nonce);
            ws_send_envelope(&mut ws, &seal_key, &req, SESSION_AAD).unwrap();
            let result = ws_recv_envelope(&mut ws, &recv_key, SESSION_AAD)
                .ok()
                .map(|e| e.message);
            let body_chunk = match &result {
                // Only an accepted dispatch sends a (possible) second body envelope.
                Some(Message::AgentRunResult { .. }) => {
                    match ws_recv_envelope(&mut ws, &recv_key, SESSION_AAD) {
                        Ok(e) => match e.message {
                            Message::AskFridayStream { chunk, .. } => Some(chunk),
                            _ => None,
                        },
                        Err(_) => None,
                    }
                }
                _ => None,
            };
            ClientObservations { result, body_chunk }
        })
    }

    // LOOPBACK CONTAINMENT (restored — the S-C rewrite dropped S-B's guard for this exact
    // security property; off-box reachability must stay zero, and S-E/S-F keep editing this bin).
    #[test]
    fn listener_binds_loopback_only_not_all_interfaces() {
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(
            addr.ip().is_loopback(),
            "agent-run WS listener must bind 127.0.0.1 (this Mac), never 0.0.0.0/LAN"
        );
        assert_ne!(
            addr.ip(),
            std::net::IpAddr::V4(Ipv4Addr::UNSPECIFIED),
            "must NOT bind 0.0.0.0"
        );
    }

    // (a) VALID AUTHORIZED PEER over a real loopback socket: correct key + allowlisted forwarded
    // principal ⇒ the loop runs, a REFS-ONLY result is returned, and the BODY is delivered SEALED
    // (never in the refs result).
    #[test]
    fn authorized_peer_runs_and_body_is_sealed_never_in_refs() {
        let (rt, _ws) = mock_runtime("authz", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        // The client derives the SAME session the server will (ECDH). We precompute its session
        // view here to OPEN the sealed body reply later; the auth_proof itself is built INSIDE the
        // client thread (it must bind the per-handshake nonce, unknown until after the handshake).
        let client_kp = DeviceKeypair::generate();
        let client_session = client_kp.agree(&server_kp.public_bytes());
        // S-F: ALLOWLIST this client's pubkey so the handshake clears the peer gate and the test
        // exercises the S-C dispatch/body path (NOT the peer gate). Captured before the move.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-1", "run-sc-1", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });

        // SERVER on the main thread (holds the non-Send runtime).
        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(processed, 1, "one authed dispatch processed");

        let obs = client.join().unwrap();
        // (refs) the REFS-ONLY result: status + fingerprint, NEVER the body.
        let Some(Message::AgentRunResult {
            run_id,
            answer_sha256,
            answer_len,
            ..
        }) = obs.result.clone()
        else {
            panic!("expected AgentRunResult, got {:?}", obs.result);
        };
        assert_eq!(run_id, "run-sc-1");
        assert_eq!(
            answer_sha256.as_deref(),
            Some(sha256_hex(BODY.as_bytes()).as_str())
        );
        assert_eq!(answer_len, Some(BODY.len() as u64));
        // CANARY: the refs result NEVER carries the body bytes.
        assert!(
            !format!("{:?}", obs.result).contains(BODY),
            "refs result leaked the body"
        );

        // (body) the BODY is delivered SEALED over the SAME session (owner-only). The carrier's
        // chunk is hex of the owner-sealed ciphertext — NOT the plaintext body. Only the owner
        // (holding the session key) can open it back to the exact body.
        let chunk = obs.body_chunk.expect("owner-sealed body delivered");
        assert!(!chunk.contains(BODY), "the body carrier leaked plaintext");
        let inner_bytes = hex_decode(&chunk).expect("body chunk is hex");
        let inner = decode_sealed_proof(&inner_bytes).expect("owner-sealed body decodes");
        let opened = friday_crypto::open(&client_session, &inner, SESSION_AAD).unwrap();
        assert_eq!(opened, BODY.as_bytes(), "owner opens the sealed body");
    }

    /// A MOCK transport that PROPOSES a mutating tool call (write_file) every turn. With the
    /// runtime's `operator_vk: None` (DenyAll), the gate's `RequiresApproval` is never upgraded ⇒
    /// the loop PAUSES and persists a `pending_approval_request` before returning the body-free
    /// NoAnswer. Used by the deploy-safety pause-surfacing tests.
    struct PauseTransport;
    impl Transport for PauseTransport {
        fn get_json(&self, _u: &str, _b: &str) -> Result<Value, DeepSeekError> {
            Ok(json!({"data":[{"id":"deepseek-v4-flash"}]}))
        }
        fn post_json(&self, _u: &str, _b: &str, _body: &Value) -> Result<Value, DeepSeekError> {
            // Propose a mutating write_file tool call (the gate Pauses it under DenyAll).
            let content = r#"{"tool":"write_file","path":"out.txt","content":"X"}"#;
            Ok(json!({
                "model":"deepseek-v4-flash",
                "choices":[{"message":{"content":content},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}
            }))
        }
    }

    /// Build a MOCK-transport runtime whose loop PAUSES on a mutating tool (operator_vk: None).
    fn pausing_runtime(tag: &str, principal: &str) -> (HubRuntime<PauseTransport>, TempWs) {
        let ws = TempWs::new(tag);
        let client = DeepSeekClient::with_transport(PauseTransport, "k".into()); // pragma: allowlist secret
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: std::env::temp_dir()
                    .join(format!(
                        "friday-execrun-pause-{}-{}-{}.sqlite",
                        std::process::id(),
                        tag,
                        C.fetch_add(1, Ordering::Relaxed)
                    ))
                    .to_string_lossy()
                    .into_owned(),
                workspace_root: ws.0.clone(),
                secret: b"execrun-pause-test-secret-0123456789".to_vec(), // pragma: allowlist secret
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None, // DenyAll ⇒ a mutating tool Pauses (never upgraded)
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    /// Run ONE authed dispatch against a PAUSING runtime with the run-control flag set to
    /// `run_control_enabled`, returning the client's first observed reply message.
    fn dispatch_pausing_with_flag(tag: &str, run_control_enabled: bool) -> Message {
        let (rt, _ws) = pausing_runtime(tag, OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-pause", "run-pause-1", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(
                &server_kp,
                &rt,
                &allowlist,
                &peer_allowlist,
                run_control_enabled,
            )
            .unwrap();
        assert_eq!(processed, 1, "[{tag}] the paused dispatch is processed");
        client.join().unwrap().result.expect("a reply is sent")
    }

    /// DEPLOY-SAFETY (the load-bearing test): with the run-control flag OFF, a PAUSED run emits
    /// EXACTLY the pre-A1 `AgentRunResult{status:"no_answer"}` — byte-for-byte the current live
    /// behavior, so deploying a v13 binary changes nothing. With the flag ON, the SAME paused run
    /// emits `AgentRunPaused` (refs-only: nonce + digest + summary) instead. ONE test, BOTH legs.
    #[test]
    fn paused_run_emits_no_answer_when_flag_off_and_paused_when_on() {
        // FLAG OFF ⇒ pre-A1 no_answer result (unchanged live behavior). The exact pre-A1 status
        // for a paused/no-body run is `no_answer_safe_failure` (the `AuthedAnswer::NoAnswer`
        // projection) — this is the byte-for-byte current behavior that must be preserved.
        match dispatch_pausing_with_flag("pause-off", false) {
            Message::AgentRunResult { run_id, status, .. } => {
                assert_eq!(run_id, "run-pause-1");
                assert_eq!(
                    status, "no_answer_safe_failure",
                    "flag OFF: a paused run MUST emit the pre-A1 no_answer result (deploy-safe)"
                );
            }
            other => panic!("flag OFF must emit AgentRunResult, got {other:?}"),
        }

        // FLAG ON ⇒ AgentRunPaused with refs-only pause info.
        match dispatch_pausing_with_flag("pause-on", true) {
            Message::AgentRunPaused {
                run_id,
                nonce,
                action_digest,
                summary,
            } => {
                assert_eq!(run_id, "run-pause-1");
                assert_eq!(nonce.len(), 64, "the CSPRNG approval nonce is surfaced");
                assert_eq!(action_digest.len(), 64);
                assert!(
                    summary.contains("write_file"),
                    "the action-verb summary is surfaced (refs-only)"
                );
                // CANARY: the pause frame never carries the tool body/args.
                let frame = format!("{run_id}{nonce}{action_digest}{summary}");
                assert!(!frame.contains("\"content\""), "pause leaked tool params");
            }
            other => panic!("flag ON must emit AgentRunPaused, got {other:?}"),
        }
    }

    /// DARK-when-OFF for control MESSAGES: a control message (e.g. AgentRunCancel) arriving with
    /// the run-control flag OFF is treated as a benign keepalive (echoed back), NOT handled — so a
    /// v13 control message on a dark server effects no state change. (Flag-ON handling is covered
    /// by the `agent_run_control` unit suite in tests/a1_run_control.rs.)
    #[test]
    fn control_message_is_keepalive_echo_when_flag_off() {
        let (rt, _ws) = mock_runtime("ctl-off", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, _nonce| {
            let req = Envelope::new(
                "req-cancel",
                1000,
                Message::AgentRunCancel {
                    run_id: "run-x".into(),
                    forwarded_principal: OWNER.into(),
                    auth_proof: vec![1, 2, 3],
                    reason: None,
                },
            );
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(
            processed, 1,
            "the control message is processed as a keepalive"
        );
        // The flag is OFF ⇒ the message is ECHOED verbatim (keepalive), NOT a control result.
        match client.join().unwrap().result.expect("an echo reply") {
            Message::AgentRunCancel { run_id, .. } => assert_eq!(run_id, "run-x"),
            other => panic!("flag OFF must echo the control message, got {other:?}"),
        }
    }

    // (b) THE PRECONDITION: a correct-handshake peer (real session key) with a NON-ALLOWLISTED /
    // forged / empty / anonymous forwarded principal is REJECTED — NO run, NO body. A session key
    // is NOT authorization.
    fn reject_case(tag: &str, forwarded: &str) {
        let (rt, _ws) = mock_runtime(tag, OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake SUCCEEDS and the rejection is
        // attributable to the PRINCIPAL gate (forged/empty/anonymous owner), not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let forwarded = forwarded.to_string();
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = agent_run_request("req-x", "run-rej", &forwarded, session, nonce);
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(processed, 0, "[{tag}] rejected dispatch processes ZERO");

        let obs = client.join().unwrap();
        // The server failed closed: NO reply at all (no run, no body).
        assert!(
            obs.result.is_none(),
            "[{tag}] a rejected dispatch must end the session with no reply (no run, no body)"
        );
        assert!(obs.body_chunk.is_none(), "[{tag}] no body on rejection");
    }

    #[test]
    fn session_reaper_flag_is_default_off_and_fail_closed() {
        // The reaper tick is DEFAULT-OFF: unset ⇒ disabled. Only the exact opt-in values
        // enable it; everything else (empty, "0", "yes", "false", garbage) is OFF.
        assert!(!reaper_enabled_from(None), "unset ⇒ disabled (default-off)");
        assert!(!reaper_enabled_from(Some("")), "empty ⇒ disabled");
        assert!(!reaper_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(!reaper_enabled_from(Some("false")), "false ⇒ disabled");
        assert!(!reaper_enabled_from(Some("no")), "no ⇒ disabled");
        assert!(!reaper_enabled_from(Some("enabled")), "garbage ⇒ disabled");
        // Only the exact opt-in values enable it (case-insensitive, trimmed).
        assert!(reaper_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(reaper_enabled_from(Some("true")), "true ⇒ enabled");
        assert!(reaper_enabled_from(Some("TRUE")), "TRUE ⇒ enabled");
        assert!(
            reaper_enabled_from(Some("  true  ")),
            "padded true ⇒ enabled"
        );
        assert!(reaper_enabled_from(Some(" 1 ")), "padded 1 ⇒ enabled");
    }

    #[test]
    fn agent_run_control_flag_is_default_off_and_fail_closed() {
        // The on-wire run-control plane is DEFAULT-OFF: unset ⇒ disabled (deploy-safe). Only the
        // exact opt-in values enable it; everything else is OFF.
        assert!(
            !agent_run_control_enabled_from(None),
            "unset ⇒ disabled (default-off, deploy-safe)"
        );
        assert!(
            !agent_run_control_enabled_from(Some("")),
            "empty ⇒ disabled"
        );
        assert!(!agent_run_control_enabled_from(Some("0")), "0 ⇒ disabled");
        assert!(
            !agent_run_control_enabled_from(Some("false")),
            "false ⇒ disabled"
        );
        assert!(
            !agent_run_control_enabled_from(Some("on")),
            "garbage ⇒ disabled"
        );
        assert!(agent_run_control_enabled_from(Some("1")), "1 ⇒ enabled");
        assert!(
            agent_run_control_enabled_from(Some("true")),
            "true ⇒ enabled"
        );
        assert!(
            agent_run_control_enabled_from(Some("  TRUE  ")),
            "padded TRUE ⇒ enabled"
        );
    }

    #[test]
    fn non_allowlisted_principal_is_rejected_no_run_no_body() {
        reject_case("rej-forged", "principal:attacker-not-allowlisted");
    }

    #[test]
    fn empty_forwarded_principal_is_rejected() {
        reject_case("rej-empty", "   ");
    }

    #[test]
    fn anonymous_forwarded_principal_is_rejected() {
        reject_case("rej-anon", "public");
        reject_case("rej-anon2", "public:default");
    }

    // (b') A correct-handshake, allowlisted principal but a BAD auth_proof (sealed under a WRONG
    // key) is rejected — the possession-of-session proof must hold, not just the handshake.
    #[test]
    fn allowlisted_principal_with_bad_auth_proof_is_rejected() {
        let (rt, _ws) = mock_runtime("rej-proof", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake SUCCEEDS and the rejection is
        // attributable to the bad auth_proof (wrong key), not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        // The envelope opens (correct session key) but the auth_proof is sealed under a WRONG key.
        let wrong = DataKey::generate();
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            // Bind the CORRECT nonce + AAD so the failure is attributable to the WRONG key, not a
            // missing nonce binding.
            let challenge = nonce_bound_challenge(AUTH_CHALLENGE, nonce);
            let req_aad = auth_aad(SESSION_AAD, OWNER, "run-badproof");
            let bad_proof = encode_sealed_proof(&seal(&wrong, &challenge, &req_aad).unwrap());
            let req = Envelope::new(
                "req-badproof",
                1000,
                Message::AgentRunRequest {
                    run_id: "run-badproof".into(),
                    task: "answer me".into(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: bad_proof,
                    session_id: None,
                    constraints: None,
                },
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(
            processed, 0,
            "a bad auth_proof (wrong key) must fail closed"
        );
        let obs = client.join().unwrap();
        assert!(obs.result.is_none(), "no reply on a bad auth_proof");
    }

    // (c) WRONG-SESSION-KEY peer: the envelope itself cannot be opened ⇒ the session ends before
    // dispatch (fail-closed). No run, no body.
    #[test]
    fn wrong_session_key_peer_fails_closed_before_dispatch() {
        let (rt, _ws) = mock_runtime("wrong-key", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the HANDSHAKE succeeds (the client IS the authorized
        // peer) and the rejection is attributable to the wrong ENVELOPE key, not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        // Seal the request (and its auth_proof) under a key that is NOT the established session.
        let wrong_key = DataKey::generate();
        // Client SEALS under the wrong key but OPENS replies under the real session (there are
        // none — the server ends the session). The nonce is still bound correctly so the failure
        // is attributable to the wrong ENVELOPE key (the server can't even open the envelope).
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = agent_run_request("req-wrong", "run-wrong", OWNER, &wrong_key, nonce);
            (req, wrong_key.clone(), session.clone())
        });

        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(
            processed, 0,
            "a wrong-session-key envelope must fail closed"
        );
        let obs = client.join().unwrap();
        assert!(obs.result.is_none(), "no reply on a wrong-key envelope");
    }

    // (d) NON-CONTRIBUTORY peer key: a known low-order X25519 point is rejected at session
    // establishment — through the REAL `accept_one` path (which also sets the read timeout and
    // calls `establish_session`). No session, no dispatch. The server holds the (non-Send)
    // runtime on the MAIN thread; the malicious client sends the low-order pubkey from a thread.
    fn assert_low_order_pubkey_rejected(tag: &str, peer_pub: [u8; 32]) {
        let (rt, _ws) = mock_runtime(tag, OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // S-F: ALLOWLIST the low-order point itself, so it CLEARS the (earlier) peer gate and the
        // rejection is attributable to the LOW-ORDER gate — keeping that PRESERVE'd property
        // exercised end-to-end through `accept_one`, not just by the standalone unit test.
        let peer_allowlist = allowlist_of(peer_pub);
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(addr).unwrap();
            // Send the low-order point as the peer pubkey; the server must reject it. The peer
            // reads back nothing (the server never writes its pubkey on rejection).
            let _ = write_frame(&mut stream, &peer_pub);
            // Hold the socket open briefly so the server's read/handshake resolves to an error
            // rather than a premature EOF ambiguity.
            std::thread::sleep(Duration::from_millis(50));
            drop(stream);
        });
        // accept_one runs the REAL production path; a low-order key must make it return Err.
        let outcome = listener.accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false);
        client.join().unwrap();
        assert!(
            outcome.is_err(),
            "[{tag}] a non-contributory (low-order) peer key must fail closed (no session)"
        );
    }

    #[test]
    fn non_contributory_low_order_peer_key_is_rejected() {
        assert_low_order_pubkey_rejected("lo-zero", [0u8; 32]);
        // The order-8 point e0eb… — a real low-order curve point, not just an edge byte string.
        assert_low_order_pubkey_rejected("lo-order8", LOW_ORDER_X25519_POINTS[2]);
    }

    // (d') THE BYPASS the masking fix closes: a blacklisted low-order point with byte-31's HIGH
    // BIT FLIPPED decodes (RFC 7748) to the SAME degenerate point — the all-zero shared secret is
    // attacker-PREDICTABLE (independent of the server's private key) — so it MUST also be
    // rejected. An exact-byte table would miss it; the masked check catches it.
    #[test]
    fn high_bit_variant_of_low_order_point_is_the_same_point_and_is_rejected() {
        let lo = LOW_ORDER_X25519_POINTS[2]; // e0eb…  (order-8 point)
        let mut hb = lo;
        hb[31] |= 0x80; // flip bit 255

        // The danger: agreeing against the low-order point yields a key INDEPENDENT of the
        // agreeing party's secret (two distinct keypairs derive the SAME session key). DataKey is
        // intentionally `!Debug` (key material), so compare via `==`, not `assert_eq!`.
        let a = DeviceKeypair::generate();
        let b = DeviceKeypair::generate();
        assert!(
            a.agree(&lo) == b.agree(&lo),
            "a low-order point yields an attacker-predictable, secret-independent key"
        );
        // The bypass: the high-bit variant decodes to the SAME degenerate point.
        assert!(
            a.agree(&lo) == a.agree(&hb),
            "bit 255 is ignored on decode — the variant is the same point"
        );
        // The fix: the masked check rejects BOTH representations.
        assert!(is_low_order_x25519(&lo));
        assert!(
            is_low_order_x25519(&hb),
            "the masked low-order check must reject the high-bit variant too"
        );
        // And end-to-end through the real accept path.
        assert_low_order_pubkey_rejected("lo-highbit", hb);
    }

    #[test]
    fn low_order_point_table_detects_known_points() {
        assert!(is_low_order_x25519(&[0u8; 32]));
        let mut one = [0u8; 32];
        one[0] = 1;
        assert!(is_low_order_x25519(&one));
        // Every blacklist entry is detected in both its canonical and high-bit-set forms.
        for entry in &LOW_ORDER_X25519_POINTS {
            assert!(is_low_order_x25519(entry));
            let mut hb = *entry;
            hb[31] |= 0x80;
            assert!(
                is_low_order_x25519(&hb),
                "high-bit variant must be detected"
            );
        }
        // A fresh real pubkey is overwhelmingly NOT low-order.
        assert!(!is_low_order_x25519(
            &DeviceKeypair::generate().public_bytes()
        ));
    }

    // (e) STALLED peer: the per-connection read timeout fires so the server does not wedge. We
    // connect, send NOTHING, and assert the server's accept_one returns (a timeout error) within
    // a bounded wall-clock, rather than blocking forever.
    #[test]
    fn stalled_peer_hits_read_timeout_no_wedge() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        // Use a SHORT timeout for the test so it completes quickly (the prod const is 30s).
        let server = thread::spawn(move || -> Result<(), TransportError> {
            let (stream, _peer) = listener.listener.accept()?;
            stream.set_read_timeout(Some(Duration::from_millis(300)))?;
            // The stall is at the PREAMBLE read, BEFORE the S-F peer gate — the allowlist is never
            // consulted, so any (here empty) allowlist suffices to drive `establish_session`.
            establish_session(stream, &server_kp, &[]).map(|_| ())
        });

        // Connect but send nothing — the server's preamble read must time out (not block).
        let _stalled = TcpStream::connect(addr).unwrap();
        let start = std::time::Instant::now();
        let outcome = server.join().unwrap();
        assert!(
            outcome.is_err(),
            "a stalled peer must hit the read timeout (no session)"
        );
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "the read timeout must bound the wait (no wedge)"
        );
        drop(_stalled);
    }

    // (f) BODY ONLY to the bound owner, NEVER in refs — exercised structurally: the refs-only
    // wire result for a delivered outcome carries the fingerprint, never the body.
    #[test]
    fn refs_result_never_carries_body() {
        use friday_hub::hub_server::AuthedAnswer;
        // (A1) Attach real run COUNTS — the refs result must surface the counts but STILL
        // never carry the body.
        let delivered = AuthedAnswer::Delivered {
            run_id: "run-f".into(),
            status: "finished".into(),
            answer: BODY.into(),
            answer_sha256: sha256_hex(BODY.as_bytes()),
            answer_len: BODY.len() as i64,
            turns: Some(3),
            executed_tools: Some(2),
        };
        let refs = result_refs(&delivered);
        assert_eq!(refs.status, "finished");
        assert_eq!(
            refs.answer_sha256.as_deref(),
            Some(sha256_hex(BODY.as_bytes()).as_str())
        );
        assert_eq!(refs.answer_len, Some(BODY.len() as u64));
        // (A1) The COUNTS rode through the refs projection.
        assert_eq!(refs.turns, Some(3));
        assert_eq!(refs.executed_tools, Some(2));
        let result = Message::AgentRunResult {
            run_id: "run-f".into(),
            status: refs.status,
            answer_sha256: refs.answer_sha256,
            answer_len: refs.answer_len,
            turns: refs.turns,
            executed_tools: refs.executed_tools,
            prompt_tokens: None,
            completion_tokens: None,
        };
        assert!(
            !format!("{result:?}").contains(BODY),
            "the refs result must never carry the body"
        );
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--port=7777".to_string(),
            "--owner=principal:o".to_string(),
        ];
        assert_eq!(arg_value(&args, "--workspace").as_deref(), Some("/tmp/ws"));
        assert_eq!(arg_value(&args, "--port").as_deref(), Some("7777"));
        assert_eq!(arg_value(&args, "--owner").as_deref(), Some("principal:o"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn ephemeral_secret_is_32_bytes() {
        assert_eq!(ephemeral_dev_secret(1, 2).len(), 32);
    }

    #[test]
    fn sealed_proof_round_trips_and_rejects_malformed() {
        let k = DataKey::generate();
        let sealed = seal(&k, AUTH_CHALLENGE, SESSION_AAD).unwrap();
        let wire = encode_sealed_proof(&sealed);
        let back = decode_sealed_proof(&wire).unwrap();
        assert_eq!(crypto_open(&k, &back, SESSION_AAD).unwrap(), AUTH_CHALLENGE);
        assert!(decode_sealed_proof(&[]).is_none());
        assert!(decode_sealed_proof(&[200, 1, 2]).is_none()); // nlen > remaining
    }

    // ============================ S-E anti-replay (end-to-end) ============================

    // (S-E c) NONCE FRESHNESS: two SEPARATE handshakes against the SAME server keypair yield
    // DISTINCT per-handshake nonces (a CSPRNG token, not a predictable counter). This is the
    // freshness/uniqueness the replay defense rests on — if the nonce repeated, a captured proof
    // would replay.
    #[test]
    fn two_handshakes_get_distinct_csprng_nonces() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        // S-F: a KNOWN client keypair, allowlisted, so BOTH handshakes clear the peer gate and the
        // test exercises nonce FRESHNESS (not the peer gate). A fresh `generate()` per handshake
        // would be non-allowlisted and rejected before a nonce was ever sent.
        let peer_allowlist =
            allowlist_of(DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes());

        // Drive one handshake: spawn a client that reads the nonce, run the server's
        // establish_session on THIS (main) thread (server_kp is borrowed, not cloned), return the
        // client-observed nonce.
        let one_handshake = || -> Vec<u8> {
            let c = thread::spawn(move || {
                let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
                let (_ws, _s, nonce) = client_handshake(addr, &client_kp);
                nonce
            });
            let (stream, _peer) = listener.listener.accept().unwrap();
            stream.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
            let _ = establish_session(stream, &server_kp, &peer_allowlist).unwrap();
            c.join().unwrap()
        };

        let n1 = one_handshake();
        let n2 = one_handshake();

        assert_eq!(n1.len(), SESSION_NONCE_LEN, "nonce is the expected width");
        assert_eq!(n2.len(), SESSION_NONCE_LEN, "nonce is the expected width");
        assert_ne!(
            n1, n2,
            "two handshakes against the same server key MUST get distinct nonces (CSPRNG, not a \
             predictable counter) — else a captured proof would replay"
        );
    }

    // (S-E a) REPLAY-TO-AUTHENTICATE DEFEATED: capture a VALID `auth_proof` from connection-1
    // (bound to nonce N1) and REPLAY it verbatim on connection-2 (a fresh handshake, nonce N2)
    // against the SAME server AND client keypairs. The envelope is freshly sealed under conn-2's
    // session (so it opens — the attacker did complete a fresh handshake), but the inner
    // `auth_proof` is the STALE captured one. The server MUST reject (processed=0, no reply): the
    // captured proof sealed `CHALLENGE || N1`, but conn-2 expects `CHALLENGE || N2`.
    //
    // Holding BOTH keypairs constant is the crux: if conn-2 used a fresh client_kp the session key
    // would differ and the proof would fail to OPEN (the existing wrong-key test) — passing for
    // the WRONG reason. Same keys ⇒ same session key ⇒ the rejection is attributable ONLY to the
    // nonce binding.
    #[test]
    fn captured_auth_proof_replayed_on_a_new_handshake_is_rejected() {
        use std::sync::mpsc;

        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        // A FIXED client secret scalar (the shared `CLIENT_SECRET` test fixture) so the SAME client
        // keypair (hence the SAME session key) is reconstructed in BOTH connection threads
        // (DeviceKeypair is not Clone/Send-shared).
        let client_secret = CLIENT_SECRET;
        // S-F: allowlist that fixed client pubkey so BOTH handshakes (conn-1 valid, conn-2 replay)
        // CLEAR the peer gate — the conn-2 rejection is then attributable ONLY to the stale nonce
        // binding (the S-E replay defense), not the peer gate.
        let peer_allowlist =
            allowlist_of(DeviceKeypair::from_secret_bytes(client_secret).public_bytes());
        let client_session =
            DeviceKeypair::from_secret_bytes(client_secret).agree(&server_kp.public_bytes());

        // --- Connection 1: a VALID dispatch; the client returns the auth_proof it sealed (N1). ---
        let (rt1, _ws1) = mock_runtime("replay-c1", OWNER);
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let sess_c1 = client_session.clone();
        let c1 = thread::spawn(move || {
            let kp = DeviceKeypair::from_secret_bytes(client_secret);
            let (mut ws, _session, nonce) = client_handshake(addr, &kp);
            // Build the proof binding THIS handshake's nonce (N1) and capture it.
            let proof = auth_proof_bytes(&sess_c1, &nonce, OWNER, "run-replay");
            tx.send(proof.clone()).unwrap();
            let req = Envelope::new(
                "req-c1",
                1000,
                Message::AgentRunRequest {
                    run_id: "run-replay".into(),
                    task: "answer me".into(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: proof,
                    session_id: None,
                    constraints: None,
                },
            );
            ws_send_envelope(&mut ws, &sess_c1, &req, SESSION_AAD).unwrap();
            // Drain the (accepted) reply so the server completes conn-1 cleanly.
            let _ = ws_recv_envelope(&mut ws, &sess_c1, SESSION_AAD);
        });
        let processed1 = listener
            .accept_one(&server_kp, &rt1, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(processed1, 1, "connection-1 is a VALID dispatch");
        let captured_proof = rx.recv().unwrap();
        c1.join().unwrap();

        // --- Connection 2: REPLAY the captured (N1) proof on a fresh handshake (N2). ----------
        let (rt2, _ws2) = mock_runtime("replay-c2", OWNER);
        let sess_c2 = client_session.clone();
        let c2 = thread::spawn(move || {
            let kp = DeviceKeypair::from_secret_bytes(client_secret);
            let (mut ws, _session, _n2) = client_handshake(addr, &kp);
            // The attacker re-seals the ENVELOPE under the (real, fresh) conn-2 session so it
            // OPENS, but stuffs the STALE captured auth_proof (bound to N1) inside.
            let req = Envelope::new(
                "req-c2",
                1000,
                Message::AgentRunRequest {
                    run_id: "run-replay".into(),
                    task: "answer me".into(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: captured_proof,
                    session_id: None,
                    constraints: None,
                },
            );
            ws_send_envelope(&mut ws, &sess_c2, &req, SESSION_AAD).unwrap();
            // The server must fail closed (END the session) — no reply.
            ws_recv_envelope(&mut ws, &sess_c2, SESSION_AAD)
                .ok()
                .map(|e| e.message)
        });
        let processed2 = listener
            .accept_one(&server_kp, &rt2, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(
            processed2, 0,
            "a captured auth_proof REPLAYED on a fresh handshake must be REJECTED (no dispatch)"
        );
        let reply2 = c2.join().unwrap();
        assert!(
            reply2.is_none(),
            "the replayed dispatch must end the session with NO reply (no run, no body)"
        );
    }

    // (S-E d) WITHIN-SESSION msg_id REPLAY rejected: a SECOND envelope with the SAME msg_id on one
    // session is rejected fail-closed (the per-session IdempotencyTracker). We send two benign
    // keepalives with the same msg_id; the first is echoed, the second ends the session.
    #[test]
    fn replayed_msg_id_within_a_session_is_rejected() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let (rt, _ws) = mock_runtime("dedup", OWNER);
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        // S-F: allowlist the client pubkey so the handshake clears the peer gate and the test
        // exercises the msg_id DEDUP (S-E within-session replay), not the peer gate.
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = thread::spawn(move || {
            let (mut ws, session, _nonce) = client_handshake(addr, &client_kp);
            // A benign keepalive (NOT an AgentRunRequest) — the dedup is checked BEFORE the branch.
            let keepalive = |id: &str| {
                Envelope::new(
                    id,
                    1000,
                    Message::AskFridayStream {
                        seq: 0,
                        chunk: "ping".into(),
                    },
                )
            };
            // First send with msg_id "dup-1": echoed back.
            ws_send_envelope(&mut ws, &session, &keepalive("dup-1"), SESSION_AAD).unwrap();
            let first = ws_recv_envelope(&mut ws, &session, SESSION_AAD).ok();
            // Second send with the SAME msg_id "dup-1": the server must END the session (no echo).
            ws_send_envelope(&mut ws, &session, &keepalive("dup-1"), SESSION_AAD).unwrap();
            let second = ws_recv_envelope(&mut ws, &session, SESSION_AAD).ok();
            (first.is_some(), second.is_some())
        });

        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        // The first keepalive was processed (echoed); the replayed msg_id ended the session.
        assert_eq!(
            processed, 1,
            "exactly ONE envelope processed: the replayed msg_id is rejected, not processed"
        );
        let (first_echoed, second_echoed) = client.join().unwrap();
        assert!(first_echoed, "the first (fresh) msg_id is echoed");
        assert!(
            !second_echoed,
            "a replayed msg_id within the session must END the session (no echo)"
        );
    }

    // ======================= S-F peer authentication (forgery defeat) =======================

    /// What a peer observed during the cleartext preamble — used by the forgery tests to assert a
    /// NON-allowlisted peer learns NOTHING (no server pubkey, no nonce).
    struct PreambleObservations {
        /// The server's pubkey frame, if the server sent it (it does NOT on a peer-gate rejection).
        server_pub: Option<Vec<u8>>,
        /// The server's per-handshake nonce frame, if sent (never, on a peer-gate rejection).
        nonce: Option<Vec<u8>>,
    }

    /// Drive ONLY the cleartext preamble from the client side: send `client_pub`, then TRY to read
    /// the server pubkey + nonce. A peer-gate rejection ends the connection BEFORE the server writes
    /// either, so both reads fail (None). This is how we prove "the peer learns nothing".
    fn try_preamble(addr: SocketAddr, client_pub: [u8; 32]) -> PreambleObservations {
        let mut stream = TcpStream::connect(addr).unwrap();
        let _ = write_frame(&mut stream, &client_pub);
        let server_pub = read_frame(&mut stream).ok();
        let nonce = if server_pub.is_some() {
            read_frame(&mut stream).ok()
        } else {
            None
        };
        PreambleObservations { server_pub, nonce }
    }

    // (S-F a) HEADLINE — FORGERY DEFEATED: a FRESH local keypair that is NOT in the SecureStore
    // allowlist cannot establish a session. The server REJECTS at the peer gate (accept_one ⇒ Err)
    // BEFORE sending its own pubkey or nonce — so the attacker cannot even begin the handshake it
    // would need to forge an `auth_proof` for an allowlisted owner string. This is the gap S-E
    // explicitly deferred; S-F closes it. (Distinct from the principal-layer reject tests: a
    // DIFFERENT, EARLIER gate and a DIFFERENT allowlist — the peer pubkey, not the owner string.)
    #[test]
    fn non_allowlisted_peer_pubkey_gets_no_session_forgery_defeated() {
        let (rt, _ws) = mock_runtime("sf-forge", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];

        // The allowlist authorizes a DIFFERENT peer (a known fixture pubkey). The attacker uses a
        // FRESH keypair that is NOT in it — exactly the forgery S-E left open.
        let authorized_peer = DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes();
        let peer_allowlist = allowlist_of(authorized_peer);
        let attacker_kp = DeviceKeypair::generate();
        let attacker_pub = attacker_kp.public_bytes();
        assert_ne!(
            attacker_pub, authorized_peer,
            "the attacker's fresh key must NOT be the allowlisted peer"
        );

        let client = thread::spawn(move || try_preamble(addr, attacker_pub));
        // The server runs the REAL accept path; a non-allowlisted peer must make it FAIL CLOSED.
        let outcome =
            listener.accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false);
        let obs = client.join().unwrap();

        assert!(
            outcome.is_err(),
            "a non-allowlisted peer pubkey must get NO session (fail closed — forgery defeated)"
        );
        // The peer learned NOTHING: the server sent neither its pubkey nor a nonce. Without the
        // server pubkey the attacker cannot derive the session key, and without the nonce it cannot
        // build the (nonce-bound) auth_proof — so an `auth_proof` for an allowlisted owner string
        // can never be forged on this connection.
        assert!(
            obs.server_pub.is_none(),
            "a rejected peer must NOT receive the server pubkey"
        );
        assert!(
            obs.nonce.is_none(),
            "a rejected peer must NOT receive the per-handshake nonce"
        );
    }

    // (S-F b) POSITIVE SecureStore read path + happy dispatch: provision a temp InMemorySecureStore
    // with the authorized peer pubkey, LOAD it via `load_peer_allowlist` (the real read path), and
    // run a full authed dispatch through `accept_one`. Proves the SecureStore-derived allowlist
    // path works POSITIVELY (not only the missing/invalid fail-closed cases) and that an ALLOWLISTED
    // peer establishes a session and runs.
    #[test]
    fn securestore_provisioned_allowlisted_peer_runs() {
        let (rt, _ws) = mock_runtime("sf-store-ok", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];

        // Provision the SecureStore with the authorized peer pubkey (raw 32 bytes), then load it
        // through the REAL read path — exactly what `run()` does at boot.
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let client_pub = client_kp.public_bytes();
        let mut store = InMemorySecureStore::new();
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &client_pub);
        let peer_allowlist =
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID).expect("provisioned allowlist");
        assert_eq!(peer_allowlist.len(), 1, "one provisioned peer pubkey");

        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-sf", "run-sf-ok", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });
        let processed = listener
            .accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(
            processed, 1,
            "a SecureStore-allowlisted peer establishes a session and runs"
        );
        let obs = client.join().unwrap();
        assert!(
            matches!(obs.result, Some(Message::AgentRunResult { .. })),
            "the allowlisted peer got a refs result"
        );
    }

    // (S-F c) FAIL CLOSED on a MISSING SecureStore entry: an empty store has no allowlist ⇒ the
    // load returns Missing (the boot would refuse to start). It never falls open to an empty/open
    // allowlist.
    #[test]
    fn missing_securestore_allowlist_fails_closed() {
        let store = InMemorySecureStore::new(); // empty store — an UNPROVISIONED allowlist
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Missing),
            "a MISSING SecureStore allowlist must fail closed (no open fallthrough)"
        );
    }

    // (S-F c') FAIL CLOSED on an INVALID SecureStore entry: empty bytes, and a length that is not a
    // nonzero multiple of 32, are both Invalid. A valid nonzero-multiple length parses to N keys.
    #[test]
    fn invalid_securestore_allowlist_fails_closed_valid_parses() {
        let mut store = InMemorySecureStore::new();

        // Empty value ⇒ Invalid.
        store.put(PEER_PUBKEY_ALLOWLIST_ID, b"");
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Invalid),
            "an EMPTY allowlist value must fail closed"
        );

        // Not a multiple of 32 (31 bytes) ⇒ Invalid.
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &[0xABu8; 31]);
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Invalid),
            "a non-32-multiple allowlist value must fail closed"
        );

        // A trailing partial key (33 bytes) ⇒ Invalid (no silent truncation).
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &[0xCDu8; 33]);
        assert_eq!(
            load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Invalid),
            "a partial trailing key must fail closed (no truncation)"
        );

        // Two concatenated 32-byte keys ⇒ parses to exactly two.
        let a = DeviceKeypair::generate().public_bytes();
        let b = DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes();
        let mut two = Vec::new();
        two.extend_from_slice(&a);
        two.extend_from_slice(&b);
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &two);
        let loaded = load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID)
            .expect("two-key allowlist parses");
        assert_eq!(loaded, vec![a, b], "two concatenated keys parse in order");
    }

    // (FIX-Q3a) SINGLE-PEER is a SERVER INVARIANT, not just a CLI convention. The loader still
    // PARSES N keys (see `invalid_securestore_allowlist_fails_closed_valid_parses`, which keeps the
    // parser forward-compatible for when the multi-principal bindings FIX-Q2/FIX-Q3b land), but the
    // boot-time `enforce_single_peer` guard REFUSES anything other than exactly one. This closes the
    // latent confidentiality chain (a 2nd enrolled pubkey + the client-asserted owner string) until
    // a real pubkey↔principal binding exists. DARK w.r.t. the running bin (live store = 1 entry).
    #[test]
    fn enforce_single_peer_fails_closed_above_one() {
        // (a) Exactly one peer ⇒ Ok — the single-peer happy path is UNCHANGED.
        let a = DeviceKeypair::generate().public_bytes();
        assert_eq!(
            enforce_single_peer(&[a]),
            Ok(()),
            "exactly one enrolled peer is admitted (single-peer happy path unchanged)"
        );

        // (b) The loader PARSES a 64-byte (two-key) store to two keys, but the guard then REFUSES
        //     it: prove via the REAL read path that a 2-pubkey store fails the boot closed.
        let b = DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes();
        let mut store = InMemorySecureStore::new();
        let mut two = Vec::new();
        two.extend_from_slice(&a);
        two.extend_from_slice(&b);
        store.put(PEER_PUBKEY_ALLOWLIST_ID, &two);
        let parsed = load_peer_allowlist(&store, PEER_PUBKEY_ALLOWLIST_ID)
            .expect("the loader still parses a two-key allowlist (parser unchanged)");
        assert_eq!(parsed.len(), 2, "loader parses both keys");
        assert_eq!(
            enforce_single_peer(&parsed),
            Err(PeerAllowlistError::MultiPeer),
            "a TWO-pubkey allowlist must fail the boot closed (FIX-Q3a server invariant)"
        );

        // (c) Defensive: an (impossible-via-parser) EMPTY list is also refused fail-closed, not Ok.
        assert_eq!(
            enforce_single_peer(&[]),
            Err(PeerAllowlistError::MultiPeer),
            "a zero-peer list must also fail closed (!= 1, never falls open)"
        );

        // (d) Three peers ⇒ refused too (any N>1).
        let c = DeviceKeypair::generate().public_bytes();
        assert_eq!(
            enforce_single_peer(&[a, b, c]),
            Err(PeerAllowlistError::MultiPeer),
            "three pubkeys are refused (any N>1 fails closed)"
        );
    }

    // (S-F d) peer_is_allowlisted exact-match semantics: only an exact 32-byte match passes; a
    // fresh (non-listed) key and a one-bit-flipped near-miss both fail.
    #[test]
    fn peer_is_allowlisted_is_exact_match() {
        let a = DeviceKeypair::generate().public_bytes();
        let b = DeviceKeypair::generate().public_bytes();
        let list = vec![a];
        assert!(peer_is_allowlisted(&list, &a), "the listed key matches");
        assert!(
            !peer_is_allowlisted(&list, &b),
            "a fresh, non-listed key does NOT match"
        );
        let mut near = a;
        near[0] ^= 0x01; // flip one bit
        assert!(
            !peer_is_allowlisted(&list, &near),
            "a one-bit near-miss must NOT match (exact equality)"
        );
        assert!(
            !peer_is_allowlisted(&[], &a),
            "an EMPTY allowlist matches nothing (fail closed)"
        );
    }

    /// A unique temp dir per test (no `tempfile` dep — the workspace minimal-dep convention,
    /// mirroring `key_source`'s test helper). Removed on drop.
    struct TempDir {
        path: PathBuf,
    }
    impl TempDir {
        fn new(tag: &str) -> Self {
            static CTR: AtomicU64 = AtomicU64::new(0);
            let n = CTR.fetch_add(1, Ordering::Relaxed);
            let mut path = std::env::temp_dir();
            path.push(format!(
                "friday-execrun-s3-server-test-{tag}-{}-{n}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self { path }
        }
        fn child(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    // (S-F e) THE TRUE END-TO-END ENROLL→PERSIST→SERVER-LOAD→ACCEPT PROOF (slice 3, deferred from
    // slice 2). This exercises the FULL chain that, at cutover, lets the live client's derived
    // pubkey pass the S-F peer gate:
    //
    //   master key  --key_source::derive_file_store_kek-->  FileSecureStore KEK
    //   master key  --key_source::derive_client_x25519_pubkey-->  enrolled pubkey
    //   enroll CLI:  FileSecureStore::open(dir, KEK).try_put(ALLOWLIST_ID, &pubkey)   [persist]
    //   server boot: FileSecureStore::open(dir, KEK) -> load_peer_allowlist(ALLOWLIST_ID)  [load]
    //   server gate: peer_is_allowlisted(&allowlist, &pubkey) == true                  [accept]
    //
    // It derives directly from a FIXED master (NO process-env mutation), persists exactly as
    // `hub_agent_run_enroll` does (`try_put`), then RE-OPENS the store and runs the server's OWN
    // private loader + gate. Mirroring the slice-2 KAT master (all 0x42) makes the round-tripped
    // pubkey the known parity value `1d4a03c1…98de56`, tying this proof to the cross-language KAT.
    #[test]
    fn enroll_to_server_load_accept_end_to_end() {
        // The slice-2 cross-language KAT master + its expected derived pubkey hex.
        let master = [0x42u8; friday_hub::key_source::MASTER_KEY_LEN];
        const KAT_PUBKEY_HEX: &str =
            "1d4a03c1c3af1a4639b616951c9b0e1cd1c957c9b0f25fe7a99b85101598de56"; // pragma: allowlist secret

        // Derive directly (no env). The KEK opens the store; the pubkey is what the enroll CLI
        // writes and the live handshake produces.
        let pubkey = friday_hub::key_source::derive_client_x25519_pubkey(&master);
        assert_eq!(
            hex_encode(&pubkey),
            KAT_PUBKEY_HEX,
            "the round-tripped pubkey must be the slice-2 cross-language KAT value (ties this \
             proof to the parity contract)"
        );

        let td = TempDir::new("e2e");
        let store_dir = td.child("agent-run-securestore");

        // ENROLL: open the store under the derived KEK and persist the pubkey under the SHARED
        // allowlist id — byte-for-byte what `hub_agent_run_enroll` does (`try_put`).
        {
            let kek = friday_hub::key_source::derive_file_store_kek(&master);
            let mut store = FileSecureStore::open(&store_dir, kek).expect("enroll: open store");
            store
                .try_put(PEER_PUBKEY_ALLOWLIST_ID, &pubkey)
                .expect("enroll: persist pubkey");
        }

        // SERVER BOOT: RE-OPEN the store under a FRESHLY re-derived KEK (Kek is consumed by `open`;
        // re-derive per the `key_source::kek_is_deterministic_for_a_master` pattern), then run the
        // server's OWN private loader — exactly the `run()` boot path (minus the listener).
        let server_store = {
            let kek = friday_hub::key_source::derive_file_store_kek(&master);
            FileSecureStore::open(&store_dir, kek).expect("server: open store")
        };
        let allowlist = load_peer_allowlist(&server_store, PEER_PUBKEY_ALLOWLIST_ID)
            .expect("server: the enroll-persisted allowlist must load (Ok)");
        assert_eq!(
            allowlist.len(),
            1,
            "exactly one enrolled peer pubkey round-trips"
        );

        // ACCEPT: the server's S-F gate admits the enrolled pubkey.
        assert!(
            peer_is_allowlisted(&allowlist, &pubkey),
            "the enroll→persist→load chain must produce an allowlist that ACCEPTS the derived \
             pubkey (the cutover accept path)"
        );

        // NEGATIVE: a DIFFERENT master derives a DIFFERENT pubkey that is NOT in this allowlist —
        // the gate fails closed against a non-enrolled peer (no fall-open).
        let other_master = [0x37u8; friday_hub::key_source::MASTER_KEY_LEN];
        let other_pubkey = friday_hub::key_source::derive_client_x25519_pubkey(&other_master);
        assert_ne!(
            pubkey, other_pubkey,
            "different masters → different pubkeys"
        );
        assert!(
            !peer_is_allowlisted(&allowlist, &other_pubkey),
            "a DIFFERENT master's pubkey must NOT be allowlisted (fail closed)"
        );
    }

    // === B1 interop scaffolding (additive, #[ignore], reuses establish_session/serve_sealed_session
    // via accept_one UNCHANGED; coordinator-applied to discharge the TS<->Rust wire proof bar) ======

    /// A "PONG"-answering mock runtime (additive test scaffolding — reuses `FinishTransport` /
    /// `HubRuntime::new` UNCHANGED, just a different deterministic answer than `BODY`).
    fn pong_runtime(
        tag: &str,
        principal: &str,
        answer: &str,
    ) -> (HubRuntime<FinishTransport>, TempWs) {
        let ws = TempWs::new(tag);
        let client = DeepSeekClient::with_transport(
            FinishTransport {
                answer: answer.to_string(),
            },
            "k".into(), // pragma: allowlist secret
        );
        let agent = DeepSeekAgentLlmClient::new(client);
        let rt = HubRuntime::new(
            HubConfig {
                db_path: std::env::temp_dir()
                    .join(format!(
                        "friday-execrun-interop-{}-{}-{}.sqlite",
                        std::process::id(),
                        tag,
                        C.fetch_add(1, Ordering::Relaxed)
                    ))
                    .to_string_lossy()
                    .into_owned(),
                workspace_root: ws.0.clone(),
                secret: b"execrun-interop-test-secret-0123456789ab".to_vec(), // pragma: allowlist secret
                max_turns: 4,
                principal_id: Some(principal.to_string()),
                disabled_tools: vec![],
                read_only: false,
                operator_vk: None,
            },
            agent,
            Box::new(DenyAllApprovals),
        )
        .unwrap();
        (rt, ws)
    }

    /// The fixed TS-client X25519 secret scalar (same fixture as `CLIENT_SECRET` above): the TS
    /// subprocess reconstructs the SAME keypair from this hex, so the test can derive its pubkey to
    /// enroll in the peer-allowlist. NON-secret test material.
    fn ts_client_secret_hex() -> String {
        CLIENT_SECRET.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// The TS-client pubkey for `CLIENT_SECRET`, derived via the SAME `DeviceKeypair` the server
    /// uses — so enrolling it in the peer-allowlist is faithful.
    fn ts_client_pubkey() -> [u8; 32] {
        DeviceKeypair::from_secret_bytes(CLIENT_SECRET).public_bytes()
    }

    /// Absolute path to the worktree root (3 levels up from `friday-hub`'s manifest dir).
    fn worktree_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(3)
            .expect("worktree root is 3 levels above friday-hub")
            .to_path_buf()
    }

    /// Spawn the TS sealed-client SUBPROCESS (the esbuild-bundled real client) targeting `port`,
    /// with `secret_hex` / `principal`. Returns the child so the caller can `wait_with_output`.
    /// Requires the bundle to be built (see the opt-in command above) and `node` on PATH.
    fn spawn_ts_client(
        port: u16,
        secret_hex: &str,
        principal: &str,
        run_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/sealed-client-runner.cjs");
        assert!(
            bundle.exists(),
            "interop bundle missing at {bundle:?} — run `node test/interop/build-sealed-client-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .arg(format!("--port={port}"))
            .arg(format!("--secret-hex={secret_hex}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--task=ping")
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node TS client subprocess")
    }

    /// Read the ONE JSON line the runner prints on stdout.
    fn read_client_json(child: std::process::Child) -> serde_json::Value {
        let out = child
            .wait_with_output()
            .expect("await TS client subprocess");
        let stdout = String::from_utf8_lossy(&out.stdout);
        let line = stdout
            .lines()
            .find(|l| l.trim_start().starts_with('{'))
            .unwrap_or_else(|| {
                panic!(
                    "TS client produced no JSON line. stdout={:?} stderr={:?}",
                    stdout,
                    String::from_utf8_lossy(&out.stderr)
                )
            });
        serde_json::from_str(line).expect("client JSON parses")
    }

    // (1) FULL ROUND-TRIP: the real TS sealed client ↔ the real server. The allowlisted client +
    // allowlisted principal ⇒ the loop runs and a REFS-ONLY result is returned. (leg-A decouple,
    // #655 Part 4) The TS client now SETTLES on the refs envelope ALONE — it no longer awaits or
    // surfaces the owner-sealed body frame (compose sources the body from the owner-gated DB
    // readback). So we assert the REFS the client surfaces (status/sha256/len from the FIRST
    // envelope); proving TS-seal → Rust-open (auth_proof accepted) + refs settle over the REAL
    // protocol. The server STILL persists the body to the DB + STILL emits the body frame after
    // the refs frame. For a SMALL body (this "PONG") `accept_one` returns Ok(1): the post-refs
    // body send lands in the loopback send buffer before the client's teardown RST is processed.
    // NOTE (characterized, flagged to the operator — NOT fixed here, server-logic is out of
    // leg-A scope): for a LARGE answer (empirically ~256KB) the body write is still pending when
    // the client's RST arrives, so `ws_send_envelope(body)` returns Err → `serve_sealed_session`
    // returns Err → `accept_one` is Err and logs `leg=body_send error=transport_closed`. This is
    // a benign log (the answer is committed in the DB and the client already settled on refs), but
    // it fires on otherwise-healthy large-answer runs. Making the body send non-fatal is a
    // follow-up server change.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_client_full_round_trip_pong() {
        const ANSWER: &str = "PONG";
        let (rt, _ws) = pong_runtime("interop-ok", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // Enroll the TS client's pubkey (derived from the fixed secret the subprocess uses).
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        let child = spawn_ts_client(
            addr.port(),
            &ts_client_secret_hex(),
            OWNER,
            "run-interop-ok",
        );
        // SERVER serves on the main thread (non-Send runtime); the TS client drives the socket.
        // (leg-A decouple) The dispatch still processes ONE authed run even though the client
        // settles on refs and tears down before draining the body frame — for this SMALL body the
        // body send lands in the loopback send buffer, so `serve_sealed_session` returns Ok (no
        // error settle). (Large bodies can Err on the body send; see the NOTE on the test above.)
        let processed = listener
            .accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false)
            .expect("server serves the interop session");
        assert_eq!(processed, 1, "one authed dispatch processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "TS client reports success: {v:?}"
        );
        // (leg-A decouple) The client no longer surfaces a body — it settles on the refs alone.
        assert!(
            v.get("body").is_none(),
            "leg-A decouple: the client surfaces NO body (refs-only settle): {v:?}"
        );
        assert_eq!(v["runId"], serde_json::json!("run-interop-ok"));
        // The refs fingerprint is surfaced from the FIRST (refs) envelope — sha256/len of the answer
        // the server persisted (and which the owner-gated DB readback will return to compose).
        assert_eq!(
            v["answerSha256"],
            serde_json::json!(sha256_hex(ANSWER.as_bytes())),
            "TS surfaced the refs sha256"
        );
        assert_eq!(
            v["answerLen"],
            serde_json::json!(ANSWER.len()),
            "TS surfaced the refs len"
        );
    }

    // (2) FAIL-CLOSED — FORGED PEER: a client pubkey NOT in the allowlist ⇒ the server establishes
    // NO session and sends NOTHING ⇒ the TS client must surface a 503-style fail-closed error (NOT a
    // hang, NOT success). Uses a DIFFERENT secret whose pubkey is not enrolled.
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_client_forged_peer_fails_closed() {
        let (rt, _ws) = pong_runtime("interop-forged", OWNER, "PONG");
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // The allowlist contains a DIFFERENT (server-generated) pubkey — NOT the TS client's.
        let peer_allowlist = allowlist_of(DeviceKeypair::generate().public_bytes());

        // The TS client uses its fixed secret (whose pubkey is NOT enrolled) ⇒ rejected at preamble.
        let child = spawn_ts_client(addr.port(), &ts_client_secret_hex(), OWNER, "run-forged");
        // The server rejects the peer pubkey and returns an Err (no session established).
        let served = listener.accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false);
        assert!(
            served.is_err(),
            "a forged/non-allowlisted peer establishes NO session"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(false),
            "forged peer ⇒ TS fails closed: {v:?}"
        );
        assert_eq!(
            v["httpStatus"],
            serde_json::json!(503),
            "fail-closed surfaces a 503"
        );
    }

    // (3) FAIL-CLOSED — BAD PRINCIPAL: a VALID handshake (allowlisted peer) but a forwarded principal
    // that is NOT in the owner allowlist ⇒ the server ends the session with no result ⇒ the TS client
    // fails closed (no body, no success).
    #[test]
    #[ignore = "needs `node` + the prebuilt interop bundle; opt in with --ignored"]
    fn interop_ts_client_bad_principal_fails_closed() {
        let (rt, _ws) = pong_runtime("interop-badprincipal", OWNER, "PONG");
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // The TS client's pubkey IS enrolled (handshake succeeds), so the rejection is attributable
        // to the PRINCIPAL gate, not the peer gate.
        let peer_allowlist = allowlist_of(ts_client_pubkey());

        // Forward a NON-allowlisted principal — a well-formed handshake, but the owner gate rejects.
        let child = spawn_ts_client(
            addr.port(),
            &ts_client_secret_hex(),
            "principal:attacker-not-allowlisted",
            "run-badprincipal",
        );
        let processed = listener
            .accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false)
            .expect("server serves the session but runs nothing");
        assert_eq!(
            processed, 0,
            "a non-allowlisted principal runs ZERO dispatches"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(false),
            "bad principal ⇒ TS fails closed: {v:?}"
        );
        assert_eq!(
            v["httpStatus"],
            serde_json::json!(503),
            "fail-closed surfaces a 503"
        );
    }

    // === B1-compose interop scaffolding (additive, #[ignore]) — drives the REAL composition seam
    // (X25519 resolver -> service adapter -> real sealed client) the B1 client interop did NOT cover.

    /// The fixture master key the compose-adapter runner sees as FRIDAY_MASTER_KEY (64 hex). NON-secret
    /// test material — a fixed value so the Rust side can re-derive the SAME client pubkey to enroll.
    const COMPOSE_FIXTURE_MASTER_KEY: [u8; 32] = [0x42u8; 32]; // pragma: allowlist secret

    /// The TS resolver's domain-separation tag (mirrors
    /// `friday-rust-hub-agent-run-ws-client-x25519-secret.ts` `WS_X25519_SECRET_PURPOSE`). The Rust
    /// side re-derives the client secret the SAME way the TS resolver does — so a passing handshake
    /// LIVE-CHECKS that the resolver's derivation matches what 6b enrolls.
    const COMPOSE_X25519_PURPOSE: &[u8] = b"friday.rust.agent_run.ws.x25519_secret.v1";

    /// Re-derive the client X25519 pubkey the TS resolver produces for `master_key`:
    /// `secret = sha256(purpose ‖ master_key)` (streaming `update(purpose).update(key)` ==
    /// `digest(purpose ‖ key)`), `pubkey = DeviceKeypair::from_secret_bytes(secret).public_bytes()`.
    fn compose_derive_client_pubkey(master_key: &[u8; 32]) -> [u8; 32] {
        let mut input = COMPOSE_X25519_PURPOSE.to_vec();
        input.extend_from_slice(master_key);
        let secret: [u8; 32] = Sha256::digest(&input).into();
        DeviceKeypair::from_secret_bytes(secret).public_bytes()
    }

    fn hex_of(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Spawn the compose-adapter runner SUBPROCESS (FRIDAY_MASTER_KEY in env → real resolver → real
    /// adapter → real sealed client). Requires the bundle built via
    /// `node test/interop/build-compose-adapter-runner.mjs` and `node` on PATH.
    fn spawn_compose_adapter_client(
        port: u16,
        master_key_hex: &str,
        principal: &str,
        run_id: &str,
    ) -> std::process::Child {
        let bundle = worktree_root().join("test/interop/.build/compose-adapter-runner.cjs");
        assert!(
            bundle.exists(),
            "compose-adapter bundle missing at {bundle:?} — run `node test/interop/build-compose-adapter-runner.mjs` first"
        );
        std::process::Command::new("node")
            .arg(bundle)
            .env("FRIDAY_MASTER_KEY", master_key_hex)
            .arg(format!("--port={port}"))
            .arg(format!("--principal={principal}"))
            .arg(format!("--run-id={run_id}"))
            .arg("--task=ping")
            .arg("--timeout-ms=15000")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn node compose-adapter subprocess")
    }

    // (1) FULL COMPOSE-SEAM ROUND-TRIP: the REAL X25519 resolver (FRIDAY_MASTER_KEY fixture) → the REAL
    // service adapter (default createClient = real sealed client) → the REAL server. The Rust side
    // re-derives + enrolls the client pubkey, so a pass proves (a) the adapter's real construct+dispatch
    // path handshakes end-to-end and (b) the resolver's derivation matches the enrolled pubkey. Refs-only
    // (the adapter drops the in-band body; compose's body source is the proven slice-3 DB readback).
    #[test]
    #[ignore = "needs `node` + the prebuilt compose-adapter bundle; opt in with --ignored"]
    fn interop_compose_adapter_resolver_full_round_trip() {
        const ANSWER: &str = "PONG";
        let (rt, _ws) = pong_runtime("interop-compose-ok", OWNER, ANSWER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // Enroll the pubkey the TS resolver will derive from the fixture master key.
        let peer_allowlist =
            allowlist_of(compose_derive_client_pubkey(&COMPOSE_FIXTURE_MASTER_KEY));

        let child = spawn_compose_adapter_client(
            addr.port(),
            &hex_of(&COMPOSE_FIXTURE_MASTER_KEY),
            OWNER,
            "run-compose-ok",
        );
        let processed = listener
            .accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false)
            .expect("server serves the compose-adapter session");
        assert_eq!(processed, 1, "one authed dispatch processed");

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(true),
            "compose adapter reports success: {v:?}"
        );
        assert_eq!(
            v["status"],
            serde_json::json!("finished"),
            "wire status is the literal 'finished'"
        );
        assert_eq!(v["runId"], serde_json::json!("run-compose-ok"));
        assert_eq!(
            v["answerSha256"],
            serde_json::json!(sha256_hex(ANSWER.as_bytes())),
            "adapter surfaced the refs sha256"
        );
        assert_eq!(
            v["answerLen"],
            serde_json::json!(ANSWER.len()),
            "adapter surfaced the refs len"
        );
    }

    // (2) FAIL-CLOSED — the resolver-derived pubkey is NOT the one enrolled (forged): the server
    // establishes NO session ⇒ the adapter surfaces a 503 (NOT a hang, NOT success).
    #[test]
    #[ignore = "needs `node` + the prebuilt compose-adapter bundle; opt in with --ignored"]
    fn interop_compose_adapter_unenrolled_pubkey_fails_closed() {
        let (rt, _ws) = pong_runtime("interop-compose-forged", OWNER, "PONG");
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let owner_allowlist = vec![OWNER.to_string()];
        // Enroll a DIFFERENT pubkey (NOT the one the fixture master key derives).
        let peer_allowlist = allowlist_of(DeviceKeypair::generate().public_bytes());

        let child = spawn_compose_adapter_client(
            addr.port(),
            &hex_of(&COMPOSE_FIXTURE_MASTER_KEY),
            OWNER,
            "run-compose-forged",
        );
        let served = listener.accept_one(&server_kp, &rt, &owner_allowlist, &peer_allowlist, false);
        assert!(
            served.is_err(),
            "an unenrolled derived pubkey establishes NO session"
        );

        let v = read_client_json(child);
        assert_eq!(
            v["ok"],
            serde_json::json!(false),
            "unenrolled pubkey ⇒ adapter fails closed: {v:?}"
        );
        assert_eq!(
            v["httpStatus"],
            serde_json::json!(503),
            "fail-closed surfaces a 503"
        );
    }

    // ────────────────────────────────────────────────────────────────────────────────────
    // (A2a Phase 1) SESSIONED read-only dispatch — the CONDITIONAL swap on `session_id`.
    // ────────────────────────────────────────────────────────────────────────────────────

    // OWNER-SCOPING: a sessioned request (non-empty `session_id`) routes through
    // `run_session_task` → `run_session_loop`. The session row is created OWNED by the
    // AUTHENTICATED forwarded principal (the `caller`), NOT the client-asserted `session_id`,
    // and the body is delivered owner-sealed to that owner EXACTLY like the sessionless path.
    #[test]
    fn sessioned_dispatch_creates_owner_scoped_session_and_delivers_body_to_owner() {
        let (rt, _ws) = mock_runtime("sess-owner", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        let client_session = client_kp.agree(&server_kp.public_bytes());
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            // CLIENT-ASSERTED session id — deliberately NOT the principal. The owner binding
            // must come from the authenticated `caller`, never this value.
            let req = sessioned_agent_run_request(
                "req-s1",
                "run-sess-1",
                OWNER,
                "chat-session-xyz",
                session,
                nonce,
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener
            .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
            .unwrap();
        assert_eq!(processed, 1, "one sessioned dispatch processed");

        let obs = client.join().unwrap();
        // The refs result + owner-sealed body are delivered EXACTLY as the sessionless path
        // (the two dispatch arms share the identical emit tail).
        let Some(Message::AgentRunResult {
            run_id,
            answer_sha256,
            answer_len,
            ..
        }) = obs.result.clone()
        else {
            panic!("expected AgentRunResult, got {:?}", obs.result);
        };
        assert_eq!(run_id, "run-sess-1");
        assert_eq!(
            answer_sha256.as_deref(),
            Some(sha256_hex(BODY.as_bytes()).as_str())
        );
        assert_eq!(answer_len, Some(BODY.len() as u64));
        assert!(
            !format!("{:?}", obs.result).contains(BODY),
            "refs result leaked the body"
        );
        let chunk = obs
            .body_chunk
            .expect("owner-sealed body delivered for the sessioned run");
        let inner_bytes = hex_decode(&chunk).expect("body chunk is hex");
        let inner = decode_sealed_proof(&inner_bytes).expect("owner-sealed body decodes");
        let opened = friday_crypto::open(&client_session, &inner, SESSION_AAD).unwrap();
        assert_eq!(
            opened,
            BODY.as_bytes(),
            "owner opens the sealed sessioned body"
        );

        // OWNER-SCOPING (the load-bearing assertion): the session row was created OWNED by the
        // AUTHENTICATED principal (`OWNER`), NEVER the client-asserted `session_id`.
        let owner = friday_storage::load_session_owner(rt.db().conn(), "chat-session-xyz")
            .unwrap()
            .expect("the sessioned run created the session row");
        assert_eq!(
            owner.user_id.as_deref(),
            Some(OWNER),
            "the session owner MUST be the authenticated principal, never the client-asserted session_id"
        );
        assert_ne!(
            owner.user_id.as_deref(),
            Some("chat-session-xyz"),
            "the client-asserted session_id must NEVER become the owner"
        );

        // The run's turn was appended to THIS session (history is now persisted for the next turn).
        assert!(
            friday_storage::session_message_count(rt.db().conn(), "chat-session-xyz").unwrap() >= 1,
            "the sessioned run appended at least the user turn"
        );

        // BODY is releasable ONLY to the bound owner (a guessed/other principal is denied).
        use friday_storage::{AnswerDenyReason, RunAnswerAccess};
        match friday_storage::get_run_answer_for_principal(rt.db().conn(), "run-sess-1", OWNER)
            .unwrap()
        {
            RunAnswerAccess::Granted(stored) => assert_eq!(stored.answer, BODY),
            other => panic!("owner must be Granted the sessioned body, got {other:?}"),
        }
        assert_eq!(
            friday_storage::get_run_answer_for_principal(
                rt.db().conn(),
                "run-sess-1",
                "principal:not-the-owner"
            )
            .unwrap(),
            RunAnswerAccess::Denied(AnswerDenyReason::PrincipalMismatch),
            "a non-owner (even one who guessed the session_id) must be DENIED the body"
        );
    }

    // SESSION THREADING: a SECOND turn on the SAME session id reloads + extends the SAME
    // session row — proving multi-turn history accumulates on one session (the Phase-1
    // capability). Two separate sealed connections (transport-stateless, DB-stateful).
    #[test]
    fn second_sessioned_turn_threads_into_the_same_session_history() {
        let (rt, _ws) = mock_runtime("sess-thread", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];
        let sid = "chat-thread-1";

        // ── Turn 1 (fresh sealed connection) ──
        let kp1 = DeviceKeypair::generate();
        let peer1 = allowlist_of(kp1.public_bytes());
        let c1 = spawn_client(addr, kp1, move |s, n| {
            let req = sessioned_agent_run_request("req-t1", "run-t1", OWNER, "chat-thread-1", s, n);
            (req, s.clone(), s.clone())
        });
        assert_eq!(
            listener
                .accept_one(&server_kp, &rt, &allowlist, &peer1, false)
                .unwrap(),
            1
        );
        c1.join().unwrap();
        let after_turn1 = friday_storage::session_message_count(rt.db().conn(), sid).unwrap();
        assert!(after_turn1 >= 1, "turn 1 appended history");

        // ── Turn 2 (a SEPARATE sealed connection, SAME session id) ──
        let kp2 = DeviceKeypair::generate();
        let peer2 = allowlist_of(kp2.public_bytes());
        let c2 = spawn_client(addr, kp2, move |s, n| {
            let req = sessioned_agent_run_request("req-t2", "run-t2", OWNER, "chat-thread-1", s, n);
            (req, s.clone(), s.clone())
        });
        assert_eq!(
            listener
                .accept_one(&server_kp, &rt, &allowlist, &peer2, false)
                .unwrap(),
            1
        );
        c2.join().unwrap();

        // Turn 2 reloaded the SAME session and appended ON TOP of turn 1's history — the count
        // STRICTLY grew (it did not start a fresh session), and both runs' turns are present.
        let after_turn2 = friday_storage::session_message_count(rt.db().conn(), sid).unwrap();
        assert!(
            after_turn2 > after_turn1,
            "turn 2 must extend the SAME session history (got {after_turn1} → {after_turn2})"
        );
        let msgs = friday_storage::load_session_messages(rt.db().conn(), sid).unwrap();
        assert!(
            msgs.iter().any(|m| m.refs.as_deref() == Some("run-t1")),
            "turn 1's message persists in the shared session"
        );
        assert!(
            msgs.iter().any(|m| m.refs.as_deref() == Some("run-t2")),
            "turn 2's message was appended to the SAME session"
        );
    }

    // BYTE-IDENTICAL SESSIONLESS: a request with NO `session_id` (the pre-A2a shape) still
    // routes through the UNCHANGED `run_authed_agent_loop` and creates NO session row — the
    // sessioned path is not silently entered. This is the regression fence for the one
    // currently-live, operator-fed sessionless path.
    #[test]
    fn sessionless_dispatch_uses_unchanged_path_and_creates_no_session_row() {
        let (rt, _ws) = mock_runtime("sess-none", OWNER);
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let allowlist = vec![OWNER.to_string()];

        let client_kp = DeviceKeypair::generate();
        let peer_allowlist = allowlist_of(client_kp.public_bytes());
        let client = spawn_client(addr, client_kp, |session, nonce| {
            // The EXACT sessionless helper today's live path uses (session_id: None).
            let req = agent_run_request("req-none", "run-none", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });
        assert_eq!(
            listener
                .accept_one(&server_kp, &rt, &allowlist, &peer_allowlist, false)
                .unwrap(),
            1
        );
        let obs = client.join().unwrap();
        // The result is delivered (the unchanged sessionless path still works).
        assert!(
            matches!(obs.result, Some(Message::AgentRunResult { .. })),
            "sessionless dispatch still returns a refs result"
        );
        // CRITICAL: NO session row was created for the sessionless run — `run_session_loop`
        // (which ensure_session's) was NEVER entered. The run's own id is never a session id.
        assert!(
            friday_storage::load_session_owner(rt.db().conn(), "run-none")
                .unwrap()
                .is_none(),
            "the sessionless path must NOT create a session row (byte-identical to today)"
        );
        // And the agent_session table has NO rows at all from this run.
        let n: i64 = rt
            .db()
            .conn()
            .query_row("SELECT count(*) FROM agent_session", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            n, 0,
            "the sessionless dispatch created ZERO session rows (the session loop was never reached)"
        );
    }
}
