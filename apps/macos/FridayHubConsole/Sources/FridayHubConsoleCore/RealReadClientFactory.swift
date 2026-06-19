import CryptoKit
import Foundation
import FridayRustClient
import Network

// MARK: - Real read-client factory + loopback transport
//
// Builds the REAL `SealedWSReadClient` (the package's sealed-WS read client) configured for
// the read-projection server's LOOPBACK host:port, with a concrete `NWConnection`-backed
// `SealedWSTransport`. This is the "the app actually reads the live Rust core" seam.
//
// LIVE ROUND-TRIP (this PR): `LoopbackSealedWSTransport` now carries the FULL sealed-WS round
// trip — the cleartext length-prefixed preamble (`BE32(len)‖payload`), a hand-rolled RFC-6455
// client WebSocket upgrade over the SAME raw `NWConnection` (masked client frames, the
// `Sec-WebSocket-Accept` check), and Binary message framing — byte-matching the Rust
// `friday_transport` (`write_frame`/`read_frame` then a tungstenite `WireWebSocket` carrying the
// sealed body as a Binary message). Against a RUNNING server with the master-derived UI peer
// enrolled, this completes the handshake → owner-authed request → opens the owner-sealed reply.
//
// HONEST-UNAVAILABLE (unchanged): against a DARK / un-flipped server (nothing listening, or the
// peer not enrolled), the connect / preamble / handshake fails and surfaces as
// `FridayReadClientError.transport(...)` → the view model's honest "unavailable" — never fake-ready.

/// Configuration for the real read client's connection to the read-projection server.
public struct ReadProjectionServerConfig: Sendable, Equatable {
  /// Loopback host the read-projection server listens on (default `127.0.0.1`).
  public let host: String
  /// TCP port the read-projection server listens on.
  public let port: UInt16
  /// Connect / preamble timeout. Past this, a dark server surfaces as honest unavailable.
  public let connectTimeout: TimeInterval
  /// Response-frame timeout. Defaults to `connectTimeout`; write clients can extend this for
  /// real model-turn agent runs without making dark-server connects hang.
  public let receiveTimeout: TimeInterval

  public init(
    host: String = "127.0.0.1",
    port: UInt16,
    connectTimeout: TimeInterval = 4,
    receiveTimeout: TimeInterval? = nil
  ) {
    self.host = host
    self.port = port
    self.connectTimeout = connectTimeout
    self.receiveTimeout = receiveTimeout ?? connectTimeout
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

  /// The LIVE read-projection seam: the loopback host:port the slice-6 read-projection
  /// LaunchAgent (`com.friday.read-projection-server`) listens on. The staged plist pins
  /// `--port 48751` (distinct from the agent-run WRITE server on 48750 and the TS hub on 48060).
  ///
  /// HONEST NOTE: the bin's `--port` defaults to `0` (OS-assigned) — `48751` is the value the
  /// operator's LaunchAgent pins, NOT a bin default. If the operator relaunches on a different
  /// port, update here / pass an explicit config. When nothing listens on this port, the
  /// transport fails honestly (the same path as the placeholder) → honest "unavailable".
  public static let liveLoopback = ReadProjectionServerConfig(
    host: "127.0.0.1", port: 48751)
}

/// The owner principal the read-projection LaunchAgent enrolls in its owner-allowlist
/// (`--owner admin-001` in the staged `com.friday.read-projection-server.plist`). The live
/// `forwarded_principal` MUST equal an owner-allowlist entry or the request fails closed
/// (the session ends with no response). `owner:hub-console-desktop` was a pre-live PLACEHOLDER.
public let liveReadProjectionOwnerPrincipal = "admin-001"

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

