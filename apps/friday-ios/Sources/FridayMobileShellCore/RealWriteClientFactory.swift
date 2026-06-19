import CryptoKit
import Foundation
import FridayRustClient
import Network

// MARK: - Real WRITE-client factory (the J2 device-pairing / Hub↔phone sync write seam)
//
// MIRRORS the iOS READ seam `RealReadClientFactory.makeLive` (#696) and the desktop NWConnection
// sealed transport precedent, but for the sealed-WS WRITE / agent-run server
// (`bin/hub_agent_run_server.rs`) on the loopback WRITE port. Builds the REAL `SealedWSWriteClient`
// (the shared `FridayRustClient` package's sealed-WS WRITE client) configured for the agent-run
// server's LOOPBACK host:port, driven over a concrete `NWConnection`-backed `SealedWSTransport`.
//
// REUSE, NO DIVERGENT IMPL: the network transport is the SAME `LoopbackSealedWSTransport` the read
// seam uses (the socket plumbing + the cleartext length-prefixed preamble + the hand-rolled
// RFC-6455 client upgrade + the masked Binary framing are byte-identical for read and write — the
// Rust `establish_session` is the SHARED handshake for both servers). The crypto is the shared
// package's X25519 ECDH → HKDF-SHA256 → XChaCha20-Poly1305; the master-derived peer is the SHARED
// `MasterKeyPeer` from #696. This file adds NO fresh crypto and NO second transport class.
//
// SINGLE-PEER-TRAP SAFETY: the WRITE server reads the SAME `PEER_PUBKEY_ALLOWLIST_ID` single-peer
// SecureStore the READ server reads (`~/.friday/agent-run-securestore`), enrolled to EXACTLY the
// master-derived peer. We therefore derive — NEVER enroll — the master-derived keypair in memory
// (`MasterKeyPeer.deriveKeypair`). A fresh enroll would EVICT that one peer and break BOTH seams.
//
// HONEST CEILING: against a DARK / un-flipped write server (nothing listening, or the peer not
// enrolled) the connect / preamble / handshake fails honestly → the Friday Chat surface renders
// honest-unavailable. The LIVE round-trip this enables is the sealed HANDSHAKE + peer-auth; a live
// agent-run MUTATION (S6 control plane) is operator-gated and DARK — this seam does NOT dispatch
// one, and the default shipped transport stays the throwing `liveTransportNotWired`.

/// Configuration for the real WRITE client's connection to the agent-run server. A WRITE-side twin
/// of `ReadProjectionServerConfig` (a distinct type so a read config can never be mis-pointed at the
/// write port and vice-versa).
public struct AgentRunServerConfig: Sendable, Equatable {
  /// Loopback host the agent-run WRITE server listens on (default `127.0.0.1`).
  public let host: String
  /// TCP port the agent-run WRITE server listens on.
  public let port: UInt16
  /// Connect / preamble timeout. Past this, a dark server surfaces as honest unavailable.
  public let connectTimeout: TimeInterval
  /// Agent-run result timeout. Long enough for real model turns while connect failure remains fast.
  public let receiveTimeout: TimeInterval

  public init(
    host: String = "127.0.0.1",
    port: UInt16,
    connectTimeout: TimeInterval = 4,
    receiveTimeout: TimeInterval = 300
  ) {
    self.host = host
    self.port = port
    self.connectTimeout = connectTimeout
    self.receiveTimeout = receiveTimeout
  }

  /// The LIVE write seam: the loopback host:port the agent-run WRITE LaunchAgent
  /// (`com.friday.rust-agent-run-ws-server`) listens on. The staged plist pins `--port 48750`
  /// (distinct from the read-projection server on 48751 and the TS hub on 48060).
  ///
  /// HONEST NOTE: `48750` is the value the operator's LaunchAgent pins, NOT a bin default. If the
  /// operator relaunches on a different port, update here / pass an explicit config. When nothing
  /// listens on this port, the transport fails honestly → honest "unavailable".
  public static let liveLoopback = AgentRunServerConfig(host: "127.0.0.1", port: 48750)
}

