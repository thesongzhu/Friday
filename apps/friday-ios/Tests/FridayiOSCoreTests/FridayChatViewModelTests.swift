import XCTest
@testable import FridayiOSCore
@testable import FridayRustClient

/// **View-model-level tests for the Friday Chat read-WRITE surface (the strict needle).**
///
/// UI-FREE: these drive `FridayChatViewModel` against a FAKE `FridayRustWriteClient` (so the
/// loop's STATE TRANSITIONS + the INV-1/2/5 enforcement are tested without a socket) and the
/// `MockOperatorSigner`. The real client's WIRING (handshake/auth/seal-open + the verbatim relay
/// at the wire) is proven separately by the package's `WriteClientWiringTests`; here we prove the
/// view model correctly drives send→answer, mutating→paused→approval-card, approve→resume-relays-
/// the-blob-VERBATIM, holds-no-key, and renders honest-unavailable on a connection failure.
@MainActor
final class FridayChatViewModelTests: XCTestCase {

  // MARK: - A fake write client (records what the view model relays; no socket)

  /// A scripted `FridayRustWriteClient`. It records the EXACT bytes the view model relays to
  /// `resumeWithApproval` (proving the verbatim INV-1 relay through the view-model layer) and can
  /// be set to throw (proving honest-unavailable).
  final class FakeWriteClient: FridayRustWriteClient {
    enum DispatchScript { case answer(AgentRunResultWire); case pause(PausedOutcome); case fail(FridayWriteClientError) }
    enum ResumeScript { case accepted(ResumeRelayResult); case refused(ResumeRelayResult); case fail(FridayWriteClientError) }

    let dispatchScript: DispatchScript
    let resumeScript: ResumeScript

    private(set) var dispatchedTasks: [String] = []
    private(set) var dispatchedConstraints: [AgentRunConstraintsWire?] = []
    private(set) var resumedRunIds: [String] = []
    /// The VERBATIM blob the view model relayed (the INV-1 proof at the view-model boundary).
    private(set) var relayedBlobs: [[UInt8]] = []

    init(dispatch: DispatchScript, resume: ResumeScript = .fail(.runControlDisabled)) {
      self.dispatchScript = dispatch
      self.resumeScript = resume
    }

    func dispatchAgentRun(task: String, constraints: AgentRunConstraintsWire?) async throws -> AgentRunDispatchOutcome {
      dispatchedTasks.append(task)
      dispatchedConstraints.append(constraints)
      switch dispatchScript {
      case .answer(let r): return .result(r)
      case .pause(let p): return .paused(p)
      case .fail(let e): throw e
      }
    }

