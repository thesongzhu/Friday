import XCTest
@testable import FridayMobileShellCore
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
  final class FakeWriteClient: FridayRustWriteClient, @unchecked Sendable {
    enum DispatchScript { case answer(AgentRunResultWire); case pause(PausedOutcome); case fail(FridayWriteClientError) }
    enum ResumeScript { case accepted(ResumeRelayResult); case refused(ResumeRelayResult); case fail(FridayWriteClientError) }
    enum RejectScript { case accepted(ResumeRelayResult); case refused(ResumeRelayResult); case fail(FridayWriteClientError) }
    enum CancelScript { case accepted(ResumeRelayResult); case refused(ResumeRelayResult); case fail(FridayWriteClientError) }

    let dispatchScript: DispatchScript
    let resumeScript: ResumeScript
    let rejectScript: RejectScript
    let cancelScript: CancelScript

    private(set) var dispatchedTasks: [String] = []
    private(set) var dispatchedConstraints: [AgentRunConstraintsWire?] = []
    private(set) var resumedRunIds: [String] = []
    private(set) var rejectedRunIds: [String] = []
    private(set) var rejectedApprovalIds: [String] = []
    private(set) var cancelledRunIds: [String] = []
    private(set) var cancelReasons: [String?] = []
    /// The VERBATIM blob the view model relayed (the INV-1 proof at the view-model boundary).
    private(set) var relayedBlobs: [[UInt8]] = []

    init(
      dispatch: DispatchScript,
      resume: ResumeScript = .fail(.runControlDisabled),
      reject: RejectScript = .fail(.runControlDisabled),
      cancel: CancelScript = .fail(.runControlDisabled)
    ) {
      self.dispatchScript = dispatch
      self.resumeScript = resume
      self.rejectScript = reject
      self.cancelScript = cancel
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

    func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
      rejectedRunIds.append(runId)
      rejectedApprovalIds.append(approvalId)
      switch rejectScript {
      case .accepted(let r), .refused(let r): return r
      case .fail(let e): throw e
      }
    }

    func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
      cancelledRunIds.append(runId)
      cancelReasons.append(reason)
      switch cancelScript {
      case .accepted(let r), .refused(let r): return r
      case .fail(let e): throw e
      }
    }
  }

  final class FakeMissionClient: FridayMobileMissionDispatchingWriteClient, @unchecked Sendable {
    private(set) var submittedIntakes: [MissionIntakeRequestWire] = []
    private(set) var missionContexts: [MissionWorkItemContextWire] = []
    private(set) var dispatchedTasks: [String] = []

    func dispatchAgentRun(
      task: String,
      constraints: AgentRunConstraintsWire?
    ) async throws -> AgentRunDispatchOutcome {
      .result(AgentRunResultWire(
        runId: "run-legacy", status: "completed",
        answerSha256: String(repeating: "d", count: 64), answerLen: 1, turns: 1, executedTools: 0))
    }

    func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
      ResumeRelayResult(runId: runId, op: "resume", accepted: false, status: "denied", auditRef: nil)
    }

    func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
      ResumeRelayResult(runId: runId, op: "reject", accepted: true, status: "rejected", auditRef: nil)
    }

    func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
      ResumeRelayResult(runId: runId, op: "cancel", accepted: true, status: "cancelled", auditRef: nil)
    }

    func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire {
      submittedIntakes.append(request)
      return MissionIntakeResultWire(
        fridayConversationId: request.fridayConversationId,
        missionId: request.missionId,
        workItemId: request.workItemId,
        surfaceThreadId: request.surfaceThreadId,
        status: "ready",
        createdOrReady: true)
    }

    func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire {
      MemoryDecisionResultWire(
        memoryId: request.memoryId,
        state: "unknown",
        status: "blocked",
        blocker: "unused",
        recallable: false)
    }

    func submitRunOutcomeLearningDecision(
      _ request: RunOutcomeLearningDecisionRequestWire
    ) async throws -> RunOutcomeLearningDecisionResultWire {
      RunOutcomeLearningDecisionResultWire(
        candidateId: request.candidateId,
        state: "unknown",
        status: "blocked",
        blocker: "unused")
    }

    func dispatchMissionBoundAgentRun(
      task: String,
      missionContext: MissionWorkItemContextWire,
      constraints: AgentRunConstraintsWire?
    ) async throws -> AgentRunDispatchOutcome {
      dispatchedTasks.append(task)
      missionContexts.append(missionContext)
      let runId = missionContext.workItemId.hasSuffix("-claude-followup") ? "run-followup" : "run-first"
      return .result(AgentRunResultWire(
        runId: runId, status: "finished",
        answerSha256: String(repeating: "e", count: 64), answerLen: 42, turns: 1, executedTools: 0))
    }
  }

  final class FakeReadClient: FridayRustReadClient, @unchecked Sendable {
    let snapshot: WorkbenchSnapshot
    let answerBodies: [String: String]

    init(snapshot: WorkbenchSnapshot, answerBodies: [String: String] = [:]) {
      self.snapshot = snapshot
      self.answerBodies = answerBodies
    }

    func fetchWorkbench() async throws -> WorkbenchSnapshot { snapshot }

    func fetchRunAnswerBody(runId: String) async throws -> RunAnswerBody {
      guard let answer = answerBodies[runId] else {
        let data = try JSONSerialization.data(withJSONObject: [
          "truth_label": "rust_wired_owner_gated",
          "ok": true,
          "outcome": "not_found",
          "run_id": runId,
        ])
        return try RunAnswerBody(answerJSON: data, generatedAtMs: 1)
      }
      let data = try JSONSerialization.data(withJSONObject: [
        "truth_label": "rust_wired_owner_gated",
        "ok": true,
        "outcome": "delivered",
        "run_id": runId,
        "status": "finished",
        "answer": answer,
        "answer_sha256": String(repeating: "f", count: 64),
        "answer_len": answer.utf8.count,
      ])
      return try RunAnswerBody(answerJSON: data, generatedAtMs: 1)
    }
  }

  final class FakeHistoryStore: ChatHistoryStoring {
    private(set) var saved: [[ChatHistoryItem]] = []
    var items: [ChatHistoryItem]

    init(_ items: [ChatHistoryItem] = []) {
      self.items = items
    }

    func load() -> [ChatHistoryItem] { items }

    func save(_ items: [ChatHistoryItem]) {
      self.items = items
      saved.append(items)
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
    XCTAssertNil(receipt.answerBody)
    XCTAssertEqual(client.dispatchedTasks, ["summarize my inbox"])
    // DEFAULT read-only/no-grant: a plain send carries NO constraints block.
    XCTAssertEqual(client.dispatchedConstraints, [Optional<AgentRunConstraintsWire>.none])
  }

  func testSend_withReadClient_surfacesOwnerGatedAnswerBody() async throws {
    let client = FakeWriteClient(dispatch: .answer(makeAnswer("run-readable")))
    let read = FakeReadClient(
      snapshot: try WorkbenchSnapshot(
        projectionJSON: Data("""
        {"missionId":"mission-readable","fridayConversationId":"fconv-readable",\
        "runtimeFeedStatus":"live_rust_hub_projection","statusLabels":[],"workItems":[]}
        """.utf8),
        generatedAtMs: 0),
      answerBodies: ["run-readable": "Readable answer from the owner-gated readback."])
    let vm = FridayChatViewModel(
      writeClient: client,
      signer: MockOperatorSigner(),
      readClient: read)

    await vm.send("summarize my inbox")

    guard case .answered(let receipt) = vm.phase else { return XCTFail("expected .answered, got \(vm.phase)") }
    XCTAssertEqual(receipt.runId, "run-readable")
    XCTAssertEqual(receipt.answerBodyRunId, "run-readable")
    XCTAssertEqual(receipt.answerBodyOutcome, "delivered")
    XCTAssertEqual(receipt.answerBody, "Readable answer from the owner-gated readback.")
  }

  func testSend_persistsLocalHistoryWithReadableAnswer() async throws {
    let client = FakeWriteClient(dispatch: .answer(makeAnswer("run-readable")))
    let read = FakeReadClient(
      snapshot: try WorkbenchSnapshot(
        projectionJSON: Data("""
        {"missionId":"mission-readable","fridayConversationId":"fconv-readable",\
        "runtimeFeedStatus":"live_rust_hub_projection","statusLabels":[],"workItems":[]}
        """.utf8),
        generatedAtMs: 0),
      answerBodies: ["run-readable": "Readable answer from the owner-gated readback."])
    let store = FakeHistoryStore()
    let vm = FridayChatViewModel(
      writeClient: client,
      signer: MockOperatorSigner(),
      readClient: read,
      historyStore: store,
      newId: { "history-id" },
      nowMs: { 42 })

    await vm.send("summarize my inbox")

    XCTAssertEqual(vm.history.map(\.role), ["you", "friday"])
    XCTAssertEqual(vm.history.map(\.text), [
      "summarize my inbox",
      "Readable answer from the owner-gated readback.",
    ])
    XCTAssertEqual(vm.history.last?.runId, "run-readable")
    XCTAssertEqual(vm.history.last?.createdAtMs, 42)
    XCTAssertEqual(store.items, vm.history)
  }

  func testHistory_loadsAndClearsFromStore() {
    let existing = [
      ChatHistoryItem(id: "h1", role: "you", text: "hello", createdAtMs: 1)
    ]
    let store = FakeHistoryStore(existing)
    let vm = FridayChatViewModel(
      writeClient: FakeWriteClient(dispatch: .answer(makeAnswer())),
      signer: MockOperatorSigner(),
      historyStore: store)

    XCTAssertEqual(vm.history, existing)
    vm.clearHistory()
    XCTAssertTrue(vm.history.isEmpty)
    XCTAssertEqual(store.items, [])
  }

  func testBuildMissionIntakeRequest_usesMobileAutoRoute() {
    let request = FridayChatViewModel.buildMissionIntakeRequest(
      intent: "route through Codex first and Claude follow-up",
      owner: "admin-001",
      idFactory: { "fixed" })
    XCTAssertEqual(request.ownerPrincipal, "admin-001")
    XCTAssertEqual(request.surfaceKind, "mobile")
    XCTAssertEqual(request.deliveryRoute, "ios://friday-mobile/chat/fixed")
    XCTAssertEqual(request.missionId, "mission-mobile-fixed")
    XCTAssertEqual(request.workItemId, "work-mobile-fixed")
    XCTAssertEqual(request.lane, "auto")
    XCTAssertNil(request.targetProviderOrAgent)
  }

  func testBuildMissionIntakeRequest_acceptsSharedMissionPrefixForUiProofCapture() {
    let request = FridayChatViewModel.buildMissionIntakeRequest(
      intent: "route through Codex first and Claude follow-up",
      owner: "admin-001",
      idFactory: { "ui_proof_fixed" },
      missionIdPrefix: "mission_")
    XCTAssertEqual(request.missionId, "mission_ui_proof_fixed")
    XCTAssertEqual(request.workItemId, "work-mobile-ui_proof_fixed")
    XCTAssertEqual(request.surfaceKind, "mobile")
    XCTAssertEqual(request.deliveryRoute, "ios://friday-mobile/chat/ui_proof_fixed")
  }

  func testSend_withMissionClient_dispatchesGeneratedClaudeFollowUp() async throws {
    let mission = FakeMissionClient()
    let snapshotJSON = """
    {
      "missionId": "mission-mobile-fixed",
      "fridayConversationId": "fconv_mobile_fixed",
      "runtimeFeedStatus": "live_rust_hub_projection",
      "statusLabels": [],
      "workItems": [
        { "workItemId": "work-mobile-fixed" },
        { "workItemId": "work-mobile-fixed-claude-followup" }
      ]
    }
    """
    let read = FakeReadClient(
      snapshot: try WorkbenchSnapshot(
        projectionJSON: Data(snapshotJSON.utf8),
        generatedAtMs: 0),
      answerBodies: [
        "run-first": "I am still checking files before the final answer. FRIDAY_MOBILE_PRODUCT_AUTO_FOLLOWUP_OK",
        "run-followup": "Claude follow-up body visible to the owner.",
      ])
    let vm = FridayChatViewModel(
      writeClient: mission,
      signer: MockOperatorSigner(),
      missionClient: mission,
      readClient: read,
      newId: { "fixed" })

    await vm.send("route through Codex first and Claude follow-up")

    XCTAssertEqual(mission.submittedIntakes.map(\.lane), ["auto"])
    XCTAssertEqual(mission.submittedIntakes.map(\.surfaceKind), ["mobile"])
    XCTAssertEqual(mission.missionContexts.map(\.workItemId), [
      "work-mobile-fixed",
      "work-mobile-fixed-claude-followup",
    ])
    XCTAssertEqual(mission.dispatchedTasks.count, 2)
    XCTAssertTrue(mission.dispatchedTasks[1].contains("source_work_item_id=work-mobile-fixed"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("follow_up_work_item_id=work-mobile-fixed-claude-followup"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("codex_first_run_id=run-first"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("output destination: owner-visible answer body"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("task: produce the final owner-visible answer"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("success = concise final synthesis"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("constraints = read-only"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("FRIDAY_MOBILE_PRODUCT_AUTO_FOLLOWUP_OK"))
    XCTAssertFalse(mission.dispatchedTasks[1].contains("I am still checking files"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("do not ask the operator for paths"))
    XCTAssertTrue(mission.dispatchedTasks[1].contains("do not claim you verified unrelated files"))
    guard case .answered(let receipt) = vm.phase else { return XCTFail("expected answered, got \(vm.phase)") }
    XCTAssertEqual(receipt.runId, "run-first")
    XCTAssertEqual(receipt.missionId, "mission-mobile-fixed")
    XCTAssertEqual(receipt.workItemId, "work-mobile-fixed")
    XCTAssertEqual(receipt.followUpWorkItemId, "work-mobile-fixed-claude-followup")
    XCTAssertEqual(receipt.followUpRunId, "run-followup")
    XCTAssertEqual(receipt.answerBodyRunId, "run-followup")
    XCTAssertEqual(receipt.answerBody, "Claude follow-up body visible to the owner.")
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
    let client = FakeWriteClient(
      dispatch: .pause(makePause()),
      resume: .accepted(ResumeRelayResult(runId: "run-1", op: "resume", accepted: true, status: "x", auditRef: nil)),
      reject: .accepted(ResumeRelayResult(
        runId: "run-1", op: "reject", accepted: true, status: "rejected", auditRef: "audit://reject/run-1")))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    XCTAssertTrue(vm.phase.isAwaitingApproval)
    await vm.reject()
    guard case .resumed(let receipt) = vm.phase else { return XCTFail("expected .resumed reject receipt, got \(vm.phase)") }
    XCTAssertEqual(receipt.op, "reject")
    XCTAssertTrue(receipt.accepted)
    XCTAssertEqual(receipt.status, "rejected")
    XCTAssertEqual(receipt.title, "Approval rejected")
    XCTAssertEqual(receipt.statusLabel, "REJECTED")
    XCTAssertEqual(client.rejectedRunIds, ["run-1"])
    XCTAssertEqual(client.rejectedApprovalIds, ["ap-nonce-run-1"])
    XCTAssertTrue(client.resumedRunIds.isEmpty, "a rejected pause relays NO resume — nothing executes")
  }

  func testReject_transportFailure_isHonestUnavailableAndDoesNotResume() async {
    let client = FakeWriteClient(
      dispatch: .pause(makePause()),
      resume: .accepted(ResumeRelayResult(runId: "run-1", op: "resume", accepted: true, status: "x", auditRef: nil)),
      reject: .fail(.transport("closed before a control result")))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    await vm.reject()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable, got \(vm.phase)") }
    XCTAssertTrue(reason.contains("offline"), "reason: \(reason)")
    XCTAssertEqual(client.rejectedRunIds, ["run-1"])
    XCTAssertEqual(client.rejectedApprovalIds, ["ap-nonce-run-1"])
    XCTAssertTrue(client.resumedRunIds.isEmpty, "reject failure must not resume the mutation")
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
    XCTAssertTrue(reason.lowercased().contains("approval key"), "reason: \(reason)")
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
  /// view model surfaces an honest unavailable reason (no fabricated receipt).
  func testApprove_runControlDisabled_isUnavailable() async {
    let client = FakeWriteClient(dispatch: .pause(makePause()), resume: .fail(.runControlDisabled))
    let vm = FridayChatViewModel(writeClient: client, signer: MockOperatorSigner())
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable") }
    XCTAssertTrue(reason.lowercased().contains("approvals are not available"), "reason: \(reason)")
  }
}
