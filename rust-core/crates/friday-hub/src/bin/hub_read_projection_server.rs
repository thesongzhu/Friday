//! **S-R1** — `hub_read_projection_server`: the SEPARATE, DARK sealed-WS READ-projection server for
//! the v1 UI direct-read seam. **DEFAULT-OFF: no LaunchAgent, no production caller — it exists, but
//! is only reachable when explicitly run; the slice-6 production flip is a separate operator gate.**
//!
//! ## Why a SEPARATE server (operator-locked transport 2b on a 2c substrate)
//! This is NOT the live agent-run WRITE bin. It shares ONLY the cryptographic substrate
//! ([`friday_hub::sealed_ws`]) — the handshake, the S-F peer-pubkey allowlist, the low-order check,
//! the sealed-proof codec, and (via `hub_server::AuthedPrincipal::authenticate_forwarded`) the
//! owner-auth chain — so the two servers cannot drift in crypto/auth. Everything else is its OWN:
//!
//! * **Capability isolation by construction.** This bin builds NO `HubRuntime` and NO
//!   `DeepSeekClient`; it never calls `DeepSeekClient::from_env`; it has NO model-call path and holds
//!   NO provider credential. The hub DB is opened **read-only** (`Db::open_hub_readonly`). A
//!   compromised/misbehaving read client therefore cannot spend quota or write — the absence of the
//!   runtime IS the no-model-path guarantee. A UI reads from a strictly smaller attack surface than
//!   the write bin.
//! * **Refs-only responses.** The workbench projection runs the SHARED
//!   [`friday_hub::workbench_projection::project_workbench`] fn, which runs the forbidden-output guard
//!   INSIDE itself — so the snapshot carries redacted proof refs / counts / labels only, never an
//!   inline body. Truth labels ride as-is; a `503`/unavailable state is surfaced as a typed error,
//!   never a fabricated success.
//! * **Owner-scoped, never client-asserted.** Every read request carries `forwarded_principal` +
//!   `auth_proof`, verified by the SAME nonce-bound + owner-allowlisted + possession-of-session chain
//!   a write uses (`authenticate_forwarded`), with the proof bound to the request's `request_id` (the
//!   read analog of `run_id` — a read has no run). The projection is released ONLY to the bound
//!   AUTHENTICATED principal. A forged / empty / non-allowlisted principal (or an un-openable proof)
//!   ⇒ NO snapshot, END the session — fail-closed, exactly like a write.
//!
//! ## DARK / default-off
//! There is NO LaunchAgent entry and NO production caller. The bin only serves when explicitly run
//! (e.g. by the S-R1 integration KAT, which drives `accept_one` directly). Activating the direct
//! path in production (provision a LaunchAgent + enroll the UI peer pubkey + flip the prod flag) is
//! the slice-6 operator gate (G2, the FREEZE tripwire) — NOT this slice. Built ≠ flipped; this moves
//! NO UI needle. NOT v1 GO.
//!
//! ## Single-owner v1 (DEFERRED cross-owner isolation — see PR body acceptance criteria)
//! The owner-allowlist ceiling is the SAME single-configured-owner model the write path uses today.
//! Per-conversation owner-principal matching (so peer A cannot read peer B's mission even with a
//! valid session) is tied to the write path's own unbuilt FIX-Q2/FIX-Q3b multi-principal bindings
//! and is DEFERRED as an explicit acceptance criterion — NOT silently skipped.

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use friday_crypto::{seal, DataKey, DeviceKeypair, FileSecureStore};
use friday_hub::hub_server::{AuthedPrincipal, ForwardedAuth};
use friday_hub::key_source::{PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN};
use friday_hub::sealed_ws::{
    decode_sealed_proof, enforce_single_peer, establish_session, load_peer_allowlist,
};
use friday_hub::workbench_projection::project_workbench;
use friday_protocol::{
    Envelope, IdempotencyTracker, Message, Seen, WorkbenchProjectionSnapshotWire,
};
use friday_storage::Db;
use friday_transport::{ws_recv_envelope, ws_send_envelope, TransportError, WireWebSocket};

