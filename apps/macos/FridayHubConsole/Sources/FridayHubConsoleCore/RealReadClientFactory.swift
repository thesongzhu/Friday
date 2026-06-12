import Foundation
import FridayRustClient
import Network

// MARK: - Real read-client factory + loopback transport
//
// Builds the REAL `SealedWSReadClient` (the package's sealed-WS read client) configured for
// the read-projection server's LOOPBACK host:port, with a concrete `NWConnection`-backed
// `SealedWSTransport`. This is the "the app actually reads the live Rust core" seam.
//
// STATUS (pre-slice-6): the Rust read-projection server (#675/#678) is DARK / not yet flipped.
// So this client CANNOT connect yet — that is EXPECTED. The loopback transport genuinely
// attempts host:port; against the dark server it fails at connect / preamble-read, throwing
// `FridayReadClientError.transport(...)`. The view model maps that to the honest "unavailable"
// state — the CORRECT pre-slice-6 behavior. The live round-trip (real WS upgrade + sealed
// exchange against a RUNNING server with the UI peer pubkey enrolled) is the DEFERRED slice-6
// acceptance criterion; this factory does not claim it.

/// Configuration for the real read client's connection to the read-projection server.
public struct ReadProjectionServerConfig: Sendable, Equatable {
  /// Loopback host the read-projection server listens on (default `127.0.0.1`).
  public let host: String
  /// TCP port the read-projection server listens on.
  public let port: UInt16
  /// Connect / preamble timeout. Past this, a dark server surfaces as honest unavailable.
  public let connectTimeout: TimeInterval

  public init(host: String = "127.0.0.1", port: UInt16, connectTimeout: TimeInterval = 4) {
    self.host = host
    self.port = port
    self.connectTimeout = connectTimeout
  }

  /// A PLACEHOLDER loopback config for pre-slice-6.
  ///
  /// HONEST NOTE: the read-projection server (`hub_read_projection_server.rs`) takes its port
  /// from an operator `--port` CLI arg and DEFAULTS to `0` (OS-assigned) — there is NO fixed
  /// well-known port to point at yet. This placeholder is intentionally a port the dark server
  /// is NOT listening on, so it surfaces as honest-unavailable. The ACTUAL host:port is wired
  /// from the operator's launch config at the slice-6 flip — confirm it there, do not trust
  /// this constant as the live endpoint.
  public static let slice6LoopbackPlaceholder = ReadProjectionServerConfig(
    host: "127.0.0.1", port: 8799)
}

/// Builds the REAL `SealedWSReadClient` for the read-projection server.
public enum RealReadClientFactory {
  /// Construct the real read client.
  ///
  /// - Parameters:
  ///   - config: the read-projection server's loopback host:port.
  ///   - keypair: this client's X25519 keypair. Its public key MUST be enrolled in the
  ///     server's SecureStore peer-allowlist (the slice-6 operator step) or the handshake is
  ///     refused. Defaults to a fresh ephemeral keypair (sufficient to PROVE honest-unavailable
  ///     against the dark server; real enrollment is the slice-6 gate).
  ///   - forwardedPrincipal: the owner principal; MUST be in the server's owner-allowlist.
  ///   - missionId: optional Mission id; `nil` ⇒ the server's first active Mission.
  public static func make(
    config: ReadProjectionServerConfig,
    keypair: FridayCrypto.DeviceKeypair = FridayCrypto.DeviceKeypair(),
    forwardedPrincipal: String,
    missionId: String? = nil
  ) -> FridayRustReadClient {
    SealedWSReadClient(
      keypair: keypair,
      forwardedPrincipal: forwardedPrincipal,
      missionId: missionId,
      makeTransport: { try LoopbackSealedWSTransport(config: config) }
    )
  }
}

// MARK: - NWConnection-backed loopback transport

/// A concrete `SealedWSTransport` over an `NWConnection` TCP loopback socket. It genuinely
/// attempts the connection + cleartext preamble framing. Against the DARK read-projection
/// server (the normal pre-slice-6 state) the connect fails / the preamble read returns no
/// bytes, surfaced as `FridayReadClientError.transport(...)` → honest unavailable.
///
/// SCOPE: this carries the byte-exact preamble framing (`BE32(len) || payload`, mirroring
/// `friday_transport::write_frame`/`read_frame`) so a connect against a LIVE server makes
/// real progress. The `upgrade()` (real RFC-6455 WS handshake) + WS message framing are
/// the DEFERRED slice-6 live-round-trip work and throw `transport("...deferred...")` here —
/// reached ONLY after a successful connect+preamble, which the dark server never grants.
final class LoopbackSealedWSTransport: SealedWSTransport {
  private let connection: NWConnection
  private let timeout: TimeInterval
  private var started = false

  init(config: ReadProjectionServerConfig) throws {
    guard let port = NWEndpoint.Port(rawValue: config.port) else {
      throw FridayReadClientError.transport("invalid read-projection port \(config.port)")
    }
    self.timeout = config.connectTimeout
    self.connection = NWConnection(
      host: NWEndpoint.Host(config.host),
      port: port,
      using: .tcp
    )
  }

