//! Friday Rust Core — framed E2E transport (gate `21` §4; `09` §1/§7).
//!
//! Carries `friday-protocol` envelopes over any byte stream (`Read`+`Write`):
//! length-prefixed frames, each frame an envelope serialized to JSON and then
//! **sealed under a `friday-crypto` session key** (X25519/HKDF, slice c). A relay
//! that forwards frames sees only ciphertext; without the session key it cannot
//! decrypt them — proven over a real loopback socket in `tests/transport.rs`.
//!
//! Framings: length-prefixed frames AND a real WebSocket upgrade/handshake
//! (`ws_accept`/`ws_connect`, carrying the sealed body as a Binary message) — both
//! exercised over real loopback sockets, including a relay hop and the
//! `Direct|Relay|Stale` connection-state machine (see `tests/`). E2E
//! confidentiality is at the seal layer, so relay-cannot-decrypt holds for both
//! framings. The only remaining Unit-4 transport gap is **real multi-host
//! network** transport (LAN/Tailscale/SSH), which needs peer hosts/Tailscale/SSH
//! and is environment-gated here — truth-labeled, not claimed.

use friday_crypto::{open, seal, DataKey, Sealed};
use friday_protocol::Envelope;
use std::io::{Read, Write};
use thiserror::Error;
use tungstenite::{Message, WebSocket};

/// Public WebSocket carrier type for crates that need to bind a domain handler
/// to the already-tested Friday E2E WebSocket framing without depending on
/// tungstenite directly.
pub type WireWebSocket<S> = WebSocket<S>;

/// 1 MiB cap on a single frame (defensive; the slice has no large payloads).
pub const MAX_FRAME: usize = 1 << 20;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame too large: {0} bytes")]
    FrameTooLarge(usize),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("crypto error: {0}")]
    Crypto(#[from] friday_crypto::CryptoError),
    // tungstenite::Error is a large enum; store its message as a String so
    // TransportError stays small (avoids clippy::result_large_err on every fn).
    #[error("websocket error: {0}")]
    WebSocket(String),
}

/// Write a length-prefixed frame (4-byte big-endian length + payload).
pub fn write_frame<W: Write>(w: &mut W, payload: &[u8]) -> Result<(), TransportError> {
    if payload.len() > MAX_FRAME {
        return Err(TransportError::FrameTooLarge(payload.len()));
    }
    w.write_all(&(payload.len() as u32).to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()?;
    Ok(())
}

/// Read one length-prefixed frame.
pub fn read_frame<R: Read>(r: &mut R) -> Result<Vec<u8>, TransportError> {
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        return Err(TransportError::FrameTooLarge(n));
    }
    let mut buf = vec![0u8; n];
    r.read_exact(&mut buf)?;
    Ok(buf)
}

// On-wire sealed form: [nonce_len: u8][nonce][ciphertext]. Carries no key.
fn encode_sealed(s: &Sealed) -> Vec<u8> {
    let mut out = Vec::with_capacity(1 + s.nonce.len() + s.ciphertext.len());
    out.push(s.nonce.len() as u8);
    out.extend_from_slice(&s.nonce);
    out.extend_from_slice(&s.ciphertext);
    out
}

fn decode_sealed(wire: &[u8]) -> Result<Sealed, TransportError> {
    if wire.is_empty() {
        return Err(TransportError::Protocol("empty sealed frame".into()));
    }
    let nlen = wire[0] as usize;
    if wire.len() < 1 + nlen {
        return Err(TransportError::Protocol("sealed frame too short".into()));
    }
    Ok(Sealed {
        nonce: wire[1..1 + nlen].to_vec(),
        ciphertext: wire[1 + nlen..].to_vec(),
    })
}

/// Serialize + seal an envelope into a wire frame body (E2E under the session key).
pub fn seal_envelope(key: &DataKey, env: &Envelope, aad: &[u8]) -> Result<Vec<u8>, TransportError> {
    let json = env
        .encode()
        .map_err(|e| TransportError::Protocol(e.to_string()))?;
    let sealed = seal(key, json.as_bytes(), aad)?;
    Ok(encode_sealed(&sealed))
}

/// Open + deserialize a wire frame body back into an envelope.
pub fn open_envelope(key: &DataKey, wire: &[u8], aad: &[u8]) -> Result<Envelope, TransportError> {
    let sealed = decode_sealed(wire)?;
    let pt = open(key, &sealed, aad)?;
    let s =
        std::str::from_utf8(&pt).map_err(|_| TransportError::Protocol("invalid utf8".into()))?;
    Envelope::decode(s).map_err(|e| TransportError::Protocol(e.to_string()))
}