/// The session AAD binding every sealed envelope on a READ session to this protocol/version. A
/// fixed, public, non-secret constant. DOMAIN-SEPARATED from the write bin's `SESSION_AAD` (a
/// distinct `:read:` tag) — hygiene: even though the per-handshake key + nonce already prevent any
/// cross-protocol replay, a distinct AAD makes a read frame and a write frame non-interchangeable by
/// construction.
const SESSION_AAD: &[u8] = b"friday:ui-read-seam:ws:s-r1:read-projection-session:aad:v1";

/// The BASE authentication challenge the peer seals (in `auth_proof`) to prove possession of the
/// read session key. Like the write challenge it is NOT the sole binding: the peer seals
/// `AUTH_CHALLENGE || session_nonce` (a fresh per-handshake CSPRNG nonce), and the AAD additionally
/// binds `(principal, request_id)`. Domain-separated from the write challenge (`:read:` tag).
const AUTH_CHALLENGE: &[u8] = b"friday:ui-read-seam:ws:s-r1:read-projection:challenge:v1";

/// Per-connection read timeout: a stalled peer cannot wedge the long-lived accept loop before
/// auth/dispatch. Set on the `TcpStream` BEFORE the cleartext preamble read.
const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// A boot-time failure category. Coarse + safe — the raw detail is NOT surfaced so a storage/init
/// error cannot leak a path or a key. Mirrors the write bin's fail-closed boot vocabulary.
#[derive(Debug)]
enum ServerError {
    BadArgs,
    Bind,
    /// The read-only hub DB could not be opened ⇒ the server refuses to start (no projection
    /// surface). The category only — never the db path.
    DbUnavailable,
    /// The SecureStore peer-pubkey allowlist is MISSING or INVALID ⇒ FAIL CLOSED.
    PeerAllowlist,
    /// More than one enrolled peer pubkey ⇒ refused (single-peer is a code invariant until the
    /// multi-principal bindings land). The count is NOT surfaced.
    MultiPeerUnsupported,
    /// The master key is absent/unreadable ⇒ the server REFUSES TO BOOT (never auto-generated).
    MasterKeyUnavailable,
    /// The persistent FileSecureStore cannot be resolved/opened ⇒ FAIL CLOSED. Never the path.
    StoreUnavailable,
}

fn main() {
    if let Err(err) = run() {
        let kind = match err {
            ServerError::BadArgs => "bad_args",
            ServerError::Bind => "bind_failed",
            ServerError::DbUnavailable => "db_unavailable",
            ServerError::PeerAllowlist => "peer_allowlist_unavailable",
            ServerError::MultiPeerUnsupported => "peer_allowlist_multi_peer_unsupported",
            ServerError::MasterKeyUnavailable => "master_key_unavailable",
            ServerError::StoreUnavailable => "secure_store_unavailable",
        };
        eprintln!("hub_read_projection_server_unavailable: {kind}");
        std::process::exit(2);
    }
}

