//! WS substrate **S-B** — `hub_agent_run_server`: the long-lived loopback agent-run WS server bin.
//!
//! ## What this slice is (DARK)
//! A NEW long-lived Rust bin that stands up the SERVER + per-session key establishment for the
//! executeRun-replacement WS substrate. It binds a **loopback-only** TCP listener, builds ONE
//! [`HubRuntime`] at boot (so the DeepSeek-client/DB cold-start is paid ONCE, not per connection),
//! and per accepted connection runs a real WebSocket handshake, establishes a sealed session key
//! via a dev/test ECDH key-exchange where the peer's public key comes FROM THE PEER OVER THE WIRE,
//! and runs a fail-closed sealed serve loop.
//!
//! It lands DARK: nothing connects to it in production (no production caller, no LaunchAgent entry).
//! Removing this file fully reverts the slice.
//!
//! ## Truth label
//! WS substrate **S-B**. Loopback-only. **Dev key-exchange** (the PRODUCTION key source — loopback
//! pairing handshake vs SecureStore — is a LATER decision, deferred; here both peers hold their OWN
//! keypair and ECDH at connect). **NO auth verification yet** (the `forwarded_principal`/`auth_proof`
//! of `AgentRunRequest` are NOT checked — that is S-C). **NO agent-run dispatch yet** (the serve loop
//! does NOT call [`HubRuntime::run_task`]; it accepts + echoes a benign handshake/keepalive — that is
//! S-C). `rust_wired` at best; NOT v1 GO; `executeRun` is NOT replaced.
//!
//! ## Why this is NOT the `hub_authed_run` ECDH anti-pattern
//! The proof bin `hub_authed_run` generates BOTH ECDH halves in-process (`hub_kp` + `caller_kp`) and
//! seals to itself — an auth BYPASS acceptable only for an in-process one-shot proof. This server
//! does NOT do that: it generates exactly ONE keypair (its OWN, at boot), and the EXTERNAL peer's
//! public key is **read from the wire** (a cleartext length-prefixed pubkey preamble, exchanged
//! BEFORE the WS upgrade — pubkeys are public by definition, the seal begins after). The server can
//! never fabricate the peer's half: [`establish_session`] takes the peer pubkey as an INPUT. A caller
//! that does not hold the matching private key derives a different session key and its sealed
//! envelopes will not open (fail-closed).
//!
//! ## Live key
//! [`HubRuntime::live`] reads the DeepSeek key from the env (`DeepSeekClient::from_env`, never
//! logged). It only CONSTRUCTS the client (no network call); running an actual agent-run needs
//! `FRIDAY_DEEPSEEK_API_KEY` and is the SEPARATE operator live-proof — and is anyway deferred to S-C.
//! CI only BUILDS this bin; the tests never reach [`HubRuntime::live`].

use std::env;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use friday_crypto::{DataKey, DeviceKeypair};
use friday_hub::runtime::{HubConfig, HubRuntime};
use friday_transport::{
    read_frame, write_frame, ws_accept, ws_recv_envelope, ws_send_envelope, TransportError,
    WireWebSocket,
};

/// The session AAD binding every sealed envelope on an S-B session to this protocol/version.
/// A fixed, public, non-secret constant (the confidentiality is in the session key, not the AAD).
const SESSION_AAD: &[u8] = b"friday:execrun:ws:s-b:agent-run-session:aad:v1";

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

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let db_path = arg_value(&args, "--db").unwrap_or_else(|| {
        format!("{workspace_root}/.hub-agent-run-server-dev-{pid}-{nanos}.sqlite")
    });

    // (1) Build ONE HubRuntime at boot so the DeepSeek-client/DB cold-start is paid ONCE (not
    // per connection). S-B HOLDS this runtime; the dispatch into `run_task` is S-C. We `let _`
    // it (rather than store it in a struct field) so the unused-but-constructed-once intent is
    // explicit and clippy's `dead_code` does not fire on a never-read field. `HubRuntime::live`
    // only CONSTRUCTS the provider client (no network call); an actual run is deferred to S-C.
    let _runtime = HubRuntime::live(HubConfig {
        db_path,
        workspace_root: PathBuf::from(&workspace_root),
        secret: ephemeral_dev_secret(pid, nanos),
        max_turns: 6,
        principal_id: None,
        disabled_tools: vec![],
        read_only: true,
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
        "hub_agent_run_server: listening (loopback-only) on {addr} — DARK (S-B: no auth-verify, no dispatch)"
    );

    // (3) Long-lived accept loop. Each accepted connection: read the peer pubkey preamble, run the
    // WS handshake, derive the sealed session key, and serve sealed envelopes fail-closed.
    loop {
        match listener.accept_one(&server_kp) {
            Ok(_served) => {}
            // A connection-level error ends THAT connection only; the server keeps listening.
            Err(_e) => continue,
        }
    }
}