    func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
      resumedRunIds.append(runId)
      relayedBlobs.append(opaqueSignedBlob)
      switch resumeScript {
      case .accepted(let r), .refused(let r): return r
      case .fail(let e): throw e
      }
    }
  }

  private func makeAnswer(_ runId: String = "run-1") -> AgentRunResultWire {
    AgentRunResultWire(runId: runId, status: "completed",
                       answerSha256: String(repeating: "a", count: 64), answerLen: 128, turns: 2, executedTools: 0)
  }

  private func makePause(_ runId: String = "run-1") -> PausedOutcome {
    PausedOutcome(runId: runId, approvalId: "ap-nonce-\(runId)",
                  actionDigest: String(repeating: "c", count: 64), ownerSealedSummary: "write_file(notes.md)")
  }

  // MARK: 1. Compose → Send → Answer (mock)

  func testSend_settlesRefsOnlyAnswer() async {
    let client = FakeWriteClient(dispatch: .answer(makeAnswer()))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("summarize my inbox")
    guard case .answered(let receipt) = vm.phase else { return XCTFail("expected .answered, got \(vm.phase)") }
    XCTAssertEqual(receipt.status, "completed")
    XCTAssertEqual(receipt.answerLen, 128)         // refs/counts only (INV-5)
    XCTAssertEqual(receipt.answerSha256?.count, 64) // a fingerprint, never a body
    XCTAssertEqual(client.dispatchedTasks, ["summarize my inbox"])
    // DEFAULT read-only/no-grant: a plain send carries NO constraints block.
    XCTAssertEqual(client.dispatchedConstraints, [Optional<AgentRunConstraintsWire>.none])
  }

  func testSend_blankTask_isNoOp() async {
    let client = FakeWriteClient(dispatch: .answer(makeAnswer()))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("   \n  ")
    XCTAssertEqual(vm.phase, .composing)            // nothing dispatched
    XCTAssertTrue(client.dispatchedTasks.isEmpty)
  }

  // MARK: 2. Mutating → Paused → Approval card

  func testSend_mutating_pausesWithApprovalCard() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    guard case .pendingApproval(let card) = vm.phase else { return XCTFail("expected .pendingApproval, got \(vm.phase)") }
    // The S6 approval card is refs-only: the verb (summary-then-proof) + the digest (proof) — no body.
    XCTAssertEqual(card.actionVerb, "write_file")
    XCTAssertEqual(card.ownerSealedSummary, "write_file(notes.md)")
    XCTAssertEqual(card.actionDigest, String(repeating: "c", count: 64))
    XCTAssertEqual(card.approvalId, "ap-nonce-run-1")
    XCTAssertEqual(card.truthLabel, "rust_wired")  // no label upgrade
    XCTAssertTrue(vm.phase.isAwaitingApproval)
  }

  // MARK: 3. Approve → Resume relays the blob VERBATIM (INV-1)

  func testApprove_relaysSignerBlobVerbatim_acceptedReceipt() async {
    let client = FakeWriteClient(
      dispatch: .pause(makePause()),
      resume: .accepted(ResumeRelayResult(runId: "run-1", op: "resume", accepted: true,
                                          status: "mutation_completed", auditRef: "audit://chain/run-1")))
    let signer = MockOperatorSigner()
    let vm = FridayChatViewModel(writeClient: client, signer: signer)

    await vm.send("edit notes.md")
    guard case .pendingApproval(let card) = vm.phase else { return XCTFail("expected pause") }
    await vm.approve()

    guard case .resumed(let receipt) = vm.phase else { return XCTFail("expected .resumed, got \(vm.phase)") }
    XCTAssertTrue(receipt.accepted)
    XCTAssertEqual(receipt.status, "mutation_completed")
    XCTAssertEqual(receipt.auditRef, "audit://chain/run-1")

    // INV-1 (verbatim relay): the view model relayed the EXACT bytes the signer produced —
    // it minted/inspected/derived nothing. Recompute the mock blob and assert byte-identity.
    let expected = try! await signer.signApproval(card.signingRequest)
    XCTAssertEqual(client.resumedRunIds, ["run-1"])
    XCTAssertEqual(client.relayedBlobs.count, 1)
    XCTAssertEqual(client.relayedBlobs.first, expected, "INV-1: the signer blob must ride VERBATIM")
  }

  /// A server REFUSAL (`accepted=false`) is a SUCCESSFUL relay of a refusal — the action did NOT
  /// execute, and the loop shows it honestly (not as a transport failure, not as an executed action).
  func testApprove_serverRefusal_isSurfacedAsARefusal() async {
    let client = FakeWriteClient(
      dispatch: .pause(makePause()),
      resume: .refused(ResumeRelayResult(runId: "run-1", op: "resume", accepted: false, status: "denied", auditRef: nil)))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .resumed(let receipt) = vm.phase else { return XCTFail("expected .resumed") }
    XCTAssertFalse(receipt.accepted)
    XCTAssertEqual(receipt.status, "denied")
  }

  // MARK: INV-2 — mutating ALWAYS pauses; approve is a NO-OP without a pause (no bypass)

  func testApprove_withoutPause_isNoOp_noResumeRelayed() async {
    let client = FakeWriteClient(dispatch: .answer(makeAnswer()))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    // No pause occurred (the run answered). Approving must do NOTHING — there is no mutation to
    // resume; the resume path is reachable ONLY from .pendingApproval.
    await vm.send("hello")
    await vm.approve()
    XCTAssertTrue(client.resumedRunIds.isEmpty, "INV-2: no pause ⇒ no resume can be relayed")
    if case .answered = vm.phase {} else { XCTFail("phase must stay .answered, got \(vm.phase)") }
  }

  func testApprove_onFreshComposer_isNoOp() async {
    let client = FakeWriteClient(dispatch: .answer(makeAnswer()))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.approve() // no run at all
    XCTAssertEqual(vm.phase, .composing)
    XCTAssertTrue(client.resumedRunIds.isEmpty)
  }

  func testReject_pausedMutation_executesNothing() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()),
                                 resume: .accepted(ResumeRelayResult(runId: "run-1", op: "resume", accepted: true, status: "x", auditRef: nil)))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    XCTAssertTrue(vm.phase.isAwaitingApproval)
    vm.reject()
    XCTAssertEqual(vm.phase, .composing)
    XCTAssertTrue(client.resumedRunIds.isEmpty, "a rejected pause relays NO resume — nothing executes")
  }

  // MARK: INV-1 — the app holds no key; a signer that declines relays nothing

  func testApprove_signerDeclines_noResumeRelayed_honestUnavailable() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()),
                                 resume: .accepted(ResumeRelayResult(runId: "run-1", op: "resume", accepted: true, status: "x", auditRef: nil)))
    // The signer declines — the app has NO key to sign with itself (INV-1), so NO resume is relayed.
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner(throwing: .declined))
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable, got \(vm.phase)") }
    XCTAssertTrue(reason.contains("declined"), "reason: \(reason)")
    XCTAssertTrue(client.resumedRunIds.isEmpty, "INV-1/INV-2: a declined signature ⇒ NO resume, NO mutation")
  }

  func testApprove_signerKeyUnprovisioned_isHonestUnavailable() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner(throwing: .keyUnprovisioned))
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable") }
    XCTAssertTrue(reason.contains("operator-key") || reason.lowercased().contains("not provisioned"), "reason: \(reason)")
    XCTAssertTrue(client.resumedRunIds.isEmpty)
  }

  // MARK: Honest-unavailable on a connection failure (the dark-server default)

  func testSend_transportFailure_rendersHonestUnavailable() async {
    let client = FakeWriteClient(dispatch: .fail(.transport("connection refused (server dark)")))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("anything")
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable, got \(vm.phase)") }
    XCTAssertTrue(reason.contains("offline") || reason.contains("dark"), "reason: \(reason)")
  }

  func testResume_transportFailure_rendersHonestUnavailable() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()), resume: .fail(.transport("closed before a control result")))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable") }
    XCTAssertTrue(reason.contains("offline"), "reason: \(reason)")
  }

  /// FLAG-OFF posture: a write client with run-control disabled refuses the resume relay — the
  /// view model surfaces it as the honest slice-6-gated reason (no fabricated receipt).
  func testApprove_runControlDisabled_isSlice6Gated() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()), resume: .fail(.runControlDisabled))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable") }
    XCTAssertTrue(reason.contains("slice-6") || reason.lowercased().contains("disabled"), "reason: \(reason)")
  }
}