fn run() -> Result<(), ServerError> {
    let args: Vec<String> = env::args().collect();

    let db_path = arg_value(&args, "--db").ok_or(ServerError::BadArgs)?;
    let port: u16 = arg_value(&args, "--port")
        .map(|p| p.parse::<u16>().map_err(|_| ServerError::BadArgs))
        .transpose()?
        .unwrap_or(0);

    // The Hub OWNER allowlist (v1 = a single configured owner). HUB-SUPPLIED (operator CLI arg),
    // NEVER client-controlled — the ceiling on which forwarded principals may read. Blank/missing ⇒
    // an EMPTY allowlist ⇒ EVERY read is rejected (fail-closed: a server with no owner reads
    // nothing).
    let owner_allowlist: Vec<String> = arg_value(&args, "--owner")
        .map(|o| o.trim().to_string())
        .filter(|o| !o.is_empty())
        .into_iter()
        .collect();

    // (0) S-F PEER AUTH — open the PERSISTENT FileSecureStore the enroll CLI provisioned and load the
    // authorized peer-pubkey allowlist BEFORE anything else, FAILING CLOSED at every step. SAME key
    // source as the write bin (the single source of truth in `key_source`); NO `--peer-pubkey`
    // fallback. An unprovisioned host (no master key, or no/empty/corrupt allowlist) REFUSES TO
    // START. Report only the COUNT — never the pubkey bytes, the master, or the store path.
    let master =
        friday_hub::key_source::read_master_key().map_err(|_| ServerError::MasterKeyUnavailable)?;
    let kek = friday_hub::key_source::derive_file_store_kek(&master);
    drop(master); // `Zeroizing` ⇒ the master is wiped now; only the KEK survives.
    let store_dir: PathBuf = match arg_value(&args, "--store-dir") {
        Some(d) => PathBuf::from(d),
        None => friday_hub::key_source::default_store_dir()
            .map_err(|_| ServerError::StoreUnavailable)?,
    };
    let secure_store =
        FileSecureStore::open(&store_dir, kek).map_err(|_| ServerError::StoreUnavailable)?;
    let peer_allowlist = load_peer_allowlist(&secure_store, PEER_PUBKEY_ALLOWLIST_ID)
        .map_err(|_| ServerError::PeerAllowlist)?;
    enforce_single_peer(&peer_allowlist).map_err(|_| ServerError::MultiPeerUnsupported)?;
    eprintln!(
        "hub_read_projection_server: peer-pubkey allowlist loaded from SecureStore (count={})",
        peer_allowlist.len()
    );
    drop(secure_store); // wipe the KEK; the allowlist is in memory.

    // (1) Open the hub DB READ-ONLY. This is the capability-isolation cornerstone: NO HubRuntime, NO
    // DeepSeekClient, NO `from_env`, NO model-call path — the read server holds no provider
    // credential and can only READ. A read client cannot spend quota or write by construction.
    let db = Db::open_hub_readonly(&db_path).map_err(|_| ServerError::DbUnavailable)?;

    // (2) The server's OWN long-lived keypair (the ONLY `generate()` in non-test code). The peer's
    // public key arrives FROM THE PEER over the wire — never fabricated here.
    let server_kp = DeviceKeypair::generate();

    let listener = ReadWsListener::bind_loopback(port).map_err(|_| ServerError::Bind)?;
    let addr = listener.local_addr().map_err(|_| ServerError::Bind)?;
    eprintln!(
        "hub_read_projection_server: listening (loopback-only) on {addr} — DARK (S-R1: read-projection arm, no LaunchAgent, no production caller)"
    );

    // (3) Long-lived accept loop. Each connection establishes the shared sealed session, then serves
    // refs-only read projections fail-closed.
    loop {
        match listener.accept_one(&server_kp, &db, &owner_allowlist, &peer_allowlist) {
            Ok(_served) => {}
            Err(_e) => continue,
        }
    }
}

/// The loopback-only read WS listener. Owns the socket lifecycle; the session/serve semantics live
/// in [`friday_hub::sealed_ws::establish_session`] / [`serve_read_session`].
struct ReadWsListener {
    listener: TcpListener,
}

impl ReadWsListener {
    /// Bind a **loopback-only** listener on `127.0.0.1:<port>` (`port = 0` lets the OS assign).
    fn bind_loopback(port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        Ok(Self { listener })
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept exactly ONE connection, set the read timeout, establish the shared sealed session
    /// (S-F peer-allowlist + low-order gates first), and serve it fail-closed — dispatching refs-only
    /// read projections. Returns the count of envelopes processed.
    fn accept_one(
        &self,
        server_kp: &DeviceKeypair,
        db: &Db,
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
    ) -> Result<usize, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let (mut ws, session_key, session_nonce) =
            establish_session(stream, server_kp, peer_allowlist)?;
        serve_read_session(&mut ws, &session_key, &session_nonce, db, owner_allowlist)
    }
}

