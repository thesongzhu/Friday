//! WS substrate **S-C** — `hub_agent_run_server`: the long-lived loopback agent-run WS server
//! bin, NOW with the authed agent-run DISPATCH arm.
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
//! WS substrate **S-C**. Loopback-only. **Dev key-exchange** (the PRODUCTION key source —
//! loopback pairing handshake vs SecureStore — is a LATER decision, deferred; here both peers
//! hold their OWN keypair and ECDH at connect). The bound principal is
//! **TRUSTED-PEER-FORWARDED** (the in-TCB TS API resolved it from a validated bearer token and
//! forwarded it over the sealed session) — NOT a client-asserted string; the sealed session is
//! the basis of trust and the owner-allowlist is the final ceiling. Production key-source + a
//! supervisor are deferred (open-qs). `rust_wired` at best; NOT v1 GO; `executeRun` is NOT
//! replaced; the live forged-principal proof is the coordinator's at S-F.
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

use friday_crypto::{seal, DataKey, DeviceKeypair, Sealed};
use friday_deepseek::Transport;
use friday_hub::hub_server::{run_authed_agent_loop, AuthedPrincipal};
use friday_hub::runtime::{HubConfig, HubRuntime};
use friday_protocol::{Envelope, Message};
use friday_transport::{
    read_frame, write_frame, ws_accept, ws_recv_envelope, ws_send_envelope, TransportError,
    WireWebSocket,
};

/// The session AAD binding every sealed envelope on an S-C session to this protocol/version.
/// A fixed, public, non-secret constant (the confidentiality is in the session key, not the AAD).
const SESSION_AAD: &[u8] = b"friday:execrun:ws:s-c:agent-run-session:aad:v1";