/// The loopback-only S-B WS listener. Owns the socket lifecycle; the session/serve semantics live
/// in [`establish_session`] / [`serve_sealed_session`]. Mirrors `pair_runtime::PairingListener`.
struct AgentRunWsListener {
    listener: TcpListener,
}

impl AgentRunWsListener {
    /// Bind a **loopback-only** listener on `127.0.0.1:<port>` (`port = 0` lets the OS assign).
    /// Binding [`Ipv4Addr::LOCALHOST`] (NEVER `0.0.0.0`/LAN) is the "this Mac only" guarantee:
    /// off-box reachability is zero. Mirrors `PairingListener::bind_loopback`.
    fn bind_loopback(port: u16) -> std::io::Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))?;
        Ok(Self { listener })
    }

    fn local_addr(&self) -> std::io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    /// Accept exactly ONE connection, establish the sealed session (peer pubkey from the wire),
    /// and serve it fail-closed. Returns the count of envelopes processed on that session.
    fn accept_one(&self, server_kp: &DeviceKeypair) -> Result<usize, TransportError> {
        let (stream, _peer) = self.listener.accept()?;
        let (mut ws, session_key) = establish_session(stream, server_kp)?;
        serve_sealed_session(&mut ws, &session_key)
    }
}

/// Establish the sealed session for one connection.
///
/// **Key-source abstraction (dev/test exchange; prod source deferred to a later decision):** the
/// server holds its OWN `server_kp`; the EXTERNAL peer's public key is **read from the wire** as a
/// cleartext length-prefixed preamble BEFORE the WS upgrade (pubkeys are public — the seal begins
/// after). The server then ECDHs `server_kp.agree(peer_pub)` → the per-session [`DataKey`]. In
/// production the server key comes from SecureStore and the peer pubkey from the loopback pairing
/// handshake; the SHAPE here (server key injected, peer key from the wire) is unchanged.
///
/// Wire order (no deadlock — `read_frame` uses `read_exact` so it cannot bleed into the HTTP GET):
/// server `read_frame` (peer pub) → `write_frame` (server pub) → [`ws_accept`] → `agree`.
///
/// A peer-pubkey frame that is not exactly 32 bytes FAILS CLOSED (a malformed preamble can never
/// yield a session).
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

    // (b) Send our OWN public key so the peer can derive the same session key.
    write_frame(&mut stream, &server_kp.public_bytes())?;

    // (c) WS upgrade over the (now preamble-consumed) stream, then derive the sealed session key.
    let ws = ws_accept(stream)?;
    let session_key = server_kp.agree(&peer_pub);
    Ok((ws, session_key))
}

