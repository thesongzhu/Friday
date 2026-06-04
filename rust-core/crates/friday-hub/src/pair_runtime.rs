//! PAIR-002 — Hub-side QR pairing message handler.
//!
//! This is the runtime seam that sits behind a local WebSocket/mDNS service:
//! it handles `Message::Pair` against a structured QR payload and writes the
//! trusted-device/audit rows. It deliberately does **not** dispatch model/provider
//! calls; scan/open/status are connection bootstrap, not Ask Friday.

use friday_core::FridayPairPayload;
use friday_crypto::DataKey;
use friday_protocol::{Envelope, ErrorCode, Message, SUPPORTED};
use friday_storage::Db;
use friday_transport::{ws_recv_envelope, ws_send_envelope, TransportError, WireWebSocket};
use std::io::{Read, Write};

/// Minimal Hub pairing runtime. A future listener owns sockets/mDNS; this type
/// owns the pairing semantics and can be tested without network or provider I/O.
#[derive(Clone, Debug)]
pub struct PairingHub {
    payload: FridayPairPayload,
    capabilities: Vec<String>,
}

impl PairingHub {
    pub fn new(payload: FridayPairPayload, capabilities: Vec<String>) -> Self {
        Self {
            payload,
            capabilities,
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
        let result = db.complete_qr_pairing(
            &self.payload,
            &device_id,
            &device_pubkey,
            &pairing_proof,
            sent_at,
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
        let hub = PairingHub::new(payload, vec!["pairing".into()]);
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
        let hub = PairingHub::new(sample_payload(2000), vec!["pairing".into()]);

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
        let hub = PairingHub::new(payload, vec!["pairing".into()]);
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
}