  /// Bring the connection to `.ready`, or throw on failure/timeout. Against the dark server
  /// this is where we fail honestly (connection refused / timed out).
  private func ensureStarted() throws {
    guard !started else { return }
    started = true
    let semaphore = DispatchSemaphore(value: 0)
    let outcome = OutcomeBox()
    connection.stateUpdateHandler = { state in
      switch state {
      case .ready:
        outcome.set(nil)
        semaphore.signal()
      case let .failed(error):
        outcome.set(FridayReadClientError.transport("connect failed: \(error)"))
        semaphore.signal()
      case let .waiting(error):
        // No listener (refused) keeps NWConnection in `.waiting`; treat as offline, do not hang.
        outcome.set(FridayReadClientError.transport("connect waiting (no server): \(error)"))
        semaphore.signal()
      case .cancelled:
        outcome.set(FridayReadClientError.transport("connection cancelled"))
        semaphore.signal()
      default:
        break
      }
    }
    connection.start(queue: .global())
    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
      connection.cancel()
      throw FridayReadClientError.transport("connect timed out after \(timeout)s (server dark?)")
    }
    if let error = outcome.take() { throw error }
  }

  func writeFrame(_ payload: [UInt8]) throws {
    try ensureStarted()
    var frame = [UInt8]()
    let len = UInt32(payload.count)
    frame.append(UInt8((len >> 24) & 0xff))
    frame.append(UInt8((len >> 16) & 0xff))
    frame.append(UInt8((len >> 8) & 0xff))
    frame.append(UInt8(len & 0xff))
    frame.append(contentsOf: payload)
    try send(Data(frame))
  }

  func readFrame() throws -> [UInt8] {
    try ensureStarted()
    let header = try receiveExactly(4)
    let len =
      (UInt32(header[0]) << 24) | (UInt32(header[1]) << 16)
      | (UInt32(header[2]) << 8) | UInt32(header[3])
    if len == 0 { return [] }
    return try receiveExactly(Int(len))
  }

  func upgrade() throws {
    // The real RFC-6455 WebSocket upgrade is the DEFERRED slice-6 live-round-trip work. It is
    // only ever reached AFTER a successful connect + preamble, which the dark read-projection
    // server never grants — so the honest-unavailable path is exercised long before here.
    throw FridayReadClientError.transport(
      "WS upgrade is the deferred slice-6 live-round-trip step (not wired pre-flip)")
  }

  func sendMessage(_ body: [UInt8]) throws {
    throw FridayReadClientError.transport("WS messaging deferred to slice-6 (not reached pre-flip)")
  }

  func recvMessage() throws -> [UInt8] {
    throw FridayReadClientError.transport("WS messaging deferred to slice-6 (not reached pre-flip)")
  }

  // MARK: NWConnection send/receive bridged to the synchronous transport contract.

  private func send(_ data: Data) throws {
    let semaphore = DispatchSemaphore(value: 0)
    let outcome = OutcomeBox()
    connection.send(
      content: data,
      completion: .contentProcessed { error in
        if let error { outcome.set(FridayReadClientError.transport("send failed: \(error)")) }
        semaphore.signal()
      })
    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
      throw FridayReadClientError.transport("send timed out (server dark?)")
    }
    if let error = outcome.take() { throw error }
  }

  private func receiveExactly(_ count: Int) throws -> [UInt8] {
    var collected = [UInt8]()
    collected.reserveCapacity(count)
    while collected.count < count {
      let chunk = try receiveSome(min: 1, max: count - collected.count)
      if chunk.isEmpty {
        throw FridayReadClientError.transport("connection closed mid-frame (server dark?)")
      }
      collected.append(contentsOf: chunk)
    }
    return collected
  }

  private func receiveSome(min: Int, max: Int) throws -> [UInt8] {
    let semaphore = DispatchSemaphore(value: 0)
    let outcome = OutcomeBox()
    let dataBox = DataBox()
    connection.receive(minimumIncompleteLength: min, maximumLength: max) {
      content, _, isComplete, error in
      if let content { dataBox.set([UInt8](content)) }
      if let error {
        outcome.set(FridayReadClientError.transport("receive failed: \(error)"))
      } else if (content == nil || content!.isEmpty) && isComplete {
        // EOF with no bytes — the dark server never wrote a preamble.
        outcome.set(FridayReadClientError.transport("connection closed (server dark?)"))
      }
      semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
      throw FridayReadClientError.transport("receive timed out (server dark?)")
    }
    if let error = outcome.take() { throw error }
    return dataBox.take()
  }

  deinit { connection.cancel() }
}

// Small thread-safe boxes so the NWConnection callbacks (on a global queue) can hand a
// result back to the waiting synchronous caller without data races.
private final class OutcomeBox: @unchecked Sendable {
  private let lock = NSLock()
  private var error: Error?
  func set(_ error: Error?) {
    lock.lock(); defer { lock.unlock() }
    if self.error == nil { self.error = error }
  }
  func take() -> Error? {
    lock.lock(); defer { lock.unlock() }
    return error
  }
}

private final class DataBox: @unchecked Sendable {
  private let lock = NSLock()
  private var bytes: [UInt8] = []
  func set(_ bytes: [UInt8]) {
    lock.lock(); defer { lock.unlock() }
    self.bytes = bytes
  }
  func take() -> [UInt8] {
    lock.lock(); defer { lock.unlock() }
    return bytes
  }
}
