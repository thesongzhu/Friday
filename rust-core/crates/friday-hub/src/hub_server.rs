//! Phase-1 runtime bridge — headless Hub serve-loop (goal file 92 §Phase 1).
//!
//! Composes existing Rust mechanisms into a local **headless** Hub runtime that a future
//! mobile/desktop UI can consume over the proven E2E-sealed WebSocket transport. It serves
//! a TRUSTED session (the per-session [`DataKey`] is established out of band by pairing;
//! a client without it cannot produce valid sealed envelopes → fail-closed) and handles a
//! STREAM of messages per connection (beyond a single `accept_one`).
//!
//! Call discipline (the load-bearing invariant): the non-model operations
//! (connect / status / refresh / list / reconnect) are **pure Hub reads and produce ZERO
//! provider/model calls**. ONLY [`Message::AskFridayRequest`] reaches the Hub-owned
//! DeepSeek route — via [`crate::record_friday_ask`], which is the single atomic
//! ask→token_ledger+Activity(AskReceipt)+audit coupling. There is **no fallback** to
//! Codex/Claude/OpenAI/local/mock: a route failure is surfaced as an exact blocker.
//!
//! Safe outbound projection: an ask returns only **refs** ([`Message::AskFridayResult`]
//! = `ledger_id` + a `result_link`) — never the raw answer text, provider account ids,
//! auth material, raw private reasoning, cwd, or external urls on the wire. The answer +
//! usage live Hub-side in the token_ledger / Activity receipt. No UI code here.

use friday_deepseek::{DeepSeekClient, Transport};
use friday_protocol::{Envelope, ErrorCode, Message, SUPPORTED};
use friday_storage::Db;
use friday_transport::{ws_recv_envelope, ws_send_envelope, TransportError, WireWebSocket};
use std::io::{Read, Write};

use crate::{record_friday_ask, RecordAskError};

/// A headless Hub runtime serving one or more trusted client sessions. Generic over the
/// DeepSeek [`Transport`] so tests inject a scripted mock and a live build uses
/// `DeepSeekClient::from_env()` (Hub-only credential).
pub struct HubServer<T: Transport> {
    db: Db,
    deepseek: DeepSeekClient<T>,
    capabilities: Vec<String>,
    max_tokens: u32,
    /// Monotonic per-ask id source (a fresh ledger_id per ask — reuse fails CLOSED on the
    /// token_ledger PK).
    next_ask: u64,
}

impl<T: Transport> HubServer<T> {
    pub fn new(
        db: Db,
        deepseek: DeepSeekClient<T>,
        capabilities: Vec<String>,
        max_tokens: u32,
    ) -> Self {
        Self {
            db,
            deepseek,
            capabilities,
            max_tokens,
            next_ask: 0,
        }
    }

    /// Borrow the Db (e.g. to inspect ledger/activity Hub-side).
    pub fn db(&self) -> &Db {
        &self.db
    }

    /// Dispatch ONE client envelope to a response. `now_ms` is supplied by the caller's
    /// clock (deterministic in tests). Non-model messages never touch the DeepSeek client.
    pub fn dispatch(&mut self, env: Envelope, now_ms: i64) -> Envelope {
        let corr = env.msg_id.clone();
        match env.message {
            // Pure Hub read — NO provider/model call.
            Message::HubStatus { .. } => self.status(&corr).with_correlation(corr),
            // The ONLY model path: Hub-owned DeepSeek route + ledger/audit/activity.
            Message::AskFridayRequest { prompt } => {
                self.ask(&corr, &prompt, now_ms).with_correlation(corr)
            }
            // The pairing channel established the session; a Pair here is out of place.
            Message::Pair { .. } => Self::error(
                &corr,
                now_ms,
                ErrorCode::Internal,
                "already on a trusted session; pairing is the connect step",
            ),
            _ => Self::error(
                &corr,
                now_ms,
                ErrorCode::Internal,
                "unsupported runtime-bridge message",
            ),
        }
    }

