import XCTest
@testable import FridayRustClient

/// **Tier-2 mission-spine-write wiring tests** — drive `SealedWSWriteClient.submitMissionIntake` +
/// `submitMemoryDecision` end-to-end over an IN-MEMORY transport that emulates the Rust
/// `hub_agent_run_server`'s mission-spine arms: the cleartext preamble (server pubkey + 64-byte
/// nonce), the SEALED session (the channel auth — NO per-request `auth_proof` for these messages),
/// and a `MissionIntakeResult` / `MemoryDecisionResult` reply.
///
/// HONEST LABEL: WIRING-ONLY, NOT a crypto-parity proof (the emulated server seals with the SAME
/// Swift primitives the client uses). The byte-parity is proven by the Rust-anchored
/// `MissionSpineWriteKATTests`. This proves the CLIENT correctly sequences the handshake, frames the
/// NO-auth_proof mission-spine request, settles on the first result, surfaces a typed `Error`
/// fail-closed, and — critically — that a `status:"blocked"` memory result is a VALID receipt the
/// client RETURNS (the caller renders the block honestly), NOT a thrown error. The live round-trip
/// against the REAL Rust server is the deferred operator-gated AC.
final class MissionSpineWriteWiringTests: XCTestCase {

  enum SpineMode {
    case intakeReady
    case intakeNeedsClarification
    case memoryConfirmed
    case memoryBlocked         // the synthetic-candidate-id reality today
    case serverError           // a typed Error frame
  }

  /// An in-memory transport playing the Rust mission-spine arms over the WRITE SESSION_AAD. It
  /// VERIFIES the inbound carries NO auth_proof field (the session is the auth) and captures the
  /// decoded request so the test can assert the wire body.
  final class EmulatedSpineServerTransport: SealedWSTransport {
    private let serverKeypair: FridayCrypto.DeviceKeypair
    private let sessionNonce: [UInt8]
    private let peerAllowlist: [[UInt8]]
    private let mode: SpineMode

    private var clientPub: [UInt8]?
    private var sessionKey: [UInt8]?
    private var upgraded = false
    private var queuedFromServer: [[UInt8]] = []
    private(set) var endedFailClosed = false
    private(set) var receivedIntake: MissionIntakeRequestWire?
    private(set) var receivedDecision: MemoryDecisionRequestWire?
    /// Proves the inbound message object carried NO `auth_proof` (sealed session is the channel auth).
    private(set) var sawAuthProof = false

    init(serverKeypair: FridayCrypto.DeviceKeypair, sessionNonce: [UInt8],
         peerAllowlist: [[UInt8]], mode: SpineMode) {
      self.serverKeypair = serverKeypair
      self.sessionNonce = sessionNonce
      self.peerAllowlist = peerAllowlist
      self.mode = mode
    }

    func writeFrame(_ payload: [UInt8]) throws {
      if clientPub == nil {
        guard peerAllowlist.contains(payload) else {
          endedFailClosed = true
          throw FridayWriteClientError.transport("peer pubkey not in allowlist")
        }
        clientPub = payload
        queuedFromServer.append(serverKeypair.publicKey)
        queuedFromServer.append(sessionNonce)
      }
    }

    func readFrame() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else { throw FridayWriteClientError.transport("no preamble frame queued") }
      return queuedFromServer.removeFirst()
    }

    func upgrade() throws {
      guard let clientPub else { throw FridayWriteClientError.transport("no client pubkey before upgrade") }
      sessionKey = try serverKeypair.agree(peerPublicKey: clientPub)
      upgraded = true
    }

