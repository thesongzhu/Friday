import Foundation
import FridayRustClient

public typealias FridayMissionSpineDispatchingWriteClient =
  FridayMissionSpineWriteClient & FridayMissionBoundRunWriteClient & FridayRustWriteClient

// MARK: - Real mission-spine WRITE-client factory (Lane-D entry-point-A organic driver)
//
// Builds the REAL `SealedWSWriteClient` (the package's sealed-WS write client) configured for the
// agent-run WRITE server's LOOPBACK host:port (127.0.0.1:48750 — DISTINCT from the read seam on
// 48751), reusing the SAME concrete `NWConnection`-backed `LoopbackSealedWSTransport` the read
// client uses (it conforms to `SealedWSTransport` and is port-parameterized via its config). This
// is the "the desktop actually WRITES the live Rust spine" seam.
//
// SINGLE-PEER IDENTITY (the load-bearing fact): the write client derives its keypair the SAME way
// the read client does — `MasterKeyPeer.deriveKeypair()` — so its public key is the SAME
// master-derived peer ALREADY enrolled on the WRITE allowlist
// (`friday:execrun:ws:s-f:peer-pubkey-allowlist:v1`) by `hub_agent_run_enroll`. The desktop shares
// the live courier's enrolled identity — NO enrollment, NO eviction, single-peer satisfied
// automatically. We do NOT mint an ephemeral keypair for the live path (its pubkey is NOT enrolled
// → handshake refused) and we do NOT add a 2nd peer (would trip `enforce_single_peer`).
//
// NO auth_proof: the mission-spine arms (`submitMissionIntake`/`submitMemoryDecision`) authenticate
// by the SEALED SESSION alone (an allowlisted peer holding the session key). The server binds the
// write to the Rust-derived AUTHENTICATED owner `--owner admin-001` (FIX-Q3b).
//
// HONEST-UNAVAILABLE: against a DARK / un-flipped server (nothing listening, or the peer not
// enrolled, or the host master key absent) the connect / preamble / handshake fails and surfaces as
// a transport error → the view model's honest "unavailable" — never fake-confirmed.

/// Configuration for the real write client's connection to the agent-run WRITE server.
public struct AgentRunWriteServerConfig: Sendable, Equatable {
  /// Loopback host the WRITE server listens on (default `127.0.0.1`).
  public let host: String
  /// TCP port the WRITE server listens on.
  public let port: UInt16
  /// Connect / preamble timeout. Past this, a dark server surfaces as honest unavailable.
  public let connectTimeout: TimeInterval
  /// Agent-run result timeout. Long enough for real model turns while connect failure remains fast.
  public let receiveTimeout: TimeInterval

  public init(
    host: String = "127.0.0.1",
    port: UInt16,
    connectTimeout: TimeInterval = 4,
    receiveTimeout: TimeInterval = 360
  ) {
    self.host = host
    self.port = port
    self.connectTimeout = connectTimeout
    self.receiveTimeout = receiveTimeout
  }

  /// The LIVE agent-run WRITE seam: the loopback host:port the agent-run WRITE LaunchAgent
  /// (`com.friday.rust-agent-run-ws-server`) listens on. The live launch script pins `--port 48750`
  /// (distinct from the read-projection server on 48751 and the TS hub on 48060).
  ///
  /// HONEST NOTE: `48750` is the value the operator's launch script pins, NOT a bin default. If the
  /// operator relaunches on a different port, update here / pass an explicit config. When nothing
  /// listens on this port, the transport fails honestly → honest "unavailable".
  public static let liveLoopback = AgentRunWriteServerConfig(host: "127.0.0.1", port: 48750)

  /// Map to the read client's transport config (the transport class is shared + port-parameterized).
  var transportConfig: ReadProjectionServerConfig {
    ReadProjectionServerConfig(
      host: host, port: port, connectTimeout: connectTimeout, receiveTimeout: receiveTimeout)
  }
}

