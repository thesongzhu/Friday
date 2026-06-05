//! WebSocket framing over REAL loopback (gate `21` §4 "versioned E2E WebSocket
//! protocol"): a genuine WS upgrade/handshake, carrying session-sealed envelopes
//! as Binary messages. E2E confidentiality is at the seal layer, so the
//! relay-cannot-decrypt property is identical to the length-prefixed framing.

use friday_crypto::DeviceKeypair;
use friday_protocol::{Envelope, Message};
use friday_transport::{seal_envelope, ws_accept, ws_connect, ws_recv_envelope, ws_send_envelope};
use std::net::{TcpListener, TcpStream};
use std::thread;

const AAD: &[u8] = b"friday-wire-v1";

#[test]
fn websocket_e2e_round_trip_over_loopback() {
    let hub_kp = DeviceKeypair::generate();
    let phone_kp = DeviceKeypair::generate();
    let hub_pub = hub_kp.public_bytes();
    let phone_pub = phone_kp.public_bytes();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let hub = thread::spawn(move || {
        let session = hub_kp.agree(&phone_pub);
        let (stream, _) = listener.accept().unwrap();
        let mut ws = ws_accept(stream).unwrap(); // real server WS handshake
        let req = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
        let resp = Envelope::new(
            "r1",
            2,
            Message::AskFridayResult {
                ledger_id: "L1".into(),
                result_link: None,
            },
        )
        .with_correlation(req.msg_id.clone());
        ws_send_envelope(&mut ws, &session, &resp, AAD).unwrap();
    });

    let session = phone_kp.agree(&hub_pub);
    let stream = TcpStream::connect(addr).unwrap();
    let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap(); // real client WS handshake
    let ask = Envelope::new(
        "m1",
        1,
        Message::AskFridayRequest {
            prompt: "ws-ping".into(),
            mission_context: None,
        },
    );
    // Ciphertext-on-the-wire: the Binary payload the WS layer frames is the
    // sealed body — the plaintext prompt must not appear in it (relay-blind).
    let wire = seal_envelope(&session, &ask, AAD).unwrap();
    assert!(
        !wire.windows(7).any(|w| w == b"ws-ping"),
        "plaintext leaked into the WS-framed body"
    );
    ws_send_envelope(&mut ws, &session, &ask, AAD).unwrap();
    let resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
    match resp.message {
        Message::AskFridayResult { ledger_id, .. } => assert_eq!(ledger_id, "L1"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(resp.correlation_id.as_deref(), Some("m1"));
    hub.join().unwrap();
}