    fn status(&self, msg_id: &str) -> Envelope {
        Envelope::new(
            format!("{msg_id}-status"),
            0,
            Message::HubStatus {
                online: true,
                capabilities: self.capabilities.clone(),
                min_version: SUPPORTED.min,
                max_version: SUPPORTED.max,
            },
        )
    }

    fn ask(&mut self, msg_id: &str, prompt: &str, now_ms: i64) -> Envelope {
        self.next_ask += 1;
        let ledger_id = format!("ask-{msg_id}-{}", self.next_ask);
        let activity_id = format!("{ledger_id}:activity");
        let session_id = "friday-hub-session";
        match record_friday_ask(
            &mut self.db,
            &self.deepseek,
            &ledger_id,
            session_id,
            &activity_id,
            prompt,
            self.max_tokens,
            now_ms,
        ) {
            // Safe projection: refs ONLY. The answer text + usage stay Hub-side in the
            // token_ledger / Activity(AskReceipt) row, never on the wire.
            Ok(_outcome) => Envelope::new(
                format!("{msg_id}-result"),
                now_ms,
                Message::AskFridayResult {
                    ledger_id: ledger_id.clone(),
                    result_link: Some(format!("friday://activity/{activity_id}")),
                },
            ),
            // Route failure → exact blocker, NO fallback, NO half-billed row (record_friday_ask
            // persists nothing on a Route error).
            Err(RecordAskError::Route(_)) => Self::error(
                msg_id,
                now_ms,
                ErrorCode::ProviderUnavailable,
                "ask route unavailable (Hub-owned DeepSeek; no fallback)",
            ),
            Err(RecordAskError::Storage(_)) => Self::error(
                msg_id,
                now_ms,
                ErrorCode::Internal,
                "ask ledger write failed (rolled back)",
            ),
        }
    }

    fn error(msg_id: &str, now_ms: i64, code: ErrorCode, message: &str) -> Envelope {
        Envelope::new(
            format!("{msg_id}-error"),
            now_ms,
            Message::Error {
                code,
                message: message.to_string(),
            },
        )
        .with_correlation(msg_id.to_string())
    }

    /// Serve a STREAM of sealed messages over ONE established session until the client
    /// disconnects (or sends an envelope that fails to open — fail-closed, no dispatch).
    /// `clock` supplies `now_ms` per message. Returns when the connection ends.
    pub fn serve_connection<S: Read + Write>(
        &mut self,
        ws: &mut WireWebSocket<S>,
        session_key: &friday_crypto::DataKey,
        aad: &[u8],
        clock: &mut dyn FnMut() -> i64,
    ) -> Result<(), TransportError> {
        loop {
            let env = match ws_recv_envelope(ws, session_key, aad) {
                Ok(e) => e,
                // EOF / disconnect / unauthenticated-or-tampered seal → end the session.
                Err(_) => return Ok(()),
            };
            let response = self.dispatch(env, clock());
            ws_send_envelope(ws, session_key, &response, aad)?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::DeviceKeypair;
    use friday_deepseek::{DeepSeekError, Transport};
    use friday_transport::{ws_accept, ws_connect, ws_recv_envelope, ws_send_envelope};
    use serde_json::{json, Value};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    const AAD: &[u8] = b"friday-runtime-bridge-v1";

    fn tmp_db() -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!(
                "friday-hubserver-{}-{}.sqlite",
                std::process::id(),
                nanos
            ))
            .to_string_lossy()
            .into_owned()
    }