/// The agreed authentication challenge the trusted peer seals (in `auth_proof`) to prove
/// possession of the session key. A fixed, public, non-secret constant — the security is in
/// possessing the session key that seals it, not in the challenge value.
const AUTH_CHALLENGE: &[u8] = b"friday:execrun:ws:s-c:authed-run:challenge:v1";

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
        let (mut ws, session_key) = establish_session(stream, server_kp)?;
        serve_sealed_session(&mut ws, &session_key, runtime, owner_allowlist)
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
fn establish_session<S: Read + Write>(
    mut stream: S,
    server_kp: &DeviceKeypair,
) -> Result<(WireWebSocket<S>, DataKey), TransportError> {
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

    // (c) WS upgrade over the (now preamble-consumed) stream, then derive the sealed session key.
    let ws = ws_accept(stream)?;
    let session_key = server_kp.agree(&peer_pub);
    Ok((ws, session_key))
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
/// Returns the number of envelopes processed before the session ended — `0` means the first
/// envelope failed to open OR failed auth (the fail-closed path: no echo, no dispatch).
fn serve_sealed_session<S: Read + Write, T: Transport>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    runtime: &HubRuntime<T>,
    owner_allowlist: &[String],
) -> Result<usize, TransportError> {
    let mut processed = 0usize;
    loop {
        let env = match ws_recv_envelope(ws, session_key, SESSION_AAD) {
            Ok(e) => e,
            // EOF / disconnect / un-openable seal (wrong key or tamper) → END the session.
            // No dispatch, no processing — fail closed.
            Err(_) => return Ok(processed),
        };
        match env.message {
            Message::AgentRunRequest {
                run_id,
                task,
                forwarded_principal,
                auth_proof,
            } => {
                // The dispatch arm: AUTH BEFORE ANY RUN. The `auth_proof` is the peer-sealed
                // challenge; reconstruct it as a `Sealed` for the session-key open. A malformed
                // proof that cannot decode is an auth failure (None below), not a panic.
                let caller = decode_sealed_proof(&auth_proof).and_then(|proof| {
                    AuthedPrincipal::authenticate_forwarded(
                        session_key,
                        &proof,
                        SESSION_AAD,
                        AUTH_CHALLENGE,
                        &forwarded_principal,
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
    use friday_deepseek::{DeepSeekClient, DeepSeekError};
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

    /// Drive the cleartext pubkey preamble from the CLIENT side, then run the WS upgrade and
    /// derive the client's view of the session key. The client keypair is generated HERE
    /// (test-only), never by the server.
    fn client_handshake(
        addr: SocketAddr,
        client_kp: &DeviceKeypair,
    ) -> (WireWebSocket<TcpStream>, DataKey) {
        let mut stream = TcpStream::connect(addr).unwrap();
        write_frame(&mut stream, &client_kp.public_bytes()).unwrap();
        let server_pub_bytes = read_frame(&mut stream).unwrap();
        let server_pub: [u8; 32] = server_pub_bytes.as_slice().try_into().unwrap();
        let ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let session = client_kp.agree(&server_pub);
        (ws, session)
    }

    /// Build a sealed `auth_proof` over the agreed challenge under the client's session view.
    fn auth_proof_bytes(client_session: &DataKey) -> Vec<u8> {
        let sealed = seal(client_session, AUTH_CHALLENGE, SESSION_AAD).unwrap();
        encode_sealed_proof(&sealed)
    }

    /// An `AgentRunRequest` envelope for `run_id` forwarding `principal`, with an `auth_proof`
    /// sealed under `client_session` (the peer's possession-of-session proof).
    fn agent_run_request(
        msg_id: &str,
        run_id: &str,
        principal: &str,
        client_session: &DataKey,
    ) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::AgentRunRequest {
                run_id: run_id.to_string(),
                task: "answer me".into(),
                forwarded_principal: principal.to_string(),
                auth_proof: auth_proof_bytes(client_session),
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

    /// Spawn the CLIENT peer: handshake, send `req` sealed under `seal_key`, then read up to two
    /// replies (refs result + owner-sealed body). Returns the observations. The server runs on
    /// the caller's (main) thread via `accept_one`.
    fn spawn_client(
        addr: SocketAddr,
        req: Envelope,
        client_kp: DeviceKeypair,
        seal_key: DataKey,
        recv_key: DataKey,
    ) -> thread::JoinHandle<ClientObservations> {
        thread::spawn(move || {
            let (mut ws, _session) = client_handshake(addr, &client_kp);
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

        // The client derives the SAME session the server will (ECDH), so it can build the
        // matching auth_proof + seal/open envelopes. We precompute its session view here.
        let client_kp = DeviceKeypair::generate();
        let client_session = client_kp.agree(&server_kp.public_bytes());
        let req = agent_run_request("req-1", "run-sc-1", OWNER, &client_session);
        let client = spawn_client(
            addr,
            req,
            client_kp,
            client_session.clone(),
            client_session.clone(),
        );

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
        let client_session = client_kp.agree(&server_kp.public_bytes());
        let req = agent_run_request("req-x", "run-rej", forwarded, &client_session);
        let client = spawn_client(addr, req, client_kp, client_session.clone(), client_session);

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
        let client_session = client_kp.agree(&server_kp.public_bytes());
        // The envelope opens (correct session key) but the auth_proof is sealed under a WRONG key.
        let wrong = DataKey::generate();
        let bad_proof = encode_sealed_proof(&seal(&wrong, AUTH_CHALLENGE, SESSION_AAD).unwrap());
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
        let client = spawn_client(addr, req, client_kp, client_session.clone(), client_session);

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
        let real_session = client_kp.agree(&server_kp.public_bytes());
        // Seal the request under a key that is NOT the established session key.
        let wrong_key = DataKey::generate();
        let req = agent_run_request("req-wrong", "run-wrong", OWNER, &wrong_key);
        // Client SEALS under the wrong key but OPENS replies under the real session (there are
        // none — the server ends the session).
        let client = spawn_client(addr, req, client_kp, wrong_key, real_session);

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
        assert_eq!(
            friday_crypto::open(&k, &back, SESSION_AAD).unwrap(),
            AUTH_CHALLENGE
        );
        assert!(decode_sealed_proof(&[]).is_none());
        assert!(decode_sealed_proof(&[200, 1, 2]).is_none()); // nlen > remaining
    }
}
