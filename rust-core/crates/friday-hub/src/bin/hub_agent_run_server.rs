//! WS substrate **S-C** + **S-E** — `hub_agent_run_server`: the long-lived loopback agent-run WS
//! server bin, with the authed agent-run DISPATCH arm (S-C) HARDENED against REPLAY (S-E).
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
//! S-E closes REPLAY ONLY. It does NOT add PEER authentication: a FRESH local process completing
//! the CURRENT handshake and forging a proof for an allowlisted owner string is STILL possible —
//! that is the PEER-AUTH gap, deferred to **S-F** (SecureStore pubkey allowlist / pairing).
//! Loopback-only + no-prod-caller bound it meanwhile.
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
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use friday_crypto::{generate_approval_nonce, seal, DataKey, DeviceKeypair, Sealed};
use friday_deepseek::Transport;
use friday_hub::hub_server::{run_authed_agent_loop, AuthedPrincipal, ForwardedAuth};
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
}

fn main() {
    if let Err(err) = run() {
        let kind = match err {
            ServerError::BadArgs => "bad_args",
            ServerError::Bind => "bind_failed",
            ServerError::Init => "init_failed",
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

    // (1) Build ONE HubRuntime at boot so the DeepSeek-client/DB cold-start is paid ONCE (not
    // per connection). S-C HOLDS this runtime and DISPATCHES into `run_task` for an authenticated
    // peer. The runtime is single-owner (v1): it is configured with the SAME principal the
    // allowlist admits, so owner-wiring records `owner == caller` and the body is releasable to
    // them. `HubRuntime::live` only CONSTRUCTS the provider client (no network call); an actual
    // run needs the env key — the separate operator live-proof.
    let runtime = HubRuntime::live(HubConfig {
        db_path,
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

    // (3) Long-lived accept loop. Each accepted connection: set the read timeout, read the peer
    // pubkey preamble (rejecting low-order points), run the WS handshake, derive the sealed
    // session key, and serve sealed envelopes fail-closed — dispatching authed agent-runs.
    loop {
        match listener.accept_one(&server_kp, &runtime, &owner_allowlist) {
            Ok(_served) => {}
            // A connection-level error ends THAT connection only; the server keeps listening.
            Err(_e) => continue,
        }
    }
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
    /// session (peer pubkey from the wire; low-order points rejected), and serve it fail-closed
    /// — dispatching authed agent-runs. Returns the count of envelopes processed on that session.
    fn accept_one<T: Transport>(
        &self,
        server_kp: &DeviceKeypair,
        runtime: &HubRuntime<T>,
        owner_allowlist: &[String],
    ) -> Result<usize, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        // HARDENING: a per-connection read timeout BEFORE any read, so a stalled peer cannot
        // wedge the single-threaded accept loop before auth/dispatch.
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let (mut ws, session_key, session_nonce) = establish_session(stream, server_kp)?;
        serve_sealed_session(
            &mut ws,
            &session_key,
            &session_nonce,
            runtime,
            owner_allowlist,
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
/// Two FAIL-CLOSED gates BEFORE the session is derived:
/// * a peer-pubkey frame that is not exactly 32 bytes (a malformed preamble can never yield a
///   session); and
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
) -> Result<(WireWebSocket<S>, DataKey, Vec<u8>), TransportError> {
    // (a) Receive the peer's X25519 public key (cleartext preamble). The peer pubkey is ALWAYS an
    // input read from the wire — the server never fabricates the peer's ECDH half.
    let peer_pub_bytes = read_frame(&mut stream)?;
    let peer_pub: [u8; 32] = peer_pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| TransportError::Protocol("peer pubkey must be 32 bytes".into()))?;

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
                let now_ms = now_ms();
                let outcome = run_authed_agent_loop(runtime, &caller, &run_id, &task, now_ms);

                // (refs) REFS-ONLY terminal receipt over the wire: status + answer FINGERPRINT
                // (sha256/len) — NEVER the body. Mirrors `AuthedAnswer::proof_refs_json`.
                let (status, answer_sha256, answer_len) = result_refs(&outcome);
                let result = Envelope::new(
                    format!("agent-run-result-{run_id}"),
                    now_ms,
                    Message::AgentRunResult {
                        run_id: run_id.clone(),
                        status,
                        answer_sha256,
                        answer_len,
                    },
                )
                .with_correlation(env.msg_id.clone());
                ws_send_envelope(ws, session_key, &result, SESSION_AAD)?;

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
                    ws_send_envelope(ws, session_key, &body_env, SESSION_AAD)?;
                }
                processed += 1;
            }
            // Benign keepalive (S-B behaviour): echo the opened envelope back, sealed under the
            // SAME session key, correlated to the request. NO dispatch.
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

/// Project a dispatch outcome to its REFS-ONLY terminal fields (status + answer sha256/len).
/// NEVER returns the body. Derives the fingerprint from the `proof_refs_json` projection so the
/// wire result and the proof surface agree.
fn result_refs(
    outcome: &friday_hub::hub_server::AuthedAnswer,
) -> (String, Option<String>, Option<u64>) {
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
    (status, answer_sha256, answer_len)
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
    use friday_crypto::open as crypto_open;
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
        let client = spawn_client(addr, client_kp, |session, nonce| {
            let req = agent_run_request("req-1", "run-sc-1", OWNER, session, nonce);
            (req, session.clone(), session.clone())
        });

        // SERVER on the main thread (holds the non-Send runtime).
        let processed = listener.accept_one(&server_kp, &rt, &allowlist).unwrap();
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
        let forwarded = forwarded.to_string();
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = agent_run_request("req-x", "run-rej", &forwarded, session, nonce);
            (req, session.clone(), session.clone())
        });

        let processed = listener.accept_one(&server_kp, &rt, &allowlist).unwrap();
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
                },
            );
            (req, session.clone(), session.clone())
        });

        let processed = listener.accept_one(&server_kp, &rt, &allowlist).unwrap();
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
        // Seal the request (and its auth_proof) under a key that is NOT the established session.
        let wrong_key = DataKey::generate();
        // Client SEALS under the wrong key but OPENS replies under the real session (there are
        // none — the server ends the session). The nonce is still bound correctly so the failure
        // is attributable to the wrong ENVELOPE key (the server can't even open the envelope).
        let client = spawn_client(addr, client_kp, move |session, nonce| {
            let req = agent_run_request("req-wrong", "run-wrong", OWNER, &wrong_key, nonce);
            (req, wrong_key.clone(), session.clone())
        });

        let processed = listener.accept_one(&server_kp, &rt, &allowlist).unwrap();
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
        let outcome = listener.accept_one(&server_kp, &rt, &allowlist);
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
            establish_session(stream, &server_kp).map(|_| ())
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
        let delivered = AuthedAnswer::Delivered {
            run_id: "run-f".into(),
            status: "finished".into(),
            answer: BODY.into(),
            answer_sha256: sha256_hex(BODY.as_bytes()),
            answer_len: BODY.len() as i64,
        };
        let (status, sha, len) = result_refs(&delivered);
        assert_eq!(status, "finished");
        assert_eq!(sha.as_deref(), Some(sha256_hex(BODY.as_bytes()).as_str()));
        assert_eq!(len, Some(BODY.len() as u64));
        let result = Message::AgentRunResult {
            run_id: "run-f".into(),
            status,
            answer_sha256: sha,
            answer_len: len,
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

        // Drive one handshake: spawn a client that reads the nonce, run the server's
        // establish_session on THIS (main) thread (server_kp is borrowed, not cloned), return the
        // client-observed nonce.
        let one_handshake = || -> Vec<u8> {
            let c = thread::spawn(move || {
                let client_kp = DeviceKeypair::generate();
                let (_ws, _s, nonce) = client_handshake(addr, &client_kp);
                nonce
            });
            let (stream, _peer) = listener.listener.accept().unwrap();
            stream.set_read_timeout(Some(READ_TIMEOUT)).unwrap();
            let _ = establish_session(stream, &server_kp).unwrap();
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
        // A FIXED client secret scalar so the SAME client keypair (hence the SAME session key) is
        // reconstructed in BOTH connection threads (DeviceKeypair is not Clone/Send-shared). The
        // value is a non-secret test fixture (small primes), not real key material.
        let client_secret: [u8; 32] = [
            // pragma: allowlist secret
            7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97,
            101, 103, 107, 109, 113, 127, 131, 137, 139, 149,
        ];
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
                },
            );
            ws_send_envelope(&mut ws, &sess_c1, &req, SESSION_AAD).unwrap();
            // Drain the (accepted) reply so the server completes conn-1 cleanly.
            let _ = ws_recv_envelope(&mut ws, &sess_c1, SESSION_AAD);
        });
        let processed1 = listener.accept_one(&server_kp, &rt1, &allowlist).unwrap();
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
                },
            );
            ws_send_envelope(&mut ws, &sess_c2, &req, SESSION_AAD).unwrap();
            // The server must fail closed (END the session) — no reply.
            ws_recv_envelope(&mut ws, &sess_c2, SESSION_AAD)
                .ok()
                .map(|e| e.message)
        });
        let processed2 = listener.accept_one(&server_kp, &rt2, &allowlist).unwrap();
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

        let processed = listener.accept_one(&server_kp, &rt, &allowlist).unwrap();
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
}
