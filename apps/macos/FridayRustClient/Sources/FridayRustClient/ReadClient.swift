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
///
/// `Sendable` so a concurrent/actor-backed real client (and the SwiftUI view model that
/// stores one) conforms cleanly under Swift 6 strict concurrency. (This was the Console's
/// duplicate-protocol constraint; the two protocols are reconciled to this single one.)
public protocol FridayRustReadClient: Sendable {
  /// Fetch the Mission Workbench refs-only projection over the sealed-WS read seam:
  /// handshake → owner-authed request → open the owner-sealed snapshot → typed result.
  func fetchWorkbench() async throws -> WorkbenchSnapshot
  /// Fetch one run's refs-only readback projection.
  func fetchRunReadback(runId: String) async throws -> ReadProjectionSnapshot
  /// Fetch one run's owner-gated answer body over the sealed-WS read seam. This is the explicit
  /// body-bearing sibling of `fetchWorkbench()`/RunReadback; implementations must not source the
  /// body from refs-only projections.
  func fetchRunAnswerBody(runId: String) async throws -> RunAnswerBody
  /// Fetch provider readiness labels through the read-only providers-doctor arm.
  func fetchProvidersDoctor(probe: String?) async throws -> ReadProjectionSnapshot
  /// Fetch the owner's routed-session refs.
  func fetchSessionList() async throws -> ReadProjectionSnapshot
  /// Fetch one owner-gated routed session transcript. This is a deliberate owner-only body carve-out.
  func fetchSessionOpen(agentSessionId: String) async throws -> ReadProjectionSnapshot
  /// Fetch one routed session's refs-only freshness/connectivity state.
  func fetchSessionLinkState(agentSessionId: String) async throws -> ReadProjectionSnapshot
  /// Fetch one run's refs-only workspace file-view projection.
  func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot
  /// Fetch one paused run's refs-only Activity / Needs-Me projection.
  func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot
}

public extension FridayRustReadClient {
  func fetchRunReadback(runId: String) async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("run readback unavailable")
  }

  func fetchRunAnswerBody(runId: String) async throws -> RunAnswerBody {
    throw FridayReadClientError.transport("run answer body readback unavailable")
  }

  func fetchProvidersDoctor(probe: String? = nil) async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("providers doctor readback unavailable")
  }

  func fetchSessionList() async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("session list readback unavailable")
  }

  func fetchSessionOpen(agentSessionId: String) async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("session open readback unavailable")
  }

  func fetchSessionLinkState(agentSessionId: String) async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("session link-state readback unavailable")
  }

  func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("run file-view readback unavailable")
  }

  func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
    throw FridayReadClientError.transport("activity needs-me readback unavailable")
  }
}

// MARK: - The sealed-WS read client implementation

/// The sealed-WS read client. Drives the full handshake + request/response LOGIC over an
/// injected `SealedWSTransport`. Pure byte-exact logic; the network is the injected pipe.
///
/// `@unchecked Sendable`: every stored property is an immutable `let` (the keypair, the
/// principal, the injected `@escaping` factory/closures). The closures are not statically
/// `@Sendable` (so the protocol's `Sendable` is not auto-satisfied), but the instance carries
/// no mutable shared state across the `await`, so it is safe to send. Asserted, not derived.
public final class SealedWSReadClient: FridayRustReadClient, @unchecked Sendable {
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
    let response = try sendReadMessage { requestId, authProof in
      .workbenchProjectionRequest(WorkbenchProjectionRequestWire(
        missionId: missionId,
        forwardedPrincipal: forwardedPrincipal,
        authProof: authProof,
        requestId: requestId))
    }