/// The owner principal the agent-run WRITE LaunchAgent enrolls in its owner-allowlist
/// (`--owner admin-001` in `com.friday.rust-agent-run-ws-server.plist`). The live
/// `forwarded_principal` MUST equal an owner-allowlist entry or a DISPATCHED run fails closed.
/// (A handshake-only probe never asserts the principal — owner-auth is exercised only by a
/// dispatch, which the live-write transport proof deliberately does NOT send.)
public let liveAgentRunOwnerPrincipal = "admin-001"

/// Mobile live WRITE client with both the legacy chat dispatch API and the first-class
/// mission-bound dispatch API. The concrete implementation is still the shared `SealedWSWriteClient`.
public typealias FridayMobileMissionDispatchingWriteClient =
  FridayRustWriteClient & FridayMissionSpineWriteClient & FridayMissionBoundRunWriteClient

/// Builds the REAL `SealedWSWriteClient` for the agent-run WRITE server.
public enum RealWriteClientFactory {
  /// Construct the real write client over the `NWConnection` write transport.
  ///
  /// - Parameters:
  ///   - config: the agent-run WRITE server's loopback host:port.
  ///   - keypair: this client's X25519 keypair. Its public key MUST be the server's enrolled
  ///     peer-allowlist entry (the master-derived peer) or the handshake is refused before the
  ///     server sends its own pubkey. Defaults to a fresh ephemeral keypair (sufficient to drive
  ///     the NEGATIVE control / honest-unavailable against the live server; the real enrolled path
  ///     is `makeLive`, which derives the master peer).
  ///   - forwardedPrincipal: the owner principal; MUST be in the server's owner-allowlist (only
  ///     exercised by a DISPATCH — never by a handshake-only probe).
  ///   - sessionId: optional session id for a sessioned (multi-turn chat) run.
  ///   - agentRunControlViaRust: DEFAULT-OFF run-control flag (the S6 pause/approve/resume gate).
  public static func make(
    config: AgentRunServerConfig,
    keypair: FridayCrypto.DeviceKeypair = FridayCrypto.DeviceKeypair(),
    forwardedPrincipal: String,
    sessionId: String? = nil,
    agentRunControlViaRust: Bool = false
  ) -> FridayMobileMissionDispatchingWriteClient {
    SealedWSWriteClient(
      keypair: keypair,
      forwardedPrincipal: forwardedPrincipal,
      sessionId: sessionId,
      agentRunControlViaRust: agentRunControlViaRust,
      makeTransport: { try LoopbackSealedWSTransport(config: ReadProjectionServerConfig(
        host: config.host,
        port: config.port,
        connectTimeout: config.connectTimeout,
        receiveTimeout: config.receiveTimeout)) }
    )
  }

  /// Construct the LIVE write client — the enrolled master-derived peer connecting to the live
  /// agent-run WRITE server.
  ///
  /// Derives the keypair from `~/.friday/master.key` (or `FRIDAY_MASTER_KEY`) the SAME way the
  /// enroll CLI did (so its pubkey IS the allowlisted peer the WRITE server reads from the SHARED
  /// single-peer SecureStore); targets `liveLoopback` (48750); authenticates as `admin-001`. Throws
  /// (fail-closed) if the master key is missing/invalid — never substitutes an ephemeral key for the
  /// live path, and NEVER enrolls a fresh key (single-peer-trap safe: `MasterKeyPeer.deriveKeypair`
  /// only reads + derives in memory; enrolling would evict the desktop write-peer + break BOTH seams).
  ///
  /// This is the launch-mode the app selects under `FRIDAY_MOBILE_LIVE_WRITE=1` / `--live-write`.
  /// The honest-unavailable (throwing `liveTransportNotWired`) client stays the shipped default;
  /// this never runs without an enrolled host master key, and only on the env/arg opt-in.
  ///
  /// `agentRunControlViaRust` stays DEFAULT-OFF here (the S6 control plane is a separate operator
  /// gate); wiring the live transport does NOT flip it on.
  public static func makeLive(
    config: AgentRunServerConfig = .liveLoopback,
    forwardedPrincipal: String = liveAgentRunOwnerPrincipal,
    sessionId: String? = nil,
    agentRunControlViaRust: Bool = false
  ) throws -> FridayMobileMissionDispatchingWriteClient {
    let keypair = try MasterKeyPeer.deriveKeypair()
    return make(
      config: config,
      keypair: keypair,
      forwardedPrincipal: forwardedPrincipal,
      sessionId: sessionId,
      agentRunControlViaRust: agentRunControlViaRust)
  }
}
