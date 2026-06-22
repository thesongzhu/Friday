//! PAIR-002 — Hub-side QR pairing message handler.
//!
//! This is the runtime seam that sits behind a local WebSocket/mDNS service:
//! it handles `Message::Pair` against a structured QR payload and writes the
//! trusted-device/audit rows. It deliberately does **not** dispatch model/provider
//! calls; scan/open/status are connection bootstrap, not Ask Friday.

use crate::read_seam_enroll::{
    enroll_read_seam_peer_additive, require_x25519_pubkey, EnrollOutcome,
};
use crate::sealed_ws::is_low_order_x25519;
use friday_core::FridayPairPayload;
use friday_crypto::{DataKey, DeviceKeypair, FileSecureStore};
use friday_protocol::{Envelope, ErrorCode, Message, SUPPORTED};
use friday_storage::Db;
use friday_transport::{
    read_frame, write_frame, ws_accept, ws_recv_envelope, ws_send_envelope, TransportError,
    WireWebSocket,
};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::time::{SystemTime, UNIX_EPOCH};

/// Source of the TRUSTED server wall-clock used to decide pairing EXPIRY.
///
/// The pairing EXPIRY decision MUST NOT trust the client's `sent_at` (it is
/// attacker-controlled — see [`PairingHub::handle_pair`]). It is evaluated against
/// THIS clock, owned by the hub. In prod the clock is [`PairClock::System`] (real
/// UNIX-ms `SystemTime::now()`); tests inject [`PairClock::Fixed`] for determinism.
#[derive(Clone, Copy, Debug)]
pub enum PairClock {
    /// Real server wall-clock (UNIX epoch milliseconds). The prod default.
    System,
    /// A fixed server-now in UNIX ms, for deterministic tests only.
    Fixed(i64),
}

impl PairClock {
    /// The trusted server "now" in UNIX milliseconds. `System` reads the real
    /// wall-clock against the UNIX epoch. A degenerate pre-1970 hub clock (the only
    /// case `duration_since` errors) saturates to `i64::MAX` — fail-CLOSED: every QR
    /// then reads as expired (`expires_at <= i64::MAX`) and pairing is denied, rather
    /// than fail-open (a `0` would make every QR look unexpired).
    pub fn now_ms(&self) -> i64 {
        match self {
            PairClock::System => SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(i64::MAX),
            PairClock::Fixed(now) => *now,
        }
    }
}

/// Minimal Hub pairing runtime. A future listener owns sockets/mDNS; this type
/// owns the pairing semantics and can be tested without network or provider I/O.
#[derive(Clone, Debug)]
pub struct PairingHub {
    payload: FridayPairPayload,
    capabilities: Vec<String>,
    /// The TRUSTED server clock used for the pairing EXPIRY check. Defaults to
    /// [`PairClock::System`] (prod) via [`PairingHub::new`]; tests use
    /// [`PairingHub::new_with_clock`].
    clock: PairClock,
}

impl PairingHub {
    /// Construct a pairing hub that enforces EXPIRY against the real server
    /// wall-clock ([`PairClock::System`]). This is the prod constructor: the bin
    /// and every existing call site keep this signature.
    pub fn new(payload: FridayPairPayload, capabilities: Vec<String>) -> Self {
        Self {
            payload,
            capabilities,
            clock: PairClock::System,
        }
    }

    /// Construct a pairing hub with an injected server clock for deterministic
    /// tests. `now_ms` is the TRUSTED server-now (UNIX ms) the EXPIRY check uses;
    /// it is NOT the client's `sent_at`.
    pub fn new_with_clock(
        payload: FridayPairPayload,
        capabilities: Vec<String>,
        now_ms: i64,
    ) -> Self {
        Self {
            payload,
            capabilities,
            clock: PairClock::Fixed(now_ms),
        }
    }

    /// Status payload shown after QR open/scan. No DB write, no provider call,
    /// no model call.
    pub fn status_envelope(&self, msg_id: impl Into<String>, sent_at: i64) -> Envelope {
        Envelope::new(
            msg_id,
            sent_at,
            Message::HubStatus {
                online: true,
                capabilities: self.capabilities.clone(),
                min_version: SUPPORTED.min,
                max_version: SUPPORTED.max,
            },
        )
    }

    /// Handle a first-slice pairing envelope. Only `Pair` writes trust state.
    /// `AskFridayRequest` is explicitly refused here so a QR/pairing socket cannot
    /// become a hidden model-call path.
    pub fn handle_envelope(&self, db: &mut Db, env: Envelope) -> Envelope {
        match env.message {
            Message::Pair {
                device_id,
                device_pubkey,
                pairing_proof,
            } => self.handle_pair(
                db,
                env.msg_id,
                env.sent_at,
                device_id,
                device_pubkey,
                pairing_proof,
            ),
            Message::HubStatus { .. } => self
                .status_envelope(format!("{}-status", env.msg_id), env.sent_at)
                .with_correlation(env.msg_id),
            Message::AskFridayRequest { .. } => Envelope::new(
                format!("{}-refused", env.msg_id),
                env.sent_at,
                Message::Error {
                    code: ErrorCode::ProviderUnavailable,
                    message: "pairing channel does not dispatch model/provider calls".into(),
                },
            )
            .with_correlation(env.msg_id),
            _ => Envelope::new(
                format!("{}-error", env.msg_id),
                env.sent_at,
                Message::Error {
                    code: ErrorCode::Internal,
                    message: "unsupported pairing-channel message".into(),
                },
            )
            .with_correlation(env.msg_id),
        }
    }

    /// Handle exactly one E2E-sealed WebSocket pairing message and reply with a
    /// sealed response. The socket/listener lifecycle is owned by the caller
    /// (daemon, test, or future mobile bridge); this method binds the proven
    /// transport framing to the pairing semantics.
    pub fn handle_websocket_once<S: Read + Write>(
        &self,
        db: &mut Db,
        ws: &mut WireWebSocket<S>,
        session_key: &DataKey,
        aad: &[u8],
    ) -> Result<Envelope, TransportError> {
        let request = ws_recv_envelope(ws, session_key, aad)?;
        let response = self.handle_envelope(db, request);
        ws_send_envelope(ws, session_key, &response, aad)?;
        Ok(response)
    }