    switch response.message {
    case .workbenchProjectionSnapshot(let snap):
      // The projection JSON is OWNER-SEALED: hex of `[nonce_len][nonce][ciphertext]`,
      // sealed under the session key with the read SESSION_AAD. Only the bound owner can
      // open it. Open → the refs-only projection JSON → typed snapshot.
      let projectionBytes = try openOwnerSealedJSON(
        snap.projectionJson, sessionKey: response.sessionKey, label: "projection")
      return try WorkbenchSnapshot(
        projectionJSON: Data(projectionBytes),
        generatedAtMs: snap.generatedAtMs
      )
    case .error(let code, let message):
      throw FridayReadClientError.serverError(code: code, message: message)
    case .workbenchProjectionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "WorkbenchProjectionRequest")
    // The WRITE / agent-run variants share the `FridayMessage` enum but are NEVER answers a READ
    // server gives — surface them as unexpected (the read seam only answers a snapshot / Error).
    case .agentRunRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunRequest")
    case .agentRunResult:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunResult")
    case .agentRunPaused:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunPaused")
    case .agentRunResume:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunResume")
    case .agentRunCancel:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunCancel")
    case .agentRunReject:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunReject")
    case .agentRunControlResult:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunControlResult")
    case .pair:
      throw FridayReadClientError.unexpectedResponse(kind: "Pair")
    case .pairAck:
      throw FridayReadClientError.unexpectedResponse(kind: "PairAck")
    case .hubStatus:
      throw FridayReadClientError.unexpectedResponse(kind: "HubStatus")
    // The mission-spine WRITE variants share the `FridayMessage` enum but are NEVER answers a READ
    // server gives — surface them as unexpected (the read seam only answers a snapshot / Error).
    case .missionIntakeRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "MissionIntakeRequest")
    case .missionIntakeResult:
      throw FridayReadClientError.unexpectedResponse(kind: "MissionIntakeResult")
    case .memoryDecisionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "MemoryDecisionRequest")
    case .memoryDecisionResult:
      throw FridayReadClientError.unexpectedResponse(kind: "MemoryDecisionResult")
    case .runOutcomeLearningDecisionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunOutcomeLearningDecisionRequest")
    case .runOutcomeLearningDecisionResult:
      throw FridayReadClientError.unexpectedResponse(kind: "RunOutcomeLearningDecisionResult")
    case .runAnswerBodyRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunAnswerBodyRequest")
    case .runAnswerBodySnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "RunAnswerBodySnapshot")
    case .runReadbackRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunReadbackRequest")
    case .runReadbackSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "RunReadbackSnapshot")
    case .providersDoctorRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "ProvidersDoctorRequest")
    case .providersDoctorSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "ProvidersDoctorSnapshot")
    case .sessionListRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionListRequest")
    case .sessionListSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionListSnapshot")
    case .sessionOpenRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionOpenRequest")
    case .sessionOpenSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionOpenSnapshot")
    case .sessionLinkStateRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionLinkStateRequest")
    case .sessionLinkStateSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionLinkStateSnapshot")
    case .runFileViewRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunFileViewRequest")
    case .runFileViewSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "RunFileViewSnapshot")
    case .activityNeedsMeRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "ActivityNeedsMeRequest")
    case .activityNeedsMeSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "ActivityNeedsMeSnapshot")
    case .unsupported(let kind):
      throw FridayReadClientError.unexpectedResponse(kind: kind)
    }
  }

  public func fetchRunReadback(runId: String) async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .runReadbackRequest(RunReadbackRequestWire(
          runId: runId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .runReadbackSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "RunReadbackSnapshot")
  }

  public func fetchRunAnswerBody(runId: String) async throws -> RunAnswerBody {
    let response = try sendReadMessage { requestId, authProof in
      .runAnswerBodyRequest(RunAnswerBodyRequestWire(
        runId: runId,
        forwardedPrincipal: forwardedPrincipal,
        authProof: authProof,
        requestId: requestId))
    }

    switch response.message {
    case .runAnswerBodySnapshot(let snap):
      let answerBytes = try openOwnerSealedJSON(
        snap.answerJson, sessionKey: response.sessionKey, label: "answer")
      return try RunAnswerBody(answerJSON: Data(answerBytes), generatedAtMs: snap.generatedAtMs)
    case .error(let code, let message):
      throw FridayReadClientError.serverError(code: code, message: message)
    case .runAnswerBodyRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunAnswerBodyRequest")
    case .workbenchProjectionSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "WorkbenchProjectionSnapshot")
    case .workbenchProjectionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "WorkbenchProjectionRequest")
    case .agentRunRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunRequest")
    case .agentRunResult:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunResult")
    case .agentRunPaused:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunPaused")
    case .agentRunResume:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunResume")
    case .agentRunCancel:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunCancel")
    case .agentRunReject:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunReject")
    case .agentRunControlResult:
      throw FridayReadClientError.unexpectedResponse(kind: "AgentRunControlResult")
    case .pair:
      throw FridayReadClientError.unexpectedResponse(kind: "Pair")
    case .pairAck:
      throw FridayReadClientError.unexpectedResponse(kind: "PairAck")
    case .hubStatus:
      throw FridayReadClientError.unexpectedResponse(kind: "HubStatus")
    case .missionIntakeRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "MissionIntakeRequest")
    case .missionIntakeResult:
      throw FridayReadClientError.unexpectedResponse(kind: "MissionIntakeResult")
    case .memoryDecisionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "MemoryDecisionRequest")
    case .memoryDecisionResult:
      throw FridayReadClientError.unexpectedResponse(kind: "MemoryDecisionResult")
    case .runOutcomeLearningDecisionRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunOutcomeLearningDecisionRequest")
    case .runOutcomeLearningDecisionResult:
      throw FridayReadClientError.unexpectedResponse(kind: "RunOutcomeLearningDecisionResult")
    case .runReadbackRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunReadbackRequest")
    case .runReadbackSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "RunReadbackSnapshot")
    case .providersDoctorRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "ProvidersDoctorRequest")
    case .providersDoctorSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "ProvidersDoctorSnapshot")
    case .sessionListRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionListRequest")
    case .sessionListSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionListSnapshot")
    case .sessionOpenRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionOpenRequest")
    case .sessionOpenSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionOpenSnapshot")
    case .sessionLinkStateRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionLinkStateRequest")
    case .sessionLinkStateSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "SessionLinkStateSnapshot")
    case .runFileViewRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "RunFileViewRequest")
    case .runFileViewSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "RunFileViewSnapshot")
    case .activityNeedsMeRequest:
      throw FridayReadClientError.unexpectedResponse(kind: "ActivityNeedsMeRequest")
    case .activityNeedsMeSnapshot:
      throw FridayReadClientError.unexpectedResponse(kind: "ActivityNeedsMeSnapshot")
    case .unsupported(let kind):
      throw FridayReadClientError.unexpectedResponse(kind: kind)
    }
  }

  public func fetchProvidersDoctor(probe: String? = nil) async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .providersDoctorRequest(ProvidersDoctorRequestWire(
          probe: probe,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .providersDoctorSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "ProvidersDoctorSnapshot")
  }

  public func fetchSessionList() async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .sessionListRequest(SessionListRequestWire(
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .sessionListSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "SessionListSnapshot")
  }

  public func fetchSessionOpen(agentSessionId: String) async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .sessionOpenRequest(SessionOpenRequestWire(
          agentSessionId: agentSessionId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .sessionOpenSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "SessionOpenSnapshot")
  }

  public func fetchSessionLinkState(agentSessionId: String) async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .sessionLinkStateRequest(SessionLinkStateRequestWire(
          agentSessionId: agentSessionId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .sessionLinkStateSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "SessionLinkStateSnapshot")
  }

  public func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .runFileViewRequest(RunFileViewRequestWire(
          runId: runId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .runFileViewSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "RunFileViewSnapshot")
  }

  public func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
    try await fetchProjection(
      makeMessage: { requestId, authProof in
        .activityNeedsMeRequest(ActivityNeedsMeRequestWire(
          runId: runId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          requestId: requestId))
      },
      extract: { message in
        if case .activityNeedsMeSnapshot(let snap) = message {
          return (snap.projectionJson, snap.generatedAtMs)
        }
        return nil
      },
      expected: "ActivityNeedsMeSnapshot")
  }

  // MARK: Envelope seal/open over the session key (transport layer)

  private struct ReadResponse {
    let message: FridayMessage
    let sessionKey: [UInt8]
  }

  private func fetchProjection(
    makeMessage: (String, [UInt8]) -> FridayMessage,
    extract: (FridayMessage) -> (projectionJson: String, generatedAtMs: Int64)?,
    expected: String
  ) async throws -> ReadProjectionSnapshot {
    let response = try sendReadMessage(makeMessage)
    if case .error(let code, let message) = response.message {
      throw FridayReadClientError.serverError(code: code, message: message)
    }
    guard let snapshot = extract(response.message) else {
      throw FridayReadClientError.unexpectedResponse(kind: expected)
    }
    let projectionBytes = try openOwnerSealedJSON(
      snapshot.projectionJson, sessionKey: response.sessionKey, label: "projection")
    return try ReadProjectionSnapshot(
      projectionJSON: Data(projectionBytes),
      generatedAtMs: snapshot.generatedAtMs)
  }

  private func sendReadMessage(_ makeMessage: (String, [UInt8]) -> FridayMessage) throws -> ReadResponse {
    let transport = try makeTransport()

    try transport.writeFrame(keypair.publicKey)
    let serverPub = try transport.readFrame()
    guard serverPub.count == FridayCrypto.x25519PublicKeyLen else {
      throw FridayReadClientError.badServerPubkey
    }
    let sessionNonce = try transport.readFrame()
    guard sessionNonce.count == 64 else {
      throw FridayReadClientError.badSessionNonce
    }
    try transport.upgrade()

    let sessionKey: [UInt8]
    do {
      sessionKey = try keypair.agree(peerPublicKey: serverPub)
    } catch {
      throw FridayReadClientError.transport("session-key agreement failed: \(error)")
    }

    let requestId = newRequestId()
    let authProof = try FridayCrypto.buildAuthProof(
      sessionKey: sessionKey,
      sessionNonce: sessionNonce,
      sessionAad: readSessionAad,
      authChallenge: readAuthChallenge,
      forwardedPrincipal: forwardedPrincipal,
      boundContext: Array(requestId.utf8))
    let reqEnvelope = FridayEnvelope(
      msgId: "msg-\(requestId)",
      sentAt: now(),
      message: makeMessage(requestId, authProof))
    try transport.sendMessage(try sealEnvelope(reqEnvelope, sessionKey: sessionKey))

    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayReadClientError.transport("no response (session ended fail-closed): \(error)")
    }
    let respEnvelope = try openEnvelope(respBody, sessionKey: sessionKey)
    return ReadResponse(message: respEnvelope.message, sessionKey: sessionKey)
  }

  private func openOwnerSealedJSON(
    _ sealedHex: String,
    sessionKey: [UInt8],
    label: String
  ) throws -> [UInt8] {
    let sealedBytes = try Hex.decode(sealedHex)
    let innerSealed = try FridayCrypto.decodeSealed(sealedBytes)
    do {
      return try FridayCrypto.open(key: sessionKey, sealed: innerSealed, aad: readSessionAad)
    } catch {
      throw FridayReadClientError.malformedProjection("owner-sealed \(label) failed to open: \(error)")
    }
  }

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
