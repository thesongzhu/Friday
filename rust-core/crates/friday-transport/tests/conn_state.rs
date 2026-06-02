//! `Direct|Relay|Stale` connection-state machine exercised over REAL loopback
//! sockets (gate `21` §4.3 / §5 `ConnState`; `05` §10 stale/offline labels):
//! Disconnected -> Connecting -> Direct -> Stale -> Connecting -> Direct.
//! The Stale transition is load-bearing on a genuine read timeout (a non-timeout
//! result panics), so a real socket event causes the state change. `ConnState`
//! itself is pure/no-I/O (gate §5); the socket-event observer is the Hub/FFI
//! client driver (Unit 5).

use friday_core::ConnState;
use friday_transport::{read_frame, write_frame, TransportError};
use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream};
use std::thread;
use std::time::Duration;

#[test]
fn connection_state_tracks_socket_lifecycle() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let hub = thread::spawn(move || {
        // Connection 1: send one frame, then go quiet so the client read times
        // out (-> Stale), then drop.
        let (mut c1, _) = listener.accept().unwrap();
        write_frame(&mut c1, b"hello-1").unwrap();
        thread::sleep(Duration::from_millis(400));
        drop(c1);
        // Connection 2 (reconnect): send a frame.
        let (mut c2, _) = listener.accept().unwrap();
        write_frame(&mut c2, b"hello-2").unwrap();
    });

    let mut st = ConnState::Disconnected;
    st = st.try_transition(ConnState::Connecting).unwrap();
    let mut sock = TcpStream::connect(addr).unwrap();
    st = st.try_transition(ConnState::Direct).unwrap();
    assert!(st.is_online());

    sock.set_read_timeout(Some(Duration::from_millis(120)))
        .unwrap();
    assert_eq!(read_frame(&mut sock).unwrap(), b"hello-1");

    // Hub quiet -> the next read times out. The real timeout is LOAD-BEARING:
    // only a genuine read timeout (not EOF/other) drives the Stale transition;
    // anything else panics. So the socket event truly causes the state change.
    match read_frame(&mut sock) {
        Err(TransportError::Io(e))
            if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
        {
            st = st.try_transition(ConnState::Stale).unwrap();
        }
        other => panic!("expected a read timeout while the hub was quiet, got {other:?}"),
    }
    assert!(st.is_stale_or_offline());
    drop(sock);

    // Reconnect.
    st = st.try_transition(ConnState::Connecting).unwrap();
    let mut sock2 = TcpStream::connect(addr).unwrap();
    sock2
        .set_read_timeout(Some(Duration::from_millis(2000)))
        .unwrap();
    st = st.try_transition(ConnState::Direct).unwrap();
    assert_eq!(read_frame(&mut sock2).unwrap(), b"hello-2");
    assert!(st.is_online());

    hub.join().unwrap();
}
