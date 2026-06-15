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
//!   the write bin. **(S-R3 caveat — honest scope.)** The providers-doctor projection does execute
//!   each provider CLI's OFFICIAL read-only **status** subcommand (`codex login status`,
//!   `claude auth status`) via a [`friday_providers::ProviderProbe`] — never a prompt/send. That is
//!   still NO model call, NO quota spend, NO credential read, and no network beyond the CLI's own
//!   local auth check; it surfaces only booleans + a coarse static `detail`, never raw CLI text.
//! * **Refs-only responses.** Each projection runs the SHARED library fn
//!   ([`friday_hub::workbench_projection::project_workbench`] for S-R1,
//!   [`friday_hub::run_readback_projection::project_run_readback`] for S-R2,
//!   [`friday_hub::providers_doctor_projection::project_providers_doctor`] for S-R3), which runs the
//!   forbidden-output guard INSIDE itself — so the snapshot carries redacted proof refs / counts /
//!   labels / booleans only, never an inline body or raw CLI text. Truth labels ride as-is (provider
//!   lanes conservatively `linked_only`, never upgraded); a `503`/unavailable state is surfaced as a
//!   typed error, never a fabricated success.
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
//! ## Multi-peer read seam (J2) — single-OWNER v1, multi-DEVICE
//! (J2) The read seam admits a NON-EMPTY MULTI-peer pubkey allowlist (boots on the DISTINCT
//! [`friday_hub::key_source::READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID`], enforcing
//! [`friday_hub::sealed_ws::enforce_peer_allowlist_nonempty`], NOT `enforce_single_peer`). This
//! REMOVES the single-peer eviction trap for the READ seam: a desktop master-derived peer AND a
//! distinct mobile device key can BOTH be enrolled and read CONCURRENTLY, with no fresh-key
//! eviction — the per-handshake S-F gate (`peer_is_allowlisted`) checks the presented key against
//! EVERY enrolled key. The live WRITE server is BYTE-UNTOUCHED: it still boots on
//! `PEER_PUBKEY_ALLOWLIST_ID` and still enforces single-peer.
//!
//! ## Single-OWNER v1 (DEFERRED per-PRINCIPAL isolation — see PR body acceptance criteria)
//! Multi-DEVICE is NOT multi-tenant. The owner-allowlist ceiling is the SAME single-configured-owner
//! model the write path uses today: every enrolled read peer/device authenticates as the SAME
//! owner. Per-conversation owner-principal matching (so peer A cannot read peer B's mission even with
//! a valid session) is tied to the write path's own unbuilt FIX-Q2/FIX-Q3b multi-principal bindings
//! (the tamper-evident pubkey→principal binding) and is DEFERRED as an explicit acceptance criterion
//! — NOT silently skipped. Multi-peer here = "more than one DEVICE for the one owner".

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use friday_crypto::{seal, DataKey, DeviceKeypair, FileSecureStore};
use friday_hub::hub_server::{AuthedPrincipal, ForwardedAuth};
use friday_hub::key_source::{READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID, X25519_PUBKEY_LEN};
use friday_hub::providers_doctor_projection::{parse_provider_selection, project_providers_doctor};
use friday_hub::run_readback_projection::{
    project_activity_needs_me, project_run_file_view, project_run_readback,
    project_session_link_state,
};
use friday_hub::sealed_ws::{
    decode_sealed_proof, enforce_peer_allowlist_nonempty, establish_session, load_peer_allowlist,
};
use friday_hub::workbench_projection::project_workbench;
use friday_protocol::{
    ActivityNeedsMeSnapshotWire, Envelope, IdempotencyTracker, Message,
    ProvidersDoctorSnapshotWire, RunFileViewSnapshotWire, RunReadbackSnapshotWire, Seen,
    SessionLinkStateSnapshotWire, SessionListSnapshotWire, SessionOpenSnapshotWire,
    WorkbenchProjectionSnapshotWire,
};
use friday_providers::{CliProbe, ProviderProbe};
use friday_storage::{Db, StorageError};
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
    /// The on-disk hub schema is STRICTLY NEWER than this binary understands ⇒ FAIL CLOSED.
    /// A STALE read server (built from an older commit, lower `hub_code_max()`) must NEVER
    /// serve projections over a forward-migrated DB it would misread — it refuses to boot and
    /// NAMES the version skew (the 13:40-vs-19:04 stale-bin incident, made diagnosable). The
    /// fail-closed behavior already lived in [`Db::open_hub_readonly`]; this distinct variant
    /// surfaces the skew instead of collapsing it into the opaque `db_unavailable`.
    SchemaTooNew {
        disk: i64,
        code: i64,
    },
    /// The SecureStore peer-pubkey allowlist is MISSING, INVALID, or EMPTY ⇒ FAIL CLOSED. (J2: the
    /// read seam admits a NON-EMPTY MULTI-peer list, so there is no longer a multi-peer refusal —
    /// only the missing/empty/corrupt fail-closed remains.)
    PeerAllowlist,
    /// The master key is absent/unreadable ⇒ the server REFUSES TO BOOT (never auto-generated).
    MasterKeyUnavailable,
    /// The persistent FileSecureStore cannot be resolved/opened ⇒ FAIL CLOSED. Never the path.
    StoreUnavailable,
}

fn main() {
    if let Err(err) = run() {
        // NAME the version skew on the schema-too-new fail-closed (the diagnosability fix). The
        // pure `boot_error_kind` mapping is shared with the tests so the surfaced token can never
        // drift from what `main` emits.
        if let ServerError::SchemaTooNew { disk, code } = &err {
            eprintln!(
                "hub_read_projection_server: leg=open error_kind=schema_too_new \
                 disk_version={disk} code_version={code} (stale binary: on-disk schema is \
                 newer than this build understands — rebuild from the deploying commit)"
            );
        }
        eprintln!(
            "hub_read_projection_server_unavailable: {}",
            boot_error_kind(&err)
        );
        std::process::exit(2);
    }
}

/// The coarse, closed-vocabulary `error_kind` token surfaced for each boot failure category.
/// Pure (no I/O) so it is shared by `main` AND the tests — the surfaced token is asserted
/// against the SAME mapping `main` uses, never a duplicate that could drift.
fn boot_error_kind(err: &ServerError) -> &'static str {
    match err {
        ServerError::BadArgs => "bad_args",
        ServerError::Bind => "bind_failed",
        ServerError::DbUnavailable => "db_unavailable",
        ServerError::SchemaTooNew { .. } => "schema_too_new",
        ServerError::PeerAllowlist => "peer_allowlist_unavailable",
        ServerError::MasterKeyUnavailable => "master_key_unavailable",
        ServerError::StoreUnavailable => "secure_store_unavailable",
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
    // (J2) MULTI-PEER read seam: load from the READ-SEAM id (DISTINCT from the live write server's
    // `PEER_PUBKEY_ALLOWLIST_ID`, which is byte-untouched) and enforce only that the allowlist is
    // NON-EMPTY — NOT single-peer. This removes the single-peer eviction trap for the READ seam: a
    // desktop master-derived peer AND a distinct mobile device key can BOTH be enrolled and BOTH
    // read, with no fresh-key eviction (the per-handshake S-F gate checks the presented key against
    // EVERY enrolled key). The write server is unaffected (own id + own single-peer guard).
    let peer_allowlist = load_peer_allowlist(&secure_store, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID)
        .map_err(|_| ServerError::PeerAllowlist)?;
    enforce_peer_allowlist_nonempty(&peer_allowlist).map_err(|_| ServerError::PeerAllowlist)?;
    eprintln!(
        "hub_read_projection_server: peer-pubkey allowlist loaded from SecureStore (count={})",
        peer_allowlist.len()
    );
    drop(secure_store); // wipe the KEK; the allowlist is in memory.

    // (1) Open the hub DB READ-ONLY. This is the capability-isolation cornerstone: NO HubRuntime, NO
    // DeepSeekClient, NO `from_env`, NO model-call path — the read server holds no provider
    // credential and can only READ. A read client cannot spend quota or write by construction.
    let db = open_hub_readonly_guarded(&db_path)?;

    // (1a) The provider-CLI status probe for the S-R3 providers-doctor projection. The REAL probe
    // runs ONLY each CLI's read-only `login/auth status` subcommand (never a prompt/send) — no model
    // call, no quota, no credential read. It holds no DB and no key; it is a pure local-auth checker.
    let probe = CliProbe::default();

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
        match listener.accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist) {
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
        probe: &dyn ProviderProbe,
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
    ) -> Result<usize, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        stream.set_read_timeout(Some(READ_TIMEOUT))?;
        let (mut ws, session_key, session_nonce) =
            establish_session(stream, server_kp, peer_allowlist)?;
        serve_read_session(
            &mut ws,
            &session_key,
            &session_nonce,
            db,
            probe,
            owner_allowlist,
        )
    }
}

