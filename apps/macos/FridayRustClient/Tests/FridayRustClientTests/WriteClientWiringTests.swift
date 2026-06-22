import XCTest
@testable import FridayRustClient

/// **Tier-2 write-client-wiring tests** — drive `SealedWSWriteClient.dispatchAgentRun` +
/// `resumeWithApproval` end-to-end over an IN-MEMORY transport that emulates the Rust
/// `hub_agent_run_server` flow: the cleartext preamble (server pubkey + 64-byte nonce), the
/// owner-auth verification (the SAME `authenticate_forwarded` chain on the WRITE constants), and
/// then EITHER a refs-only `AgentRunResult`, an `AgentRunPaused` (flag-on), or — for a resume —
/// an `AgentRunControlResult`.
///
/// HONEST LABEL: this is WIRING-ONLY, NOT a crypto-parity proof (the emulated server seals with the
/// SAME Swift primitives the client uses — a passing round-trip says nothing the circular-roundtrip
/// trap warns about). The crypto byte-parity is proven SEPARATELY by the Rust-anchored
/// `WriteKATTests`. This proves the CLIENT correctly sequences the handshake, frames the
/// owner-authed dispatch, settles refs-only on the FIRST inbound (leg-A decouple), discriminates a
/// PAUSE from a result under the flag, and relays the opaque resume blob VERBATIM (INV-1). The live
/// round-trip against the REAL Rust server + a real operator-signed blob is the deferred slice-6 AC.
final class WriteClientWiringTests: XCTestCase {

  // The control op the emulated server returns on a relayed resume.
  enum ServerMode {
    case completeRun         // dispatch → AgentRunResult(completed, with fingerprint)
    case pauseRun            // dispatch → AgentRunPaused(refs only)
    case resumeAccepted      // resume → AgentRunControlResult(accepted, mutation_completed)
    case resumeRefused       // resume → AgentRunControlResult(accepted=false, denied)
    case rejectAccepted      // reject → AgentRunControlResult(accepted, rejected)
    case cancelAccepted      // cancel → AgentRunControlResult(accepted, cancelled)
  }

  /// An in-memory transport playing the Rust agent-run WRITE server's half, in the byte sequence
  /// `establish_session` + `serve_sealed_session` use, over the WRITE SESSION_AAD.
  final class EmulatedWriteServerTransport: SealedWSTransport {
    private let serverKeypair: FridayCrypto.DeviceKeypair
    private let sessionNonce: [UInt8]
    private let peerAllowlist: [[UInt8]]
    private let ownerAllowlist: [String]
    private let mode: ServerMode

    private var clientPub: [UInt8]?
    private var sessionKey: [UInt8]?
    private var upgraded = false
    private var queuedFromServer: [[UInt8]] = []
    private(set) var dispatched = 0
    private(set) var resumed = 0
    private(set) var rejected = 0
    private(set) var cancelled = 0
    private(set) var endedFailClosed = false
    /// Captured VERBATIM blob the client relayed (proves INV-1 verbatim relay end-to-end).
    private(set) var receivedSignedBlob: [UInt8]?
    private(set) var receivedApprovalId: String?
    private(set) var receivedCancelReason: String?
    private(set) var receivedConstraints: AgentRunConstraintsWire?
    private(set) var receivedSessionId: String?
    private(set) var receivedMissionContext: MissionWorkItemContextWire?

    init(serverKeypair: FridayCrypto.DeviceKeypair, sessionNonce: [UInt8],
         peerAllowlist: [[UInt8]], ownerAllowlist: [String], mode: ServerMode) {
      self.serverKeypair = serverKeypair
      self.sessionNonce = sessionNonce
      self.peerAllowlist = peerAllowlist
      self.ownerAllowlist = ownerAllowlist
      self.mode = mode
    }