    func sendMessage(_ body: [UInt8]) throws {
      guard upgraded, let sessionKey else { throw FridayWriteClientError.transport("not upgraded") }
      let plaintext = try FridayCrypto.open(
        key: sessionKey, sealed: FridayCrypto.decodeSealed(body), aad: writeSessionAad)
      // Inspect the raw JSON to PROVE no auth_proof rode the wire for these messages.
      if let obj = try JSONSerialization.jsonObject(with: Data(plaintext)) as? [String: Any],
         let msg = obj["message"] as? [String: Any],
         let request = msg["request"] as? [String: Any],
         request["auth_proof"] != nil {
        sawAuthProof = true
      }
      let env = try FridayEnvelope.decodeJSON(Data(plaintext))
      let reply: FridayMessage
      switch env.message {
      case .missionIntakeRequest(let req):
        receivedIntake = req
        switch mode {
        case .serverError:
          reply = .error(code: .internal, message: "intake failed")
        case .intakeNeedsClarification:
          reply = .missionIntakeResult(MissionIntakeResultWire(
            fridayConversationId: req.fridayConversationId, missionId: req.missionId,
            surfaceThreadId: req.surfaceThreadId, status: "needs_clarification",
            createdOrReady: false,
            clarificationQuestions: ["What is the deadline?"]))
        default:
          reply = .missionIntakeResult(MissionIntakeResultWire(
            fridayConversationId: req.fridayConversationId, missionId: req.missionId,
            workItemId: req.workItemId, surfaceThreadId: req.surfaceThreadId,
            status: "ready", createdOrReady: true))
        }
      case .memoryDecisionRequest(let req):
        receivedDecision = req
        switch mode {
        case .serverError:
          reply = .error(code: .internal, message: "decision failed")
        case .memoryBlocked:
          reply = .memoryDecisionResult(MemoryDecisionResultWire(
            memoryId: req.memoryId, state: "unknown", status: "blocked",
            blocker: "unknown_candidate", recallable: false))
        default:
          reply = .memoryDecisionResult(MemoryDecisionResultWire(
            memoryId: req.memoryId,
            state: req.decision == "confirm" ? "confirmed" : "rejected",
            status: req.decision == "confirm" ? "confirmed" : "rejected",
            recallable: req.decision == "confirm"))
        }
      default:
        throw FridayWriteClientError.transport("unexpected inbound on the spine session: \(env.msgId)")
      }
      let resp = FridayEnvelope(msgId: "spine-result", sentAt: 1_780_640_000_000, message: reply)
        .withCorrelation(env.msgId)
      queuedFromServer.append(try FridayCrypto.encodeSealed(FridayCrypto.seal(
        key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: writeSessionAad)))
    }