    fn handle_pair(
        &self,
        db: &mut Db,
        msg_id: String,
        sent_at: i64,
        device_id: String,
        device_pubkey: Vec<u8>,
        pairing_proof: Vec<u8>,
    ) -> Envelope {
        // EXPIRY trust: evaluate `expires_at` against the TRUSTED SERVER clock, NEVER the client's
        // `sent_at`. `sent_at` is attacker-controlled (the receive path enforces no freshness/skew
        // on it, and the `pairing_proof` HMAC covers ONLY `device_pubkey`, not the timestamp) — so a
        // backdated `sent_at` must NOT be able to revive an expired QR. We pass the server-now as the
        // `complete_qr_pairing` time arg, so both the `validate_at` expiry check AND the recorded
        // `paired_at`/audit timestamp use the hub's own clock. The reply still echoes the client's
        // `sent_at` for correlation; only the EXPIRY/record decision uses the server clock.
        let server_now = self.clock.now_ms();
        let result = db.complete_qr_pairing(
            &self.payload,
            &device_id,
            &device_pubkey,
            &pairing_proof,
            server_now,
            &format!("audit-pair-{msg_id}"),
        );
        match result {
            Ok(()) => Envelope::new(
                format!("{msg_id}-ack"),
                sent_at,
                Message::PairAck {
                    accepted: true,
                    error_code: None,
                },
            )
            .with_correlation(msg_id),
            Err(_) => Envelope::new(
                format!("{msg_id}-denied"),
                sent_at,
                Message::PairAck {
                    accepted: false,
                    error_code: Some(ErrorCode::PairingDenied),
                },
            )
            .with_correlation(msg_id),
        }
    }
}

/// PAIR-004 — local Hub pairing LISTENER. Binds **loopback only** (`127.0.0.1`) so the QR
/// pairs a phone to THIS Mac's Hub and nothing routable off-box; it never exposes a
/// provider secret. It owns the socket lifecycle; the pairing semantics + trust writes
/// stay in [`PairingHub`]. Challenge-response is enforced downstream by
/// `handle_websocket_once` → `handle_envelope`: only a valid `Pair` proof writes trust,
/// and a pre-auth session/proof/model message is refused with no trust/model rows.
pub struct PairingListener {
    hub: PairingHub,
    listener: TcpListener,
}

impl PairingListener {
    /// Bind a LOOPBACK-only listener on `127.0.0.1:<port>` (`port = 0` lets the OS assign).
    /// Binding `Ipv4Addr::LOCALHOST` (not `0.0.0.0`) is the "this Mac only" guarantee.
    pub fn bind_loopback(hub: PairingHub, port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        Ok(Self { hub, listener })
    }

    /// Build a pairing listener from a socket that the caller already bound.
    ///
    /// The productizing bin uses this to bind first, read the actual OS-assigned
    /// port, and then place that exact endpoint in the QR manifest. Callers that
    /// accept non-loopback sockets must perform their own explicit operator gate
    /// before reaching this constructor.
    pub fn from_tcp_listener(hub: PairingHub, listener: TcpListener) -> Self {
        Self { hub, listener }
    }

    pub fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept exactly ONE connection, run the WebSocket handshake, and handle one sealed
    /// pairing message. The E2E `session_key` is established out of band (pairing
    /// handshake); this binds the listener to the proven pairing semantics. The challenge
    /// (a valid `pairing_proof`) is verified before any trust/session/proof data.
    pub fn accept_one(
        &self,
        db: &mut Db,
        session_key: &DataKey,
        aad: &[u8],
    ) -> Result<Envelope, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        let mut ws = ws_accept(stream)?;
        self.hub
            .handle_websocket_once(db, &mut ws, session_key, aad)
    }

    /// **J1/J2 LIVE accept + read-seam enroll bridge.** Accept exactly ONE connection, derive the
    /// PAIRING session key over the wire ([`establish_pairing_session`] — pre-trust, so it does NOT
    /// allowlist-gate the peer; that would be circular for a first-time pair), handle one sealed
    /// pairing message, and — ON A SUCCESSFUL PAIR ONLY — enroll the paired device's pubkey into the
    /// read-seam allowlist so that device can read (:48751). The `enroll_store` is the read-seam
    /// FileSecureStore (the SAME store the `hub_read_seam_enroll` CLI writes).
    ///
    /// ## The enroll is PROOF-BOUND — fail-closed
    /// The bridge enrolls the device pubkey ONLY when [`PairingHub::handle_envelope`] returns
    /// `PairAck { accepted: true }` for THIS connection's `Pair` message. That ack is returned ONLY
    /// when `db.complete_qr_pairing` returned `Ok(())`, i.e. the `pairing_proof` was a valid
    /// `HMAC(qr_secret, device_pubkey)`, the payload was UNEXPIRED **as judged by the hub's own
    /// TRUSTED SERVER clock** (NOT the client's `sent_at` — `sent_at` is untrusted client input and
    /// is not used for the expiry decision; see [`PairingHub::handle_pair`]), and the device_id was
    /// not a replay (PK conflict) — verified INSIDE `pair_device` over EXACTLY the `device_pubkey`
    /// we then enroll, so there is no TOCTOU. An invalid / replayed / expired / revoked pairing
    /// yields `PairAck { accepted: false }` (or an `Error`) and enrolls NOTHING.
    ///
    /// ## NO eviction, additive only
    /// Enroll goes through the SHARED [`enroll_read_seam_peer_additive`]: APPEND-only + idempotent,
    /// so the existing desktop master peer (and any other enrolled device) is NEVER evicted.
    ///
    /// ## Atomicity (HONEST, NOTED): the `trusted_device` DB txn and the read-seam FileSecureStore
    /// are SEPARATE stores. The enroll runs AFTER `complete_qr_pairing` committed, so a
    /// "trust written, enroll failed" window exists. That is surfaced LOUDLY (the returned
    /// [`PairOutcome::enroll_error`]) so the operator can re-run `hub_read_seam_enroll --pubkey …
    /// --add`; acceptable for this DARK bin. The pairing trust itself is never rolled back.
    ///
    /// Returns the pairing [`Envelope`] response + the enroll outcome (so the bin can report a count,
    /// never a key).
    pub fn accept_one_live(
        &self,
        db: &mut Db,
        enroll_store: &mut FileSecureStore,
        server_kp: &DeviceKeypair,
        aad: &[u8],
    ) -> Result<PairOutcome, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        let (mut ws, session_key) = establish_pairing_session(stream, server_kp)?;

        // Receive the one sealed pairing envelope BEFORE handling, so we can capture the device
        // pubkey to enroll if (and only if) the proof verifies.
        let request = ws_recv_envelope(&mut ws, &session_key, aad)?;
        // Capture the device pubkey from a `Pair` request (the ONLY message that can write trust).
        let pair_pubkey: Option<Vec<u8>> = match &request.message {
            Message::Pair { device_pubkey, .. } => Some(device_pubkey.clone()),
            _ => None,
        };

        let response = self.hub.handle_envelope(db, request);
        ws_send_envelope(&mut ws, &session_key, &response, aad)?;

        // PROOF-BOUND ENROLL: only an `accepted: true` PairAck (⇒ complete_qr_pairing Ok) enrolls,
        // and only the device pubkey the proof was verified over. Anything else enrolls NOTHING.
        let mut enroll_outcome: Option<EnrollOutcome> = None;
        let mut enroll_error: Option<String> = None;
        let accepted = matches!(response.message, Message::PairAck { accepted: true, .. });
        if accepted {
            if let Some(pubkey_bytes) = pair_pubkey {
                match require_x25519_pubkey(&pubkey_bytes)
                    .and_then(|pk| enroll_read_seam_peer_additive(enroll_store, &pk))
                {
                    Ok(outcome) => enroll_outcome = Some(outcome),
                    Err(e) => {
                        // Trust is committed but enroll failed — surface LOUDLY (no key bytes).
                        enroll_error = Some(e.to_string());
                    }
                }
            } else {
                // Defensive: an `accepted: true` ack with no `Pair` device pubkey is not reachable
                // (only a `Pair` yields a true ack), but never enroll without a verified pubkey.
                enroll_error = Some("paired but no device pubkey to enroll (unreachable)".into());
            }
        }

        Ok(PairOutcome {
            response,
            accepted,
            enroll_outcome,
            enroll_error,
        })
    }
}

