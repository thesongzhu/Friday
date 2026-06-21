import XCTest
@testable import FridayRustClient

/// **Tier-2 client-wiring tests** — drive `SealedWSReadClient.fetchWorkbench()` end-to-end
/// over an IN-MEMORY transport that emulates the Rust `hub_read_projection_server` flow:
/// the cleartext preamble (server pubkey + 64-byte nonce), the owner-auth verification
/// (the SAME `authenticate_forwarded` chain: open the `auth_proof` under the session key
/// with the read AAD, check it equals the nonce-bound challenge, owner-allowlist), and the
/// OWNER-SEALED refs-only snapshot response.
///
/// HONEST LABEL: this is WIRING-ONLY, NOT a crypto-parity proof. The emulated server seals
/// with the SAME Swift primitives the client uses, so a passing round-trip says nothing the
/// circular-roundtrip trap warns about. The crypto byte-parity is proven SEPARATELY by the
/// Rust-anchored `KATTests`; this test proves the CLIENT correctly sequences the handshake,
/// frames the owner-authed request, and decodes the owner-sealed snapshot into a typed
/// `WorkbenchSnapshot`. The live round-trip against the REAL Rust server is the deferred AC.
final class ReadClientWiringTests: XCTestCase {

  /// An in-memory transport that plays the Rust read server's half of the protocol, in the
  /// same byte sequence `establish_session` + `serve_read_session` use.
  final class EmulatedRustServerTransport: SealedWSTransport {
    private let serverKeypair: FridayCrypto.DeviceKeypair
    private let sessionNonce: [UInt8]
    private let peerAllowlist: [[UInt8]]
    private let ownerAllowlist: [String]
    private let projectionJSON: [UInt8]
    private let answerJSON: [UInt8]

    // Handshake state.
    private var clientPub: [UInt8]?
    private var sessionKey: [UInt8]?
    private var upgraded = false
    private var queuedFromServer: [[UInt8]] = []
    private(set) var processed = 0
    private(set) var endedFailClosed = false

    init(serverKeypair: FridayCrypto.DeviceKeypair,
         sessionNonce: [UInt8],
         peerAllowlist: [[UInt8]],
         ownerAllowlist: [String],
         projectionJSON: [UInt8],
         answerJSON: [UInt8] = []) {
      self.serverKeypair = serverKeypair
      self.sessionNonce = sessionNonce
      self.peerAllowlist = peerAllowlist
      self.ownerAllowlist = ownerAllowlist
      self.projectionJSON = projectionJSON
      self.answerJSON = answerJSON
    }

    // Phase 1 — preamble. The client writes its pubkey; we (server) reply with our pubkey
    // then the 64-byte session nonce, exactly like `establish_session`.
    func writeFrame(_ payload: [UInt8]) throws {
      if clientPub == nil {
        // (a') S-F peer-allowlist gate FIRST (a non-allowlisted client gets NO session).
        guard peerAllowlist.contains(payload) else {
          endedFailClosed = true
          throw FridayReadClientError.transport("peer pubkey not in allowlist")
        }
        clientPub = payload
        // (b) server pubkey out, (b') fresh nonce out.
        queuedFromServer.append(serverKeypair.publicKey)
        queuedFromServer.append(sessionNonce)
      }
    }

    func readFrame() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else {
        throw FridayReadClientError.transport("no preamble frame queued")
      }
      return queuedFromServer.removeFirst()
    }

    func upgrade() throws {
      guard let clientPub else { throw FridayReadClientError.transport("no client pubkey before upgrade") }
      // (c) derive the session key on the server side (agree is symmetric).
      sessionKey = try serverKeypair.agree(peerPublicKey: clientPub)
      upgraded = true
    }