    func recvMessage() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else { throw FridayWriteClientError.transport("session ended (no response)") }
      return queuedFromServer.removeFirst()
    }
  }

  private let owner = "admin-001"

  private func makeClient(mode: SpineMode, peerEnrolled: Bool = true)
    throws -> (SealedWSWriteClient, EmulatedSpineServerTransport) {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)
    let transport = EmulatedSpineServerTransport(
      serverKeypair: serverKp, sessionNonce: nonce,
      peerAllowlist: peerEnrolled ? [clientKp.publicKey] : [serverKp.publicKey], mode: mode)
    let client = SealedWSWriteClient(
      keypair: clientKp, forwardedPrincipal: owner,
      makeTransport: { transport }, now: { 1000 }, newRunId: { "run-x" })
    return (client, transport)
  }

  private func sampleIntake() -> MissionIntakeRequestWire {
    MissionIntakeRequestWire(
      fridayConversationId: "fconv_desktop_1", ownerPrincipal: owner,
      surfaceThreadId: "surface-desktop-1", surfaceKind: "desktop",
      deliveryRoute: "desktop://hub-console/operations", visibilityPolicy: "compact",
      missionId: "mission-desktop-1", workItemId: "work-desktop-1",
      title: "Coordinate Friday work", intent: "keep one Mission across every surface",
      lane: "deepseek")
  }

  // MARK: submitMissionIntake

  func testSubmitMissionIntake_ready_returnsResultNoAuthProof() async throws {
    let (client, transport) = try makeClient(mode: .intakeReady)
    let result = try await client.submitMissionIntake(sampleIntake())
    XCTAssertEqual(result.status, "ready")
    XCTAssertEqual(result.missionId, "mission-desktop-1")
    XCTAssertEqual(result.workItemId, "work-desktop-1")
    XCTAssertTrue(result.createdOrReady)
    // The server saw the exact body (owner_principal == admin-001), and NO auth_proof rode the wire.
    XCTAssertEqual(transport.receivedIntake?.ownerPrincipal, owner)
    XCTAssertEqual(transport.receivedIntake?.surfaceKind, "desktop")
    XCTAssertFalse(transport.sawAuthProof, "the mission-spine request must carry NO auth_proof")
  }

  func testSubmitMissionIntake_needsClarification_carriesQuestions() async throws {
    let (client, _) = try makeClient(mode: .intakeNeedsClarification)
    let result = try await client.submitMissionIntake(sampleIntake())
    XCTAssertEqual(result.status, "needs_clarification")
    XCTAssertFalse(result.createdOrReady)
    XCTAssertEqual(result.clarificationQuestions, ["What is the deadline?"])
  }

  func testSubmitMissionIntake_serverError_throwsServerError() async throws {
    let (client, _) = try makeClient(mode: .serverError)
    do {
      _ = try await client.submitMissionIntake(sampleIntake())
      XCTFail("a typed Error frame must throw")
    } catch let err as FridayWriteClientError {
      guard case .serverError(let code, _) = err else { return XCTFail("expected serverError, got \(err)") }
      XCTAssertEqual(code, .internal)
    }
  }

  func testSubmitMissionIntake_nonAllowlistedPeer_rejectedAtHandshake() async throws {
    let (client, transport) = try makeClient(mode: .intakeReady, peerEnrolled: false)
    do {
      _ = try await client.submitMissionIntake(sampleIntake())
      XCTFail("a non-allowlisted peer must be rejected at the handshake")
    } catch {
      XCTAssertTrue(transport.endedFailClosed)
    }
  }

  // MARK: submitMemoryDecision

  func testSubmitMemoryDecision_confirm_returnsConfirmedRecallable() async throws {
    let (client, transport) = try makeClient(mode: .memoryConfirmed)
    let result = try await client.submitMemoryDecision(
      MemoryDecisionRequestWire(memoryId: "mem-1", ownerPrincipal: owner, decision: "confirm"))
    XCTAssertEqual(result.status, "confirmed")
    XCTAssertEqual(result.state, "confirmed")
    XCTAssertTrue(result.recallable)
    XCTAssertEqual(transport.receivedDecision?.decision, "confirm")
    XCTAssertFalse(transport.sawAuthProof, "the memory-decision request must carry NO auth_proof")
  }

  /// THE synthetic-id reality (Layer-D prerequisite): a `status:"blocked"` is a VALID receipt the
  /// client RETURNS (so the UI renders it honestly), NOT a thrown error.
  func testSubmitMemoryDecision_blocked_isAReturnedReceiptNotAThrow() async throws {
    let (client, _) = try makeClient(mode: .memoryBlocked)
    let result = try await client.submitMemoryDecision(
      MemoryDecisionRequestWire(memoryId: "memory_candidate_mission_x_0", ownerPrincipal: owner, decision: "confirm"))
    XCTAssertEqual(result.status, "blocked")
    XCTAssertEqual(result.blocker, "unknown_candidate")
    XCTAssertFalse(result.recallable)
  }

  func testSubmitMemoryDecision_serverError_throwsServerError() async throws {
    let (client, _) = try makeClient(mode: .serverError)
    do {
      _ = try await client.submitMemoryDecision(
        MemoryDecisionRequestWire(memoryId: "mem-1", ownerPrincipal: owner, decision: "reject"))
      XCTFail("a typed Error frame must throw")
    } catch let err as FridayWriteClientError {
      guard case .serverError = err else { return XCTFail("expected serverError, got \(err)") }
    }
  }
}