/// Serve sealed read-projection envelopes over ONE established session until the peer disconnects,
/// sends an envelope that fails to open, OR fails auth.
///
/// **S-R1 read arm.** A sealed envelope that opens to [`Message::WorkbenchProjectionRequest`] is the
/// read path:
/// 1. [`AuthedPrincipal::authenticate_forwarded`] verifies the forwarded principal against the
///    session (possession-of-session + per-handshake nonce + owner-allowlist), with the proof bound
///    to the request's `request_id` (the read analog of `run_id`).
/// 2. `Some(caller)` ⇒ run the SHARED `project_workbench` fn (refs-only, guard inside) and return an
///    OWNER-SEALED [`Message::WorkbenchProjectionSnapshot`] — the projection JSON is double-sealed
///    (sealed under the session key BEFORE entering the Message, then the transport seals the
///    envelope again) so the body is released ONLY to the bound owner over this owner-only channel.
/// 3. `None` (forged / empty / non-allowlisted principal, OR an un-openable proof) ⇒ **fail closed**:
///    NO snapshot, END the session.
///
/// A projection that fails (missing mission, non-canonical id, forbidden-marker leak) is surfaced as
/// a typed [`Message::Error`] — never a fabricated success. Anti-replay: a per-session
/// [`IdempotencyTracker`] rejects a replayed `msg_id` fail-closed. An envelope that fails to open
/// ENDS the session.
fn serve_read_session<S: Read + Write>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    session_nonce: &[u8],
    db: &Db,
    owner_allowlist: &[String],
) -> Result<usize, TransportError> {
    let mut processed = 0usize;
    let mut seen_ids = IdempotencyTracker::new();
    loop {
        let env = match ws_recv_envelope(ws, session_key, SESSION_AAD) {
            Ok(e) => e,
            // EOF / disconnect / un-openable seal → END the session. Fail closed.
            Err(_) => return Ok(processed),
        };
        // Reject a REPLAYED msg_id within this session (fail-closed: END the session).
        if let Seen::Replay = seen_ids.observe(&env.msg_id) {
            return Ok(processed);
        }
        match env.message {
            Message::WorkbenchProjectionRequest { request } => {
                // AUTH BEFORE ANY READ. Bind the proof to THIS request's `request_id` (the read
                // analog of `run_id`) + principal. A forged/lifted/stale proof fails closed.
                let caller = decode_sealed_proof(&request.auth_proof).and_then(|proof| {
                    AuthedPrincipal::authenticate_forwarded(
                        session_key,
                        SESSION_AAD,
                        AUTH_CHALLENGE,
                        ForwardedAuth {
                            auth_proof: &proof,
                            session_nonce,
                            bound_context: request.request_id.as_bytes(),
                            forwarded_principal: &request.forwarded_principal,
                        },
                        owner_allowlist,
                    )
                });
                let Some(_caller) = caller else {
                    // FAIL CLOSED: forged / empty / non-allowlisted principal, or un-openable proof.
                    // NO snapshot, END the session — never a partial release. (The projection is
                    // released only to the bound AUTHENTICATED principal, so we simply do not serve
                    // an unauthenticated read.)
                    eprintln!(
                        "hub_read_projection_server_read: request_id={} leg=auth_failed (session ended)",
                        request.request_id
                    );
                    return Ok(processed);
                };

                // AUTHENTICATED. Run the SHARED refs-only projection fn (forbidden-output guard runs
                // INSIDE it). A projection error (missing/non-canonical mission, leak) is surfaced as
                // a typed Error frame — never a fabricated success.
                let now_ms = now_ms();
                let response = match project_workbench(db, request.mission_id.as_deref()) {
                    Ok(snapshot_value) => {
                        // The refs-only projection JSON. `project_workbench` already ran the
                        // forbidden-output guard, so this string is refs-only. Serialize compactly.
                        let projection_json = match serde_json::to_string(&snapshot_value) {
                            Ok(s) => s,
                            Err(_) => {
                                // A serialization failure is a typed unavailable, never a partial.
                                let err = Envelope::new(
                                    format!("read-projection-error-{}", request.request_id),
                                    now_ms,
                                    Message::Error {
                                        code: friday_protocol::ErrorCode::Internal,
                                        message: "projection serialization failed".into(),
                                    },
                                )
                                .with_correlation(env.msg_id.clone());
                                ws_send_envelope(ws, session_key, &err, SESSION_AAD)?;
                                processed += 1;
                                continue;
                            }
                        };
                        // OWNER-SEALED, REFS-ONLY snapshot. Double-seal: seal the refs-only JSON under
                        // the session key BEFORE it enters the Message (so even a future plaintext log
                        // of the carrier never exposes it), then the transport seals the envelope
                        // again. The owner-sealed ciphertext rides `projection_json` as hex. Released
                        // ONLY to the bound owner over this owner-only session.
                        let sealed = seal(session_key, projection_json.as_bytes(), SESSION_AAD)?;
                        let sealed_hex = hex_encode(&encode_sealed(&sealed));
                        eprintln!(
                            "hub_read_projection_server_read: request_id={} leg=snapshot status=delivered",
                            request.request_id
                        );
                        Envelope::new(
                            format!("read-projection-snapshot-{}", request.request_id),
                            now_ms,
                            Message::WorkbenchProjectionSnapshot {
                                snapshot: WorkbenchProjectionSnapshotWire {
                                    request_id: request.request_id.clone(),
                                    projection_json: sealed_hex,
                                    generated_at_ms: now_ms,
                                },
                            },
                        )
                        .with_correlation(env.msg_id.clone())
                    }
                    Err(reason) => {
                        // 503 / stale / missing surfaced AS TRUTH — a typed Error, never a fake-ready
                        // snapshot. The reason is the projection's own coarse string (no body/path).
                        eprintln!(
                            "hub_read_projection_server_read: request_id={} leg=unavailable reason={reason}",
                            request.request_id
                        );
                        Envelope::new(
                            format!("read-projection-error-{}", request.request_id),
                            now_ms,
                            Message::Error {
                                code: friday_protocol::ErrorCode::HubOffline,
                                message: reason,
                            },
                        )
                        .with_correlation(env.msg_id.clone())
                    }
                };
                ws_send_envelope(ws, session_key, &response, SESSION_AAD)?;
                processed += 1;
            }
            // Any other opened envelope is NOT a read projection. The read server has no write/
            // control surface — refuse it with a typed Error (never an echo of an unknown message,
            // never a dispatch). The session continues so a benign keepalive does not drop the link.
            other => {
                let _ = other;
                let err = Envelope::new(
                    env.msg_id.clone(),
                    env.sent_at,
                    Message::Error {
                        code: friday_protocol::ErrorCode::SchemaVersionUnsupported,
                        message: "read server accepts only WorkbenchProjectionRequest".into(),
                    },
                )
                .with_correlation(env.msg_id.clone());
                ws_send_envelope(ws, session_key, &err, SESSION_AAD)?;
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

/// On-wire form for a `friday_crypto::Sealed`: `[nonce_len: u8][nonce][ciphertext]`. The read
/// server's owner-sealed projection body uses the IDENTICAL framing the write bin / TS client speak
/// (kept local here as a thin alias over the shared codec's encode — the shared
/// `encode_sealed_proof` is the same bytes).
fn encode_sealed(s: &friday_crypto::Sealed) -> Vec<u8> {
    friday_hub::sealed_ws::encode_sealed_proof(s)
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

/// Lowercase-hex encode (the owner-sealed projection ciphertext rides a `String` field).
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
    use friday_hub::hub_server::{auth_aad, nonce_bound_challenge};
    use friday_hub::sealed_ws::encode_sealed_proof;
    use friday_protocol::WorkbenchProjectionRequestWire;
    use friday_transport::{read_frame, write_frame, ws_connect};
    use std::net::TcpStream;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;

    static C: AtomicU64 = AtomicU64::new(0);

    const OWNER: &str = "principal:read-owner-allowlisted";

    /// A FIXED non-secret test client secret scalar (small primes). Lets a test compute the client's
    /// pubkey up-front (to put it in the S-F peer allowlist) AND reconstruct the SAME keypair inside
    /// a spawned thread (`DeviceKeypair` is not Clone/Send). TEST FIXTURE, not real key material.
    const CLIENT_SECRET: [u8; 32] = [
        // pragma: allowlist secret
        7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83, 89, 97, 101,
        103, 107, 109, 113, 127, 131, 137, 139, 149,
    ];

    /// Decode the wire `[nonce_len][nonce][ciphertext]` form (the client side of `encode_sealed`).
    fn decode_sealed(wire: &[u8]) -> friday_crypto::Sealed {
        let nlen = wire[0] as usize;
        friday_crypto::Sealed {
            nonce: wire[1..1 + nlen].to_vec(),
            ciphertext: wire[1 + nlen..].to_vec(),
        }
    }

    /// Build a unique temp file path for an isolated test DB.
    fn temp_db_path(tag: &str) -> String {
        std::env::temp_dir()
            .join(format!(
                "friday-read-seam-{}-{}-{}.sqlite",
                std::process::id(),
                tag,
                C.fetch_add(1, Ordering::Relaxed)
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Seed a probe hub DB with one canonical Mission + a route decision + work items, then return
    /// its path. Reuses the SAME storage upserts the bin's `write_mission_workbench_probe_db` proof
    /// uses, but inlined here (the bin test is `#[ignore]`-gated on an env var). The shape mirrors
    /// `project_workbench`'s requirements: a `mission_` id, ≥1 work item, ≥1 route decision.
    fn seed_probe_db(tag: &str) -> String {
        use friday_core::{
            ApprovalState, FridayConversation, HandoffJudgmentMemory, Mission, MissionStatus,
            RouteDecisionCard, TruthStatus, WorkItem, WorkItemStatus, WorkLane,
        };
        let path = temp_db_path(tag);
        let db = Db::open_hub(&path).unwrap();
        let now = 1_780_640_000_000;
        let conversation_id = "fconv_read_seam_probe";
        let mission_id = "mission_read_seam_probe_20260611";
        let work_provider = "work_read_probe_provider";

        db.upsert_friday_conversation(&FridayConversation {
            friday_conversation_id: conversation_id.into(),
            owner_principal: OWNER.into(),
            title: "Read seam probe".into(),
            current_focus_summary: "read-seam workbench round-trip".into(),
            active_mission_ids: vec![mission_id.into()],
            surface_thread_ids: vec![],
            memory_scope_ref: None,
            truth_status: TruthStatus::Proven,
            proof_refs: vec!["proof://mission/read-seam-probe".into()],
            created_at_ms: now,
            updated_at_ms: now,
        })
        .unwrap();
        db.upsert_mission(&Mission {
            mission_id: mission_id.into(),
            friday_conversation_id: conversation_id.into(),
            title: "Prove read-seam workbench projection".into(),
            intent: "round-trip the workbench projection over the sealed read server".into(),
            status: MissionStatus::Active,
            why_now: "the read seam must be proven end-to-end".into(),
            decision_path_summary: "Rust Hub owns the Mission projection; UI reads it.".into(),
            considered_options: vec!["route missing".into(), "live Rust projection".into()],
            deferred_options: vec!["final UI/device evidence".into()],
            known_pitfalls: vec!["provider ack is not completion".into()],
            handoff_inheritance: vec!["keep proof refs redacted".into()],
            work_item_ids: vec![work_provider.into()],
            memory_candidate_refs: vec![],
            context_passport_refs: Vec::new(),
            proof_refs: vec!["proof://mission/read-seam-probe".into()],
            created_at_ms: now,
            updated_at_ms: now + 10,
        })
        .unwrap();
        let provider_item = WorkItem {
            work_item_id: work_provider.into(),
            mission_id: mission_id.into(),
            lane: WorkLane::DeepSeek,
            target_provider_or_agent: Some("deepseek".into()),
            status: WorkItemStatus::ProviderWaiting,
            owner_claim_ids: Vec::new(),
            workspace_refs: Vec::new(),
            capability_id: Some("skill.mission-advisor".into()),
            risk_level: friday_core::Risk::Low,
            approval_state: ApprovalState::Required,
            blocking_reason: Some("provider receipt pending".into()),
            input_refs: vec!["body://redacted/provider-request".into()],
            output_refs: Vec::new(),
            proof_requirements: vec!["provider proof receipt before completion".into()],
            proof_receipts: Vec::new(),
            judgment_memory: HandoffJudgmentMemory {
                task: "Mission-bound provider action".into(),
                current_blocker: None,
                target_lane_thread_agent_provider: "deepseek".into(),
                read_first_files: vec![],
                required_output: "redacted Mission Workbench projection".into(),
                done_criteria: vec!["proof receipt required before done".into()],
                red_lines: vec!["do not leak raw transcripts or ids".into()],
                why_this_route: "The Workbench must consume Rust Hub Mission truth.".into(),
                considered_options: vec!["missing route".into(), "Rust Hub projection".into()],
                deferred_options: vec!["final UI/device capture".into()],
                previous_pitfalls: vec!["provider ack looked like done".into()],
                inheritable_context: vec!["carry proof refs, not raw transcript".into()],
                proof_requirements: vec!["redacted route projection".into()],
                ownership_claim_ids: Vec::new(),
            },
            created_at_ms: now + 4,
            updated_at_ms: now + 5,
        };
        db.upsert_work_item(&provider_item).unwrap();
        db.upsert_route_decision(&RouteDecisionCard::from_work_item(
            "route_read_probe".into(),
            &provider_item,
            vec!["trace://redacted/provider-route".into()],
            now + 8,
            None,
        ))
        .unwrap();
        path
    }

    /// Drive the client half of the handshake (mirrors the write-bin test client + the TS reference
    /// client): raw preamble (client pubkey out → server pubkey in → nonce in) → WS upgrade →
    /// derive the session key. Returns `(ws, session_key, session_nonce)`.
    fn client_handshake(
        addr: SocketAddr,
        client_kp: &DeviceKeypair,
    ) -> (WireWebSocket<TcpStream>, DataKey, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).unwrap();
        write_frame(&mut stream, &client_kp.public_bytes()).unwrap();
        let server_pub_bytes = read_frame(&mut stream).unwrap();
        let server_pub: [u8; 32] = server_pub_bytes.as_slice().try_into().unwrap();
        let session_nonce = read_frame(&mut stream).unwrap();
        let ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let session_key = client_kp.agree(&server_pub);
        (ws, session_key, session_nonce)
    }

    /// Build a valid read `auth_proof` sealed under the client's session view, bound to THIS
    /// handshake's `session_nonce` + `(principal, request_id)` — the read analog of the write peer's
    /// proof. `bound_context = request_id.as_bytes()`.
    fn read_auth_proof(
        client_session: &DataKey,
        session_nonce: &[u8],
        principal: &str,
        request_id: &str,
    ) -> Vec<u8> {
        let challenge = nonce_bound_challenge(AUTH_CHALLENGE, session_nonce);
        let req_aad = auth_aad(SESSION_AAD, principal, request_id.as_bytes());
        let sealed = seal(client_session, &challenge, &req_aad).unwrap();
        encode_sealed_proof(&sealed)
    }

    /// KAT — the workbench projection round-trips through the read server: handshake → owner auth →
    /// owner-sealed refs-only snapshot. The opened body is the refs-only projection JSON, with the
    /// canonical mission id present and NO forbidden marker.
    #[test]
    fn workbench_projection_round_trips_through_the_read_server() {
        let db_path = seed_probe_db("roundtrip");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            listener
                .accept_one(&server_kp, &db, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-roundtrip-1";
        let req = Envelope::new(
            "msg-roundtrip-1",
            1000,
            Message::WorkbenchProjectionRequest {
                request: WorkbenchProjectionRequestWire {
                    mission_id: None,
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, request_id),
                    request_id: request_id.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();

        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::WorkbenchProjectionSnapshot { snapshot } = resp.message else {
            panic!("expected a WorkbenchProjectionSnapshot, got a different/typed-error frame");
        };
        assert_eq!(snapshot.request_id, request_id);
        // The projection JSON is OWNER-SEALED (hex of `[nonce_len][nonce][ciphertext]`). Open it
        // under the session key — only the bound owner can — and assert it is the refs-only
        // projection with the canonical mission id and no forbidden marker.
        let sealed_bytes = hex_decode(&snapshot.projection_json);
        let opened = crypto_open(&session_key, &decode_sealed(&sealed_bytes), SESSION_AAD).unwrap();
        let json = String::from_utf8(opened).unwrap();
        assert!(
            json.contains("mission_read_seam_probe_20260611"),
            "the owner-opened snapshot carries the canonical mission id"
        );
        assert!(json.contains("live_rust_hub_projection"));
        assert!(
            !json.contains("Authorization") && !json.contains("Bearer"),
            "refs-only: no secret markers"
        );
        // The server processed exactly one envelope, then the client drop ends the session.
        drop(ws);
        let processed = server.join().unwrap();
        assert_eq!(processed, 1);
    }

    /// KAT — owner-scoping: a MISMATCHED forwarded principal (well-formed, but NOT in the owner
    /// allowlist) is rejected. The read server serves NO snapshot and ENDS the session — the
    /// projection is released ONLY to the bound authenticated owner, never a client-asserted id.
    #[test]
    fn read_server_rejects_a_mismatched_principal() {
        let db_path = seed_probe_db("ownerscope");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        // The server's owner allowlist contains OWNER — but the client forwards a DIFFERENT,
        // non-allowlisted principal (and seals its proof to that principal, so the proof itself
        // opens; only the allowlist ceiling rejects it).
        let owner_allowlist = vec![OWNER.to_string()];
        let attacker_principal = "principal:not-the-owner";

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            listener
                .accept_one(&server_kp, &db, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-ownerscope-1";
        let req = Envelope::new(
            "msg-ownerscope-1",
            1000,
            Message::WorkbenchProjectionRequest {
                request: WorkbenchProjectionRequestWire {
                    mission_id: None,
                    forwarded_principal: attacker_principal.to_string(),
                    auth_proof: read_auth_proof(
                        &session_key,
                        &session_nonce,
                        attacker_principal,
                        request_id,
                    ),
                    request_id: request_id.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();

        // The session ends fail-closed: NO snapshot frame ever arrives, the recv errors (EOF).
        let got = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD);
        assert!(
            got.is_err(),
            "a mismatched (non-allowlisted) principal must get NO snapshot — the session ends"
        );
        let processed = server.join().unwrap();
        assert_eq!(
            processed, 0,
            "the read server processed nothing for a mismatched principal"
        );
    }

    /// Lowercase-hex decode helper for the test (mirror of the bin's `hex_encode`).
    fn hex_decode(s: &str) -> Vec<u8> {
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() / 2);
        let mut i = 0;
        while i + 1 < bytes.len() {
            let hi = (bytes[i] as char).to_digit(16).unwrap() as u8;
            let lo = (bytes[i + 1] as char).to_digit(16).unwrap() as u8;
            out.push((hi << 4) | lo);
            i += 2;
        }
        out
    }
}
