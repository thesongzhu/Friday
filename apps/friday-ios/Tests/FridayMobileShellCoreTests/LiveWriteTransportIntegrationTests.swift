import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE write-transport sealed-handshake integration (MANUAL / env-gated — CI SKIPS)
//
// The J2 mirror of `LiveReadProjectionIntegrationTests` (#696), but for the sealed-WS WRITE /
// agent-run server (`bin/hub_agent_run_server.rs`) on 127.0.0.1:48750. It drives the iOS
// `LoopbackSealedWSTransport` (the SAME transport the read seam uses — no divergent impl) as the
// enrolled MASTER-DERIVED peer (the SAME peer the read seam + the desktop derive, read from the
// host `~/.friday/master.key`), and asserts the cleartext preamble + the RFC-6455 WS upgrade + the
// ECDH session-key agreement COMPLETE — i.e. peer-auth passed at the SHARED `establish_session`
// (`sealed_ws.rs`), which gates the SecureStore peer-allowlist FIRST, BEFORE the server writes back
// its own pubkey + the 64-byte session nonce. So a peer that receives the server pubkey + a 64-byte
// nonce HAS been peer-authenticated by the write server.
//
// These read a real host secret and require a live server, so they are GATED on
// `FRIDAY_MOBILE_LIVE_WRITE_TEST=1` and are SKIPPED in CI (which has no such server and must never
// read the host master key).
//
// Run locally (the agent-run WRITE server must already be listening — verify with
// `lsof -nP -iTCP:48750 -sTCP:LISTEN`):
//   FRIDAY_MOBILE_LIVE_WRITE_TEST=1 swift test --package-path apps/friday-ios \
//     --filter LiveWriteTransport
//
// PROOF CEILING (honest — read it before trusting the green):
//   * This proves the iOS WRITE-TRANSPORT sealed HANDSHAKE + peer-auth ONLY. It is deliberately
//     NON-MUTATING: it sends ZERO `AgentRunRequest` envelopes. Dispatching a run would START A RUN
//     (the S6 control plane is DARK + operator-gated) — so this test STOPS at the completed
//     handshake and NEVER calls `dispatchAgentRun`.
//   * It therefore does NOT prove a live agent-run, a live mutation, or owner-principal admission
//     (the `forwarded_principal` owner-auth is exercised only by a DISPATCH, which we do not send).
//     Those are slice-6 / operator gates.
//   * SINGLE-PEER-TRAP: the master-derived path NEVER enrolls a fresh key — it only reads the
//     master key and derives in memory. The negative control's ephemeral `DeviceKeypair()` opens a
//     socket but writes NOTHING to the shared SecureStore.
//   * SECRET DISCIPLINE: we print the PUBLIC key hex + handshake byte LENGTHS only — never the
//     master key, the derived secret, or the session key.

private let liveWriteTestEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_WRITE_TEST"] == "1"

/// Drive the sealed-WS handshake (preamble + WS upgrade + ECDH) over the live write transport as the
/// enrolled master-derived peer, asserting peer-auth completes. NON-MUTATING: no envelope is sent.
@Test(.enabled(if: liveWriteTestEnabled))
func liveWriteTransportSealedHandshakeWithMasterDerivedPeer() throws {
  // The enrolled peer: derive the keypair from the host master key the SAME way the enroll CLI did.
  // Its pubkey is the allowlisted peer the WRITE server reads from the SHARED single-peer
  // SecureStore (offline-proven byte-identical by `masterDerivedPubkeyMatchesRustKat`; here it is
  // the REAL host key).
  let keypair = try MasterKeyPeer.deriveKeypair()
  print("[live-write] master-derived peer pubkey (PUBLIC) = \(Hex.encode(keypair.publicKey))")

  // The SAME transport the read seam uses, pointed at the WRITE port (48750).
  let transport = try LoopbackSealedWSTransport(config: ReadProjectionServerConfig(
    host: AgentRunServerConfig.liveLoopback.host,
    port: AgentRunServerConfig.liveLoopback.port))

  // PHASE 1 — the cleartext preamble. Send our (enrolled) pubkey. The write server runs the
  // peer-allowlist gate FIRST in `establish_session`; only an ALLOWLISTED peer then receives the
  // server pubkey + the 64-byte session nonce. Receiving them IS the peer-auth proof.
  try transport.writeFrame(keypair.publicKey)

  let serverPub = try transport.readFrame()
  print("[live-write] server pubkey bytes = \(serverPub.count)")
  #expect(serverPub.count == FridayCrypto.x25519PublicKeyLen)

  let sessionNonce = try transport.readFrame()
  print("[live-write] session nonce bytes = \(sessionNonce.count)")
  #expect(sessionNonce.count == 64)  // SESSION_NONCE_LEN — must match the write client's check.

  // PHASE 1→2 — the RFC-6455 client WS upgrade over the (preamble-consumed) socket. The server is
  // plain tungstenite over ws://; this validates 101 + Sec-WebSocket-Accept.
  try transport.upgrade()

  // The ECDH session-key agreement — the byte-exact shared substrate (X25519 → the per-session
  // key the WRITE SESSION_AAD seals under). A 32-byte agreed key = the sealed channel is live.
  let sessionKey = try keypair.agree(peerPublicKey: serverPub)
  print("[live-write] AUTHENTICATED HANDSHAKE OK — agreed session key bytes = \(sessionKey.count)")
  #expect(sessionKey.count == FridayCrypto.sessionKeyLen)

  // STOP HERE. We do NOT send an AgentRunRequest — that would start a run (S6 is dark +
  // operator-gated). The completed handshake + peer-auth is the transport proof.
}

/// NEGATIVE CONTROL — proves the master-derivation (peer-allowlist) is load-bearing. A FRESH
/// ephemeral keypair is NOT the enrolled allowlist peer, so the write server's `establish_session`
/// peer-allowlist gate fail-closes BEFORE writing back its pubkey — the session ends and the
/// transport read fails. DISTINCT from the master-derived peer's completed handshake.
@Test(.enabled(if: liveWriteTestEnabled))
func liveWriteTransportRefusesFreshEphemeralPeer() throws {
  let ephemeral = FridayCrypto.DeviceKeypair()
  print("[live-write] ephemeral (NON-enrolled) pubkey = \(Hex.encode(ephemeral.publicKey))")

  let transport = try LoopbackSealedWSTransport(config: ReadProjectionServerConfig(
    host: AgentRunServerConfig.liveLoopback.host,
    port: AgentRunServerConfig.liveLoopback.port))

  do {
    try transport.writeFrame(ephemeral.publicKey)
    let serverPub = try transport.readFrame()
    // If a server pubkey of the correct width comes back, a non-enrolled peer was admitted — a
    // peer-auth bypass. Fail loudly.
    if serverPub.count == FridayCrypto.x25519PublicKeyLen {
      Issue.record(
        "a non-enrolled ephemeral peer unexpectedly received a server pubkey (peer-auth bypass)")
    } else {
      // A short/empty frame is the server fail-closing — acceptable as a refusal signal.
      print("[live-write] ephemeral peer REFUSED (short/empty frame, \(serverPub.count) bytes) as expected")
    }
  } catch {
    // The expected outcome: the allowlist gate ended the session → the preamble read fails.
    print("[live-write] ephemeral peer REFUSED (fail-closed) as expected: \(error)")
  }
}