/// Serve sealed read-projection envelopes over ONE established session until the peer disconnects,
/// sends an envelope that fails to open, OR fails auth.
///
/// **Read arms (S-R1/S-R2/S-R3 + C2I-PR2).** A sealed envelope that opens to one of the read
/// requests — the original three ([`Message::WorkbenchProjectionRequest`],
/// [`Message::RunReadbackRequest`], [`Message::ProvidersDoctorRequest`]) PLUS the five C2I-PR2
/// owner-gated C2 read-plane ops ([`Message::SessionListRequest`], [`Message::SessionOpenRequest`]
/// (the M-2 sealed-body carve-out), [`Message::SessionLinkStateRequest`],
/// [`Message::RunFileViewRequest`], [`Message::ActivityNeedsMeRequest`]) — takes the IDENTICAL read
/// path, factored into two shared helpers so the arms cannot drift:
/// 1. [`authenticate_read_request`] — [`AuthedPrincipal::authenticate_forwarded`] verifies the
///    forwarded principal against the session (possession-of-session + per-handshake nonce +
///    owner-allowlist), with the proof bound to the request's `request_id` (the read analog of
///    `run_id`). `None` (forged / empty / non-allowlisted principal, OR an un-openable proof) ⇒
///    **fail closed**: NO snapshot, END the session.
/// 2. Authenticated ⇒ run the SHARED projection fn (refs-only, guard inside) and pass its
///    `Result<Value, String>` to [`seal_and_frame`], which OWNER-SEALS the refs-only JSON
///    (double-seal: sealed under the session key BEFORE entering the Message, then the transport
///    seals the envelope again) into the arm's snapshot variant, or surfaces a projection failure as
///    a typed [`Message::Error`] (503 / missing / leak) — never a fabricated success.
///
/// Anti-replay: a per-session [`IdempotencyTracker`] rejects a replayed `msg_id` fail-closed. An
/// envelope that fails to open ENDS the session.
fn serve_read_session<S: Read + Write>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
    session_nonce: &[u8],
    db: &Db,
    probe: &dyn ProviderProbe,
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
        let now_ms = now_ms();
        // Each arm: (1) AUTH BEFORE ANY READ via the shared helper (a `None` ENDS the session), then
        // (2) run the arm's SHARED projection fn and OWNER-SEAL/frame its result via `seal_and_frame`
        // with the arm's snapshot constructor. The auth + seal + typed-Error path is byte-identical
        // across all three arms by construction (the substrate's whole reason for existing).
        let response = match env.message {
            Message::WorkbenchProjectionRequest { request } => {
                // Auth-before-read. The workbench projection has NO per-run owner scope (it gates on
                // `mission_id`), so we only need the pass/fail — the verified principal is not
                // re-applied here. `None` ⇒ fail closed, END the session.
                if authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                )
                .is_none()
                {
                    return Ok(processed);
                }
                let request_id = request.request_id.clone();
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    project_workbench(db, request.mission_id.as_deref()),
                    |sealed_hex| Message::WorkbenchProjectionSnapshot {
                        snapshot: WorkbenchProjectionSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            Message::RunReadbackRequest { request } => {
                // Auth-before-read. The run-readback projection IS per-run owner-scoped (M-3), so we
                // bind the VERIFIED `AuthedPrincipal` and scope the read on it — NEVER the raw wire
                // `forwarded_principal`. `None` ⇒ fail closed, END the session.
                let caller = match authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                ) {
                    Some(caller) => caller,
                    None => return Ok(processed),
                };
                let request_id = request.request_id.clone();
                // M-3 owner gate: `project_run_readback` returns `Ok(None)` when the verified caller
                // is NOT the run's bound owner (or the run is absent/owner-less). Map that `Ok(None)`
                // to the SAME `run_not_found` typed error a non-existent run produced before the
                // gate, so not-owner is INDISTINGUISHABLE from unknown-run on the wire (no oracle)
                // and the prior unknown-run frame is byte-identical in OUTCOME.
                let projection = match project_run_readback(db, caller.principal(), &request.run_id)
                {
                    Ok(Some(value)) => Ok(value),
                    Ok(None) => Err("run_not_found".to_string()),
                    Err(reason) => Err(reason),
                };
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::RunReadbackSnapshot {
                        snapshot: RunReadbackSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            Message::ProvidersDoctorRequest { request } => {
                // Auth-before-read (auth runs BEFORE the provider CLIs are ever probed). The
                // providers-doctor is NOT a per-run/DB read and has no owner scope, so we only need
                // the pass/fail. `None` ⇒ fail closed, END the session.
                if authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                )
                .is_none()
                {
                    return Ok(processed);
                }
                let request_id = request.request_id.clone();
                // The providers-doctor is NOT a DB read — it runs each provider CLI's read-only
                // status command via `probe` (no model call / no quota). Parse the `--probe`
                // selection then project; a bad selection surfaces as a typed Error (never a panic).
                let projection = parse_provider_selection(request.probe.as_deref())
                    .and_then(|providers| project_providers_doctor(probe, &providers));
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::ProvidersDoctorSnapshot {
                        snapshot: ProvidersDoctorSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            // ===== C2I-PR2: the 5 OWNER-GATED C2 read-plane arms ==========================
            // Each rides the IDENTICAL auth-before-read path the RunReadbackRequest arm proved
            // (C2I-PR1): authenticate via the shared helper (a `None` ENDS the session, fail-
            // closed), call the EXISTING owner-scoped accessor with the VERIFIED principal
            // (`caller.principal()`, NEVER the raw wire `forwarded_principal`), then `seal_and_frame`
            // the result. For the 4 resource-keyed ops a per-resource owner denial collapses to the
            // SAME typed `*_not_found` Error a non-existent resource produced — INDISTINGUISHABLE on
            // the wire (no cross-principal existence/state oracle), exactly the M-3 discipline.
            //
            // **C2-4 SessionList** — the OWNER-SCOPED routed-session list. No resource key: a
            // different principal's list is naturally EMPTY, so there is no per-resource gate (the
            // `user_id = ?1` scope IS the gate). An owned-but-empty list is a real `Ok([])` snapshot,
            // not an error. The `SessionListItem`s are refs-only (id + timestamps, never a body).
            Message::SessionListRequest { request } => {
                let caller = match authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                ) {
                    Some(caller) => caller,
                    None => return Ok(processed),
                };
                let request_id = request.request_id.clone();
                // Owner-scoped list (the SAME `friday_storage::list_sessions_for_owner` the
                // HubRuntime accessor wraps). A blank/non-owner principal matches NOTHING.
                let projection =
                    friday_storage::list_sessions_for_owner(db.conn(), caller.principal())
                        .map(|items| {
                            serde_json::json!({
                                "truth_label": "rust_wired_dev",
                                "proof_only": true,
                                "ok": true,
                                "session_count": items.len(),
                                "sessions": items
                                    .iter()
                                    .map(|item| serde_json::json!({
                                        "agent_session_id": item.agent_session_id,
                                        "created_at": item.created_at,
                                        "updated_at": item.updated_at,
                                    }))
                                    .collect::<Vec<_>>(),
                            })
                        })
                        .map_err(|_| "read_failed".to_string());
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::SessionListSnapshot {
                        snapshot: SessionListSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            // **C2-4 / M-2 SessionOpen** — the ONE DELIBERATE BODY-DELIVERY CARVE-OUT. The owner gate
            // is `owner_matches(caller.principal())` (INSIDE `open_session_for_owner` — a non-owner /
            // owner-less / absent session all read back `None`, never a client-asserted user_id). The
            // full transcript bodies are delivered ONLY when the gate passes, and ONLY OWNER-SEALED
            // via `seal_and_frame` (so the body never leaves the process unsealed). We DO NOT run
            // `reject_forbidden_output` on this body — that guard would false-reject legitimate
            // transcript text; the owner gate + the owner-sealing ARE the protection (M-2). A `None`
            // (non-owner / absent / owner-less) collapses to `session_not_found` — INDISTINGUISHABLE,
            // so the verified caller learns nothing about a session it does not own (no body, no
            // existence oracle). An owned-but-empty session is a real `Some(vec![])` snapshot.
            Message::SessionOpenRequest { request } => {
                let caller = match authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                ) {
                    Some(caller) => caller,
                    None => return Ok(processed),
                };
                let request_id = request.request_id.clone();
                let projection = match friday_storage::open_session_for_owner(
                    db.conn(),
                    caller.principal(),
                    &request.agent_session_id,
                ) {
                    // M-2 carve-out: the owner is entitled to the FULL bodies. Serialize the folded
                    // transcript (role/content/refs/seq) — this DOES carry message text, delivered
                    // ONLY here, ONLY to the gated owner, and ONLY sealed by `seal_and_frame`. NO
                    // `reject_forbidden_output` (it would false-reject legit transcript text).
                    Ok(Some(messages)) => Ok(serde_json::json!({
                        "truth_label": "rust_wired_dev",
                        "proof_only": true,
                        "ok": true,
                        "agent_session_id": request.agent_session_id,
                        "message_count": messages.len(),
                        // The DELIBERATE body carve-out: the owner's own transcript bodies.
                        "messages": messages
                            .iter()
                            .map(|m| serde_json::json!({
                                "message_id": m.message_id,
                                "seq": m.seq,
                                "role": m.role,
                                "content": m.content,
                                "refs": m.refs,
                                "created_at": m.created_at,
                            }))
                            .collect::<Vec<_>>(),
                    })),
                    // Fail-closed: a non-owner / owner-less / absent session is INDISTINGUISHABLE.
                    Ok(None) => Err("session_not_found".to_string()),
                    Err(_) => Err("read_failed".to_string()),
                };
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::SessionOpenSnapshot {
                        snapshot: SessionOpenSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            // **C2-8 SessionLinkState** — the refs-only connectivity/staleness label. OWNER-GATED
            // inside `project_session_link_state` (`Ok(None)` for a non-owner / absent / owner-less
            // session). The staleness is derived against the SERVER's own clock (`now_ms`, NOT a
            // client-supplied field — a caller cannot paint their own session fresh). A non-owner
            // `Ok(None)` collapses to `session_not_found` (INDISTINGUISHABLE).
            Message::SessionLinkStateRequest { request } => {
                let caller = match authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                ) {
                    Some(caller) => caller,
                    None => return Ok(processed),
                };
                let request_id = request.request_id.clone();
                let projection = match project_session_link_state(
                    db,
                    caller.principal(),
                    &request.agent_session_id,
                    now_ms,
                ) {
                    Ok(Some(value)) => Ok(value),
                    Ok(None) => Err("session_not_found".to_string()),
                    Err(reason) => Err(reason),
                };
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::SessionLinkStateSnapshot {
                        snapshot: SessionLinkStateSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            // **C2-5 RunFileView** — the refs-only workspace file refs the run's `read_file` receipts
            // recorded. OWNER-GATED inside `project_run_file_view` (the C2-4/D1-Q1
            // `get_run_answer_for_principal` axis; `Ok(None)` for a non-owner / owner-less / absent
            // run). A non-owner `Ok(None)` collapses to `run_not_found` (INDISTINGUISHABLE — the SAME
            // shape the RunReadback arm uses).
            Message::RunFileViewRequest { request } => {
                let caller = match authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                ) {
                    Some(caller) => caller,
                    None => return Ok(processed),
                };
                let request_id = request.request_id.clone();
                let projection =
                    match project_run_file_view(db, caller.principal(), &request.run_id) {
                        Ok(Some(value)) => Ok(value),
                        Ok(None) => Err("run_not_found".to_string()),
                        Err(reason) => Err(reason),
                    };
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::RunFileViewSnapshot {
                        snapshot: RunFileViewSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            // **C2-9 ActivityNeedsMe** — the refs-only Activity / Needs-Me projection for a PAUSED
            // run. OWNER-GATED inside `project_activity_needs_me` (the paused run's pending-row owner
            // via `resolve_run_owner`; `Ok(None)` for a non-owner / not-paused / owner-less run). A
            // non-owner `Ok(None)` collapses to `run_not_found` (INDISTINGUISHABLE).
            Message::ActivityNeedsMeRequest { request } => {
                let caller = match authenticate_read_request(
                    session_key,
                    session_nonce,
                    &request.auth_proof,
                    &request.forwarded_principal,
                    &request.request_id,
                    owner_allowlist,
                ) {
                    Some(caller) => caller,
                    None => return Ok(processed),
                };
                let request_id = request.request_id.clone();
                let projection =
                    match project_activity_needs_me(db, caller.principal(), &request.run_id) {
                        Ok(Some(value)) => Ok(value),
                        Ok(None) => Err("run_not_found".to_string()),
                        Err(reason) => Err(reason),
                    };
                seal_and_frame(
                    session_key,
                    &env.msg_id,
                    &request_id,
                    now_ms,
                    projection,
                    |sealed_hex| Message::ActivityNeedsMeSnapshot {
                        snapshot: ActivityNeedsMeSnapshotWire {
                            request_id: request_id.clone(),
                            projection_json: sealed_hex,
                            generated_at_ms: now_ms,
                        },
                    },
                )?
            }
            // Any other opened envelope is NOT a read projection. The read server has no write/
            // control surface — refuse it with a typed Error (never an echo of an unknown message,
            // never a dispatch). The session continues so a benign keepalive does not drop the link.
            _other => Envelope::new(
                env.msg_id.clone(),
                env.sent_at,
                Message::Error {
                    code: friday_protocol::ErrorCode::SchemaVersionUnsupported,
                    message: "read server accepts only WorkbenchProjectionRequest, \
                              RunReadbackRequest, ProvidersDoctorRequest, SessionListRequest, \
                              SessionOpenRequest, SessionLinkStateRequest, RunFileViewRequest, \
                              or ActivityNeedsMeRequest"
                        .into(),
                },
            )
            .with_correlation(env.msg_id.clone()),
        };
        ws_send_envelope(ws, session_key, &response, SESSION_AAD)?;
        processed += 1;
    }
}

/// Shared AUTH gate for every read arm. Verifies the forwarded principal against the sealed session
/// (possession-of-session + per-handshake nonce + owner-allowlist), with the proof bound to THIS
/// request's `request_id` (the read analog of `run_id`) + principal. Returns
/// `Some(AuthedPrincipal)` iff the caller is the bound AUTHENTICATED owner — the VERIFIED principal
/// minted ONLY from [`AuthedPrincipal::authenticate_forwarded`] (NEVER the raw wire
/// `forwarded_principal` string). Each arm scopes its read on THIS authenticated principal, never on
/// the client-asserted wire string. `None` (forged / empty / non-allowlisted principal, or an
/// un-openable proof) means the caller MUST fail closed and END the session — never a partial
/// release. Factored so the three arms share ONE auth path that cannot drift.
fn authenticate_read_request(
    session_key: &DataKey,
    session_nonce: &[u8],
    auth_proof: &[u8],
    forwarded_principal: &str,
    request_id: &str,
    owner_allowlist: &[String],
) -> Option<AuthedPrincipal> {
    let caller = decode_sealed_proof(auth_proof).and_then(|proof| {
        AuthedPrincipal::authenticate_forwarded(
            session_key,
            SESSION_AAD,
            AUTH_CHALLENGE,
            ForwardedAuth {
                auth_proof: &proof,
                session_nonce,
                bound_context: request_id.as_bytes(),
                forwarded_principal,
            },
            owner_allowlist,
        )
    });
    if caller.is_none() {
        eprintln!(
            "hub_read_projection_server_read: request_id={request_id} leg=auth_failed (session ended)"
        );
    }
    caller
}

/// Shared OWNER-SEAL + framing for every read arm (auth already passed). Takes the arm's projection
/// `Result<Value, String>` and a `build_snapshot` closure that wraps the owner-sealed-hex JSON in
/// the arm's snapshot Message variant:
/// * `Ok(value)` ⇒ serialize the refs-only JSON (guard already ran INSIDE the projection fn),
///   OWNER-SEAL it under the session key (double-seal: the transport seals the envelope again), and
///   frame the arm's snapshot variant — released ONLY to the bound owner over this owner-only
///   session. A serialization failure is a typed `Internal` Error, never a partial.
/// * `Err(reason)` ⇒ a typed `HubOffline` [`Message::Error`] carrying the projection's own coarse
///   string (no body / path) — 503 / stale / missing surfaced AS TRUTH, never a fake-ready snapshot.
fn seal_and_frame(
    session_key: &DataKey,
    correlation_msg_id: &str,
    request_id: &str,
    now_ms: i64,
    projection: Result<serde_json::Value, String>,
    build_snapshot: impl FnOnce(String) -> Message,
) -> Result<Envelope, TransportError> {
    let envelope = match projection {
        Ok(snapshot_value) => match serde_json::to_string(&snapshot_value) {
            Ok(projection_json) => {
                // OWNER-SEALED, REFS-ONLY snapshot. The owner-sealed ciphertext rides
                // `projection_json` as hex. Released ONLY to the bound owner over this session.
                let sealed = seal(session_key, projection_json.as_bytes(), SESSION_AAD)?;
                let sealed_hex = hex_encode(&encode_sealed(&sealed));
                eprintln!(
                    "hub_read_projection_server_read: request_id={request_id} leg=snapshot status=delivered"
                );
                Envelope::new(
                    format!("read-projection-snapshot-{request_id}"),
                    now_ms,
                    build_snapshot(sealed_hex),
                )
                .with_correlation(correlation_msg_id.to_string())
            }
            Err(_) => Envelope::new(
                format!("read-projection-error-{request_id}"),
                now_ms,
                Message::Error {
                    code: friday_protocol::ErrorCode::Internal,
                    message: "projection serialization failed".into(),
                },
            )
            .with_correlation(correlation_msg_id.to_string()),
        },
        Err(reason) => {
            eprintln!(
                "hub_read_projection_server_read: request_id={request_id} leg=unavailable reason={reason}"
            );
            Envelope::new(
                format!("read-projection-error-{request_id}"),
                now_ms,
                Message::Error {
                    code: friday_protocol::ErrorCode::HubOffline,
                    message: reason,
                },
            )
            .with_correlation(correlation_msg_id.to_string())
        }
    };
    Ok(envelope)
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

/// Open the hub DB READ-ONLY, mapping a fail-closed schema-version skew to a DISTINCT,
/// diagnosable [`ServerError::SchemaTooNew`]. [`Db::open_hub_readonly`] already FAILS CLOSED
/// when the on-disk schema is strictly NEWER than this binary understands (`SchemaTooNew` — the
/// always-on guard a STALE read server, built from an older commit with a lower `hub_code_max()`,
/// hits against a forward-migrated DB). The behavior is unchanged — the open still errors and the
/// server refuses to boot/serve — but instead of collapsing it into the generic `db_unavailable`,
/// the skew is surfaced (and NAMED in `main`) so a stale-bin incident is attributable. Every other
/// open error keeps `DbUnavailable`, byte-identical to before.
fn open_hub_readonly_guarded(db_path: &str) -> Result<Db, ServerError> {
    Db::open_hub_readonly(db_path).map_err(|e| match e {
        StorageError::SchemaTooNew { disk, code } => ServerError::SchemaTooNew { disk, code },
        _ => ServerError::DbUnavailable,
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
    use friday_protocol::{
        ProvidersDoctorRequestWire, RunReadbackRequestWire, WorkbenchProjectionRequestWire,
    };
    use friday_providers::{ProbeOutput, Provider, ProviderError};
    use friday_transport::{read_frame, write_frame, ws_connect};
    use std::collections::HashMap;
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

    /// A mock provider probe so the S-R3 round-trip is DETERMINISTIC and never shells out to a real
    /// CLI inside a unit test (matching every other providers test in the workspace). Returns canned
    /// raw CLI status output (or a missing-CLI error) per provider; `detect`/`parse_status` strip the
    /// raw `ProbeOutput` before the projection ever sees a status.
    #[derive(Clone)]
    struct MockProbe {
        out: HashMap<&'static str, Option<String>>,
    }
    impl MockProbe {
        fn new() -> Self {
            Self {
                out: HashMap::new(),
            }
        }
        fn set(mut self, p: Provider, stdout: &str) -> Self {
            self.out.insert(p.as_str(), Some(stdout.to_string()));
            self
        }
    }
    impl ProviderProbe for MockProbe {
        fn status(&self, provider: Provider) -> Result<ProbeOutput, ProviderError> {
            match self.out.get(provider.as_str()) {
                Some(Some(o)) => Ok(ProbeOutput {
                    stdout: o.clone(),
                    stderr: String::new(),
                }),
                _ => Err(ProviderError::NotInstalled("mock".into())),
            }
        }
    }

    /// A probe the non-S-R3 round-trips pass to `accept_one` (they never send a providers-doctor
    /// request, so the probe is never invoked — an empty mock returns `not_installed` if it ever is).
    fn null_probe() -> MockProbe {
        MockProbe::new()
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

    /// Seed a probe hub DB with ONE `agent_run` + an ordered event log (through the WRITE path),
    /// then return its path. The S-R2 run-readback projection reads back this run's
    /// state/loop-status/event-kinds/counts refs-only. The task body is a body that must NEVER leak.
    ///
    /// M-3: the run also records a `run_result` whose `owner_principal == OWNER`, so the
    /// owner-gated [`project_run_readback`] Grants the readback to OWNER (the bound owner the read
    /// server authenticates as). Without a recorded owner the run is owner-less and the gate would
    /// fail-close to `run_not_found`; the providers-doctor round-trips never read the run, so the
    /// owner row is harmless for those callers.
    fn seed_run_db(tag: &str) -> String {
        use friday_storage::agent_run::{create_run, record_event};
        use friday_storage::{persist_run_result, RunResult};
        let path = temp_db_path(tag);
        let db = Db::open_hub(&path).unwrap();
        let now = 1_780_640_000_000;
        create_run(
            db.conn(),
            "run_read_seam_probe",
            "raw run task body that must never leak off-process",
            now,
        )
        .unwrap();
        record_event(
            db.conn(),
            "ev-1",
            "run_read_seam_probe",
            "plan.none",
            now + 1,
        )
        .unwrap();
        record_event(
            db.conn(),
            "ev-2",
            "run_read_seam_probe",
            "tool.executed:read 15 bytes from notes.md",
            now + 2,
        )
        .unwrap();
        record_event(
            db.conn(),
            "ev-3",
            "run_read_seam_probe",
            "agent.finished",
            now + 3,
        )
        .unwrap();
        // M-3: bind OWNER as the run's owner so the owner-gated readback Grants the read server's
        // authenticated owner (the run's answer body is owner-only and never rides the readback).
        persist_run_result(
            db.conn(),
            "run_read_seam_probe",
            &RunResult::new(
                "finished",
                "owner-only run answer body that must never leak",
                None,
            )
            .with_owner_principal(OWNER),
            now + 4,
        )
        .unwrap();
        path
    }

    // ===== C2I-PR2 seeders (real DB, no network) =====================================
    // Each seeds the EXACT rows the corresponding owner-scoped accessor reads — bound to
    // `owner` so a verified caller authenticating AS that principal Grants, and any other
    // principal is fail-closed. The bodies (session transcript text, run answer) are seeded
    // verbatim so the round-trip can assert they (a) reach the gated owner sealed and (b)
    // NEVER appear for a non-owner.

    /// Seed an owned `agent_session` + two folded transcript messages (`user` then
    /// `assistant`), bound to `owner` via `user_id`. The contents are bodies that must reach
    /// ONLY the gated owner, ONLY sealed (the M-2 carve-out). Returns the session id.
    fn seed_owned_session(path: &str, owner: &str, session_id: &str) {
        use friday_storage::agent_session::{
            append_session_message, ensure_session_with_owner, SessionMessage, SessionOwner,
        };
        let db = Db::open_hub(path).unwrap();
        let now = 1_780_640_000_000;
        ensure_session_with_owner(
            db.conn(),
            session_id,
            &SessionOwner {
                user_id: Some(owner.to_string()),
                ..SessionOwner::default()
            },
            now,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            session_id,
            &SessionMessage::new("user", "TRANSCRIPT-BODY-user-says-hello", None),
            now + 1,
        )
        .unwrap();
        append_session_message(
            db.conn(),
            session_id,
            &SessionMessage::new("assistant", "TRANSCRIPT-BODY-assistant-replies", None),
            now + 2,
        )
        .unwrap();
    }

    /// Seed an owned `agent_session` with NO messages (the owned-but-empty edge): a real owned
    /// session that opens to `Some(vec![])`, NOT `session_not_found`.
    fn seed_owned_empty_session(path: &str, owner: &str, session_id: &str) {
        use friday_storage::agent_session::{ensure_session_with_owner, SessionOwner};
        let db = Db::open_hub(path).unwrap();
        ensure_session_with_owner(
            db.conn(),
            session_id,
            &SessionOwner {
                user_id: Some(owner.to_string()),
                ..SessionOwner::default()
            },
            1_780_640_000_000,
        )
        .unwrap();
    }

    /// Seed a session bound to `owner` whose `updated_at` is far in the past, so its link-state
    /// derives to `offline` against any plausible wall clock (the band transitions themselves are
    /// unit-tested in runtime.rs c2_8; this wire KAT only needs round-trip + owner-gating).
    fn seed_owned_stale_session(path: &str, owner: &str, session_id: &str) {
        use friday_storage::agent_session::{ensure_session_with_owner, SessionOwner};
        let db = Db::open_hub(path).unwrap();
        ensure_session_with_owner(
            db.conn(),
            session_id,
            &SessionOwner {
                user_id: Some(owner.to_string()),
                ..SessionOwner::default()
            },
            // A fixed epoch-millis in 2020 — far enough past that `now - updated_at` exceeds the
            // offline threshold under any real wall clock the test runs at.
            1_577_836_800_000,
        )
        .unwrap();
    }

    /// Seed a FINISHED run owned by `owner` (via `run_result.owner_principal`) plus a `read_file`
    /// receipt event (the exact `tool.executed:read {n} bytes from {path}` shape
    /// `list_read_file_refs` parses). The file-view of this run reads back `["notes.md"]` for the
    /// gated owner, `run_not_found` for anyone else.
    fn seed_owned_filed_run(path: &str, owner: &str, run_id: &str) {
        use friday_storage::agent_run::{create_run, record_event};
        use friday_storage::{persist_run_result, RunResult};
        let db = Db::open_hub(path).unwrap();
        let now = 1_780_640_000_000;
        create_run(db.conn(), run_id, "RUN-TASK-BODY-must-never-leak", now).unwrap();
        record_event(
            db.conn(),
            &format!("{run_id}-ev-read"),
            run_id,
            "tool.executed:read 15 bytes from notes.md",
            now + 1,
        )
        .unwrap();
        record_event(
            db.conn(),
            &format!("{run_id}-ev-fin"),
            run_id,
            "agent.finished",
            now + 2,
        )
        .unwrap();
        persist_run_result(
            db.conn(),
            run_id,
            &RunResult::new("finished", "RUN-ANSWER-BODY-must-never-leak", None)
                .with_owner_principal(owner),
            now + 3,
        )
        .unwrap();
    }

    /// Seed a PAUSED run owned by `owner` (the pending approval row's `principal_id`), so
    /// `resolve_run_owner` (the C2-9 owner axis) Grants the gated owner. Returns the approval
    /// nonce the Needs-Me item anchors to.
    fn seed_owned_paused_run(path: &str, owner: &str, run_id: &str) -> String {
        use friday_storage::agent_run::create_run;
        use friday_storage::pending_request::{persist_pending_request, PendingApprovalRequest};
        let db = Db::open_hub(path).unwrap();
        let now = 1_780_640_000_000;
        create_run(
            db.conn(),
            run_id,
            "PAUSED-RUN-TASK-BODY-must-never-leak",
            now,
        )
        .unwrap();
        let nonce = format!("approval-nonce-{run_id}");
        persist_pending_request(
            db.conn(),
            &PendingApprovalRequest {
                approval_id: nonce.clone(),
                run_id: run_id.to_string(),
                action: "write_file".to_string(),
                action_digest: "0".repeat(64),
                principal_id: Some(owner.to_string()),
                surface: "test".to_string(),
                resource_type: None,
                resource_id: None,
                expires_at: now + 1_000_000,
                issuer: friday_core::gate::CANONICAL_GATE_ISSUER.to_string(),
                status: "pending".to_string(),
                created_at: now + 1,
                tool_params: None,
            },
        )
        .unwrap();
        nonce
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
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
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

    /// A SECOND fixed non-secret test client secret scalar, DISTINCT from [`CLIENT_SECRET`] (so it
    /// derives a different X25519 pubkey). Used by the J2 multi-peer KAT to enroll a second peer.
    /// TEST FIXTURE, not real key material.
    const CLIENT_SECRET_B: [u8; 32] = [
        // pragma: allowlist secret
        151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 227, 229, 233, 239, 241,
        251, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25, 27,
    ];

    /// Drive ONE full sealed read round-trip (workbench projection) for the peer built from
    /// `client_secret` against the listener: handshake → owner auth → owner-sealed refs-only
    /// snapshot. The server accepts inline (using a FIXED `server_secret` so each accept derives a
    /// stable key); the client runs in a spawned thread (`DeviceKeypair` is neither Clone nor Send,
    /// so the secret bytes — which ARE Copy — cross the thread boundary and the keypair is rebuilt
    /// inside). Asserts the canonical mission id is in the owner-opened body and exactly ONE
    /// envelope was served. Reused by the J2 multi-peer KAT so each peer's round-trip is identical.
    #[allow(clippy::too_many_arguments)]
    fn one_read_round_trip(
        listener: &ReadWsListener,
        addr: SocketAddr,
        server_secret: [u8; 32],
        client_secret: [u8; 32],
        owner_allowlist: &[String],
        peer_allowlist: &[[u8; X25519_PUBKEY_LEN]],
        db_path: &str,
        request_id: &str,
    ) {
        let req_id = request_id.to_string();
        let client = thread::spawn(move || {
            let client_kp = DeviceKeypair::from_secret_bytes(client_secret);
            let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
            let req = Envelope::new(
                format!("msg-{req_id}"),
                1000,
                Message::WorkbenchProjectionRequest {
                    request: WorkbenchProjectionRequestWire {
                        mission_id: None,
                        forwarded_principal: OWNER.to_string(),
                        auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, &req_id),
                        request_id: req_id.clone(),
                    },
                },
            );
            ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
            let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
            let Message::WorkbenchProjectionSnapshot { snapshot } = resp.message else {
                panic!("expected a WorkbenchProjectionSnapshot");
            };
            assert_eq!(snapshot.request_id, req_id);
            let sealed_bytes = hex_decode(&snapshot.projection_json);
            let opened =
                crypto_open(&session_key, &decode_sealed(&sealed_bytes), SESSION_AAD).unwrap();
            let json = String::from_utf8(opened).unwrap();
            assert!(
                json.contains("mission_read_seam_probe_20260611"),
                "the owner-opened snapshot carries the canonical mission id"
            );
            drop(ws);
        });
        let server_kp = DeviceKeypair::from_secret_bytes(server_secret);
        let db = Db::open_hub_readonly(db_path).unwrap();
        let probe = null_probe();
        let processed = listener
            .accept_one(&server_kp, &db, &probe, owner_allowlist, peer_allowlist)
            .unwrap();
        assert_eq!(processed, 1, "the server served exactly one read envelope");
        client.join().unwrap();
    }

    /// (J2 KAT) MULTI-PEER read seam, NO eviction. TWO distinct real `DeviceKeypair`s are enrolled
    /// under the read-seam allowlist; the server runs `accept_one` THREE times. Peer A completes a
    /// full sealed read round-trip, THEN peer B completes one, THEN peer A AGAIN — proving B did NOT
    /// evict A (the single-peer trap is gone for the read seam). The server uses a FIXED keypair
    /// across the three accepts so each peer derives a stable session key.
    #[test]
    fn read_server_admits_two_distinct_peers_with_no_eviction() {
        let db_path = seed_probe_db("j2-multipeer");
        const SERVER_SECRET: [u8; 32] = [
            // pragma: allowlist secret
            2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 83,
            89, 97, 101, 103, 107, 109, 113, 127, 131,
        ];
        let kp_a = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let kp_b = DeviceKeypair::from_secret_bytes(CLIENT_SECRET_B);
        // The two peers are genuinely DISTINCT (different pubkeys) — a real multi-device allowlist.
        assert_ne!(kp_a.public_bytes(), kp_b.public_bytes());
        let peer_allowlist = vec![kp_a.public_bytes(), kp_b.public_bytes()];
        // The read seam admits this 2-key list (nonempty), where the write seam would refuse it.
        assert!(
            friday_hub::sealed_ws::enforce_peer_allowlist_nonempty(&peer_allowlist).is_ok(),
            "read seam admits a 2-peer allowlist"
        );
        assert!(
            friday_hub::sealed_ws::enforce_single_peer(&peer_allowlist).is_err(),
            "the write seam guard still refuses the SAME 2-peer list (untouched)"
        );
        let owner_allowlist = vec![OWNER.to_string()];

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        // Peer A → Peer B → Peer A again. All three succeed: B did NOT evict A.
        one_read_round_trip(
            &listener,
            addr,
            SERVER_SECRET,
            CLIENT_SECRET,
            &owner_allowlist,
            &peer_allowlist,
            &db_path,
            "j2-A-1",
        );
        one_read_round_trip(
            &listener,
            addr,
            SERVER_SECRET,
            CLIENT_SECRET_B,
            &owner_allowlist,
            &peer_allowlist,
            &db_path,
            "j2-B-1",
        );
        one_read_round_trip(
            &listener,
            addr,
            SERVER_SECRET,
            CLIENT_SECRET,
            &owner_allowlist,
            &peer_allowlist,
            &db_path,
            "j2-A-2-after-B",
        );
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
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
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

    /// KAT (S-R2) — the run-readback projection round-trips through the read server: handshake →
    /// owner auth → owner-sealed refs-only snapshot. The opened body carries the run id /
    /// loop-status / event-kinds / counts + the DB-WIDE token totals (labelled as such, never run
    /// cost), with NO run `task` body and NO forbidden secret marker.
    #[test]
    fn run_readback_projection_round_trips_through_the_read_server() {
        let db_path = seed_run_db("r2-roundtrip");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-r2-roundtrip-1";
        let req = Envelope::new(
            "msg-r2-roundtrip-1",
            1000,
            Message::RunReadbackRequest {
                request: RunReadbackRequestWire {
                    run_id: "run_read_seam_probe".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, request_id),
                    request_id: request_id.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();

        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::RunReadbackSnapshot { snapshot } = resp.message else {
            panic!("expected a RunReadbackSnapshot, got a different/typed-error frame");
        };
        assert_eq!(snapshot.request_id, request_id);
        let sealed_bytes = hex_decode(&snapshot.projection_json);
        let opened = crypto_open(&session_key, &decode_sealed(&sealed_bytes), SESSION_AAD).unwrap();
        let json = String::from_utf8(opened).unwrap();
        assert!(
            json.contains("run_read_seam_probe"),
            "the owner-opened snapshot carries the run id"
        );
        assert!(json.contains("\"loop_status_derived\":\"finished\""));
        assert!(json.contains("event_kinds"));
        // Token totals are labelled DB-WIDE, never as this run's cost.
        assert!(json.contains("db_wide_token_total"));
        // Refs-only: NO run task body, NO secret markers.
        assert!(
            !json.contains("raw run task body"),
            "the run task body must never appear"
        );
        assert!(
            !json.contains("\"task\""),
            "refs-only: the run task field must never appear"
        );
        assert!(
            !json.contains("Authorization") && !json.contains("Bearer") && !json.contains("sk-"),
            "refs-only: no secret markers"
        );
        drop(ws);
        let processed = server.join().unwrap();
        assert_eq!(processed, 1);
    }

    /// KAT (S-R2) — owner-scoping for run-readback: a MISMATCHED forwarded principal (well-formed,
    /// but NOT in the owner allowlist) is rejected. NO snapshot, the session ends — the read is
    /// released ONLY to the bound authenticated owner.
    #[test]
    fn run_readback_read_server_rejects_a_mismatched_principal() {
        let db_path = seed_run_db("r2-ownerscope");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let attacker_principal = "principal:not-the-owner";

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-r2-ownerscope-1";
        let req = Envelope::new(
            "msg-r2-ownerscope-1",
            1000,
            Message::RunReadbackRequest {
                request: RunReadbackRequestWire {
                    run_id: "run_read_seam_probe".to_string(),
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

        let got = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD);
        assert!(
            got.is_err(),
            "a mismatched (non-allowlisted) principal must get NO run-readback snapshot — session ends"
        );
        let processed = server.join().unwrap();
        assert_eq!(processed, 0);
    }

    /// KAT (M-3) — the NEW per-run owner gate at the WIRE level. A VERIFIED, allowlisted caller
    /// (authenticated as OWNER, exactly the proven happy path) requests a run that is owned by a
    /// DIFFERENT principal. Before M-3 this would have read back ANY run by id (the cross-principal
    /// existence/state oracle); now the owner gate collapses it to `Ok(None)`, which the server maps
    /// to a `run_not_found` typed Error — INDISTINGUISHABLE from a non-existent run, so the
    /// authenticated owner learns nothing about a run it does not own (no snapshot, no body, no
    /// state). This is the ONE genuinely new denial: a verified caller reading another principal's
    /// run. The session does NOT end (a benign typed Error keeps the link, unlike a failed auth).
    #[test]
    fn run_readback_read_server_owner_gate_denies_a_run_owned_by_another_principal() {
        use friday_storage::agent_run::{create_run, record_event};
        use friday_storage::{persist_run_result, RunResult};
        // Seed a finished run OWNED BY A DIFFERENT principal (not OWNER, but the read server
        // authenticates the caller as OWNER).
        let db_path = temp_db_path("m3-cross-principal");
        let db = Db::open_hub(&db_path).unwrap();
        let now = 1_780_640_000_000;
        create_run(
            db.conn(),
            "run_owned_by_someone_else",
            "secret task body",
            now,
        )
        .unwrap();
        record_event(
            db.conn(),
            "ev-1",
            "run_owned_by_someone_else",
            "agent.finished",
            now + 1,
        )
        .unwrap();
        persist_run_result(
            db.conn(),
            "run_owned_by_someone_else",
            &RunResult::new("finished", "the other principal's answer", None)
                .with_owner_principal("principal:a-different-owner"),
            now + 2,
        )
        .unwrap();
        drop(db);

        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-m3-cross-principal-1";
        // The caller authenticates as OWNER (the proven happy-path principal) — a VALID, allowlisted
        // forwarded principal that DOES authenticate. Only the M-3 per-run owner gate denies it.
        let req = Envelope::new(
            "msg-m3-cross-principal-1",
            1000,
            Message::RunReadbackRequest {
                request: RunReadbackRequestWire {
                    run_id: "run_owned_by_someone_else".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, request_id),
                    request_id: request_id.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();

        // The authenticated caller gets a typed `run_not_found` Error — NEVER a snapshot of a run it
        // does not own. The link stays open (auth passed; only the per-run gate denied).
        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::Error { code, message } = resp.message else {
            panic!("expected a typed Error for a non-owned run, got a snapshot/other frame");
        };
        assert!(matches!(code, friday_protocol::ErrorCode::HubOffline));
        assert_eq!(
            message, "run_not_found",
            "not-owner must be indistinguishable from unknown-run (no cross-principal oracle)"
        );
        drop(ws);
        let processed = server.join().unwrap();
        assert_eq!(
            processed, 1,
            "the server processed the request, then denied the read"
        );
    }

    /// KAT (S-R3) — the providers-doctor projection round-trips through the read server: handshake →
    /// owner auth → owner-sealed refs-only snapshot. The opened body carries the per-provider
    /// installed/authenticated booleans + `ready_providers` + the conservative `linked_only` truth
    /// label, with NO raw account markers and NO secret marker. The probe is a MOCK so the test is
    /// deterministic and never shells out to a real CLI.
    #[test]
    fn providers_doctor_projection_round_trips_through_the_read_server() {
        let db_path = seed_run_db("r3-roundtrip"); // any DB; the providers projection never reads it
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        // codex logged in, claude logged out — a realistic onboarding state.
        let probe = MockProbe::new()
            .set(Provider::Codex, "Logged in using ChatGPT")
            .set(Provider::Claude, "{\n  \"loggedIn\": false\n}");

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-r3-roundtrip-1";
        let req = Envelope::new(
            "msg-r3-roundtrip-1",
            1000,
            Message::ProvidersDoctorRequest {
                request: ProvidersDoctorRequestWire {
                    probe: Some("both".to_string()),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, request_id),
                    request_id: request_id.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();

        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::ProvidersDoctorSnapshot { snapshot } = resp.message else {
            panic!("expected a ProvidersDoctorSnapshot, got a different/typed-error frame");
        };
        assert_eq!(snapshot.request_id, request_id);
        let sealed_bytes = hex_decode(&snapshot.projection_json);
        let opened = crypto_open(&session_key, &decode_sealed(&sealed_bytes), SESSION_AAD).unwrap();
        let json = String::from_utf8(opened).unwrap();
        assert!(json.contains("\"provider\":\"codex\""));
        assert!(json.contains("\"ready_providers\":[\"codex\"]"));
        // CONSERVATIVE truth label present, never upgraded.
        assert!(json.contains("\"truthLabel\":\"linked_only\""));
        // Refs-only: no raw account fields, no secret markers.
        assert!(
            !json.contains("authMethod")
                && !json.contains("subscriptionType")
                && !json.contains("loggedIn"),
            "refs-only: no raw CLI account fields"
        );
        assert!(
            !json.contains("Authorization") && !json.contains("Bearer") && !json.contains("sk-"),
            "refs-only: no secret markers"
        );
        drop(ws);
        let processed = server.join().unwrap();
        assert_eq!(processed, 1);
    }

    /// KAT (S-R3) — owner-scoping for providers-doctor: a MISMATCHED forwarded principal (well-formed,
    /// but NOT in the owner allowlist) is rejected. NO snapshot, the session ends — and (belt +
    /// suspenders) the provider CLIs are NEVER probed for an unauthenticated reader (the auth gate
    /// runs BEFORE the projection).
    #[test]
    fn providers_doctor_read_server_rejects_a_mismatched_principal() {
        let db_path = seed_run_db("r3-ownerscope");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let attacker_principal = "principal:not-the-owner";
        let probe = MockProbe::new().set(Provider::Codex, "Logged in using ChatGPT");

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let request_id = "req-r3-ownerscope-1";
        let req = Envelope::new(
            "msg-r3-ownerscope-1",
            1000,
            Message::ProvidersDoctorRequest {
                request: ProvidersDoctorRequestWire {
                    probe: Some("both".to_string()),
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

        let got = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD);
        assert!(
            got.is_err(),
            "a mismatched (non-allowlisted) principal must get NO providers-doctor snapshot — session ends"
        );
        let processed = server.join().unwrap();
        assert_eq!(processed, 0);
    }

    // ===== C2I-PR2 KATs — the 5 owner-gated C2 read-plane ops over the read server ============
    //
    // Two distinct fail-closed layers are covered (per op):
    //   (A) AUTH layer — an unverified / non-allowlisted forwarded principal ⇒
    //       `authenticate_read_request` returns None ⇒ the session ENDS, `processed == 0`, NO frame.
    //   (B) OWNER-GATE layer (the 4 resource-keyed ops) — a VERIFIED caller (authenticates fine AS
    //       OWNER) requests a resource owned by a DIFFERENT principal ⇒ a typed `*_not_found` Error,
    //       the link STAYS OPEN (`processed == 1`), NO body.
    // SessionList has no per-resource gate (its scope-to-empty IS the gate), so it has only an
    // (A) test + a happy-path round-trip. The M-2 crux is SessionOpen's (B) test: a verified
    // non-owner gets `session_not_found` and NO transcript byte appears in ANY frame.

    /// The single peer secret every C2I-PR2 KAT enrolls (reusing the proven [`CLIENT_SECRET`]).
    /// Drive ONE C2I-PR2 read request over a fresh sealed session against `db_path`. The closure
    /// builds the request `Message` from the freshly-sealed `auth_proof` (bound to
    /// `forwarded_principal` + `request_id`). Returns `(opened_response, processed)` where
    /// `opened_response` is `None` iff the session ended fail-closed before any frame arrived (the
    /// AUTH-layer denial), else `Some(envelope)` (a snapshot OR a typed Error — the OWNER-GATE
    /// layer / happy path). The OWNER allowlist is fixed to `[OWNER]`.
    fn c2_read_request(
        db_path: &str,
        forwarded_principal: &str,
        request_id: &str,
        build: impl FnOnce(Vec<u8>) -> Message + Send + 'static,
    ) -> (Option<Envelope>, usize) {
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let db_path = db_path.to_string();

        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });

        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let auth_proof = read_auth_proof(
            &session_key,
            &session_nonce,
            forwarded_principal,
            request_id,
        );
        let req = Envelope::new(format!("msg-{request_id}"), 1000, build(auth_proof));
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
        // A snapshot/typed-Error arrives (processed==1) OR the session ends fail-closed (the recv
        // errors with EOF and processed==0 — the AUTH-layer denial).
        let opened = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).ok();
        drop(ws);
        let processed = server.join().unwrap();
        (opened, processed)
    }

    /// Open a snapshot's OWNER-SEALED `projection_json` (hex of `[nonce_len][nonce][ciphertext]`)
    /// under the session key — only the bound owner can — and return the JSON string. Re-derives
    /// the client session key from the FIXED test secrets (the helper above used a fresh server
    /// keypair, so a snapshot test instead asserts on the wire shape + that the body is sealed;
    /// see each test). This thin opener is used by the happy-path tests that retain the key.
    fn open_sealed_projection(session_key: &DataKey, projection_json: &str) -> String {
        let sealed_bytes = hex_decode(projection_json);
        let opened =
            friday_crypto::open(session_key, &decode_sealed(&sealed_bytes), SESSION_AAD).unwrap();
        String::from_utf8(opened).unwrap()
    }

    /// (A-layer, ALL 5) An unverified / non-allowlisted forwarded principal is refused fail-closed
    /// for EVERY one of the 5 ops: NO frame, the session ends, `processed == 0`. This is the auth
    /// gate the 5 arms inherit verbatim from C2I-PR1 — table-driven so a new arm cannot skip it.
    #[test]
    fn c2i_pr2_all_five_ops_reject_an_unverified_principal_fail_closed() {
        let attacker = "principal:not-the-owner";
        // Each op, built against a DB seeded so the resource EXISTS for OWNER — proving the denial
        // is the AUTH gate (attacker not allowlisted), not a missing resource.
        // 1. SessionList
        {
            let db = seed_run_db("a-list");
            let rid = "req-a-list";
            let (resp, processed) = c2_read_request(&db, attacker, rid, |auth_proof| {
                Message::SessionListRequest {
                    request: friday_protocol::SessionListRequestWire {
                        forwarded_principal: attacker.to_string(),
                        auth_proof,
                        request_id: rid.to_string(),
                    },
                }
            });
            assert!(
                resp.is_none() && processed == 0,
                "SessionList: auth-fail ends the session"
            );
        }
        // 2. SessionOpen (M-2)
        {
            let db = seed_run_db("a-open");
            seed_owned_session(&db, OWNER, "sess-a");
            let rid = "req-a-open";
            let (resp, processed) = c2_read_request(&db, attacker, rid, |auth_proof| {
                Message::SessionOpenRequest {
                    request: friday_protocol::SessionOpenRequestWire {
                        agent_session_id: "sess-a".to_string(),
                        forwarded_principal: attacker.to_string(),
                        auth_proof,
                        request_id: rid.to_string(),
                    },
                }
            });
            assert!(
                resp.is_none() && processed == 0,
                "SessionOpen: auth-fail ends the session"
            );
        }
        // 3. SessionLinkState
        {
            let db = seed_run_db("a-link");
            seed_owned_session(&db, OWNER, "sess-a");
            let rid = "req-a-link";
            let (resp, processed) = c2_read_request(&db, attacker, rid, |auth_proof| {
                Message::SessionLinkStateRequest {
                    request: friday_protocol::SessionLinkStateRequestWire {
                        agent_session_id: "sess-a".to_string(),
                        forwarded_principal: attacker.to_string(),
                        auth_proof,
                        request_id: rid.to_string(),
                    },
                }
            });
            assert!(
                resp.is_none() && processed == 0,
                "SessionLinkState: auth-fail ends the session"
            );
        }
        // 4. RunFileView
        {
            let db = seed_run_db("a-fv");
            seed_owned_filed_run(&db, OWNER, "run-a");
            let rid = "req-a-fv";
            let (resp, processed) = c2_read_request(&db, attacker, rid, |auth_proof| {
                Message::RunFileViewRequest {
                    request: friday_protocol::RunFileViewRequestWire {
                        run_id: "run-a".to_string(),
                        forwarded_principal: attacker.to_string(),
                        auth_proof,
                        request_id: rid.to_string(),
                    },
                }
            });
            assert!(
                resp.is_none() && processed == 0,
                "RunFileView: auth-fail ends the session"
            );
        }
        // 5. ActivityNeedsMe
        {
            let db = seed_run_db("a-anm");
            seed_owned_paused_run(&db, OWNER, "run-a");
            let rid = "req-a-anm";
            let (resp, processed) = c2_read_request(&db, attacker, rid, |auth_proof| {
                Message::ActivityNeedsMeRequest {
                    request: friday_protocol::ActivityNeedsMeRequestWire {
                        run_id: "run-a".to_string(),
                        forwarded_principal: attacker.to_string(),
                        auth_proof,
                        request_id: rid.to_string(),
                    },
                }
            });
            assert!(
                resp.is_none() && processed == 0,
                "ActivityNeedsMe: auth-fail ends the session"
            );
        }
    }

    /// (C2-4) SessionList happy path: the gated OWNER reads back their own sessions, OWNER-SEALED
    /// refs-only (id + timestamps, never a body). The full sealed round-trip retains the client key
    /// so the opened body can be asserted.
    #[test]
    fn c2i_pr2_session_list_owner_reads_own_sessions_sealed_refs_only() {
        let db_path = seed_run_db("list-ok");
        seed_owned_session(&db_path, OWNER, "sess-list-1");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });
        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let rid = "req-list-ok";
        let req = Envelope::new(
            "msg-list-ok",
            1000,
            Message::SessionListRequest {
                request: friday_protocol::SessionListRequestWire {
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, rid),
                    request_id: rid.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::SessionListSnapshot { snapshot } = resp.message else {
            panic!("expected a SessionListSnapshot");
        };
        assert_eq!(snapshot.request_id, rid);
        let json = open_sealed_projection(&session_key, &snapshot.projection_json);
        assert!(
            json.contains("sess-list-1"),
            "the owner sees her own session id"
        );
        assert!(json.contains("\"session_count\":1"));
        // Refs-only: no transcript body in the LIST (bodies ride SessionOpen only).
        assert!(
            !json.contains("TRANSCRIPT-BODY"),
            "list is refs-only — no body"
        );
        drop(ws);
        assert_eq!(server.join().unwrap(), 1);
    }

    /// (C2-4 / M-2) SessionOpen happy path — THE CARVE-OUT: the gated OWNER reads back the FULL
    /// transcript bodies, but ONLY OWNER-SEALED. The body is delivered (the deliberate carve-out)
    /// AND it is sealed (open it under the session key to read it).
    #[test]
    fn c2i_pr2_session_open_owner_reads_full_transcript_only_sealed_m2() {
        let db_path = seed_run_db("open-ok");
        seed_owned_session(&db_path, OWNER, "sess-open-1");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });
        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let rid = "req-open-ok";
        let req = Envelope::new(
            "msg-open-ok",
            1000,
            Message::SessionOpenRequest {
                request: friday_protocol::SessionOpenRequestWire {
                    agent_session_id: "sess-open-1".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, rid),
                    request_id: rid.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::SessionOpenSnapshot { snapshot } = resp.message else {
            panic!("expected a SessionOpenSnapshot");
        };
        assert_eq!(snapshot.request_id, rid);
        // M-2: the body NEVER appears unsealed on the wire — the sealed hex must NOT contain the
        // plaintext transcript marker.
        assert!(
            !snapshot.projection_json.contains("TRANSCRIPT-BODY"),
            "the transcript body is SEALED — never plaintext on the wire"
        );
        // The gated OWNER opens it under the session key and DOES get the full bodies (the carve-out).
        let json = open_sealed_projection(&session_key, &snapshot.projection_json);
        assert!(
            json.contains("TRANSCRIPT-BODY-user-says-hello"),
            "owner gets the user body"
        );
        assert!(
            json.contains("TRANSCRIPT-BODY-assistant-replies"),
            "owner gets the assistant body"
        );
        assert!(json.contains("\"message_count\":2"));
        drop(ws);
        assert_eq!(server.join().unwrap(), 1);
    }

    /// (C2-4 / M-2 CRUX) SessionOpen owner-gate: a VERIFIED caller (authenticates AS OWNER) opens a
    /// session owned by a DIFFERENT principal. The owner gate (`owner_matches`) collapses it to
    /// `session_not_found` — INDISTINGUISHABLE from an absent session — and NO transcript byte
    /// appears in ANY frame. The link stays open (auth passed; only the per-resource gate denied).
    #[test]
    fn c2i_pr2_session_open_owner_gate_denies_a_session_owned_by_another_principal_m2() {
        let db_path = seed_run_db("open-cross");
        // The session is owned by SOMEONE ELSE; the caller authenticates as OWNER.
        seed_owned_session(&db_path, "principal:a-different-owner", "sess-other");
        let rid = "req-open-cross";
        let (resp, processed) = c2_read_request(&db_path, OWNER, rid, |auth_proof| {
            Message::SessionOpenRequest {
                request: friday_protocol::SessionOpenRequestWire {
                    agent_session_id: "sess-other".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof,
                    request_id: rid.to_string(),
                },
            }
        });
        assert_eq!(
            processed, 1,
            "auth passed; the per-resource gate denied (link stays open)"
        );
        let resp = resp.expect("a typed Error frame (not a session-end)");
        // Belt + suspenders: serialize the WHOLE frame FIRST — no transcript byte rides it at all.
        let rendered = serde_json::to_string(&resp).unwrap();
        assert!(
            !rendered.contains("TRANSCRIPT-BODY"),
            "M-2: a non-owner gets NO body byte in any frame"
        );
        let Message::Error { code, message } = resp.message else {
            panic!("a verified non-owner must get a typed Error, never a SessionOpenSnapshot");
        };
        assert!(matches!(code, friday_protocol::ErrorCode::HubOffline));
        assert_eq!(
            message, "session_not_found",
            "not-owner is INDISTINGUISHABLE from unknown-session (no oracle)"
        );
    }

    /// (C2-4) SessionOpen owned-but-EMPTY edge: an owned session with no turns opens to a real
    /// (sealed) snapshot with `message_count == 0`, NOT `session_not_found`. Proves the `Some(vec![])`
    /// vs `None` split treats empty as a real owned read.
    #[test]
    fn c2i_pr2_session_open_owned_empty_session_is_a_real_snapshot_not_not_found() {
        let db_path = seed_run_db("open-empty");
        seed_owned_empty_session(&db_path, OWNER, "sess-empty");
        let rid = "req-open-empty";
        let (resp, processed) = c2_read_request(&db_path, OWNER, rid, |auth_proof| {
            Message::SessionOpenRequest {
                request: friday_protocol::SessionOpenRequestWire {
                    agent_session_id: "sess-empty".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof,
                    request_id: rid.to_string(),
                },
            }
        });
        assert_eq!(processed, 1);
        let resp = resp.expect("a snapshot frame");
        let Message::SessionOpenSnapshot { snapshot } = resp.message else {
            panic!("an owned-but-empty session must be a real snapshot, never session_not_found");
        };
        assert_eq!(snapshot.request_id, rid);
        // The sealed body is a real (empty-transcript) snapshot — assert on the wire shape (the
        // fresh-server helper does not retain the key, so we cannot open it here; the open-ok test
        // proves the opening). The presence of the snapshot variant (not an Error) is the assertion.
    }

    /// (C2-8) SessionLinkState owner-gate: a VERIFIED caller opens a link-state for a session owned
    /// by a DIFFERENT principal ⇒ `session_not_found` (INDISTINGUISHABLE), link stays open, no text.
    #[test]
    fn c2i_pr2_link_state_owner_gate_denies_a_session_owned_by_another_principal() {
        let db_path = seed_run_db("link-cross");
        seed_owned_stale_session(&db_path, "principal:a-different-owner", "sess-other");
        let rid = "req-link-cross";
        let (resp, processed) = c2_read_request(&db_path, OWNER, rid, |auth_proof| {
            Message::SessionLinkStateRequest {
                request: friday_protocol::SessionLinkStateRequestWire {
                    agent_session_id: "sess-other".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof,
                    request_id: rid.to_string(),
                },
            }
        });
        assert_eq!(processed, 1);
        let resp = resp.expect("a typed Error frame");
        let Message::Error { message, .. } = resp.message else {
            panic!("a verified non-owner must get a typed Error");
        };
        assert_eq!(
            message, "session_not_found",
            "no cross-principal link-state oracle"
        );
    }

    /// (C2-8) SessionLinkState happy path: the gated OWNER reads back the (sealed) link-state label
    /// for her own session. The far-past `updated_at` derives to `offline`.
    #[test]
    fn c2i_pr2_link_state_owner_reads_own_session_sealed() {
        let db_path = seed_run_db("link-ok");
        seed_owned_stale_session(&db_path, OWNER, "sess-link");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });
        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let rid = "req-link-ok";
        let req = Envelope::new(
            "msg-link-ok",
            1000,
            Message::SessionLinkStateRequest {
                request: friday_protocol::SessionLinkStateRequestWire {
                    agent_session_id: "sess-link".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, rid),
                    request_id: rid.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::SessionLinkStateSnapshot { snapshot } = resp.message else {
            panic!("expected a SessionLinkStateSnapshot");
        };
        let json = open_sealed_projection(&session_key, &snapshot.projection_json);
        assert!(
            json.contains("\"link_state\":\"offline\""),
            "far-past session derives offline"
        );
        assert!(json.contains("sess-link"));
        drop(ws);
        assert_eq!(server.join().unwrap(), 1);
    }

    /// (C2-5) RunFileView owner-gate: a VERIFIED caller reads a file-view for a run owned by a
    /// DIFFERENT principal ⇒ `run_not_found` (INDISTINGUISHABLE), link stays open, no body.
    #[test]
    fn c2i_pr2_file_view_owner_gate_denies_a_run_owned_by_another_principal() {
        let db_path = seed_run_db("fv-cross");
        seed_owned_filed_run(&db_path, "principal:a-different-owner", "run-other");
        let rid = "req-fv-cross";
        let (resp, processed) = c2_read_request(&db_path, OWNER, rid, |auth_proof| {
            Message::RunFileViewRequest {
                request: friday_protocol::RunFileViewRequestWire {
                    run_id: "run-other".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof,
                    request_id: rid.to_string(),
                },
            }
        });
        assert_eq!(processed, 1);
        let resp = resp.expect("a typed Error frame");
        let Message::Error { message, .. } = resp.message else {
            panic!("a verified non-owner must get a typed Error");
        };
        assert_eq!(
            message, "run_not_found",
            "no cross-principal file-view oracle"
        );
    }

    /// (C2-5) RunFileView happy path: the gated OWNER reads back the (sealed) refs-only file-view of
    /// her own run — the `read_file` receipt path ref, never the run task/answer body.
    #[test]
    fn c2i_pr2_file_view_owner_reads_own_run_sealed_refs_only() {
        let db_path = seed_run_db("fv-ok");
        seed_owned_filed_run(&db_path, OWNER, "run-fv");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });
        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let rid = "req-fv-ok";
        let req = Envelope::new(
            "msg-fv-ok",
            1000,
            Message::RunFileViewRequest {
                request: friday_protocol::RunFileViewRequestWire {
                    run_id: "run-fv".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, rid),
                    request_id: rid.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::RunFileViewSnapshot { snapshot } = resp.message else {
            panic!("expected a RunFileViewSnapshot");
        };
        let json = open_sealed_projection(&session_key, &snapshot.projection_json);
        assert!(
            json.contains("notes.md"),
            "the file-view surfaces the read_file receipt ref"
        );
        assert!(json.contains("\"file_view_count\":1"));
        // Refs-only: the run task / answer body never appears.
        assert!(!json.contains("RUN-TASK-BODY"), "no run task body");
        assert!(!json.contains("RUN-ANSWER-BODY"), "no run answer body");
        drop(ws);
        assert_eq!(server.join().unwrap(), 1);
    }

    /// (C2-9) ActivityNeedsMe owner-gate: a VERIFIED caller reads Activity/Needs-Me for a paused run
    /// owned by a DIFFERENT principal ⇒ `run_not_found` (INDISTINGUISHABLE), link stays open.
    #[test]
    fn c2i_pr2_activity_needs_me_owner_gate_denies_a_run_owned_by_another_principal() {
        let db_path = seed_run_db("anm-cross");
        seed_owned_paused_run(&db_path, "principal:a-different-owner", "run-other");
        let rid = "req-anm-cross";
        let (resp, processed) = c2_read_request(&db_path, OWNER, rid, |auth_proof| {
            Message::ActivityNeedsMeRequest {
                request: friday_protocol::ActivityNeedsMeRequestWire {
                    run_id: "run-other".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof,
                    request_id: rid.to_string(),
                },
            }
        });
        assert_eq!(processed, 1);
        let resp = resp.expect("a typed Error frame");
        let Message::Error { message, .. } = resp.message else {
            panic!("a verified non-owner must get a typed Error");
        };
        assert_eq!(
            message, "run_not_found",
            "no cross-principal activity oracle"
        );
    }

    /// (C2-9) ActivityNeedsMe happy path: the gated OWNER reads back the (sealed) Needs-Me item
    /// anchored to the REAL pending-approval nonce of her own paused run.
    #[test]
    fn c2i_pr2_activity_needs_me_owner_reads_own_paused_run_sealed() {
        let db_path = seed_run_db("anm-ok");
        let nonce = seed_owned_paused_run(&db_path, OWNER, "run-anm");
        let server_kp = DeviceKeypair::generate();
        let client_kp = DeviceKeypair::from_secret_bytes(CLIENT_SECRET);
        let peer_allowlist = vec![client_kp.public_bytes()];
        let owner_allowlist = vec![OWNER.to_string()];
        let listener = ReadWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let db = Db::open_hub_readonly(&db_path).unwrap();
            let probe = null_probe();
            listener
                .accept_one(&server_kp, &db, &probe, &owner_allowlist, &peer_allowlist)
                .unwrap()
        });
        let (mut ws, session_key, session_nonce) = client_handshake(addr, &client_kp);
        let rid = "req-anm-ok";
        let req = Envelope::new(
            "msg-anm-ok",
            1000,
            Message::ActivityNeedsMeRequest {
                request: friday_protocol::ActivityNeedsMeRequestWire {
                    run_id: "run-anm".to_string(),
                    forwarded_principal: OWNER.to_string(),
                    auth_proof: read_auth_proof(&session_key, &session_nonce, OWNER, rid),
                    request_id: rid.to_string(),
                },
            },
        );
        ws_send_envelope(&mut ws, &session_key, &req, SESSION_AAD).unwrap();
        let resp = ws_recv_envelope(&mut ws, &session_key, SESSION_AAD).unwrap();
        let Message::ActivityNeedsMeSnapshot { snapshot } = resp.message else {
            panic!("expected an ActivityNeedsMeSnapshot");
        };
        let json = open_sealed_projection(&session_key, &snapshot.projection_json);
        assert!(json.contains("run-anm"), "keyed to the run");
        assert!(
            json.contains(&nonce),
            "the Needs-Me item points at the REAL approval nonce"
        );
        // Refs-only: the paused run task body never appears.
        assert!(!json.contains("PAUSED-RUN-TASK-BODY"), "no run task body");
        drop(ws);
        assert_eq!(server.join().unwrap(), 1);
    }

    /// NORMAL same-commit deploy: a DB at exactly `hub_code_max()` opens read-only and the read
    /// server proceeds — BYTE-IDENTICAL to before the guard (the guard NEVER fires on equal).
    #[test]
    fn equal_schema_version_opens_read_only() {
        let path = temp_db_path("ro-equal");
        drop(Db::open_hub(&path).unwrap());
        let db = open_hub_readonly_guarded(&path).expect("equal version must open read-only");
        assert_eq!(db.version().unwrap(), friday_storage::hub_code_max());
    }

    /// STALE read server vs a forward-migrated DB: the on-disk version is `code_max + 1`, so the
    /// open FAILS CLOSED with `ServerError::SchemaTooNew` (kind `schema_too_new`, NAMING the skew)
    /// — the server never boots and never serves projections it would misread. The fail-closed
    /// behavior already lived in `Db::open_hub_readonly`; this asserts the bin surfaces the skew
    /// instead of the opaque `db_unavailable`.
    #[test]
    fn newer_on_disk_schema_fails_closed_with_named_skew() {
        let path = temp_db_path("ro-too-new");
        {
            let db = Db::open_hub(&path).unwrap();
            db.conn()
                .execute(
                    "UPDATE schema_version SET version = ?1 WHERE id = 1",
                    [friday_storage::hub_code_max() + 1],
                )
                .unwrap();
            drop(db);
        }
        let err = match open_hub_readonly_guarded(&path) {
            Ok(_) => panic!("a stale read server must NOT open a forward-migrated DB"),
            Err(e) => e,
        };
        match err {
            ServerError::SchemaTooNew { disk, code } => {
                assert_eq!(disk, friday_storage::hub_code_max() + 1);
                assert_eq!(code, friday_storage::hub_code_max());
            }
            other => panic!("expected SchemaTooNew naming the skew, got {other:?}"),
        }
        // The surfaced error_kind is the distinct, diagnosable token — asserted against the SAME
        // `boot_error_kind` mapping `main` emits (not a duplicate that could drift): a stale-bin
        // open maps to `schema_too_new`, while every other open error stays `db_unavailable`.
        assert_eq!(
            boot_error_kind(&ServerError::SchemaTooNew { disk: 99, code: 1 }),
            "schema_too_new"
        );
        assert_eq!(
            boot_error_kind(&ServerError::DbUnavailable),
            "db_unavailable"
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