  /// Construct the LIVE read client — the enrolled master-derived peer reading the live
  /// read-projection server.
  ///
  /// Derives the keypair from `~/.friday/master.key` (or `FRIDAY_MASTER_KEY`) the SAME way the
  /// enroll CLI did, so its pubkey IS the allowlisted peer; targets `liveLoopback` (48751); and
  /// authenticates as `admin-001` (the LaunchAgent's `--owner`). Throws (fail-closed) if the
  /// master key is missing/invalid — never substitutes an ephemeral key for the live path.
  ///
  /// This is the DEFAULT launch-mode the app selects (the slice-6 flip): a normal run reads live.
  /// The mock is an explicit opt-in (`--use-mock-read-client` / `FRIDAY_CONSOLE_MOCK=1`) for
  /// design/demo work, and tests inject their own clients; this path never runs without an
  /// enrolled host master key (fail-closed otherwise → honest unavailable).
  public static func makeLive(
    config: ReadProjectionServerConfig = .liveLoopback,
    forwardedPrincipal: String = liveReadProjectionOwnerPrincipal,
    missionId: String? = nil
  ) throws -> FridayRustReadClient {
    let keypair = try MasterKeyPeer.deriveKeypair()
    return make(
      config: config,
      keypair: keypair,
      forwardedPrincipal: forwardedPrincipal,
      missionId: missionId)
  }

  /// A real-protocol client that always fails closed to honest "unavailable" with `reason`.
  /// Used by the app when LIVE mode is requested but the master key is unavailable: the UI must
  /// render the truth, NOT silently fall back to the mock (which would fabricate a ready view).
  public static func makeHonestlyUnavailable(reason: String) -> FridayRustReadClient {
    HonestlyUnavailableReadClient(reason: reason)
  }
}

/// A `FridayRustReadClient` that always throws — so the view model renders honest "unavailable".
/// Never returns a snapshot; it cannot fabricate readiness.
struct HonestlyUnavailableReadClient: FridayRustReadClient {
  let reason: String
  func fetchWorkbench() async throws -> FridayRustClient.WorkbenchSnapshot {
    throw FridayReadClientError.transport("live read client unavailable: \(reason)")
  }
}

// MARK: - NWConnection-backed loopback transport

/// A concrete `SealedWSTransport` over an `NWConnection` TCP loopback socket. It carries the
/// FULL sealed-WS round trip:
///  1. the cleartext length-prefixed preamble (`BE32(len) || payload`, mirroring
///     `friday_transport::write_frame`/`read_frame`),
///  2. a hand-rolled RFC-6455 client WebSocket upgrade over the SAME raw socket (the protocol
///     exchanges raw preamble bytes BEFORE the upgrade, so `URLSessionWebSocketTask` /
///     `NWProtocolWebSocket` — which upgrade atomically at connect — cannot be used), and
///  3. masked client Binary frames + server Binary-frame reads (mirroring tungstenite, which
///     ENFORCES client masking and carries the sealed body as a `Message::Binary`).
///
/// Against a DARK read-projection server (nothing listening, or the peer not enrolled) the
/// connect / preamble / handshake fails, surfaced as `FridayReadClientError.transport(...)` →
/// honest unavailable. Never fake-ready.
final class LoopbackSealedWSTransport: SealedWSTransport {
  private let connection: NWConnection
  private let connectTimeout: TimeInterval
  private let receiveTimeout: TimeInterval
  private let host: String
  private let port: UInt16
  private var started = false
  /// Bytes received from the socket but not yet consumed by a frame read. CRITICAL: the WS
  /// handshake response and the first Binary frame can arrive in the SAME TCP segment, so any
  /// bytes read past the `\r\n\r\n` handshake terminator MUST be retained here for the frame
  /// parser — never discarded. All reads drain this buffer first, then the socket.
  private var readBuffer = [UInt8]()