/// Serve sealed envelopes over ONE established session until the peer disconnects OR sends an
/// envelope that fails to open under the session key. Mirrors `HubServer::serve_connection`:
/// an envelope that fails to open ENDS the session (fail-closed) — no processing, no dispatch.
///
/// **S-B: NO agent-run dispatch.** This loop does NOT call [`HubRuntime::run_task`] and does NOT
/// route on `AgentRunRequest` — that is S-C. The benign behaviour is a sealed echo of the opened
/// envelope (a handshake/keepalive), proving the SERVER + sealed-session lifecycle, dark.
///
/// Returns the number of envelopes processed (echoed) before the session ended — `0` means the
/// first envelope failed to open (wrong key / tamper), the fail-closed path.
fn serve_sealed_session<S: Read + Write>(
    ws: &mut WireWebSocket<S>,
    session_key: &DataKey,
) -> Result<usize, TransportError> {
    let mut processed = 0usize;
    loop {
        let env = match ws_recv_envelope(ws, session_key, SESSION_AAD) {
            Ok(e) => e,
            // EOF / disconnect / un-openable seal (wrong key or tamper) → END the session.
            // No dispatch, no processing — fail closed.
            Err(_) => return Ok(processed),
        };
        // Benign keepalive: echo the opened envelope back, sealed under the SAME session key,
        // correlated to the request. NO dispatch — S-B holds the session, S-C will dispatch.
        let reply = env.clone().with_correlation(env.msg_id.clone());
        ws_send_envelope(ws, session_key, &reply, SESSION_AAD)?;
        processed += 1;
    }
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

/// Ephemeral, non-secret bytes for the boot-time runtime config (dormant under deny-all/read-only).
/// Derived, not read from any key store.
fn ephemeral_dev_secret(pid: u32, nanos: u128) -> Vec<u8> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("hub-agent-run-server-dev:{pid}:{nanos}").as_bytes());
    hasher.finalize().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_protocol::{Envelope, Message};
    use friday_transport::{ws_connect, ws_send_envelope};
    use std::net::TcpStream;
    use std::thread;

    /// A benign handshake/keepalive envelope (NO `AgentRunRequest` — S-B does not dispatch).
    fn keepalive(msg_id: &str) -> Envelope {
        Envelope::new(
            msg_id,
            1000,
            Message::HubStatus {
                online: true,
                capabilities: vec!["agent_run_ws_s_b".into()],
                min_version: friday_protocol::SUPPORTED.min,
                max_version: friday_protocol::SUPPORTED.max,
            },
        )
    }

    /// Drive the cleartext pubkey preamble from the CLIENT side, then run the WS upgrade and
    /// derive the client's view of the session key. This is the peer the server reads from the
    /// wire — the client keypair is generated HERE (test-only), never by the server.
    fn client_handshake(
        addr: SocketAddr,
        client_kp: &DeviceKeypair,
    ) -> (WireWebSocket<TcpStream>, DataKey) {
        let mut stream = TcpStream::connect(addr).unwrap();
        // Client sends its pubkey first (server reads it first), then reads the server's pubkey.
        write_frame(&mut stream, &client_kp.public_bytes()).unwrap();
        let server_pub_bytes = read_frame(&mut stream).unwrap();
        let server_pub: [u8; 32] = server_pub_bytes.as_slice().try_into().unwrap();
        let ws = ws_connect(&format!("ws://{addr}/"), stream).unwrap();
        let session = client_kp.agree(&server_pub);
        (ws, session)
    }

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

    /// ECDH symmetry over the EXTERNALLY-supplied peer key: the server derives the SAME session
    /// key the peer does, using the peer pubkey it was GIVEN — not a self-fabricated one. Two
    /// distinct keypairs (server + peer) agree; this is impossible if the server fabricated both
    /// halves (it would agree-to-itself with a key the real peer never sees).
    #[test]
    fn server_agrees_with_supplied_peer_key_not_a_fabricated_one() {
        let server_kp = DeviceKeypair::generate();
        let peer_kp = DeviceKeypair::generate();
        let server_view = server_kp.agree(&peer_kp.public_bytes());
        let peer_view = peer_kp.agree(&server_kp.public_bytes());
        // Both ends derive the same session key from the OTHER's public half.
        let probe = keepalive("ecdh-probe");
        let wire = friday_transport::seal_envelope(&server_view, &probe, SESSION_AAD).unwrap();
        let opened = friday_transport::open_envelope(&peer_view, &wire, SESSION_AAD).unwrap();
        assert_eq!(
            opened, probe,
            "server's session key must match the supplied peer's"
        );
    }

    /// A malformed (non-32-byte) peer-pubkey preamble FAILS CLOSED: no session is established.
    #[test]
    fn short_peer_pubkey_preamble_fails_closed() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || establish_session_result(&listener, &server_kp));

        let mut stream = TcpStream::connect(addr).unwrap();
        // Send a too-short "pubkey" (16 bytes) — the server must reject it.
        write_frame(&mut stream, &[0u8; 16]).unwrap();
        let outcome = server.join().unwrap();
        assert!(
            outcome.is_err(),
            "a non-32-byte peer pubkey must fail closed (no session)"
        );
    }

    /// Test helper: accept one connection and return ONLY whether the session established (so the
    /// fail-closed preamble test can join the server thread without serving).
    fn establish_session_result(
        listener: &AgentRunWsListener,
        server_kp: &DeviceKeypair,
    ) -> Result<(), TransportError> {
        let (stream, _peer) = listener.listener.accept()?;
        establish_session(stream, server_kp).map(|_| ())
    }

    /// HAPPY PATH over a REAL loopback socket: an external-peer-key (test-generated, NOT
    /// server-fabricated) connection establishes the sealed session and a sealed round-trip works.
    #[test]
    fn external_peer_key_establishes_session_and_round_trips() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || listener.accept_one(&server_kp).unwrap());

        let client_kp = DeviceKeypair::generate();
        let (mut ws, session) = client_handshake(addr, &client_kp);
        let req = keepalive("s-b-keepalive-1");
        ws_send_envelope(&mut ws, &session, &req, SESSION_AAD).unwrap();
        let reply = ws_recv_envelope(&mut ws, &session, SESSION_AAD).unwrap();
        assert_eq!(reply.correlation_id.as_deref(), Some("s-b-keepalive-1"));
        assert_eq!(
            reply.message, req.message,
            "S-B echoes the keepalive (no dispatch)"
        );
        // End the session so the server's serve loop returns.
        drop(ws);

        let processed = server.join().unwrap();
        assert_eq!(
            processed, 1,
            "exactly one keepalive processed on the session"
        );
    }

    /// FAIL-CLOSED over a REAL loopback socket: the client completes the handshake (deriving the
    /// real session key) but then seals its envelope under a WRONG key (≠ the session key). The
    /// server's `ws_recv_envelope` cannot open it → the serve loop returns having processed ZERO
    /// envelopes (no echo, no dispatch), and the client's next read errors (session ended).
    #[test]
    fn wrong_session_key_fails_closed_no_processing() {
        let server_kp = DeviceKeypair::generate();
        let listener = AgentRunWsListener::bind_loopback(0).unwrap();
        let addr = listener.local_addr().unwrap();

        let server = thread::spawn(move || listener.accept_one(&server_kp).unwrap());

        let client_kp = DeviceKeypair::generate();
        let (mut ws, _real_session) = client_handshake(addr, &client_kp);
        // Seal under a key that is NOT the established session key.
        let wrong_key = DataKey::generate();
        let req = keepalive("s-b-tampered");
        ws_send_envelope(&mut ws, &wrong_key, &req, SESSION_AAD).unwrap();
        // The server ends the session without replying; the next read must error.
        assert!(
            ws_recv_envelope(&mut ws, &_real_session, SESSION_AAD).is_err(),
            "session must end (no reply) after an un-openable envelope"
        );

        let processed = server.join().unwrap();
        assert_eq!(
            processed, 0,
            "wrong-key envelope must be fail-closed: ZERO processed"
        );
    }

    #[test]
    fn arg_value_supports_space_and_equals_forms() {
        let args = vec![
            "bin".to_string(),
            "--workspace".to_string(),
            "/tmp/ws".to_string(),
            "--port=7777".to_string(),
        ];
        assert_eq!(arg_value(&args, "--workspace").as_deref(), Some("/tmp/ws"));
        assert_eq!(arg_value(&args, "--port").as_deref(), Some("7777"));
        assert_eq!(arg_value(&args, "--missing"), None);
    }

    #[test]
    fn ephemeral_secret_is_32_bytes() {
        assert_eq!(ephemeral_dev_secret(1, 2).len(), 32);
    }
}