    /// Scripted DeepSeek transport: returns canned models + chat, and counts EVERY
    /// transport call via a shared atomic so a test can prove "zero provider calls" on the
    /// non-model ops.
    struct CountingMock {
        calls: Arc<AtomicUsize>,
    }
    impl Transport for CountingMock {
        fn get_json(&self, _url: &str, _bearer: &str) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({"object":"list","data":[
                {"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek"}
            ]}))
        }
        fn post_json(
            &self,
            _url: &str,
            _bearer: &str,
            _body: &Value,
        ) -> Result<Value, DeepSeekError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(json!({
                "model":"deepseek-v4-flash",
                "choices":[{"index":0,"message":{"role":"assistant","content":"SECRET-ANSWER-TEXT"},"finish_reason":"stop"}],
                "usage":{"prompt_tokens":11,"completion_tokens":8,"total_tokens":19}
            }))
        }
    }

    fn server(calls: Arc<AtomicUsize>, db_path: &str) -> HubServer<CountingMock> {
        let db = Db::open_hub(db_path).unwrap();
        let client =
            DeepSeekClient::with_transport(CountingMock { calls }, "test-key-not-real".to_string()); // pragma: allowlist secret
        HubServer::new(db, client, vec!["ask_friday".into(), "status".into()], 256)
    }

    /// Headless e2e over real loopback TCP + the sealed WS transport + a mock DeepSeek:
    /// connect → status (no model call) → ask (one model call → ledger/activity/audit) →
    /// reconnect → status (still no extra model call). Proves the call discipline + safe
    /// projection end to end.
    #[test]
    fn headless_e2e_status_is_pure_ask_routes_to_deepseek_with_safe_projection() {
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub);
            let mut hub = server(server_calls, &server_db);
            // Serve TWO connections (the second = reconnect).
            for _ in 0..2 {
                let (stream, _) = listener.accept().unwrap();
                let mut ws = ws_accept(stream).unwrap();
                let mut clock = || 1000i64;
                hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                    .unwrap();
            }
        });

        let session = phone_kp.agree(&hub_pub);

        // --- connection 1: status (pure) then ask (model) ---
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();

            // status → pure, zero provider calls so far
            let status_req = Envelope::new(
                "c1-status",
                1,
                Message::HubStatus {
                    online: false,
                    capabilities: vec![],
                    min_version: SUPPORTED.min,
                    max_version: SUPPORTED.max,
                },
            );
            ws_send_envelope(&mut ws, &session, &status_req, AAD).unwrap();
            let status_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            assert!(matches!(
                status_resp.message,
                Message::HubStatus { online: true, .. }
            ));
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "status must make ZERO provider calls"
            );

            // ask → routes to DeepSeek; result is refs-only (no raw answer on the wire)
            let ask_req = Envelope::new(
                "c1-ask",
                2,
                Message::AskFridayRequest {
                    prompt: "hello friday".into(),
                },
            );
            ws_send_envelope(&mut ws, &session, &ask_req, AAD).unwrap();
            let ask_resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            match &ask_resp.message {
                Message::AskFridayResult {
                    ledger_id,
                    result_link,
                } => {
                    assert!(ledger_id.starts_with("ask-"));
                    assert!(result_link
                        .as_deref()
                        .unwrap()
                        .starts_with("friday://activity/"));
                }
                other => panic!("expected AskFridayResult, got {other:?}"),
            }
            // SAFE PROJECTION: the raw answer text must NOT appear anywhere in the wire response.
            assert!(
                !format!("{ask_resp:?}").contains("SECRET-ANSWER-TEXT"),
                "raw answer leaked to the wire"
            );
            assert!(
                calls.load(Ordering::SeqCst) >= 1,
                "ask must reach the DeepSeek route"
            );
        } // client 1 disconnects → serve_connection returns

        let calls_after_ask = calls.load(Ordering::SeqCst);

        // --- connection 2: reconnect + status → still no extra provider call ---
        {
            let stream = TcpStream::connect(addr).unwrap();
            let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
            let status_req = Envelope::new(
                "c2-status",
                3,
                Message::HubStatus {
                    online: false,
                    capabilities: vec![],
                    min_version: SUPPORTED.min,
                    max_version: SUPPORTED.max,
                },
            );
            ws_send_envelope(&mut ws, &session, &status_req, AAD).unwrap();
            let resp = ws_recv_envelope(&mut ws, &session, AAD).unwrap();
            assert!(matches!(
                resp.message,
                Message::HubStatus { online: true, .. }
            ));
        }
        srv.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            calls_after_ask,
            "reconnect/status must make NO extra provider call"
        );

        // Hub-side: exactly one ask → one token_ledger row + one AskReceipt activity + audit.
        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("token_ledger").unwrap(), 1);
        assert_eq!(db.count("activity_item").unwrap(), 1);
        assert!(db.count("audit_ledger").unwrap() >= 1);
    }

    #[test]
    fn unauthenticated_session_key_serves_nothing() {
        // A client with the WRONG session key cannot produce a sealed envelope the Hub can
        // open → serve_connection ends without dispatching (fail-closed).
        let db_path = tmp_db();
        let calls = Arc::new(AtomicUsize::new(0));
        let hub_kp = DeviceKeypair::generate();
        let phone_kp = DeviceKeypair::generate();
        let attacker_kp = DeviceKeypair::generate();
        let hub_pub = hub_kp.public_bytes();
        let phone_pub = phone_kp.public_bytes();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server_calls = calls.clone();
        let server_db = db_path.clone();
        let srv = thread::spawn(move || {
            let session = hub_kp.agree(&phone_pub); // Hub's real session
            let mut hub = server(server_calls, &server_db);
            let (stream, _) = listener.accept().unwrap();
            let mut ws = ws_accept(stream).unwrap();
            let mut clock = || 1000i64;
            hub.serve_connection(&mut ws, &session, AAD, &mut clock)
                .unwrap();
        });

        // Attacker uses a key the Hub does not share.
        let wrong = attacker_kp.agree(&hub_pub);
        let stream = TcpStream::connect(addr).unwrap();
        let mut ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let ask = Envelope::new(
            "x-ask",
            1,
            Message::AskFridayRequest {
                prompt: "exfiltrate".into(),
            },
        );
        // The send may encode, but the Hub cannot open it → no dispatch, no model call.
        let _ = ws_send_envelope(&mut ws, &wrong, &ask, AAD);
        drop(ws);
        srv.join().unwrap();
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "no provider call for an unauthenticated session"
        );
        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(db.count("token_ledger").unwrap(), 0);
    }

    /// LIVE Phase-1 DeepSeek proof (`#[ignore]`d) — the ONE authorized live model call.
    /// Run with the Hub credential exported, e.g.:
    ///   set -a; . /private/tmp/friday-closure-20260530/.deepseek-env; set +a
    ///   cargo test -p friday-hub --test ... -- --ignored   (here: in-crate, via --ignored)
    /// Missing credential → graceful skip recorded as an EXACT blocker (never faked).
    #[test]
    #[ignore = "live: needs FRIDAY_DEEPSEEK_API_KEY (Hub-only); one authorized DeepSeek ask"]
    fn live_ask_friday_routes_through_deepseek_and_ledgers() {
        if std::env::var(friday_deepseek::ENV_KEY)
            .map(|k| k.trim().is_empty())
            .unwrap_or(true)
        {
            eprintln!(
                "SKIP/BLOCKER: {} not set — DeepSeek live proof not run (no fake success)",
                friday_deepseek::ENV_KEY
            );
            return;
        }
        let db_path = tmp_db();
        let client = DeepSeekClient::from_env().expect("live DeepSeek client");
        let mut hub = HubServer::new(
            Db::open_hub(&db_path).unwrap(),
            client,
            vec!["ask_friday".into()],
            64,
        );
        let resp = hub.dispatch(
            Envelope::new(
                "live-1",
                1,
                Message::AskFridayRequest {
                    prompt: "Reply with the single word: OK".into(),
                },
            ),
            1_700_000_000_000,
        );
        match resp.message {
            Message::AskFridayResult { ledger_id, .. } => {
                eprintln!("LIVE ask ok: ledger {ledger_id}")
            }
            Message::Error { code, message } => {
                panic!("BLOCKER (no fake): live ask errored: {code:?} {message}")
            }
            other => panic!("unexpected {other:?}"),
        }
        let db = Db::open_hub(&db_path).unwrap();
        assert_eq!(
            db.count("token_ledger").unwrap(),
            1,
            "live ask must write exactly one ledger row"
        );
        assert_eq!(db.count("activity_item").unwrap(), 1);
    }
}
