import Foundation
import FridayRustClient

/// **The integration factory** — builds the REAL sealed-WS clients the iOS surfaces depend on,
/// with the mock behind an explicit preview/debug flag.
///
/// This is the single place the iOS app reconciles to the PACKAGE's real clients: the Home
/// surface gets a real `SealedWSReadClient`; the Friday Chat surface gets a real
/// `SealedWSWriteClient`. The concrete network transport (a live `NWConnection`-backed
/// `SealedWSTransport` against a RUNNING Rust server with the UI peer pubkey enrolled) is the
/// DEFERRED slice-6 acceptance criterion — until then the injected transport factory fails to
/// connect and the view models render honest-unavailable (which is the EXPECTED state while the
/// servers are DARK).
public enum FridayClientFactory {

  /// The endpoint + identity a real sealed-WS client binds to. Sourced from the operator's
  /// paired-Hub config at runtime (the device-pairing seam). All fields are refs/identity —
  /// NO secret rides here; the X25519 keypair is held by the device keychain, never logged.
  public struct Endpoint: Sendable {
    public let forwardedPrincipal: String
    public let missionId: String?
    public let sessionId: String?
    /// DEFAULT-OFF run-control flag (mirrors `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`). OFF ⇒ the chat
    /// loop is read-only-only (a pause fails closed); ON ⇒ the S6 pause/approve/resume is live.
    /// Flipping this ON in production is part of the slice-6 operator gate.
    public let agentRunControlViaRust: Bool

    public init(
      forwardedPrincipal: String,
      missionId: String? = nil,
      sessionId: String? = nil,
      agentRunControlViaRust: Bool = false
    ) {
      self.forwardedPrincipal = forwardedPrincipal
      self.missionId = missionId
      self.sessionId = sessionId
      self.agentRunControlViaRust = agentRunControlViaRust
    }
  }

  /// Build the REAL read client for the Home surface. The `makeTransport` closure is the live
  /// network transport (deferred slice-6); a default that throws yields honest-unavailable.
  public static func makeReadClient(
    keypair: FridayCrypto.DeviceKeypair,
    endpoint: Endpoint,
    makeTransport: @escaping () throws -> SealedWSTransport = { throw FridayClientFactoryError.liveTransportNotWired }
  ) -> FridayRustReadClient {
    SealedWSReadClient(
      keypair: keypair,
      forwardedPrincipal: endpoint.forwardedPrincipal,
      missionId: endpoint.missionId,
      makeTransport: makeTransport
    )
  }

  /// Build the REAL write client for the Friday Chat read-WRITE surface.
  public static func makeWriteClient(
    keypair: FridayCrypto.DeviceKeypair,
    endpoint: Endpoint,
    makeTransport: @escaping () throws -> SealedWSTransport = { throw FridayClientFactoryError.liveTransportNotWired }
  ) -> FridayRustWriteClient {
    SealedWSWriteClient(
      keypair: keypair,
      forwardedPrincipal: endpoint.forwardedPrincipal,
      sessionId: endpoint.sessionId,
      agentRunControlViaRust: endpoint.agentRunControlViaRust,
      makeTransport: makeTransport
    )
  }
}

/// Factory-level failures. `liveTransportNotWired` is the EXPECTED state while the Rust servers
/// are DARK (the live transport is the slice-6 deferred AC) — it surfaces as honest-unavailable.
public enum FridayClientFactoryError: Error, Sendable, Equatable, CustomStringConvertible {
  case liveTransportNotWired

  public var description: String {
    switch self {
    case .liveTransportNotWired:
      return "live connection is not set up yet"
    }
  }
}