/// The result of one live pairing accept: the pairing response + the read-seam enroll outcome. No
/// key bytes — only an accepted flag, a peer count (via [`EnrollOutcome`]), and a coarse error string.
#[derive(Debug)]
pub struct PairOutcome {
    /// The sealed pairing response sent to the device (`PairAck` or `Error`).
    pub response: Envelope,
    /// `true` iff the pairing was ACCEPTED (valid proof, unexpired, non-replay).
    pub accepted: bool,
    /// On an accepted pair, the read-seam enroll result (peer count + newly-added). `None` if the
    /// pair was denied (NOTHING enrolled) or the enroll failed (see `enroll_error`).
    pub enroll_outcome: Option<EnrollOutcome>,
    /// A coarse, non-leaking error if the read-seam enroll failed AFTER trust was committed (the
    /// known atomicity window). `None` on success or when nothing was enrolled.
    pub enroll_error: Option<String>,
}

/// **Pairing-specific** sealed-WS handshake — the PRE-TRUST sibling of
/// [`crate::sealed_ws::establish_session`], MINUS the S-F peer-allowlist gate.
///
/// Pairing happens BEFORE the device is enrolled (enrollment is the RESULT of a successful pair), so
/// allowlist-gating the pairing transport would be circular and would reject every first-time pair.
/// The pairing trust gate is the `pairing_proof` (`HMAC(qr_secret, device_pubkey)`) checked at the
/// DB layer — NOT the transport. We still keep the LOW-ORDER check (a non-contributory peer key
/// would yield an all-zero shared secret). The `server_kp` pubkey rides the cleartext preamble (it
/// is the hub key the QR conveyed to the phone), so it is a fresh per-process `generate()`, NOT
/// master-derived. No per-handshake nonce is needed: replay is caught at the DB layer (the
/// `device_id` PK conflict), and the pairing channel dispatches no model/provider call.
pub fn establish_pairing_session<S: Read + Write>(
    mut stream: S,
    server_kp: &DeviceKeypair,
) -> Result<(WireWebSocket<S>, DataKey), TransportError> {
    // (a) Receive the device's X25519 public key (cleartext preamble) — never fabricated here.
    let peer_pub_bytes = read_frame(&mut stream)?;
    let peer_pub: [u8; 32] = peer_pub_bytes
        .as_slice()
        .try_into()
        .map_err(|_| TransportError::Protocol("device pubkey must be 32 bytes".into()))?;

    // (a') HARDENING: reject a non-contributory (known low-order) device key BEFORE deriving the
    // session — such a key would yield an all-zero shared secret a peer never has to "prove". (We do
    // NOT run the S-F allowlist gate: pairing is pre-trust.)
    if is_low_order_x25519(&peer_pub) {
        return Err(TransportError::Protocol(
            "non-contributory (low-order) device key rejected".into(),
        ));
    }

    // (b) Send our OWN public key so the device can derive the same session key, then WS-upgrade and
    // derive the sealed session.
    write_frame(&mut stream, &server_kp.public_bytes())?;
    let ws = ws_accept(stream)?;
    let session_key = server_kp.agree(&peer_pub);
    Ok((ws, session_key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_core::{
        PairAuthority, PairTransportHint, PairTransportKind, CURRENT_PAIR_PAYLOAD_VERSION,
    };
    use friday_crypto::{pairing_proof, DeviceKeypair};
    use friday_protocol::SUPPORTED;
    use friday_storage::StorageError;
    use friday_transport::{
        seal_envelope, ws_accept, ws_connect, ws_recv_envelope, ws_send_envelope,
    };
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    const AAD: &[u8] = b"friday-pairing-ws-v1";

    struct TempDb(PathBuf);

    impl TempDb {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            Self(std::env::temp_dir().join(format!("friday-pair-runtime-{tag}-{nanos}.sqlite")))
        }

        fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn sample_payload(expires_at: i64) -> FridayPairPayload {
        FridayPairPayload::new(
            CURRENT_PAIR_PAYLOAD_VERSION,
            "hub-mac-mini",
            "pair-1",
            "friday-pairing-secret-32-bytes",
            "Jarvis Mac mini",
            vec![PairTransportHint::new(
                PairTransportKind::LanWebSocket,
                "ws://127.0.0.1:4477",
                "LAN WebSocket",
            )
            .unwrap()],
            expires_at,
            vec![PairAuthority::StatusOnly, PairAuthority::Approvals],
        )
        .unwrap()
    }

    #[test]
    fn status_envelope_is_online_and_has_no_side_effects() {
        let tmp = TempDb::new("status");
        let db = Db::open_hub(tmp.path()).unwrap();
        let hub = PairingHub::new(
            sample_payload(2000),
            vec!["pairing".into(), "provider_workspace".into()],
        );

        let env = hub.status_envelope("status-1", 100);
        match env.message {
            Message::HubStatus {
                online,
                capabilities,
                min_version,
                max_version,
            } => {
                assert!(online);
                assert_eq!(capabilities, vec!["pairing", "provider_workspace"]);
                assert_eq!(min_version, SUPPORTED.min);
                assert_eq!(max_version, SUPPORTED.max);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(db.count("trusted_device").unwrap(), 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
    }

    #[test]
    fn pair_message_records_trusted_device_and_no_model_call_rows() {
        let tmp = TempDb::new("pair");
        let mut db = Db::open_hub(tmp.path()).unwrap();
        let payload = sample_payload(2000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        // Server clock = 500 (< expires_at 2000) ⇒ UNEXPIRED by the trusted clock.
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 500);
        let pubkey = vec![7u8; 32];
        let proof = pairing_proof(&secret, &pubkey);

        let env = Envelope::new(
            "pair-msg",
            1000,
            Message::Pair {
                device_id: "ios-1".into(),
                device_pubkey: pubkey,
                pairing_proof: proof,
            },
        );
        let response = hub.handle_envelope(&mut db, env);
        assert_eq!(response.correlation_id.as_deref(), Some("pair-msg"));
        assert_eq!(
            response.message,
            Message::PairAck {
                accepted: true,
                error_code: None
            }
        );
        assert_eq!(db.count("trusted_device").unwrap(), 1);
        assert_eq!(db.count("audit_ledger").unwrap(), 1);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    #[test]
    fn bad_pair_and_ask_on_pairing_channel_do_not_call_model_or_write_trust() {
        let tmp = TempDb::new("bad");
        let mut db = Db::open_hub(tmp.path()).unwrap();
        // Server clock UNEXPIRED (500 < 2000) so the denial is from the BAD PROOF, not expiry.
        let hub = PairingHub::new_with_clock(sample_payload(2000), vec!["pairing".into()], 500);

        let bad_pair = Envelope::new(
            "bad-pair",
            1000,
            Message::Pair {
                device_id: "ios-1".into(),
                device_pubkey: vec![7u8; 32],
                pairing_proof: vec![1, 2, 3],
            },
        );
        let response = hub.handle_envelope(&mut db, bad_pair);
        assert_eq!(
            response.message,
            Message::PairAck {
                accepted: false,
                error_code: Some(ErrorCode::PairingDenied)
            }
        );

        let ask = Envelope::new(
            "ask-hidden",
            1001,
            Message::AskFridayRequest {
                prompt: "do not run".into(),
                mission_context: None,
            },
        );
        let response = hub.handle_envelope(&mut db, ask);
        match response.message {
            Message::Error {
                code: ErrorCode::ProviderUnavailable,
                message,
            } => assert!(message.contains("does not dispatch")),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(db.count("trusted_device").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    #[test]
    fn phone_db_cannot_complete_pair_message() {
        let tmp = TempDb::new("phone");
        let mut db = Db::open_phone(tmp.path()).unwrap();
        let payload = sample_payload(2000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        let hub = PairingHub::new(payload, vec!["pairing".into()]);
        let pubkey = vec![7u8; 32];
        let proof = pairing_proof(&secret, &pubkey);

        let env = Envelope::new(
            "phone-pair",
            1000,
            Message::Pair {
                device_id: "ios-1".into(),
                device_pubkey: pubkey,
                pairing_proof: proof,
            },
        );
        let response = hub.handle_envelope(&mut db, env);
        assert_eq!(
            response.message,
            Message::PairAck {
                accepted: false,
                error_code: Some(ErrorCode::PairingDenied)
            }
        );
        assert!(matches!(
            db.count("trusted_device"),
            Err(StorageError::Unsupported(_))
        ));
    }

    #[test]
    fn websocket_pair_round_trip_over_loopback_writes_trust_no_model_rows() {
        let tmp = TempDb::new("ws-pair");
        let db_path = tmp.path().to_string();
        let payload = sample_payload(2000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        // Server clock UNEXPIRED (500 < 2000).
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 500);
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let mut db = Db::open_hub(&db_path).unwrap();
            let (stream, _) = listener.accept().unwrap();
            let mut ws = ws_accept(stream).unwrap();
            let response = hub
                .handle_websocket_once(&mut db, &mut ws, &session, AAD)
                .unwrap();
            assert_eq!(
                response.message,
                Message::PairAck {
                    accepted: true,
                    error_code: None,
                }
            );
        });

        let session = phone_kp.agree(&hub_pub);
        let pubkey = vec![7u8; 32];
        let proof = pairing_proof(&secret, &pubkey);
        let request = Envelope::new(
            "ws-pair-msg",
            1000,
            Message::Pair {
                device_id: "ios-ws-1".into(),
                device_pubkey: pubkey,
                pairing_proof: proof,
            },
        );
        let wire = seal_envelope(&session, &request, AAD).unwrap();
        assert!(
            !wire.windows(b"ios-ws-1".len()).any(|w| w == b"ios-ws-1"),
            "device id leaked in sealed WebSocket body"
        );
        assert!(
            !wire.windows(secret.len()).any(|w| w == secret.as_slice()),
            "QR secret leaked in sealed WebSocket body"
        );

        let stream = TcpStream::connect(addr).unwrap();
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        ws_send_envelope(&mut ws, &session, &request, AAD).unwrap();
        let response = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
        assert_eq!(response.correlation_id.as_deref(), Some("ws-pair-msg"));
        assert_eq!(
            response.message,
            Message::PairAck {
                accepted: true,
                error_code: None,
            }
        );
        server.join().unwrap();

        let db = Db::open_hub(tmp.path()).unwrap();
        assert_eq!(db.count("trusted_device").unwrap(), 1);
        assert_eq!(db.count("audit_ledger").unwrap(), 1);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    #[test]
    fn websocket_ask_on_pairing_channel_is_refused_no_model_rows() {
        let tmp = TempDb::new("ws-ask");
        let db_path = tmp.path().to_string();
        let hub = PairingHub::new(sample_payload(2000), vec!["pairing".into()]);
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let mut db = Db::open_hub(&db_path).unwrap();
            let (stream, _) = listener.accept().unwrap();
            let mut ws = ws_accept(stream).unwrap();
            let response = hub
                .handle_websocket_once(&mut db, &mut ws, &session, AAD)
                .unwrap();
            match response.message {
                Message::Error {
                    code: ErrorCode::ProviderUnavailable,
                    message,
                } => assert!(message.contains("does not dispatch")),
                other => panic!("unexpected {other:?}"),
            }
        });

        let session = phone_kp.agree(&hub_pub);
        let request = Envelope::new(
            "ws-ask",
            1000,
            Message::AskFridayRequest {
                prompt: "hidden model call must not happen".into(),
                mission_context: None,
            },
        );
        let stream = TcpStream::connect(addr).unwrap();
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        ws_send_envelope(&mut ws, &session, &request, AAD).unwrap();
        let response = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
        assert_eq!(response.correlation_id.as_deref(), Some("ws-ask"));
        match response.message {
            Message::Error {
                code: ErrorCode::ProviderUnavailable,
                ..
            } => {}
            other => panic!("unexpected {other:?}"),
        }
        server.join().unwrap();

        let db = Db::open_hub(tmp.path()).unwrap();
        assert_eq!(db.count("trusted_device").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    // ---- PAIR-004 adverse suite -------------------------------------------------

    /// Build a valid `Pair` message for `payload` + `device`.
    fn pair_msg(payload: &FridayPairPayload, device_id: &str, pubkey: &[u8]) -> Message {
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        Message::Pair {
            device_id: device_id.into(),
            device_pubkey: pubkey.to_vec(),
            pairing_proof: pairing_proof(&secret, pubkey),
        }
    }

    #[test]
    fn expired_pairing_payload_is_denied_and_writes_no_trust() {
        let tmp = TempDb::new("expiry");
        let mut db = Db::open_hub(tmp.path()).unwrap();
        let payload = sample_payload(1000); // expires_at = 1000
        let msg = pair_msg(&payload, "ios-exp", &[7u8; 32]);
        // SERVER clock == expires_at (1000) → expired (validate_at: expires_at <= now). The client's
        // `sent_at` is irrelevant to the expiry decision; here we even backdate it to 0 (a fresh
        // capture) to prove the SERVER clock, not `sent_at`, decides expiry.
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 1000);
        let response = hub.handle_envelope(&mut db, Envelope::new("pair-exp", 0, msg));
        assert_eq!(
            response.message,
            Message::PairAck {
                accepted: false,
                error_code: Some(ErrorCode::PairingDenied),
            }
        );
        assert_eq!(db.count("trusted_device").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
    }

    #[test]
    fn replayed_pairing_is_denied_with_no_double_trust() {
        let tmp = TempDb::new("replay");
        let mut db = Db::open_hub(tmp.path()).unwrap();
        let payload = sample_payload(5000);
        let pubkey = [7u8; 32];
        let first_msg = pair_msg(&payload, "ios-replay", &pubkey);
        let replay_msg = pair_msg(&payload, "ios-replay", &pubkey); // identical proof
                                                                    // Server clock UNEXPIRED (1000 < 5000); the replay is denied by the PK conflict, not expiry.
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 1000);

        let first = hub.handle_envelope(&mut db, Envelope::new("pair-1", 1000, first_msg));
        assert_eq!(
            first.message,
            Message::PairAck {
                accepted: true,
                error_code: None,
            }
        );
        assert_eq!(db.count("trusted_device").unwrap(), 1);

        // Replaying the exact captured Pair must be denied (device_id PK conflict) and
        // must NOT create a second trust row.
        let replay = hub.handle_envelope(&mut db, Envelope::new("pair-2", 1001, replay_msg));
        assert_eq!(
            replay.message,
            Message::PairAck {
                accepted: false,
                error_code: Some(ErrorCode::PairingDenied),
            }
        );
        assert_eq!(db.count("trusted_device").unwrap(), 1);
    }

    #[test]
    fn revoked_device_is_no_longer_trusted() {
        let tmp = TempDb::new("revoke");
        let mut db = Db::open_hub(tmp.path()).unwrap();
        let payload = sample_payload(5000);
        let msg = pair_msg(&payload, "ios-revoke", &[7u8; 32]);
        // Server clock UNEXPIRED (1000 < 5000) so the pair succeeds and can then be revoked.
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 1000);
        hub.handle_envelope(&mut db, Envelope::new("pair-rev", 1000, msg));
        assert!(friday_storage::pairing::is_trusted(db.conn(), "ios-revoke").unwrap());

        friday_storage::pairing::revoke_device(db.conn_mut(), "ios-revoke", 2000, "audit-revoke-1")
            .unwrap();
        assert!(!friday_storage::pairing::is_trusted(db.conn(), "ios-revoke").unwrap());
    }

    #[test]
    fn first_message_before_auth_writes_no_trust_and_leaks_no_session_data() {
        // Before any valid Pair, NO message (status / ask / unsupported) may write trust
        // or return session/proof/transcript data — only challenge-response (a valid
        // Pair) establishes trust.
        let tmp = TempDb::new("preauth");
        let mut db = Db::open_hub(tmp.path()).unwrap();
        let hub = PairingHub::new(sample_payload(5000), vec!["pairing".into()]);

        // (a) Ask before auth → refused, no model/provider call.
        let ask = hub.handle_envelope(
            &mut db,
            Envelope::new(
                "pre-ask",
                1000,
                Message::AskFridayRequest {
                    prompt: "leak my history".into(),
                    mission_context: None,
                },
            ),
        );
        assert!(matches!(ask.message, Message::Error { .. }));

        // (b) An unsupported pairing-channel message before auth → Error, not data.
        let unsupported = hub.handle_envelope(
            &mut db,
            Envelope::new(
                "pre-unsupported",
                1000,
                Message::PairAck {
                    accepted: true,
                    error_code: None,
                },
            ),
        );
        assert!(matches!(unsupported.message, Message::Error { .. }));

        // (c) Status before auth is bootstrap-only: online + capabilities, NEVER a
        // session/proof/transcript payload.
        let status = hub.handle_envelope(&mut db, hub.status_envelope("pre-status", 1000));
        assert!(matches!(status.message, Message::HubStatus { .. }));

        // No pre-auth message wrote trust or any side-effect row.
        assert_eq!(db.count("trusted_device").unwrap(), 0);
        assert_eq!(db.count("audit_ledger").unwrap(), 0);
        assert_eq!(db.count("token_ledger").unwrap(), 0);
        assert_eq!(db.count("activity_item").unwrap(), 0);
    }

    #[test]
    fn pairing_listener_binds_loopback_and_accepts_one_pair() {
        let tmp = TempDb::new("listener");
        let db_path = tmp.path().to_string();
        let payload = sample_payload(5000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        // Server clock UNEXPIRED (1000 < 5000).
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 1000);
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = PairingListener::bind_loopback(hub, 0).unwrap();
        let addr = listener.local_addr().unwrap();
        assert!(
            addr.ip().is_loopback(),
            "pairing listener must bind loopback only (this Mac)"
        );

        let server = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let mut db = Db::open_hub(&db_path).unwrap();
            listener.accept_one(&mut db, &session, AAD).unwrap()
        });

        let session = phone_kp.agree(&hub_pub);
        // The proof is over the SAME pairing secret the hub holds (captured before the
        // payload moved into the hub).
        let pubkey = vec![7u8; 32];
        let request = Envelope::new(
            "listener-pair",
            1000,
            Message::Pair {
                device_id: "ios-listener".into(),
                device_pubkey: pubkey.clone(),
                pairing_proof: pairing_proof(&secret, &pubkey),
            },
        );

        let stream = TcpStream::connect(addr).unwrap();
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        ws_send_envelope(&mut ws, &session, &request, AAD).unwrap();
        let client_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
        let server_resp = server.join().unwrap();

        assert_eq!(
            server_resp.message,
            Message::PairAck {
                accepted: true,
                error_code: None,
            }
        );
        assert_eq!(
            client_resp.message,
            Message::PairAck {
                accepted: true,
                error_code: None,
            }
        );
        let db = Db::open_hub(tmp.path()).unwrap();
        assert_eq!(db.count("trusted_device").unwrap(), 1);
    }

    // ===== J1/J2 LIVE pairing → read-seam enroll bridge (accept_one_live) =========================
    // These drive the SAME wire path a real device uses: the pairing preamble (device pubkey →
    // low-order check → hub pubkey → ws_accept → agree), then a sealed `Pair`. On a VALID pair the
    // device pubkey is enrolled into the read-seam allowlist; an invalid/expired/replayed pair
    // enrolls NOTHING; existing peers are not evicted; the WRITE seam is untouched.

    use crate::key_source::{
        derive_file_store_kek, PEER_PUBKEY_ALLOWLIST_ID, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID,
        X25519_PUBKEY_LEN,
    };
    use crate::read_seam_enroll::enroll_read_seam_peer_additive;
    use crate::sealed_ws::{
        enforce_peer_allowlist_nonempty, enforce_single_peer, load_peer_allowlist,
        peer_is_allowlisted, PeerAllowlistError,
    };
    use friday_crypto::FileSecureStore;

    /// A read-seam store dir under a fixed test master KEK, isolated per test.
    struct TempStore {
        dir: PathBuf,
    }
    impl TempStore {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("friday-pair-enroll-{tag}-{nanos}"));
            std::fs::create_dir_all(&dir).unwrap();
            Self { dir }
        }
        fn open(&self) -> FileSecureStore {
            FileSecureStore::open(&self.dir, derive_file_store_kek(&[0x42u8; 32])).unwrap()
        }
    }
    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Drive ONE live pairing connection end-to-end and return the server's `PairOutcome`. The
    /// device uses `device_kp`'s REAL X25519 pubkey as its `Message::Pair` device_pubkey (so the
    /// enrolled key is the SAME key the device would present at the read seam). The server pre-seeds
    /// `seed_peers` into the read-seam allowlist (to prove no-eviction). `server_now_ms` is the
    /// TRUSTED server clock the EXPIRY check uses; `sent_at` is the (untrusted) client timestamp on
    /// the wire — deliberately DECOUPLED so a test can backdate `sent_at` while the server clock is
    /// past expiry. Returns (outcome, store_dir, device_pub) for post-assertions.
    #[allow(clippy::too_many_arguments)]
    fn run_live_pair(
        tag: &str,
        payload: FridayPairPayload,
        device_kp: &DeviceKeypair,
        device_id: &str,
        proof: Vec<u8>,
        sent_at: i64,
        server_now_ms: i64,
        seed_peers: &[[u8; X25519_PUBKEY_LEN]],
    ) -> (PairOutcome, TempStore, [u8; X25519_PUBKEY_LEN]) {
        let tmp = TempDb::new(tag);
        let db_path = tmp.path().to_string();
        let store = TempStore::new(tag);

        // Pre-seed any existing read-seam peers (e.g. the desktop master peer) to prove no-eviction.
        {
            let mut s = store.open();
            for pk in seed_peers {
                enroll_read_seam_peer_additive(&mut s, pk).unwrap();
            }
        }

        let device_pub = device_kp.public_bytes();
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], server_now_ms);
        let server_kp = DeviceKeypair::generate();
        let server_pub = server_kp.public_bytes();
        let listener = PairingListener::bind_loopback(hub, 0).unwrap();
        let addr = listener.local_addr().unwrap();

        let store_dir = store.dir.clone();
        let server = thread::spawn(move || {
            let mut db = Db::open_hub(&db_path).unwrap();
            let mut enroll_store =
                FileSecureStore::open(&store_dir, derive_file_store_kek(&[0x42u8; 32])).unwrap();
            listener
                .accept_one_live(&mut db, &mut enroll_store, &server_kp, AAD)
                .unwrap()
        });

        // Client side mirrors `establish_pairing_session`: send device pubkey preamble, read hub
        // pubkey, ws_connect, derive session, send sealed Pair, read the response.
        let mut stream = TcpStream::connect(addr).unwrap();
        write_frame(&mut stream, &device_pub).unwrap();
        let got_hub_pub = read_frame(&mut stream).unwrap();
        assert_eq!(
            got_hub_pub.as_slice(),
            &server_pub[..],
            "hub pubkey rides the preamble"
        );
        let session = device_kp.agree(&server_pub);
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let request = Envelope::new(
            "live-pair",
            sent_at,
            Message::Pair {
                device_id: device_id.into(),
                device_pubkey: device_pub.to_vec(),
                pairing_proof: proof,
            },
        );
        ws_send_envelope(&mut ws, &session, &request, AAD).unwrap();
        let _client_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
        let outcome = server.join().unwrap();
        (outcome, store, device_pub)
    }

    #[test]
    fn live_valid_pair_enrolls_device_into_read_seam_no_eviction() {
        let payload = sample_payload(5000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        let device_kp = DeviceKeypair::generate();
        let device_pub = device_kp.public_bytes();
        let proof = pairing_proof(&secret, &device_pub);
        // Pre-seed the desktop master peer so we can prove it SURVIVES.
        let master_peer = [0xAAu8; X25519_PUBKEY_LEN];

        let (outcome, store, enrolled) = run_live_pair(
            "valid",
            payload,
            &device_kp,
            "ios-live",
            proof,
            1000, // client sent_at
            1000, // trusted server now (< expires_at 5000 ⇒ UNEXPIRED)
            &[master_peer],
        );

        assert!(outcome.accepted, "valid pair accepted");
        assert_eq!(outcome.enroll_error, None, "no enroll error");
        let o = outcome.enroll_outcome.expect("enrolled");
        assert!(o.newly_added);
        assert_eq!(o.total_peers, 2, "master peer + new device");

        // The read server ADMITS the device (and the master peer SURVIVES — no eviction).
        let store2 = store.open();
        let allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(allow.len(), 2);
        assert!(enforce_peer_allowlist_nonempty(&allow).is_ok());
        assert!(
            peer_is_allowlisted(&allow, &enrolled),
            "device can now read"
        );
        assert!(
            peer_is_allowlisted(&allow, &master_peer),
            "master peer NOT evicted"
        );
    }

    #[test]
    fn live_expired_pair_enrolls_nothing_and_does_not_evict() {
        // expires_at = 1000; trusted server now = 1000 → expired (validate_at: expires_at <= now).
        let payload = sample_payload(1000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        let device_kp = DeviceKeypair::generate();
        let device_pub = device_kp.public_bytes();
        let proof = pairing_proof(&secret, &device_pub);
        let master_peer = [0xAAu8; X25519_PUBKEY_LEN];

        let (outcome, store, device) = run_live_pair(
            "expired",
            payload,
            &device_kp,
            "ios-exp",
            proof,
            1000, // client sent_at
            1000, // trusted server now == expires_at ⇒ EXPIRED
            &[master_peer],
        );

        assert!(!outcome.accepted, "expired pair DENIED");
        assert!(outcome.enroll_outcome.is_none(), "nothing enrolled");
        // The allowlist BYTES are unchanged: ONLY the pre-seeded master peer remains, the device is
        // NOT present (the real no-enroll-on-failure proof, not just a denied ack).
        let store2 = store.open();
        let allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(allow.len(), 1, "still just the master peer");
        assert!(peer_is_allowlisted(&allow, &master_peer));
        assert!(
            !peer_is_allowlisted(&allow, &device),
            "expired device NOT enrolled"
        );
    }

    #[test]
    fn live_expired_pair_with_backdated_client_sent_at_enrolls_nothing() {
        // THE EXPLOIT THIS PR CLOSES (BLOCKER): an attacker who captured a `qr_secret` + `expires_at`
        // sends a Pair with a BACKDATED client `sent_at` (here 0) to try to slip an EXPIRED QR past
        // the freshness check. Expiry MUST be judged by the TRUSTED SERVER clock — NOT `sent_at` —
        // so the long-expired QR enrolls NOTHING even though `sent_at` is well before `expires_at`.
        //
        // expires_at = 1000; client sent_at = 0 (backdated, attacker-controlled); trusted server
        // now = 2000 (well PAST expiry). Pre-fix this enrolled the device (sent_at=0 passed the
        // check); post-fix the server clock denies it.
        let payload = sample_payload(1000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        let device_kp = DeviceKeypair::generate();
        let device_pub = device_kp.public_bytes();
        let proof = pairing_proof(&secret, &device_pub); // a VALID HMAC proof over the device pubkey
        let master_peer = [0xAAu8; X25519_PUBKEY_LEN];

        let (outcome, store, device) = run_live_pair(
            "expired-backdated",
            payload,
            &device_kp,
            "ios-exp-backdated",
            proof,
            0,    // BACKDATED client sent_at — attacker-controlled, must carry NO authority
            2000, // trusted server now (> expires_at 1000) ⇒ EXPIRED by the server clock
            &[master_peer],
        );

        // The ack is DENIED and NOTHING is enrolled — the read-seam allowlist BYTES are unchanged.
        assert!(
            !outcome.accepted,
            "expired QR with backdated sent_at MUST be denied by the SERVER clock"
        );
        assert!(outcome.enroll_outcome.is_none(), "nothing enrolled");
        let store2 = store.open();
        let allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(
            allow.len(),
            1,
            "still just the pre-seeded master peer (unchanged)"
        );
        assert!(peer_is_allowlisted(&allow, &master_peer));
        assert!(
            !peer_is_allowlisted(&allow, &device),
            "expired-by-server-clock device NOT enrolled despite backdated sent_at"
        );
    }

    #[test]
    fn live_invalid_proof_pair_enrolls_nothing() {
        let payload = sample_payload(5000);
        let device_kp = DeviceKeypair::generate();
        // A bogus proof (not HMAC(secret, pubkey)) ⇒ pair_device returns PairingDenied.
        let bad_proof = vec![1u8, 2, 3, 4];

        let (outcome, store, _device) = run_live_pair(
            "badproof",
            payload,
            &device_kp,
            "ios-bad",
            bad_proof,
            1000, // client sent_at
            1000, // trusted server now (< expires_at 5000 ⇒ UNEXPIRED; denial is from the bad proof)
            &[],
        );

        assert!(!outcome.accepted, "invalid proof DENIED");
        assert!(outcome.enroll_outcome.is_none());
        // No peer pre-seeded and none enrolled ⇒ the allowlist entry is MISSING (fail-closed), which
        // is exactly the read server's never-provisioned state.
        let store2 = store.open();
        assert_eq!(
            load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Missing),
            "invalid pair enrolled nothing"
        );
    }

    #[test]
    fn live_replayed_pair_enrolls_only_once() {
        // First pair (valid) enrolls; the EXACT replay (same device_id) is denied at the DB layer
        // (PK conflict) and enrolls NOTHING the second time — the allowlist stays at exactly 1 peer.
        let device_kp = DeviceKeypair::generate();
        let device_pub = device_kp.public_bytes();

        let payload1 = sample_payload(5000);
        let secret = payload1.pairing_secret.expose_for_qr().as_bytes().to_vec();
        let proof = pairing_proof(&secret, &device_pub);

        // Reuse ONE db + ONE store across two connections to model a true replay.
        let tmp = TempDb::new("replay-live");
        let db_path = tmp.path().to_string();
        let store = TempStore::new("replay-live");

        let drive_once = |sent_at: i64| -> PairOutcome {
            // Server clock UNEXPIRED (1000 < 5000); the replay is denied by the PK conflict.
            let hub =
                PairingHub::new_with_clock(sample_payload(5000), vec!["pairing".into()], 1000);
            let listener = PairingListener::bind_loopback(hub, 0).unwrap();
            let addr = listener.local_addr().unwrap();
            let db_path = db_path.clone();
            let store_dir = store.dir.clone();
            // A fresh server keypair per connection is fine: the device re-derives the session from
            // the hub pubkey carried in THIS connection's preamble (the device kp + proof are reused,
            // which is what makes the second attempt a true replay at the DB layer).
            let conn_server_kp = DeviceKeypair::generate();
            let conn_server_pub = conn_server_kp.public_bytes();
            let server = thread::spawn(move || {
                let mut db = Db::open_hub(&db_path).unwrap();
                let mut s = FileSecureStore::open(&store_dir, derive_file_store_kek(&[0x42u8; 32]))
                    .unwrap();
                listener
                    .accept_one_live(&mut db, &mut s, &conn_server_kp, AAD)
                    .unwrap()
            });
            let mut stream = TcpStream::connect(addr).unwrap();
            write_frame(&mut stream, &device_pub).unwrap();
            let got = read_frame(&mut stream).unwrap();
            assert_eq!(got.as_slice(), &conn_server_pub[..]);
            let session = device_kp.agree(&conn_server_pub);
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let request = Envelope::new(
                "replay-pair",
                sent_at,
                Message::Pair {
                    device_id: "ios-replay".into(),
                    device_pubkey: device_pub.to_vec(),
                    pairing_proof: proof.clone(),
                },
            );
            ws_send_envelope(&mut ws, &session, &request, AAD).unwrap();
            let _ = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            server.join().unwrap()
        };

        let first = drive_once(1000);
        assert!(first.accepted);
        assert_eq!(first.enroll_outcome.as_ref().unwrap().total_peers, 1);

        let replay = drive_once(1001);
        assert!(!replay.accepted, "exact replay DENIED at the DB layer");
        assert!(replay.enroll_outcome.is_none(), "replay enrolls NOTHING");

        // Exactly ONE peer (the idempotent + replay-denied result), and the WRITE seam is untouched.
        let store2 = store.open();
        let allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(allow.len(), 1, "no double-enroll on replay");
        assert!(peer_is_allowlisted(&allow, &device_pub));
        // The WRITE seam id was NEVER written by the pairing bridge.
        assert_eq!(
            load_peer_allowlist(&store2, PEER_PUBKEY_ALLOWLIST_ID),
            Err(PeerAllowlistError::Missing),
            "pairing bridge never touches the write-seam single-peer allowlist"
        );
    }

    #[test]
    fn live_pair_never_writes_the_write_seam_single_peer() {
        // A valid pair enrolls the READ seam only; the WRITE seam's single-peer id is never written,
        // so a write server enforcing `enforce_single_peer` on its own id is unaffected.
        let payload = sample_payload(5000);
        let secret = payload.pairing_secret.expose_for_qr().as_bytes().to_vec();
        let device_kp = DeviceKeypair::generate();
        let device_pub = device_kp.public_bytes();
        let proof = pairing_proof(&secret, &device_pub);
        // Pre-seed a write-seam single-peer entry (the live write peer) to prove it is byte-untouched.
        let write_peer = [0xCCu8; X25519_PUBKEY_LEN];

        let tmp = TempDb::new("writeseam");
        let db_path = tmp.path().to_string();
        let store = TempStore::new("writeseam");
        {
            let mut s = store.open();
            s.try_put(PEER_PUBKEY_ALLOWLIST_ID, &write_peer).unwrap();
        }
        let server_kp = DeviceKeypair::generate();
        let server_pub = server_kp.public_bytes();
        // Server clock UNEXPIRED (1000 < 5000).
        let hub = PairingHub::new_with_clock(payload, vec!["pairing".into()], 1000);
        let listener = PairingListener::bind_loopback(hub, 0).unwrap();
        let addr = listener.local_addr().unwrap();
        let store_dir = store.dir.clone();
        let server = thread::spawn(move || {
            let mut db = Db::open_hub(&db_path).unwrap();
            let mut s =
                FileSecureStore::open(&store_dir, derive_file_store_kek(&[0x42u8; 32])).unwrap();
            listener
                .accept_one_live(&mut db, &mut s, &server_kp, AAD)
                .unwrap()
        });
        let mut stream = TcpStream::connect(addr).unwrap();
        write_frame(&mut stream, &device_pub).unwrap();
        let _ = read_frame(&mut stream).unwrap();
        let session = device_kp.agree(&server_pub);
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let request = Envelope::new(
            "ws-pair",
            1000,
            Message::Pair {
                device_id: "ios-ws".into(),
                device_pubkey: device_pub.to_vec(),
                pairing_proof: proof,
            },
        );
        ws_send_envelope(&mut ws, &session, &request, AAD).unwrap();
        let _ = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
        let outcome = server.join().unwrap();
        assert!(outcome.accepted);

        let store2 = store.open();
        // The WRITE seam still holds EXACTLY its single peer (unchanged) and passes single-peer.
        let write_allow = load_peer_allowlist(&store2, PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(write_allow.len(), 1, "write-seam single-peer unchanged");
        assert!(enforce_single_peer(&write_allow).is_ok());
        assert!(peer_is_allowlisted(&write_allow, &write_peer));
        // The READ seam got the device, on its OWN distinct id.
        let read_allow = load_peer_allowlist(&store2, READ_SEAM_PEER_PUBKEY_ALLOWLIST_ID).unwrap();
        assert_eq!(read_allow.len(), 1);
        assert!(peer_is_allowlisted(&read_allow, &device_pub));
    }
}
