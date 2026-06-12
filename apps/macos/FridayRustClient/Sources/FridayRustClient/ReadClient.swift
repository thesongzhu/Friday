import Foundation

/// **The Swift sealed-WS READ client** for the Rust read-projection server
/// (`bin/hub_read_projection_server.rs`, read-seam branch `ui-read-seam-sr0-sr1-20260611`).
///
/// This is the client half of the SAME sealed-WS protocol the Rust `establish_session`
/// (cleartext preamble) + `serve_read_session` (owner-authed refs-only projection) speak,
/// and the SAME byte framing the TS reference client
/// (`friday-rust-hub-agent-run-ws-sealed-client.ts`) uses:
///
/// 1. **Handshake (cleartext preamble over the raw socket, BEFORE the WS upgrade):**
///    client pubkey OUT → server pubkey IN → 64-byte session nonce IN, each a
///    length-prefixed frame (`BE32(len) || payload`). Then the WS upgrade, then
///    `agree(serverPub)` derives the per-session key.
/// 2. **Request:** a `WorkbenchProjectionRequest` envelope carrying
///    `forwarded_principal` + an `auth_proof` (sealed `nonceBoundChallenge(AUTH_CHALLENGE,
///    nonce)` under the per-request `authAad(SESSION_AAD, principal, request_id)`), then
///    sealed under the session key as a WS Binary message.
/// 3. **Response:** an owner-sealed `WorkbenchProjectionSnapshot` (or a typed `Error`).
///    The `projection_json` field is hex of `[nonce_len][nonce][ciphertext]`; the client
///    opens it under the session key to recover the refs-only projection JSON.
///
/// ## Transport abstraction (mirrors the Rust `S: Read + Write` genericity)
/// The Rust `establish_session` / `serve_read_session` are generic over the pipe. So is
/// this client: the byte-exact handshake + request/response LOGIC lives here over a
/// `SealedWSTransport`; the concrete network transport (raw socket + real WS upgrade) is a
/// separate concern. The live `NWConnection`-backed transport is a **DEFERRED acceptance
/// criterion** (see the PR body) — proving the live round-trip needs a running server with
/// the UI peer pubkey enrolled (the slice-6 operator gate). The crypto-parity KATs prove
/// byte-identity OFFLINE; an in-memory transport proves this client's wiring.

// MARK: - Read-seam protocol constants

/// The READ session AAD binding every sealed envelope on a READ session. Mirrors the bin's
/// `SESSION_AAD` (`b"friday:ui-read-seam:ws:s-r1:read-projection-session:aad:v1"`).
/// DOMAIN-SEPARATED from the write bin's AAD (the `:read:` / `ui-read-seam` tag).
public let readSessionAad = Array("friday:ui-read-seam:ws:s-r1:read-projection-session:aad:v1".utf8)

/// The BASE auth challenge the peer seals in its `auth_proof`. Mirrors the bin's
/// `AUTH_CHALLENGE` (`b"friday:ui-read-seam:ws:s-r1:read-projection:challenge:v1"`).
public let readAuthChallenge = Array("friday:ui-read-seam:ws:s-r1:read-projection:challenge:v1".utf8)

// MARK: - Errors

public enum FridayReadClientError: Error, Equatable {
  /// The server's pubkey frame was not 32 bytes.
  case badServerPubkey
  /// The session nonce frame was not the expected 64-byte width.
  case badSessionNonce
  /// The server answered with a typed `Error` frame instead of a snapshot.
  case serverError(code: FridayErrorCode, message: String)
  /// The server's response was not a `WorkbenchProjectionSnapshot`.
  case unexpectedResponse(kind: String)
  /// The owner-sealed projection JSON could not be opened / parsed.
  case malformedProjection(String)
  /// A transport-layer failure (the pipe closed / no response — the read server ENDS the
  /// session fail-closed on an auth failure, surfaced here as a closed transport).
  case transport(String)
}

// MARK: - Transport abstraction