/// Builds the REAL `SealedWSWriteClient` (as the product-facing `FridayMissionSpineWriteClient`) for
/// the agent-run WRITE server.
public enum RealWriteClientFactory {
  /// Construct the real mission-spine write client.
  ///
  /// - Parameters:
  ///   - config: the WRITE server's loopback host:port.
  ///   - keypair: this client's X25519 keypair. Its public key MUST be enrolled in the WRITE
  ///     SecureStore peer-allowlist (already done for the master-derived peer) or the handshake is
  ///     refused. Defaults to a fresh ephemeral keypair (sufficient to PROVE honest-unavailable
  ///     against a dark server; the real enrolled identity is `makeLiveWrite`).
  ///   - forwardedPrincipal: the owner principal; MUST equal the server's `--owner` (`admin-001`).
  public static func make(
    config: AgentRunWriteServerConfig,
    keypair: FridayCrypto.DeviceKeypair = FridayCrypto.DeviceKeypair(),
    forwardedPrincipal: String
  ) -> FridayMissionSpineDispatchingWriteClient {
    let transportConfig = config.transportConfig
    return SealedWSWriteClient(
      keypair: keypair,
      forwardedPrincipal: forwardedPrincipal,
      makeTransport: { try LoopbackSealedWSTransport(config: transportConfig) }
    )
  }

  /// Construct the LIVE mission-spine write client — the enrolled master-derived peer writing the
  /// live agent-run WRITE server (the SAME enrolled identity the courier uses).
  ///
  /// Derives the keypair from `~/.friday/master.key` (or `FRIDAY_MASTER_KEY`) the SAME way the
  /// read client + the enroll CLI did, so its pubkey IS the allowlisted WRITE peer; targets
  /// `liveLoopback` (48750); and authenticates as `admin-001` (the LaunchAgent's `--owner`). Throws
  /// (fail-closed) if the master key is missing/invalid — never substitutes an ephemeral key for the
  /// live path (mirrors `RealReadClientFactory.makeLive`).
  public static func makeLiveWrite(
    config: AgentRunWriteServerConfig = .liveLoopback,
    forwardedPrincipal: String = liveReadProjectionOwnerPrincipal
  ) throws -> FridayMissionSpineDispatchingWriteClient {
    let keypair = try MasterKeyPeer.deriveKeypair()
    return make(config: config, keypair: keypair, forwardedPrincipal: forwardedPrincipal)
  }

  /// A real-protocol write client that always fails closed to honest "unavailable" with `reason`.
  /// Used by the app when LIVE mode is requested but the master key is unavailable: the compose /
  /// confirm controls must render the truth, NOT a fabricated success (mirrors the read side's
  /// `makeHonestlyUnavailable`).
  public static func makeHonestlyUnavailableWrite(reason: String) -> FridayMissionSpineDispatchingWriteClient {
    HonestlyUnavailableWriteClient(reason: reason)
  }
}

/// A `FridayMissionSpineWriteClient` that always throws — so the view model renders honest
/// "unavailable". Never returns a result; it cannot fabricate a confirm.
struct HonestlyUnavailableWriteClient: FridayMissionSpineWriteClient, FridayMissionBoundRunWriteClient, FridayRustWriteClient {
  let reason: String
  func dispatchAgentRun(
    task: String,
    constraints: AgentRunConstraintsWire?
  ) async throws -> AgentRunDispatchOutcome {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
    throw FridayWriteClientError.transport("live write client unavailable: \(self.reason)")
  }
  func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func submitRunOutcomeLearningDecision(
    _ request: RunOutcomeLearningDecisionRequestWire
  ) async throws -> RunOutcomeLearningDecisionResultWire {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func submitActivityMarkDone(_ request: ActivityMarkDoneRequestWire) async throws -> ActivityMarkDoneResultWire {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func submitWorkItemStatus(_ request: WorkItemStatusRequestWire) async throws -> WorkItemStatusResultWire {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
  func dispatchMissionBoundAgentRun(
    task: String,
    missionContext: MissionWorkItemContextWire,
    constraints: AgentRunConstraintsWire?
  ) async throws -> AgentRunDispatchOutcome {
    throw FridayWriteClientError.transport("live write client unavailable: \(reason)")
  }
}