    // Phase 2 — the client sends a sealed WorkbenchProjectionRequest; we verify auth and
    // reply with the owner-sealed snapshot (or end fail-closed).
    func sendMessage(_ body: [UInt8]) throws {
      guard upgraded, let sessionKey else { throw FridayReadClientError.transport("not upgraded") }
      // Open the envelope under the session key with the read SESSION_AAD.
      let envSealed = try FridayCrypto.decodeSealed(body)
      let envPt = try FridayCrypto.open(key: sessionKey, sealed: envSealed, aad: readSessionAad)
      let env = try FridayEnvelope.decodeJSON(Data(envPt))
      let reqPrincipal: String
      let reqId: String
      let authProof: [UInt8]
      enum ResponseKind {
        case workbench
        case projection((String, String, Int64) -> FridayMessage)
        case answerBody(runId: String)
      }
      let responseKind: ResponseKind
      switch env.message {
      case .workbenchProjectionRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .workbench
      case .runReadbackRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .runReadbackSnapshot(RunReadbackSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      case .runAnswerBodyRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .answerBody(runId: req.runId)
      case .providersDoctorRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .providersDoctorSnapshot(ProvidersDoctorSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      case .sessionListRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .sessionListSnapshot(SessionListSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      case .sessionOpenRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .sessionOpenSnapshot(SessionOpenSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      case .sessionLinkStateRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .sessionLinkStateSnapshot(SessionLinkStateSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      case .runFileViewRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .runFileViewSnapshot(RunFileViewSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      case .activityNeedsMeRequest(let req):
        reqPrincipal = req.forwardedPrincipal
        reqId = req.requestId
        authProof = req.authProof
        responseKind = .projection { requestId, sealedHex, generatedAtMs in
          .activityNeedsMeSnapshot(ActivityNeedsMeSnapshotWire(
            requestId: requestId, projectionJson: sealedHex, generatedAtMs: generatedAtMs))
        }
      default:
        throw FridayReadClientError.transport("expected a read projection request")
      }

      // AUTH — the SAME chain `authenticate_forwarded` runs: open the auth_proof under the
      // session key with auth_aad(read_aad, principal, request_id); it must equal the
      // nonce-bound challenge; principal must be on the owner allowlist.
      let reqAad = FridayCrypto.authAad(readSessionAad,
                                        forwardedPrincipal: reqPrincipal,
                                        boundContext: Array(reqId.utf8))
      let proofSealed = try FridayCrypto.decodeSealed(authProof)
      let openedChallenge: [UInt8]
      do {
        openedChallenge = try FridayCrypto.open(key: sessionKey, sealed: proofSealed, aad: reqAad)
      } catch {
        endedFailClosed = true
        return // NO snapshot — session ends fail-closed (the client recv will see EOF).
      }
      let expected = FridayCrypto.nonceBoundChallenge(readAuthChallenge, sessionNonce: sessionNonce)
      guard openedChallenge == expected, ownerAllowlist.contains(reqPrincipal) else {
        endedFailClosed = true
        return // fail-closed: no snapshot.
      }

      let responseMessage: FridayMessage
      let plaintext: [UInt8]
      switch responseKind {
      case .workbench:
        plaintext = projectionJSON
        responseMessage = .workbenchProjectionSnapshot(WorkbenchProjectionSnapshotWire(
          requestId: reqId,
          projectionJson: "",
          generatedAtMs: 1_780_640_000_000
        ))
      case .projection(let build):
        plaintext = projectionJSON
        responseMessage = build(reqId, "", 1_780_640_000_000)
      case .answerBody(let runId):
        if answerJSON.isEmpty {
          plaintext = Array("""
          {"truth_label":"rust_wired_owner_gated","ok":true,"outcome":"not_found","run_id":"\(runId)"}
          """.utf8)
        } else {
          plaintext = answerJSON
        }
        responseMessage = .runAnswerBodySnapshot(RunAnswerBodySnapshotWire(
          requestId: reqId,
          answerJson: "",
          generatedAtMs: 1_780_640_000_000
        ))
      }

      // AUTHENTICATED — owner-seal the projection JSON under the session key, hex it, and answer.
      let inner = try FridayCrypto.seal(key: sessionKey, plaintext: plaintext, aad: readSessionAad)
      let sealedHex = Hex.encode(FridayCrypto.encodeSealed(inner))
      let finalMessage: FridayMessage
      switch responseMessage {
      case .workbenchProjectionSnapshot(let snap):
        finalMessage = .workbenchProjectionSnapshot(WorkbenchProjectionSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .runReadbackSnapshot(let snap):
        finalMessage = .runReadbackSnapshot(RunReadbackSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .providersDoctorSnapshot(let snap):
        finalMessage = .providersDoctorSnapshot(ProvidersDoctorSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .sessionListSnapshot(let snap):
        finalMessage = .sessionListSnapshot(SessionListSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .sessionOpenSnapshot(let snap):
        finalMessage = .sessionOpenSnapshot(SessionOpenSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .sessionLinkStateSnapshot(let snap):
        finalMessage = .sessionLinkStateSnapshot(SessionLinkStateSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .runFileViewSnapshot(let snap):
        finalMessage = .runFileViewSnapshot(RunFileViewSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .activityNeedsMeSnapshot(let snap):
        finalMessage = .activityNeedsMeSnapshot(ActivityNeedsMeSnapshotWire(
          requestId: snap.requestId,
          projectionJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      case .runAnswerBodySnapshot(let snap):
        finalMessage = .runAnswerBodySnapshot(RunAnswerBodySnapshotWire(
          requestId: snap.requestId,
          answerJson: sealedHex,
          generatedAtMs: snap.generatedAtMs))
      default:
        throw FridayReadClientError.transport("unreachable response kind")
      }
      let resp = FridayEnvelope(
        msgId: "read-projection-snapshot-\(reqId)",
        sentAt: 1_780_640_000_000,
        message: finalMessage
      ).withCorrelation(env.msgId)
      let respSealed = try FridayCrypto.seal(key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: readSessionAad)
      queuedFromServer.append(FridayCrypto.encodeSealed(respSealed))
      processed += 1
    }

    func recvMessage() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else {
        // The server ended the session (fail-closed auth) — the client sees a closed pipe.
        throw FridayReadClientError.transport("session ended (no response)")
      }
      return queuedFromServer.removeFirst()
    }
  }

  // A refs-only projection JSON shaped like the Rust `project_workbench` output.
  private static let refsOnlyProjection = """
  {"missionId":"mission_read_seam_probe_20260611",\
  "fridayConversationId":"fconv_read_seam_probe",\
  "runtimeFeedStatus":"live_rust_hub_projection",\
  "statusLabels":["stale","offline","error"],\
  "routeDecision":{"advisorSummary":"The Workbench must consume Rust Hub Mission truth.",\
  "selectedRoute":"route-decision://redacted/route_read_probe","truthLabel":"friday_owned"},\
  "workItems":[{"workItemId":"work_read_probe_provider","status":"provider_waiting"}]}
  """

  private let owner = "principal:read-owner-allowlisted"

  func testFetchWorkbench_happyPath_decodesOwnerSealedSnapshot() async throws {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce) // a valid 64-byte nonce

    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey],
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: owner,
      makeTransport: { transport },
      now: { 1000 },
      newRequestId: { "req-roundtrip-1" }
    )

    let snapshot = try await client.fetchWorkbench()
    XCTAssertEqual(snapshot.missionId, "mission_read_seam_probe_20260611")
    XCTAssertEqual(snapshot.fridayConversationId, "fconv_read_seam_probe")
    XCTAssertEqual(snapshot.runtimeFeedStatus, "live_rust_hub_projection")
    XCTAssertEqual(snapshot.statusLabels, ["stale", "offline", "error"])
    XCTAssertEqual(snapshot.routeDecisionSummary, "The Workbench must consume Rust Hub Mission truth.")
    XCTAssertEqual(snapshot.workItemIds, ["work_read_probe_provider"])
    XCTAssertEqual(snapshot.generatedAtMs, 1_780_640_000_000)
    XCTAssertEqual(transport.processed, 1)
    // Refs-only: no secret markers leaked into the opened projection.
    let raw = try JSONSerialization.data(withJSONObject: snapshot.raw)
    let rawStr = String(decoding: raw, as: UTF8.self)
    XCTAssertFalse(rawStr.contains("Authorization"))
    XCTAssertFalse(rawStr.contains("Bearer"))
  }

  func testFetchRunAnswerBody_happyPath_decodesOwnerSealedAnswer() async throws {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)
    let answerJSON = """
    {"truth_label":"rust_wired_owner_gated","ok":true,"outcome":"delivered","run_id":"run-readable",\
    "status":"finished","answer":"Friday can now show the owner-gated answer body.",\
    "answer_sha256":"\(String(repeating: "a", count: 64))","answer_len":50}
    """

    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey],
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8),
      answerJSON: Array(answerJSON.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: owner,
      makeTransport: { transport },
      now: { 1000 },
      newRequestId: { "req-answer-1" }
    )

    let body = try await client.fetchRunAnswerBody(runId: "run-readable")
    XCTAssertEqual(body.runId, "run-readable")
    XCTAssertEqual(body.outcome, "delivered")
    XCTAssertEqual(body.deliveredAnswer, "Friday can now show the owner-gated answer body.")
    XCTAssertEqual(body.status, "finished")
    XCTAssertEqual(body.answerLen, 50)
    XCTAssertEqual(body.truthLabel, "rust_wired_owner_gated")
    XCTAssertEqual(transport.processed, 1)
  }

  func testFetchAdditionalReadArms_decodeOwnerSealedProjection() async throws {
    func makeClient(requestId: String) throws -> (SealedWSReadClient, EmulatedRustServerTransport) {
      let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
      let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
      let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)
      let transport = EmulatedRustServerTransport(
        serverKeypair: serverKp,
        sessionNonce: nonce,
        peerAllowlist: [clientKp.publicKey],
        ownerAllowlist: [owner],
        projectionJSON: Array(Self.refsOnlyProjection.utf8)
      )
      let client = SealedWSReadClient(
        keypair: clientKp,
        forwardedPrincipal: owner,
        makeTransport: { transport },
        now: { 1000 },
        newRequestId: { requestId }
      )
      return (client, transport)
    }

    let runReadback = try makeClient(requestId: "req-run-readback")
    let runReadbackSnapshot = try await runReadback.0.fetchRunReadback(runId: "run-1")
    XCTAssertEqual(runReadbackSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(runReadback.1.processed, 1)

    let providersDoctor = try makeClient(requestId: "req-providers")
    let providersDoctorSnapshot = try await providersDoctor.0.fetchProvidersDoctor(probe: "both")
    XCTAssertEqual(providersDoctorSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(providersDoctor.1.processed, 1)

    let sessionList = try makeClient(requestId: "req-session-list")
    let sessionListSnapshot = try await sessionList.0.fetchSessionList()
    XCTAssertEqual(sessionListSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(sessionList.1.processed, 1)

    let sessionOpen = try makeClient(requestId: "req-session-open")
    let sessionOpenSnapshot = try await sessionOpen.0.fetchSessionOpen(agentSessionId: "session-1")
    XCTAssertEqual(sessionOpenSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(sessionOpen.1.processed, 1)

    let linkState = try makeClient(requestId: "req-link-state")
    let linkStateSnapshot = try await linkState.0.fetchSessionLinkState(agentSessionId: "session-1")
    XCTAssertEqual(linkStateSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(linkState.1.processed, 1)

    let fileView = try makeClient(requestId: "req-file-view")
    let fileViewSnapshot = try await fileView.0.fetchRunFileView(runId: "run-1")
    XCTAssertEqual(fileViewSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(fileView.1.processed, 1)

    let needsMe = try makeClient(requestId: "req-needs-me")
    let needsMeSnapshot = try await needsMe.0.fetchActivityNeedsMe(runId: "run-1")
    XCTAssertEqual(needsMeSnapshot.raw["missionId"] as? String, "mission_read_seam_probe_20260611")
    XCTAssertEqual(needsMe.1.processed, 1)
  }

  func testFetchWorkbench_mismatchedPrincipal_endsFailClosed() async throws {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)

    // The server's owner allowlist holds `owner`; the client forwards a DIFFERENT principal.
    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [clientKp.publicKey],
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: "principal:not-the-owner",
      makeTransport: { transport },
      newRequestId: { "req-ownerscope-1" }
    )

    do {
      _ = try await client.fetchWorkbench()
      XCTFail("a mismatched principal must get NO snapshot")
    } catch {
      // The session ends fail-closed: the client's recv sees a closed pipe.
      XCTAssertTrue(transport.endedFailClosed)
      XCTAssertEqual(transport.processed, 0)
    }
  }

  func testFetchWorkbench_nonAllowlistedPeer_rejectedAtHandshake() async throws {
    // A FRESH client keypair whose pubkey is NOT in the server's peer allowlist.
    let clientKp = FridayCrypto.DeviceKeypair()
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let enrolledKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)

    let transport = EmulatedRustServerTransport(
      serverKeypair: serverKp,
      sessionNonce: nonce,
      peerAllowlist: [enrolledKp.publicKey], // the fresh client is NOT here
      ownerAllowlist: [owner],
      projectionJSON: Array(Self.refsOnlyProjection.utf8)
    )
    let client = SealedWSReadClient(
      keypair: clientKp,
      forwardedPrincipal: owner,
      makeTransport: { transport }
    )

    do {
      _ = try await client.fetchWorkbench()
      XCTFail("a non-allowlisted peer must be rejected at the handshake")
    } catch {
      XCTAssertTrue(transport.endedFailClosed)
    }
  }

  /// Envelope JSON round-trips (sanity for the request the client builds). NOT a parity
  /// assertion — the envelope is sealed then serde-parsed (order-agnostic); this just pins
  /// the request shape the client emits.
  func testEnvelopeRoundTrips() throws {
    let req = WorkbenchProjectionRequestWire(
      missionId: nil, forwardedPrincipal: owner, authProof: [1, 2, 3], requestId: "req-x"
    )
    let env = FridayEnvelope(msgId: "msg-x", sentAt: 7, message: .workbenchProjectionRequest(req))
      .withCorrelation("corr-1")
    let data = try env.encodeJSON()
    let back = try FridayEnvelope.decodeJSON(data)
    XCTAssertEqual(back, env)
    // An absent missionId is OMITTED on the wire (matches Rust skip_serializing_if).
    let json = String(decoding: data, as: UTF8.self)
    XCTAssertFalse(json.contains("mission_id"))
    XCTAssertTrue(json.contains("\"kind\":\"WorkbenchProjectionRequest\""))

    let answerReq = RunAnswerBodyRequestWire(
      runId: "run-1", forwardedPrincipal: owner, authProof: [4, 5, 6], requestId: "req-answer"
    )
    let answerEnv = FridayEnvelope(msgId: "msg-answer", sentAt: 8, message: .runAnswerBodyRequest(answerReq))
      .withCorrelation("corr-answer")
    let answerData = try answerEnv.encodeJSON()
    let answerBack = try FridayEnvelope.decodeJSON(answerData)
    XCTAssertEqual(answerBack, answerEnv)
    let answerJson = String(decoding: answerData, as: UTF8.self)
    XCTAssertTrue(answerJson.contains("\"kind\":\"RunAnswerBodyRequest\""))
  }
}
