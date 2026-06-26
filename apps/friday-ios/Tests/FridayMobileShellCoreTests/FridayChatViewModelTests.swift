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
    enum MemoryScript { case result(MemoryDecisionResultWire); case fail(FridayWriteClientError) }
    enum PassportScript { case result(ContextPassportTransferResultWire); case fail(FridayWriteClientError) }

    private(set) var submittedIntakes: [MissionIntakeRequestWire] = []
    private(set) var missionContexts: [MissionWorkItemContextWire] = []
    private(set) var dispatchedTasks: [String] = []
    private(set) var memoryRequests: [MemoryDecisionRequestWire] = []
    private(set) var passportRequests: [ContextPassportTransferRequestWire] = []
    let memoryScript: MemoryScript
    let passportScript: PassportScript

    init(memoryScript: MemoryScript = .result(MemoryDecisionResultWire(
      memoryId: "unused",
      state: "unknown",
      status: "blocked",
      blocker: "unused",
      recallable: false)),
      passportScript: PassportScript = .result(ContextPassportTransferResultWire(
        passportId: "unused",
        missionId: "unused",
        destinationLane: "codex",
        sharedItemCount: 0,
        missionRefCount: 0,
        status: "blocked",
        blocker: "unused"))
    ) {
      self.memoryScript = memoryScript
      self.passportScript = passportScript
    }

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
      memoryRequests.append(request)
      switch memoryScript {
      case .result(let result): return result
      case .fail(let error): throw error
      }
    }

    func submitContextPassportTransfer(
      _ request: ContextPassportTransferRequestWire
    ) async throws -> ContextPassportTransferResultWire {
      passportRequests.append(request)
      switch passportScript {
      case .result(let result): return result
      case .fail(let error): throw error
      }
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

    func submitActivityMarkDone(_ request: ActivityMarkDoneRequestWire) async throws -> ActivityMarkDoneResultWire {
      ActivityMarkDoneResultWire(
        activityId: request.activityId,
        state: "unknown",
        status: "blocked",
        blocker: "unused")
    }

    func submitWorkItemStatus(_ request: WorkItemStatusRequestWire) async throws -> WorkItemStatusResultWire {
      WorkItemStatusResultWire(
        workItemId: request.workItemId,
        missionId: "unused",
        previousStatus: "unknown",
        status: "blocked",
        actorRef: request.actorRef,
        reason: request.reason,
        proofReceiptCount: 0,
        updatedAtMs: 0)
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
                       answerSha256: String(repeating: "a", count: 64), answerLen: 128, turns: 2, executedTools: 0,
                       promptTokens: 41, completionTokens: 58)
  }

  private func makePause(_ runId: String = "run-1") -> PausedOutcome {
    PausedOutcome(runId: runId, approvalId: "ap-nonce-\(runId)",
                  actionDigest: String(repeating: "c", count: 64), ownerSealedSummary: "write_file(notes.md)")
  }

  private func makeMemoryCandidateSnapshot(id: String = "cand-chat-1") throws -> WorkbenchSnapshot {
    try WorkbenchSnapshot(
      projectionJSON: Data("""
      {"missionId":"mission-chat","fridayConversationId":"fconv-chat",\
      "runtimeFeedStatus":"live_rust_hub_projection","statusLabels":[],"workItems":[],\
      "memoryCandidates":[{"id":"\(id)","preview":"Remember Friday prefers batched PRs","state":"candidate_review_only","grantsMemoryAuthority":false,"evidenceRef":"proof://mobile/fridayChat/memory/\(id)"}]}
      """.utf8),
      generatedAtMs: 0)
  }

  private func writeMobileChatActionEvidenceIfRequested(
    actions: [[String: Any]],
    proof: [String: Any]
  ) throws {
    guard let rawDir = ProcessInfo.processInfo.environment[
      "FRIDAY_MOBILE_CHAT_ACTION_EVIDENCE_DIR"
    ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawDir.isEmpty else {
      return
    }

    let payload: [String: Any] = [
      "truth": "mobile_chat_action_swift_viewmodel_runtime_not_live_hub_not_endbar",
      "status": "ready",
      "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
      "proof": proof,
      "actions": actions,
      "caveat": "Partial runtime evidence only: iOS Chat ViewModel actions delegate to the governed write/sign/reject seams and render refs-only results. This is not a simulator tap, not a live Hub audit receipt, not true operator-key approval, not END-BAR, and not adoption.",
    ]

    let dir = URL(fileURLWithPath: rawDir)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let out = dir.appendingPathComponent("action-runtime-evidence.json")
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: out, options: .atomic)
    print("[mobile-chat-action-evidence] proofOut=\(out.path)")
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
    XCTAssertEqual(receipt.promptTokens, 41)
    XCTAssertEqual(receipt.completionTokens, 58)
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
    XCTAssertTrue(vm.history.last?.receiptRefs.contains(ChatReceiptRef(label: "run_id", ref: "run-readable")) == true)
    XCTAssertTrue(vm.history.last?.receiptRefs.contains(ChatReceiptRef(label: "answer_body_run_id", ref: "run-readable")) == true)
    XCTAssertTrue(vm.history.last?.receiptRefs.contains(ChatReceiptRef(label: "answer_body", ref: "delivered")) == true)
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

  func testHistory_decodesLegacyRowsWithoutReceiptRefs() throws {
    let data = Data("""
    [{"id":"h1","role":"friday","text":"legacy answer","runId":"run-old","createdAtMs":7}]
    """.utf8)

    let rows = try JSONDecoder().decode([ChatHistoryItem].self, from: data)

    XCTAssertEqual(rows, [
      ChatHistoryItem(id: "h1", role: "friday", text: "legacy answer", runId: "run-old", createdAtMs: 7)
    ])
    XCTAssertEqual(rows.first?.receiptRefs, [])
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

  func testBuildMissionIntakeRequest_carriesRoutePreference() {
    let request = FridayChatViewModel.buildMissionIntakeRequest(
      intent: "use Claude for this synthesis",
      owner: "admin-001",
      idFactory: { "fixed" },
      routePreference: .claude)
    XCTAssertEqual(request.lane, "claude")
    XCTAssertEqual(request.targetProviderOrAgent, "claude")
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

    await vm.send("route through Codex first and Claude follow-up", routePreference: .codex)

    XCTAssertEqual(mission.submittedIntakes.map(\.lane), ["codex"])
    XCTAssertEqual(mission.submittedIntakes.first?.targetProviderOrAgent, "codex")
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
    XCTAssertTrue(receipt.receiptRefs.contains(ChatReceiptRef(label: "mission_id", ref: "mission-mobile-fixed")))
    XCTAssertTrue(receipt.receiptRefs.contains(ChatReceiptRef(label: "work_item_id", ref: "work-mobile-fixed")))
    XCTAssertTrue(receipt.receiptRefs.contains(ChatReceiptRef(label: "follow_up_work_item_id", ref: "work-mobile-fixed-claude-followup")))
    XCTAssertTrue(receipt.receiptRefs.contains(ChatReceiptRef(label: "follow_up_run_id", ref: "run-followup")))
    XCTAssertEqual(vm.history.last?.receiptRefs, receipt.receiptRefs)
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
    XCTAssertTrue(vm.history.last?.receiptRefs.contains(ChatReceiptRef(label: "audit_ref", ref: "audit://chain/run-1")) == true)
    XCTAssertTrue(vm.history.last?.receiptRefs.contains(ChatReceiptRef(label: "truth", ref: "rust_wired")) == true)
  }

  func testMobileChatActionEvidenceCoversSendApprovalCardAndControls() async throws {
    let sendClient = FakeWriteClient(dispatch: .answer(makeAnswer("run-chat-send")))
    let sendVM = FridayChatViewModel(writeClient: sendClient, signer: MockOperatorSigner())
    await sendVM.send("summarize the current Friday closure status")
    guard case let .answered(answerReceipt) = sendVM.phase else {
      return XCTFail("expected answered, got \(sendVM.phase)")
    }
    XCTAssertEqual(sendVM.contextCards.map(\.id), ["handoff", "memory"])
    sendVM.selectContextCard("handoff")
    XCTAssertEqual(sendVM.selectedContextCardId, "handoff")
    sendVM.selectContextCard("memory")
    XCTAssertEqual(sendVM.selectedContextCardId, "memory")

    let approveClient = FakeWriteClient(
      dispatch: .pause(makePause("run-chat-approve")),
      resume: .accepted(ResumeRelayResult(
        runId: "run-chat-approve",
        op: "resume",
        accepted: true,
        status: "mutation_completed",
        auditRef: "audit://mobile-chat/approve")))
    let approveVM = FridayChatViewModel(writeClient: approveClient, signer: MockOperatorSigner())
    await approveVM.send("edit notes.md")
    guard case let .pendingApproval(approvalCard) = approveVM.phase else {
      return XCTFail("expected pending approval, got \(approveVM.phase)")
    }
    await approveVM.approve()
    guard case let .resumed(approveReceipt) = approveVM.phase else {
      return XCTFail("expected approve resume receipt, got \(approveVM.phase)")
    }

    let rejectClient = FakeWriteClient(
      dispatch: .pause(makePause("run-chat-reject")),
      reject: .accepted(ResumeRelayResult(
        runId: "run-chat-reject",
        op: "reject",
        accepted: true,
        status: "rejected",
        auditRef: "audit://mobile-chat/reject")))
    let rejectVM = FridayChatViewModel(writeClient: rejectClient, signer: MockOperatorSigner())
    await rejectVM.send("edit notes.md")
    await rejectVM.reject()
    guard case let .resumed(rejectReceipt) = rejectVM.phase else {
      return XCTFail("expected reject receipt, got \(rejectVM.phase)")
    }

    let memoryRead = FakeReadClient(snapshot: try makeMemoryCandidateSnapshot())
    let keepMemoryClient = FakeMissionClient(memoryScript: .result(MemoryDecisionResultWire(
      memoryId: "cand-chat-1",
      state: "confirmed",
      status: "confirmed",
      recallable: true)))
    let keepMemoryVM = FridayChatViewModel(
      writeClient: keepMemoryClient,
      signer: MockOperatorSigner(),
      readClient: memoryRead)
    await keepMemoryVM.send("summarize the memory candidate")
    XCTAssertEqual(keepMemoryVM.contextCards.first(where: { $0.id == "memory" })?.memoryCandidateId, "cand-chat-1")
    await keepMemoryVM.decideContextMemory(confirm: true)
    XCTAssertEqual(keepMemoryClient.memoryRequests, [
      MemoryDecisionRequestWire(
        memoryId: "cand-chat-1",
        ownerPrincipal: liveAgentRunOwnerPrincipal,
        decision: "confirm"),
    ])
    XCTAssertEqual(
      keepMemoryVM.contextMemoryDecisionState,
      .confirmed(summary: "confirmed · state=confirmed · recallable=true"))

    let rejectMemoryClient = FakeMissionClient(memoryScript: .result(MemoryDecisionResultWire(
      memoryId: "cand-chat-1",
      state: "rejected",
      status: "rejected",
      recallable: false)))
    let rejectMemoryVM = FridayChatViewModel(
      writeClient: rejectMemoryClient,
      signer: MockOperatorSigner(),
      readClient: memoryRead)
    await rejectMemoryVM.send("summarize the memory candidate")
    await rejectMemoryVM.decideContextMemory(confirm: false)
    XCTAssertEqual(rejectMemoryClient.memoryRequests, [
      MemoryDecisionRequestWire(
        memoryId: "cand-chat-1",
        ownerPrincipal: liveAgentRunOwnerPrincipal,
        decision: "reject"),
    ])
    XCTAssertEqual(
      rejectMemoryVM.contextMemoryDecisionState,
      .confirmed(summary: "rejected · state=rejected · recallable=false"))

    let passportClient = FakeMissionClient(passportScript: .result(ContextPassportTransferResultWire(
      passportId: "mobile-chat-passport-mission-mobile-passport",
      missionId: "mission-mobile-passport",
      workItemId: "work-mobile-passport",
      destinationLane: "codex",
      destinationTarget: "codex",
      sharedItemCount: 3,
      missionRefCount: 1,
      linkId: "context-passport-mobile-chat-passport-mission-mobile-passport-1",
      status: "confirmed")))
    let passportRead = FakeReadClient(
      snapshot: try WorkbenchSnapshot(
        projectionJSON: Data("""
        {"missionId":"mission-mobile-passport","fridayConversationId":"fconv_mobile_passport",\
        "runtimeFeedStatus":"live_rust_hub_projection","statusLabels":[],"workItems":[]}
        """.utf8),
        generatedAtMs: 0),
      answerBodies: ["run-first": "Owner-visible mission answer for a context handoff."])
    let passportVM = FridayChatViewModel(
      writeClient: passportClient,
      signer: MockOperatorSigner(),
      missionClient: passportClient,
      readClient: passportRead,
      newId: { "passport" })
    await passportVM.send("create a mission answer for handoff", routePreference: .codex)
    await passportVM.submitContextPassportHandoff()
    XCTAssertEqual(passportClient.passportRequests.count, 1)
    XCTAssertEqual(passportClient.passportRequests.first?.missionId, "mission-mobile-passport")
    XCTAssertEqual(passportClient.passportRequests.first?.workItemId, "work-mobile-passport")
    XCTAssertEqual(passportClient.passportRequests.first?.items.count, 3)
    XCTAssertEqual(
      passportVM.contextPassportTransferState,
      .confirmed(summary: "passport mobile-chat-passport-mission-mobile-passport · items=3"))

    try writeMobileChatActionEvidenceIfRequested(
      actions: [
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "chat:typing",
          "capability_id": "ask_friday_chat",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/send/\(answerReceipt.runId)",
          "source": "ios_chat_viewmodel_send_runtime",
          "truth_label": "swift_viewmodel_write_client_runtime_not_live_hub_not_operator_key_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "chat:approveCard",
          "capability_id": "ask_friday_chat",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/approval-card/\(approvalCard.runId)",
          "source": "ios_chat_viewmodel_paused_approval_card_runtime",
          "truth_label": "swift_viewmodel_write_client_runtime_not_live_hub_not_operator_key_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "check",
          "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/approve/\(approveReceipt.runId)",
          "source": "ios_chat_viewmodel_approve_relay_runtime",
          "truth_label": "swift_viewmodel_mock_operator_signer_not_true_key_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "act",
          "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/reject/\(rejectReceipt.runId)",
          "source": "ios_chat_viewmodel_reject_runtime",
          "truth_label": "swift_viewmodel_write_client_runtime_not_live_hub_not_operator_key_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "chat:handoffCard",
          "capability_id": "ask_friday_chat",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/handoff-card/\(answerReceipt.runId)",
          "source": "ios_chat_viewmodel_context_card_runtime",
          "truth_label": "swift_viewmodel_local_affordance_runtime_not_passport_send_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "chat:memoryCard",
          "capability_id": "ask_friday_chat",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/memory-card/\(answerReceipt.runId)",
          "source": "ios_chat_viewmodel_context_card_runtime",
          "truth_label": "swift_viewmodel_local_affordance_runtime_not_memory_decision_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "share",
          "capability_id": "context_passport_transfer_checklist",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/handoff/passport/\(passportClient.passportRequests.first?.missionId ?? "missing")",
          "source": "ios_chat_viewmodel_context_passport_transfer_runtime",
          "truth_label": "swift_viewmodel_context_passport_write_seam_runtime_not_live_hub_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "check",
          "capability_id": "memory_review_no_silent_write_decide_candidate",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/memory/confirm/cand-chat-1",
          "source": "ios_chat_viewmodel_memory_decision_runtime",
          "truth_label": "swift_viewmodel_memory_decision_write_seam_runtime_not_live_hub_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "fridayChat",
          "action_id": "act",
          "capability_id": "memory_review_no_silent_write_decide_candidate",
          "status": "pass",
          "evidence_ref": "swift://mobile/fridayChat/memory/reject/cand-chat-1",
          "source": "ios_chat_viewmodel_memory_decision_runtime",
          "truth_label": "swift_viewmodel_memory_decision_write_seam_runtime_not_live_hub_not_endbar",
        ],
      ],
      proof: [
        "send_run_id": answerReceipt.runId,
        "context_card_ids": sendVM.contextCards.map(\.id),
        "selected_context_card_id": sendVM.selectedContextCardId ?? "",
        "memory_candidate_id": "cand-chat-1",
        "memory_keep_request_count": keepMemoryClient.memoryRequests.count,
        "memory_reject_request_count": rejectMemoryClient.memoryRequests.count,
        "context_passport_request_count": passportClient.passportRequests.count,
        "context_passport_item_count": passportClient.passportRequests.first?.items.count ?? 0,
        "approval_card_run_id": approvalCard.runId,
        "approval_card_digest_len": approvalCard.actionDigest.count,
        "approve_run_id": approveReceipt.runId,
        "approve_status": approveReceipt.status,
        "reject_run_id": rejectReceipt.runId,
        "reject_status": rejectReceipt.status,
        "approve_relay_count": approveClient.resumedRunIds.count,
        "reject_relay_count": rejectClient.rejectedRunIds.count,
      ])
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

  func testApprove_unavailableProductionSignerRelaysNoResume() async {
    let client = FakeWriteClient(
      dispatch: .pause(makePause()),
      resume: .accepted(ResumeRelayResult(runId: "run-1", op: "resume", accepted: true, status: "x", auditRef: nil)))
    let vm = FridayChatViewModel(writeClient: client, signer: UnavailableOperatorSigner())
    await vm.send("edit notes.md")
    await vm.approve()
    guard case .unavailable(let reason) = vm.phase else { return XCTFail("expected .unavailable") }
    XCTAssertTrue(reason.lowercased().contains("signer unavailable"), "reason: \(reason)")
    XCTAssertTrue(client.resumedRunIds.isEmpty, "production unavailable signer must not relay resume")
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