/// The two-phase pipe the sealed-WS handshake needs. Phase 1 is the cleartext
/// length-prefixed preamble over the raw socket; phase 2 is WS Binary messages (the WS
/// layer supplies its own length, so a sealed body is sent VERBATIM — no extra prefix).
///
/// The Rust server is generic over `S: Read + Write` for the SAME reason; the concrete
/// network transport is injected so the handshake/request LOGIC is testable offline.
public protocol SealedWSTransport {
  /// Phase 1 — write a length-prefixed preamble frame (`BE32(len) || payload`). Mirrors
  /// `friday_transport::write_frame`.
  func writeFrame(_ payload: [UInt8]) throws
  /// Phase 1 — read one length-prefixed preamble frame. Mirrors `read_frame`.
  func readFrame() throws -> [UInt8]
  /// Transition: perform the WS upgrade over the (preamble-consumed) socket. After this,
  /// only `sendMessage`/`recvMessage` are valid.
  func upgrade() throws
  /// Phase 2 — send a sealed body as one WS Binary message (verbatim; WS owns the length).
  func sendMessage(_ body: [UInt8]) throws
  /// Phase 2 — receive the next WS Binary message body.
  func recvMessage() throws -> [UInt8]
}

// MARK: - The clean read-client protocol

/// The clean product-facing read client. A UI depends on THIS, not the transport. Returns
/// the refs-only typed `WorkbenchSnapshot` mirroring the Rust `WorkbenchProjectionSnapshot`.
public protocol FridayRustReadClient {
  /// Fetch the Mission Workbench refs-only projection over the sealed-WS read seam:
  /// handshake → owner-authed request → open the owner-sealed snapshot → typed result.
  func fetchWorkbench() async throws -> WorkbenchSnapshot
}

// MARK: - The sealed-WS read client implementation

/// The sealed-WS read client. Drives the full handshake + request/response LOGIC over an
/// injected `SealedWSTransport`. Pure byte-exact logic; the network is the injected pipe.
public final class SealedWSReadClient: FridayRustReadClient {
  private let keypair: FridayCrypto.DeviceKeypair
  private let forwardedPrincipal: String
  private let missionId: String?
  private let makeTransport: () throws -> SealedWSTransport
  private let now: () -> Int64
  private let newRequestId: () -> String

  /// - Parameters:
  ///   - keypair: this client's X25519 keypair. Its public key MUST be enrolled in the
  ///     server's SecureStore peer-allowlist (S-F) or the server refuses the handshake.
  ///   - forwardedPrincipal: the owner principal; MUST be in the server's owner-allowlist.
  ///   - missionId: optional Mission id; `nil` ⇒ the first active Mission.
  ///   - makeTransport: factory for a fresh transport per `fetchWorkbench()` (one session).
  ///   - now: epoch-millis clock (injectable for tests).
  ///   - newRequestId: fresh per-request id factory (the read analog of a `run_id`).
  public init(
    keypair: FridayCrypto.DeviceKeypair,
    forwardedPrincipal: String,
    missionId: String? = nil,
    makeTransport: @escaping () throws -> SealedWSTransport,
    now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
    newRequestId: @escaping () -> String = { "req-\(UUID().uuidString)" }
  ) {
    self.keypair = keypair
    self.forwardedPrincipal = forwardedPrincipal
    self.missionId = missionId
    self.makeTransport = makeTransport
    self.now = now
    self.newRequestId = newRequestId
  }