    func writeFrame(_ payload: [UInt8]) throws {
      if clientPub == nil {
        // S-F peer-allowlist gate FIRST (a non-allowlisted client gets NO session).
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
      let env = try FridayEnvelope.decodeJSON(Data(try FridayCrypto.open(
        key: sessionKey, sealed: FridayCrypto.decodeSealed(body), aad: writeSessionAad)))
      switch env.message {
      case .agentRunRequest(let req):
        try handleDispatch(req, sessionKey: sessionKey, correlation: env.msgId)
      case .agentRunResume(let runId, let signedBlob):
        try handleResume(runId: runId, signedBlob: signedBlob, sessionKey: sessionKey, correlation: env.msgId)
      case .agentRunReject(let runId, let approvalId, let forwardedPrincipal, let authProof):
        try handleOwnerAuthedControl(
          runId: runId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          sessionKey: sessionKey,
          correlation: env.msgId,
          op: "reject",
          acceptedStatus: "rejected",
          auditRef: "audit://reject/\(runId)",
          onAccepted: {
            self.receivedApprovalId = approvalId
            self.rejected += 1
          })
      case .agentRunCancel(let runId, let forwardedPrincipal, let authProof, let reason):
        try handleOwnerAuthedControl(
          runId: runId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          sessionKey: sessionKey,
          correlation: env.msgId,
          op: "cancel",
          acceptedStatus: "cancelled",
          auditRef: "audit://cancel/\(runId)",
          onAccepted: {
            self.receivedCancelReason = reason
            self.cancelled += 1
          })
      default:
        throw FridayWriteClientError.transport("unexpected inbound on the write session: \(env.msgId)")
      }
    }

    private func handleDispatch(_ req: AgentRunRequestWire, sessionKey: [UInt8], correlation: String) throws {
      receivedConstraints = req.constraints
      receivedSessionId = req.sessionId
      receivedMissionContext = req.missionContext
      // AUTH — the SAME chain: open the auth_proof under the session key with auth_aad(write_aad,
      // principal, run_id); it must equal the WRITE nonce-bound challenge; principal must be on the
      // owner allowlist. (The WRITE constants, not the read constants.)
      let reqAad = FridayCrypto.authAad(writeSessionAad, forwardedPrincipal: req.forwardedPrincipal, boundContext: Array(req.runId.utf8))
      let opened: [UInt8]
      do {
        opened = try FridayCrypto.open(key: sessionKey, sealed: FridayCrypto.decodeSealed(req.authProof), aad: reqAad)
      } catch {
        endedFailClosed = true; return // fail-closed: NO result, session ends.
      }
      let expected = FridayCrypto.nonceBoundChallenge(writeAuthChallenge, sessionNonce: sessionNonce)
      guard opened == expected, ownerAllowlist.contains(req.forwardedPrincipal) else {
        endedFailClosed = true; return
      }
      // AUTHENTICATED — answer per the mode.
      let message: FridayMessage
      switch mode {
      case .pauseRun:
        message = .agentRunPaused(AgentRunPausedWire(
          runId: req.runId, nonce: "approval-nonce-\(req.runId)",
          actionDigest: String(repeating: "c", count: 64), summary: "write_file"))
      default:
        message = .agentRunResult(AgentRunResultWire(
          runId: req.runId, status: "completed",
          answerSha256: String(repeating: "a", count: 64), answerLen: 128, turns: 2, executedTools: 1))
      }
      let resp = FridayEnvelope(msgId: "agent-run-result-\(req.runId)", sentAt: 1_780_640_000_000, message: message)
        .withCorrelation(correlation)
      queuedFromServer.append(try FridayCrypto.encodeSealed(FridayCrypto.seal(
        key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: writeSessionAad)))
      dispatched += 1
    }

    private func handleResume(runId: String, signedBlob: [UInt8], sessionKey: [UInt8], correlation: String) throws {
      // The server decodes the OPAQUE blob to a CanonicalApproval + Ed25519-verifies under the
      // operator's public key (modeled here as: a non-empty blob is the only thing the relay leg
      // carries — the real verify is the Rust S6 spine). Capture it to prove the verbatim relay.
      receivedSignedBlob = signedBlob
      let accepted = (mode == .resumeAccepted)
      let result = AgentRunControlResultWire(
        runId: runId, op: "resume", accepted: accepted,
        status: accepted ? "mutation_completed" : "denied",
        auditRef: accepted ? "audit://chain/\(runId)" : nil)
      let resp = FridayEnvelope(msgId: "agent-run-control-result-\(runId)", sentAt: 1_780_640_000_000,
                                message: .agentRunControlResult(result)).withCorrelation(correlation)
      queuedFromServer.append(try FridayCrypto.encodeSealed(FridayCrypto.seal(
        key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: writeSessionAad)))
      resumed += 1
    }

    private func handleOwnerAuthedControl(
      runId: String,
      forwardedPrincipal: String,
      authProof: [UInt8],
      sessionKey: [UInt8],
      correlation: String,
      op: String,
      acceptedStatus: String,
      auditRef: String,
      onAccepted: () -> Void
    ) throws {
      let reqAad = FridayCrypto.authAad(
        writeSessionAad,
        forwardedPrincipal: forwardedPrincipal,
        boundContext: Array(runId.utf8))
      let opened: [UInt8]
      do {
        opened = try FridayCrypto.open(
          key: sessionKey,
          sealed: FridayCrypto.decodeSealed(authProof),
          aad: reqAad)
      } catch {
        endedFailClosed = true
        return
      }
      let expected = FridayCrypto.nonceBoundChallenge(writeAuthChallenge, sessionNonce: sessionNonce)
      let accepted = opened == expected && ownerAllowlist.contains(forwardedPrincipal)
      if accepted {
        onAccepted()
      }
      let result = AgentRunControlResultWire(
        runId: runId,
        op: op,
        accepted: accepted,
        status: accepted ? acceptedStatus : "auth_failed",
        auditRef: accepted ? auditRef : nil)
      let resp = FridayEnvelope(
        msgId: "agent-run-control-result-\(runId)",
        sentAt: 1_780_640_000_000,
        message: .agentRunControlResult(result)).withCorrelation(correlation)
      queuedFromServer.append(try FridayCrypto.encodeSealed(FridayCrypto.seal(
        key: sessionKey, plaintext: [UInt8](resp.encodeJSON()), aad: writeSessionAad)))
    }

    func recvMessage() throws -> [UInt8] {
      guard !queuedFromServer.isEmpty else { throw FridayWriteClientError.transport("session ended (no response)") }
      return queuedFromServer.removeFirst()
    }
  }