  init(config: ReadProjectionServerConfig) throws {
    guard let port = NWEndpoint.Port(rawValue: config.port) else {
      throw FridayReadClientError.transport("invalid read-projection port \(config.port)")
    }
    self.connectTimeout = config.connectTimeout
    self.receiveTimeout = config.receiveTimeout
    self.host = config.host
    self.port = config.port
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
    if semaphore.wait(timeout: .now() + connectTimeout) == .timedOut {
      connection.cancel()
      throw FridayReadClientError.transport("connect timed out after \(connectTimeout)s (server dark?)")
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
    let header = try readExactly(4)
    let len =
      (UInt32(header[0]) << 24) | (UInt32(header[1]) << 16)
      | (UInt32(header[2]) << 8) | UInt32(header[3])
    if len == 0 { return [] }
    return try readExactly(Int(len))
  }

  /// Perform the RFC-6455 client opening handshake over the (preamble-consumed) raw socket.
  /// Sends `GET / HTTP/1.1` with `Upgrade: websocket` + a random `Sec-WebSocket-Key`, then
  /// reads the response headers BYTE-BY-BYTE up to `\r\n\r\n` (so any first-frame bytes the
  /// server coalesced into the same segment stay buffered), and validates `101` +
  /// `Sec-WebSocket-Accept == base64(SHA1(key ‖ GUID))`. The Rust server is plain `tungstenite`
  /// over `ws://`, so a standard handshake is accepted.
  func upgrade() throws {
    try ensureStarted()
    // 16 random bytes, base64 — the RFC-6455 client nonce.
    var keyBytes = [UInt8](repeating: 0, count: 16)
    for i in keyBytes.indices { keyBytes[i] = UInt8.random(in: 0...255) }
    let secKey = Data(keyBytes).base64EncodedString()

    let request =
      "GET / HTTP/1.1\r\n"
      + "Host: \(host):\(port)\r\n"
      + "Upgrade: websocket\r\n"
      + "Connection: Upgrade\r\n"
      + "Sec-WebSocket-Key: \(secKey)\r\n"
      + "Sec-WebSocket-Version: 13\r\n"
      + "\r\n"
    try send(Data(request.utf8))

    let headerBytes = try readUntilCRLFCRLF()
    guard let header = String(bytes: headerBytes, encoding: .utf8) else {
      throw FridayReadClientError.transport("ws handshake response was not valid UTF-8")
    }
    // Status line: HTTP/1.1 101 Switching Protocols.
    guard let statusLine = header.split(separator: "\r\n").first,
      statusLine.contains("101")
    else {
      throw FridayReadClientError.transport(
        "ws upgrade refused (no 101 Switching Protocols): \(header.prefix(80))")
    }
    // Verify Sec-WebSocket-Accept = base64(SHA1(secKey ‖ RFC-6455 GUID)).
    let expectedAccept = Self.wsAccept(forKey: secKey)
    let acceptOK = header
      .split(separator: "\r\n")
      .contains { line in
        let lower = line.lowercased()
        return lower.hasPrefix("sec-websocket-accept:")
          && line.contains(expectedAccept)
      }
    guard acceptOK else {
      throw FridayReadClientError.transport("ws upgrade Sec-WebSocket-Accept mismatch")
    }
  }

  /// Send the sealed body as ONE masked client Binary frame (FIN + opcode 0x2). tungstenite
  /// ENFORCES client→server masking, so the 4-byte masking key + XOR are mandatory.
  func sendMessage(_ body: [UInt8]) throws {
    var frame = [UInt8]()
    frame.append(0x82)  // FIN=1, RSV=0, opcode=0x2 (Binary)
    let len = body.count
    // Payload length form + MASK bit (0x80) set on the length byte.
    if len <= 125 {
      frame.append(0x80 | UInt8(len))
    } else if len <= 0xffff {
      frame.append(0x80 | 126)
      frame.append(UInt8((len >> 8) & 0xff))
      frame.append(UInt8(len & 0xff))
    } else {
      frame.append(0x80 | 127)
      let u = UInt64(len)
      for shift in stride(from: 56, through: 0, by: -8) {
        frame.append(UInt8((u >> UInt64(shift)) & 0xff))
      }
    }
    // 4-byte masking key, then payload XOR'd with the rotating key bytes.
    var maskKey = [UInt8](repeating: 0, count: 4)
    for i in maskKey.indices { maskKey[i] = UInt8.random(in: 0...255) }
    frame.append(contentsOf: maskKey)
    for (i, b) in body.enumerated() {
      frame.append(b ^ maskKey[i % 4])
    }
    try send(Data(frame))
  }

  /// Read the next server→client Binary message body. Server frames are UNMASKED (RFC-6455).
  /// Control frames (Ping/Pong) and continuation noise are skipped; a Close or a non-Binary
  /// data frame surfaces as a transport error (mirroring `ws_recv_envelope`). Reassembles a
  /// fragmented message across continuation frames.
  func recvMessage() throws -> [UInt8] {
    var assembled = [UInt8]()
    var assembling = false
    while true {
      let (fin, opcode, payload) = try readOneFrame()
      switch opcode {
      case 0x2:  // Binary (start of a data message)
        if fin { return payload }
        assembled = payload
        assembling = true
      case 0x0:  // Continuation
        guard assembling else {
          throw FridayReadClientError.transport("ws continuation frame with no start")
        }
        assembled.append(contentsOf: payload)
        if fin { return assembled }
      case 0x9, 0xA:  // Ping / Pong — skip (the server does not require a client Pong here).
        continue
      case 0x8:  // Close
        throw FridayReadClientError.transport("ws closed by server (session ended fail-closed)")
      case 0x1:  // Text — the read seam only speaks Binary.
        throw FridayReadClientError.transport("unexpected text ws frame")
      default:
        throw FridayReadClientError.transport("unexpected ws opcode \(opcode)")
      }
    }
  }

  // MARK: WS frame parsing helpers

  /// Read one WS frame, returning (fin, opcode, unmasked payload). The server is the unmasked
  /// side; if a (spec-noncompliant) masked server frame ever arrived we still unmask it.
  private func readOneFrame() throws -> (fin: Bool, opcode: UInt8, payload: [UInt8]) {
    let b0b1 = try readExactly(2)
    let fin = (b0b1[0] & 0x80) != 0
    let opcode = b0b1[0] & 0x0f
    let masked = (b0b1[1] & 0x80) != 0
    var len = Int(b0b1[1] & 0x7f)
    if len == 126 {
      let ext = try readExactly(2)
      len = (Int(ext[0]) << 8) | Int(ext[1])
    } else if len == 127 {
      let ext = try readExactly(8)
      var v = 0
      for byte in ext { v = (v << 8) | Int(byte) }
      len = v
    }
    var maskKey = [UInt8]()
    if masked { maskKey = try readExactly(4) }
    var payload = len > 0 ? try readExactly(len) : []
    if masked {
      for i in payload.indices { payload[i] ^= maskKey[i % 4] }
    }
    return (fin, opcode, payload)
  }

  /// Read exactly `count` bytes, draining the retained `readBuffer` first then the socket.
  private func readExactly(_ count: Int) throws -> [UInt8] {
    while readBuffer.count < count {
      let chunk = try receiveSome(min: 1, max: max(count - readBuffer.count, 1))
      if chunk.isEmpty {
        throw FridayReadClientError.transport("connection closed mid-frame (server dark?)")
      }
      readBuffer.append(contentsOf: chunk)
    }
    let out = Array(readBuffer.prefix(count))
    readBuffer.removeFirst(count)
    return out
  }

  /// Read response header bytes up to and including the `\r\n\r\n` terminator. Bytes the server
  /// coalesced PAST the terminator (the first WS frame) remain in `readBuffer`.
  private func readUntilCRLFCRLF() throws -> [UInt8] {
    let terminator: [UInt8] = [0x0d, 0x0a, 0x0d, 0x0a]
    while true {
      if let range = Self.firstRange(of: terminator, in: readBuffer) {
        let end = range.upperBound
        let header = Array(readBuffer[0..<end])
        readBuffer.removeFirst(end)
        return header
      }
      let chunk = try receiveSome(min: 1, max: 1024)
      if chunk.isEmpty {
        throw FridayReadClientError.transport("connection closed during ws handshake (server dark?)")
      }
      readBuffer.append(contentsOf: chunk)
    }
  }

  /// `base64(SHA1(key ‖ "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))` — the RFC-6455 accept value.
  private static func wsAccept(forKey key: String) -> String {
    let magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    let digest = Insecure.SHA1.hash(data: Data((key + magic).utf8))
    return Data(digest).base64EncodedString()
  }

  /// First index range of `needle` within `haystack`, or nil.
  private static func firstRange(of needle: [UInt8], in haystack: [UInt8]) -> Range<Int>? {
    guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
    let last = haystack.count - needle.count
    var i = 0
    while i <= last {
      if Array(haystack[i..<i + needle.count]) == needle {
        return i..<(i + needle.count)
      }
      i += 1
    }
    return nil
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
    if semaphore.wait(timeout: .now() + connectTimeout) == .timedOut {
      throw FridayReadClientError.transport("send timed out (server dark?)")
    }
    if let error = outcome.take() { throw error }
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
    if semaphore.wait(timeout: .now() + receiveTimeout) == .timedOut {
      throw FridayReadClientError.transport("receive timed out after \(receiveTimeout)s")
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