  public func fetchWorkbench() async throws -> WorkbenchSnapshot {
    let transport = try makeTransport()

    // (1) HANDSHAKE — cleartext preamble over the raw socket, then WS upgrade.
    //   client pubkey OUT → server pubkey IN → 64-byte session nonce IN.
    try transport.writeFrame(keypair.publicKey)
    let serverPub = try transport.readFrame()
    guard serverPub.count == FridayCrypto.x25519PublicKeyLen else {
      throw FridayReadClientError.badServerPubkey
    }
    let sessionNonce = try transport.readFrame()
    // The server emits a 64-byte (hex-of-32-CSPRNG) nonce; the verifier rejects any other
    // width (`SESSION_NONCE_LEN`). Bind it VERBATIM (do NOT hex-decode to 32 bytes).
    guard sessionNonce.count == 64 else {
      throw FridayReadClientError.badSessionNonce
    }
    try transport.upgrade()

    // Derive the per-session key (ECDH + HKDF). Same key both ends agree on.
    let sessionKey: [UInt8]
    do {
      sessionKey = try keypair.agree(peerPublicKey: serverPub)
    } catch {
      throw FridayReadClientError.transport("session-key agreement failed: \(error)")
    }

    // (2) REQUEST — a WorkbenchProjectionRequest, owner-authed, sealed under the session key.
    let requestId = newRequestId()
    let authProof = try FridayCrypto.buildAuthProof(
      sessionKey: sessionKey,
      sessionNonce: sessionNonce,
      sessionAad: readSessionAad,
      authChallenge: readAuthChallenge,
      forwardedPrincipal: forwardedPrincipal,
      boundContext: Array(requestId.utf8)
    )
    let request = WorkbenchProjectionRequestWire(
      missionId: missionId,
      forwardedPrincipal: forwardedPrincipal,
      authProof: authProof,
      requestId: requestId
    )
    let reqEnvelope = FridayEnvelope(
      msgId: "msg-\(requestId)",
      sentAt: now(),
      message: .workbenchProjectionRequest(request)
    )
    let reqBody = try sealEnvelope(reqEnvelope, sessionKey: sessionKey)
    try transport.sendMessage(reqBody)

    // (3) RESPONSE — open the sealed envelope, then the owner-sealed snapshot body.
    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      // A read server that fails auth ENDS the session (no snapshot). Surface as fail-closed.
      throw FridayReadClientError.transport("no response (session ended fail-closed): \(error)")
    }
    let respEnvelope = try openEnvelope(respBody, sessionKey: sessionKey)

    switch respEnvelope.message {
    case .workbenchProjectionSnapshot(let snap):
      // The projection JSON is OWNER-SEALED: hex of `[nonce_len][nonce][ciphertext]`,
      // sealed under the session key with the read SESSION_AAD. Only the bound owner can
      // open it. Open → the refs-only projection JSON → typed snapshot.
      let sealedBytes = try Hex.decode(snap.projectionJson)
      let innerSealed = try FridayCrypto.decodeSealed(sealedBytes)
      let projectionBytes: [UInt8]
      do {
        projectionBytes = try FridayCrypto.open(key: sessionKey, sealed: innerSealed, aad: readSessionAad)
      } catch {
        throw FridayReadClientError.malformedProjection("owner-sealed projection failed to open: \(error)")
      }
      return try WorkbenchSnapshot(
        projectionJSON: Data(projectionBytes),
        generatedAtMs: snap.generatedAtMs
      )
    case .error(let code, let message):
      throw FridayReadClientError.serverError(code: code, message: message)
    case .workbenchProjectionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "WorkbenchProjectionRequest")
    case .unsupported(let kind):
      throw FridayReadClientError.unexpectedResponse(kind: kind)
    }
  }

  // MARK: Envelope seal/open over the session key (transport layer)

  /// Serialize + seal an envelope into a WS Binary body. Mirrors
  /// `friday_transport::seal_envelope`: JSON → `seal(key, json, aad)` → `encodeSealed`.
  func sealEnvelope(_ env: FridayEnvelope, sessionKey: [UInt8]) throws -> [UInt8] {
    let json = try env.encodeJSON()
    let sealed = try FridayCrypto.seal(key: sessionKey, plaintext: [UInt8](json), aad: readSessionAad)
    return FridayCrypto.encodeSealed(sealed)
  }

  /// Open + deserialize a WS Binary body into an envelope. Mirrors
  /// `friday_transport::open_envelope`: `decodeSealed` → `open(key, …, aad)` → JSON parse.
  func openEnvelope(_ body: [UInt8], sessionKey: [UInt8]) throws -> FridayEnvelope {
    let sealed = try FridayCrypto.decodeSealed(body)
    let pt: [UInt8]
    do {
      pt = try FridayCrypto.open(key: sessionKey, sealed: sealed, aad: readSessionAad)
    } catch {
      throw FridayReadClientError.transport("envelope failed to open (fail-closed): \(error)")
    }
    return try FridayEnvelope.decodeJSON(Data(pt))
  }
}