  private let owner = "principal:owner-allowlisted"

  private func makeClient(mode: ServerMode, controlEnabled: Bool, principal: String? = nil,
                          peerEnrolled: Bool = true, sessionId: String? = nil)
    throws -> (SealedWSWriteClient, EmulatedWriteServerTransport) {
    let clientKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.clientSecret))
    let serverKp = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(B1KAT.k1Agree.serverSecret))
    let nonce = try Hex.decode(B1KAT.k3Auth.sessionNonce)
    let transport = EmulatedWriteServerTransport(
      serverKeypair: serverKp, sessionNonce: nonce,
      peerAllowlist: peerEnrolled ? [clientKp.publicKey] : [serverKp.publicKey],
      ownerAllowlist: [owner], mode: mode)
    let client = SealedWSWriteClient(
      keypair: clientKp, forwardedPrincipal: principal ?? owner, sessionId: sessionId,
      agentRunControlViaRust: controlEnabled, makeTransport: { transport },
      now: { 1000 }, newRunId: { "run-wiring-1" })
    return (client, transport)
  }

  // MARK: dispatch — completed result

  func testDispatch_happyPath_settlesRefsOnlyResult() async throws {
    let (client, transport) = try makeClient(mode: .completeRun, controlEnabled: false)
    let outcome = try await client.dispatchAgentRun(task: "summarize the inbox", constraints: nil)
    guard case .result(let r) = outcome else { return XCTFail("expected a result outcome") }
    XCTAssertEqual(r.runId, "run-wiring-1")
    XCTAssertEqual(r.status, "completed")
    XCTAssertEqual(r.answerLen, 128)
    XCTAssertEqual(r.turns, 2)
    XCTAssertEqual(r.executedTools, 1)
    XCTAssertEqual(transport.dispatched, 1)
    // DEFAULT read-only/no-grant: a nil constraints dispatch carries NO constraints block.
    XCTAssertNil(transport.receivedConstraints)
    XCTAssertNil(transport.receivedSessionId)
  }

  /// A constraints-bearing dispatch forwards ONLY restrictions to the server (the grant/gate hints
  /// never ride the wire — end-to-end proof of the WK3 surface).
  func testDispatch_constraintsForwardRestrictionsOnly() async throws {
    let (client, transport) = try makeClient(mode: .completeRun, controlEnabled: true, sessionId: "sess-1")
    let constraints = AgentRunConstraintsWire(
      readOnly: false, disabledTools: ["run_command"], maxTurns: 4,
      mutatingToolGrant: ["write_file"], mutationGate: "operator_signed_ed25519")
    _ = try await client.dispatchAgentRun(task: "edit the file", constraints: constraints)
    let got = try XCTUnwrap(transport.receivedConstraints)
    XCTAssertFalse(got.readOnly)
    XCTAssertEqual(got.disabledTools, ["run_command"])
    XCTAssertEqual(got.maxTurns, 4)
    // The grant/gate admission hints did NOT survive the wire (decoded to defaults).
    XCTAssertTrue(got.mutatingToolGrant.isEmpty)
    XCTAssertNil(got.mutationGate)
    XCTAssertEqual(transport.receivedSessionId, "sess-1")
  }

  func testDispatch_missionBoundCarriesFirstClassMissionContext() async throws {
    let (client, transport) = try makeClient(mode: .completeRun, controlEnabled: false)
    let context = MissionWorkItemContextWire(
      fridayConversationId: "fconv-product-1",
      missionId: "mission-product-1",
      workItemId: "work-product-1")
    let outcome = try await client.dispatchMissionBoundAgentRun(
      task: "summarize the mission state",
      missionContext: context,
      constraints: AgentRunConstraintsWire(readOnly: true))
    guard case .result(let r) = outcome else { return XCTFail("expected a result outcome") }
    XCTAssertEqual(r.runId, "run-wiring-1")
    XCTAssertEqual(transport.receivedMissionContext, context)
    XCTAssertEqual(transport.receivedConstraints?.readOnly, true)
    XCTAssertEqual(transport.dispatched, 1)
  }

  // MARK: dispatch — pause (flag-gated)

  /// FLAG-ON: a server `AgentRunPaused` settles the dispatch with a `.paused` outcome carrying REFS
  /// ONLY (runId, approvalId=nonce, actionDigest, summary?) — NO signing material (INV-1).
  func testDispatch_pause_flagOn_settlesPausedOutcomeRefsOnly() async throws {
    let (client, transport) = try makeClient(mode: .pauseRun, controlEnabled: true)
    let outcome = try await client.dispatchAgentRun(task: "write a file", constraints: nil)
    guard case .paused(let p) = outcome else { return XCTFail("expected a paused outcome") }
    XCTAssertEqual(p.runId, "run-wiring-1")
    XCTAssertEqual(p.approvalId, "approval-nonce-run-wiring-1") // wire `nonce` → approvalId
    XCTAssertEqual(p.actionDigest, String(repeating: "c", count: 64))
    XCTAssertEqual(p.ownerSealedSummary, "write_file")
    XCTAssertEqual(p.truthLabel, "rust_wired")
    XCTAssertEqual(transport.dispatched, 1)
  }

  /// FLAG-OFF: the SAME server `AgentRunPaused` is an UNKNOWN inbound ⇒ fail-closed (byte-identical
  /// to the no-control posture). The pause never settles as a recognized outcome.
  func testDispatch_pause_flagOff_failsClosedUnknown() async throws {
    let (client, _) = try makeClient(mode: .pauseRun, controlEnabled: false)
    do {
      _ = try await client.dispatchAgentRun(task: "write a file", constraints: nil)
      XCTFail("a paused frame with the flag off must fail closed")
    } catch let err as FridayWriteClientError {
      XCTAssertEqual(err, .unexpectedResponse(kind: "AgentRunPaused"))
    }
  }

  // MARK: dispatch — fail-closed auth

  func testDispatch_mismatchedPrincipal_endsFailClosed() async throws {
    let (client, transport) = try makeClient(mode: .completeRun, controlEnabled: false, principal: "principal:not-the-owner")
    do {
      _ = try await client.dispatchAgentRun(task: "x", constraints: nil)
      XCTFail("a mismatched principal must get NO result")
    } catch {
      XCTAssertTrue(transport.endedFailClosed)
      XCTAssertEqual(transport.dispatched, 0)
    }
  }

  func testDispatch_nonAllowlistedPeer_rejectedAtHandshake() async throws {
    let (client, transport) = try makeClient(mode: .completeRun, controlEnabled: false, peerEnrolled: false)
    do {
      _ = try await client.dispatchAgentRun(task: "x", constraints: nil)
      XCTFail("a non-allowlisted peer must be rejected at the handshake")
    } catch {
      XCTAssertTrue(transport.endedFailClosed)
    }
  }

  // MARK: resume (the S6 relay)

  /// FLAG-ON: `resumeWithApproval` relays the OPAQUE blob VERBATIM over a FRESH session and parses
  /// the refs-only AgentRunControlResult. INV-1: the server received the EXACT bytes the caller
  /// passed (the client minted/inspected nothing).
  func testResume_flagOn_relaysBlobVerbatim_acceptedControlResult() async throws {
    let (client, transport) = try makeClient(mode: .resumeAccepted, controlEnabled: true)
    let blob: [UInt8] = (0..<48).map { UInt8($0 &* 5 &+ 1) }
    let result = try await client.resumeWithApproval(runId: "run-paused-9", opaqueSignedBlob: blob)
    XCTAssertTrue(result.accepted)
    XCTAssertEqual(result.op, "resume")
    XCTAssertEqual(result.status, "mutation_completed")
    XCTAssertEqual(result.auditRef, "audit://chain/run-paused-9")
    XCTAssertEqual(transport.resumed, 1)
    XCTAssertEqual(transport.receivedSignedBlob, blob, "INV-1: the blob must arrive VERBATIM at the server")
  }

  /// A server REFUSAL (`accepted=false`) is a SUCCESSFUL relay of a refusal outcome, NOT a
  /// transport failure — it resolves with `{accepted:false, status}`.
  func testResume_serverRefusal_isASuccessfulRelayOfARefusal() async throws {
    let (client, _) = try makeClient(mode: .resumeRefused, controlEnabled: true)
    let result = try await client.resumeWithApproval(runId: "run-x", opaqueSignedBlob: [1, 2, 3])
    XCTAssertFalse(result.accepted)
    XCTAssertEqual(result.status, "denied")
    XCTAssertNil(result.auditRef)
  }

  /// FLAG-OFF: `resumeWithApproval` relays NOTHING — it fails closed WITHOUT opening a socket
  /// (the default-off posture is byte-identical; no AgentRunResume is ever sent).
  func testResume_flagOff_refusesWithoutOpeningASocket() async throws {
    let (client, transport) = try makeClient(mode: .resumeAccepted, controlEnabled: false)
    do {
      _ = try await client.resumeWithApproval(runId: "run-x", opaqueSignedBlob: [1, 2, 3])
      XCTFail("resume with the flag off must fail closed")
    } catch let err as FridayWriteClientError {
      XCTAssertEqual(err, .runControlDisabled)
      XCTAssertEqual(transport.resumed, 0, "no socket opened ⇒ the server saw no resume")
      XCTAssertNil(transport.receivedSignedBlob)
    }
  }

  /// INV-1 guard: an EMPTY blob carries no signature ⇒ fail closed (no relay).
  func testResume_emptyBlob_failsClosed() async throws {
    let (client, transport) = try makeClient(mode: .resumeAccepted, controlEnabled: true)
    do {
      _ = try await client.resumeWithApproval(runId: "run-x", opaqueSignedBlob: [])
      XCTFail("an empty signed blob must fail closed")
    } catch let err as FridayWriteClientError {
      XCTAssertEqual(err, .emptySignedBlob)
      XCTAssertEqual(transport.resumed, 0)
    }
  }

  // MARK: reject/cancel (owner-authed run controls)

  func testReject_flagOn_sendsOwnerAuthedApprovalReject() async throws {
    let (client, transport) = try makeClient(mode: .rejectAccepted, controlEnabled: true)
    let result = try await client.rejectApproval(runId: "run-paused-9", approvalId: "approval-123")
    XCTAssertTrue(result.accepted)
    XCTAssertEqual(result.op, "reject")
    XCTAssertEqual(result.status, "rejected")
    XCTAssertEqual(result.auditRef, "audit://reject/run-paused-9")
    XCTAssertEqual(transport.rejected, 1)
    XCTAssertEqual(transport.receivedApprovalId, "approval-123")
    XCTAssertEqual(transport.resumed, 0, "reject must not relay a resume blob")
  }

  func testReject_flagOff_refusesWithoutOpeningASocket() async throws {
    let (client, transport) = try makeClient(mode: .rejectAccepted, controlEnabled: false)
    do {
      _ = try await client.rejectApproval(runId: "run-x", approvalId: "approval-x")
      XCTFail("reject with the flag off must fail closed")
    } catch let err as FridayWriteClientError {
      XCTAssertEqual(err, .runControlDisabled)
      XCTAssertEqual(transport.rejected, 0)
      XCTAssertNil(transport.receivedApprovalId)
    }
  }

  func testReject_missingApprovalId_failsClosedBeforeSocket() async throws {
    let (client, transport) = try makeClient(mode: .rejectAccepted, controlEnabled: true)
    do {
      _ = try await client.rejectApproval(runId: "run-x", approvalId: "")
      XCTFail("reject requires a concrete approval id")
    } catch let err as FridayWriteClientError {
      XCTAssertEqual(err, .missingRef("reject requires an approval id"))
      XCTAssertEqual(transport.rejected, 0)
    }
  }

  func testCancel_flagOn_sendsOwnerAuthedCancel() async throws {
    let (client, transport) = try makeClient(mode: .cancelAccepted, controlEnabled: true)
    let result = try await client.cancelRun(runId: "run-live-1", reason: "operator stopped it")
    XCTAssertTrue(result.accepted)
    XCTAssertEqual(result.op, "cancel")
    XCTAssertEqual(result.status, "cancelled")
    XCTAssertEqual(result.auditRef, "audit://cancel/run-live-1")
    XCTAssertEqual(transport.cancelled, 1)
    XCTAssertEqual(transport.receivedCancelReason, "operator stopped it")
    XCTAssertEqual(transport.resumed, 0)
  }

  func testCancel_flagOff_refusesWithoutOpeningASocket() async throws {
    let (client, transport) = try makeClient(mode: .cancelAccepted, controlEnabled: false)
    do {
      _ = try await client.cancelRun(runId: "run-x", reason: nil)
      XCTFail("cancel with the flag off must fail closed")
    } catch let err as FridayWriteClientError {
      XCTAssertEqual(err, .runControlDisabled)
      XCTAssertEqual(transport.cancelled, 0)
      XCTAssertNil(transport.receivedCancelReason)
    }
  }
}