/// Convenience: seal an envelope and write it as a frame.
pub fn send_envelope<W: Write>(
    w: &mut W,
    key: &DataKey,
    env: &Envelope,
    aad: &[u8],
) -> Result<(), TransportError> {
    let body = seal_envelope(key, env, aad)?;
    write_frame(w, &body)
}

/// Convenience: read a frame and open it into an envelope.
pub fn recv_envelope<R: Read>(
    r: &mut R,
    key: &DataKey,
    aad: &[u8],
) -> Result<Envelope, TransportError> {
    let body = read_frame(r)?;
    open_envelope(key, &body, aad)
}

// --- WebSocket framing (gate 21 §4: versioned E2E WebSocket protocol) --------
//
// The same sealed-envelope body is carried as a WebSocket Binary message over a
// real WS upgrade/handshake. E2E confidentiality is unchanged (the payload is
// sealed before framing), so the relay-cannot-decrypt property holds identically
// whether the framing is length-prefixed or WebSocket.

/// Seal an envelope and send it as a WebSocket Binary message.
pub fn ws_send_envelope<S: Read + Write>(
    ws: &mut WebSocket<S>,
    key: &DataKey,
    env: &Envelope,
    aad: &[u8],
) -> Result<(), TransportError> {
    let body = seal_envelope(key, env, aad)?;
    ws.send(Message::Binary(body))
        .map_err(|e| TransportError::WebSocket(e.to_string()))?;
    Ok(())
}

/// Read the next Binary WebSocket message and open it into an envelope.
/// Ping/Pong/raw frames are skipped; Text/Close are surfaced as errors.
pub fn ws_recv_envelope<S: Read + Write>(
    ws: &mut WebSocket<S>,
    key: &DataKey,
    aad: &[u8],
) -> Result<Envelope, TransportError> {
    loop {
        let msg = ws
            .read()
            .map_err(|e| TransportError::WebSocket(e.to_string()))?;
        match msg {
            Message::Binary(b) => return open_envelope(key, &b, aad),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
            Message::Text(_) => {
                return Err(TransportError::Protocol("unexpected text ws frame".into()))
            }
            Message::Close(_) => return Err(TransportError::Protocol("websocket closed".into())),
        }
    }
}

/// Server-side WebSocket handshake over an accepted stream.
pub fn ws_accept<S: Read + Write>(stream: S) -> Result<WebSocket<S>, TransportError> {
    tungstenite::accept(stream).map_err(|e| TransportError::Protocol(format!("ws accept: {e}")))
}

/// Client-side WebSocket handshake over a connected stream (uri e.g. `ws://host:port/`).
pub fn ws_connect<S: Read + Write>(uri: &str, stream: S) -> Result<WebSocket<S>, TransportError> {
    let (ws, _resp) = tungstenite::client(uri, stream)
        .map_err(|e| TransportError::Protocol(format!("ws connect: {e}")))?;
    Ok(ws)
}

#[cfg(test)]
mod tests {
    use super::*;
    use friday_crypto::DataKey;
    use friday_protocol::{Envelope, Message};

    #[test]
    fn frame_round_trip_in_memory() {
        let mut buf: Vec<u8> = Vec::new();
        write_frame(&mut buf, b"hello-frame").unwrap();
        let mut cur = std::io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cur).unwrap(), b"hello-frame");
    }

    #[test]
    fn seal_open_envelope_round_trip() {
        let key = DataKey::generate();
        let env = Envelope::new(
            "m1",
            1,
            Message::AskFridayRequest {
                prompt: "secret prompt".into(),
            },
        );
        let wire = seal_envelope(&key, &env, b"aad").unwrap();
        // The plaintext prompt must not appear in the sealed wire bytes.
        assert!(!wire.windows(13).any(|w| w == b"secret prompt"));
        let back = open_envelope(&key, &wire, b"aad").unwrap();
        assert_eq!(back, env);
    }

    #[test]
    fn wrong_session_key_cannot_open() {
        let k1 = DataKey::generate();
        let k2 = DataKey::generate();
        let env = Envelope::new("m1", 1, Message::AskFridayRequest { prompt: "p".into() });
        let wire = seal_envelope(&k1, &env, b"aad").unwrap();
        assert!(open_envelope(&k2, &wire, b"aad").is_err());
    }
}
