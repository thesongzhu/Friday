//! Live transport over real loopback sockets (gate `21` §4.3/§4.4; `09` §1/§7):
//! direct E2E round-trip, relay-forwards-ciphertext-but-cannot-decrypt across a
//! real relay hop, and reconnect + resumable-stream catch-up.

use friday_crypto::DeviceKeypair;
use friday_protocol::{Envelope, Message, ResumableStream};
use friday_transport::{open_envelope, read_frame, recv_envelope, send_envelope, write_frame};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

const AAD: &[u8] = b"friday-wire-v1";

#[test]
fn direct_e2e_round_trip_over_loopback() {
    let hub_kp = DeviceKeypair::generate();
    let phone_kp = DeviceKeypair::generate();
    let hub_pub = hub_kp.public_bytes();
    let phone_pub = phone_kp.public_bytes();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let hub = thread::spawn(move || {
        let session = hub_kp.agree(&phone_pub);
        let (mut sock, _) = listener.accept().unwrap();
        let req = recv_envelope(&mut sock, &session, AAD).unwrap();
        match &req.message {
            Message::AskFridayRequest {
                prompt,
                mission_context,
            } => {
                assert_eq!(prompt, "ping");
                assert!(mission_context.is_none());
            }
            other => panic!("unexpected {other:?}"),
        }
        let resp = Envelope::new(
            "r1",
            2,
            Message::AskFridayResult {
                ledger_id: "L1".into(),
                result_link: None,
            },
        )
        .with_correlation(req.msg_id.clone());
        send_envelope(&mut sock, &session, &resp, AAD).unwrap();
    });

    let session = phone_kp.agree(&hub_pub);
    let mut sock = TcpStream::connect(addr).unwrap();
    let ask = Envelope::new(
        "m1",
        1,
        Message::AskFridayRequest {
            prompt: "ping".into(),
            mission_context: None,
        },
    );
    send_envelope(&mut sock, &session, &ask, AAD).unwrap();
    let resp = recv_envelope(&mut sock, &session, AAD).unwrap();
    match resp.message {
        Message::AskFridayResult { ledger_id, .. } => assert_eq!(ledger_id, "L1"),
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(resp.correlation_id.as_deref(), Some("m1"));
    hub.join().unwrap();
}

#[test]
fn relay_forwards_ciphertext_but_cannot_decrypt() {
    let hub_kp = DeviceKeypair::generate();
    let phone_kp = DeviceKeypair::generate();
    let relay_kp = DeviceKeypair::generate(); // relay has its own keys, NOT the session
    let hub_pub = hub_kp.public_bytes();
    let phone_pub = phone_kp.public_bytes();

    let hub_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let hub_addr = hub_listener.local_addr().unwrap();
    let relay_listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let relay_addr = relay_listener.local_addr().unwrap();

    // Hub: derive session with the phone, answer one ask.
    let hub = thread::spawn(move || {
        let session = hub_kp.agree(&phone_pub);
        let (mut sock, _) = hub_listener.accept().unwrap();
        let req = recv_envelope(&mut sock, &session, AAD).unwrap();
        let resp = Envelope::new(
            "r1",
            2,
            Message::AskFridayResult {
                ledger_id: "L1".into(),
                result_link: None,
            },
        )
        .with_correlation(req.msg_id.clone());
        send_envelope(&mut sock, &session, &resp, AAD).unwrap();
    });

    // Relay: forward frame bodies both ways, capturing everything it forwards.
    // It has no session key — it only moves ciphertext.
    let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let cap = captured.clone();
    let relay = thread::spawn(move || {
        let (mut from_phone, _) = relay_listener.accept().unwrap();
        let mut to_hub = TcpStream::connect(hub_addr).unwrap();
        let req_body = read_frame(&mut from_phone).unwrap();
        cap.lock().unwrap().push(req_body.clone());
        write_frame(&mut to_hub, &req_body).unwrap();
        let resp_body = read_frame(&mut to_hub).unwrap();
        cap.lock().unwrap().push(resp_body.clone());
        write_frame(&mut from_phone, &resp_body).unwrap();
    });

    // Phone: talk to the hub THROUGH the relay.
    let session = phone_kp.agree(&hub_pub);
    let mut sock = TcpStream::connect(relay_addr).unwrap();
    let prompt = "TOP-SECRET-RELAY-PROMPT-zz";
    let ask = Envelope::new(
        "m1",
        1,
        Message::AskFridayRequest {
            prompt: prompt.into(),
            mission_context: None,
        },
    );
    send_envelope(&mut sock, &session, &ask, AAD).unwrap();
    let resp = recv_envelope(&mut sock, &session, AAD).unwrap();
    match resp.message {
        Message::AskFridayResult { ledger_id, .. } => assert_eq!(ledger_id, "L1"),
        other => panic!("unexpected {other:?}"),
    }
    hub.join().unwrap();
    relay.join().unwrap();

    // What the relay actually forwarded:
    let frames = captured.lock().unwrap();
    assert_eq!(frames.len(), 2, "relay forwarded request + response");
    let needle = prompt.as_bytes();
    for body in frames.iter() {
        // (1) The plaintext prompt never appears in the forwarded ciphertext.
        assert!(
            !body.windows(needle.len()).any(|w| w == needle),
            "plaintext leaked through the relay"
        );
        // (2) The relay, with only the public keys, cannot derive the session
        //     key, so it cannot decrypt a captured frame.
        let relay_vs_phone = relay_kp.agree(&phone_pub);
        let relay_vs_hub = relay_kp.agree(&hub_pub);
        assert!(open_envelope(&relay_vs_phone, body, AAD).is_err());
        assert!(open_envelope(&relay_vs_hub, body, AAD).is_err());
    }
}

#[test]
fn reconnect_resumes_missed_stream_frames() {
    let hub_kp = DeviceKeypair::generate();
    let phone_kp = DeviceKeypair::generate();
    let hub_pub = hub_kp.public_bytes();
    let phone_pub = phone_kp.public_bytes();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    // Hub: a 4-frame durable stream. Connection 1 delivers seq 1..=2, then the
    // phone disconnects. Connection 2 carries the phone's last-acked seq; the hub
    // replays only the missed frames (seq 3,4).
    let hub = thread::spawn(move || {
        let session = hub_kp.agree(&phone_pub);
        let mut stream = ResumableStream::new();
        for chunk in ["alpha", "bravo", "charlie", "delta"] {
            stream.push(chunk);
        }

        // Connection 1: send first two frames.
        let (mut c1, _) = listener.accept().unwrap();
        for f in stream.missed_since(0).into_iter().take(2) {
            let env = Envelope::new(
                format!("s{}", f.seq),
                f.seq as i64,
                Message::AskFridayStream {
                    seq: f.seq,
                    chunk: f.chunk,
                },
            );
            send_envelope(&mut c1, &session, &env, AAD).unwrap();
        }
        drop(c1); // simulate disconnect

        // Connection 2: read the phone's last-acked seq, replay the rest.
        let (mut c2, _) = listener.accept().unwrap();
        let resume = recv_envelope(&mut c2, &session, AAD).unwrap();
        let last_acked = match resume.message {
            Message::AskFridayStream { seq, .. } => seq,
            other => panic!("expected resume marker, got {other:?}"),
        };
        for f in stream.missed_since(last_acked) {
            let env = Envelope::new(
                format!("s{}", f.seq),
                f.seq as i64,
                Message::AskFridayStream {
                    seq: f.seq,
                    chunk: f.chunk,
                },
            );
            send_envelope(&mut c2, &session, &env, AAD).unwrap();
        }
    });

    let session = phone_kp.agree(&hub_pub);

    // Connection 1: receive seq 1,2.
    let mut c1 = TcpStream::connect(addr).unwrap();
    let mut got = Vec::new();
    for _ in 0..2 {
        let env = recv_envelope(&mut c1, &session, AAD).unwrap();
        if let Message::AskFridayStream { seq, chunk } = env.message {
            got.push((seq, chunk));
        }
    }
    drop(c1);
    assert_eq!(
        got,
        vec![(1, "alpha".to_string()), (2, "bravo".to_string())]
    );
    let last_acked = got.last().unwrap().0; // 2

    // Connection 2: report last-acked seq, receive only the missed frames.
    let mut c2 = TcpStream::connect(addr).unwrap();
    let resume = Envelope::new(
        "resume",
        0,
        Message::AskFridayStream {
            seq: last_acked,
            chunk: String::new(),
        },
    );
    send_envelope(&mut c2, &session, &resume, AAD).unwrap();
    let mut resumed = Vec::new();
    for _ in 0..2 {
        let env = recv_envelope(&mut c2, &session, AAD).unwrap();
        if let Message::AskFridayStream { seq, chunk } = env.message {
            resumed.push((seq, chunk));
        }
    }
    hub.join().unwrap();
    assert_eq!(
        resumed,
        vec![(3, "charlie".to_string()), (4, "delta".to_string())],
        "reconnect replayed exactly the missed frames"
    );
}
