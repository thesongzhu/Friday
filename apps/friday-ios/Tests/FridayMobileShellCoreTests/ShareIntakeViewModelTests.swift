import XCTest
@testable import FridayMobileShellCore
@testable import FridayRustClient

@MainActor
final class ShareIntakeViewModelTests: XCTestCase {
  final class FakeMissionClient: FridayMissionSpineWriteClient, @unchecked Sendable {
    var result: MissionIntakeResultWire
    private(set) var requests: [MissionIntakeRequestWire] = []

    init(result: MissionIntakeResultWire) {
      self.result = result
    }

    func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire {
      requests.append(request)
      return result
    }

    func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire {
      MemoryDecisionResultWire(
        memoryId: request.memoryId,
        state: "unknown",
        status: "blocked",
        blocker: "unused",
        recallable: false)
    }

    func submitContextPassportTransfer(
      _ request: ContextPassportTransferRequestWire
    ) async throws -> ContextPassportTransferResultWire {
      ContextPassportTransferResultWire(
        passportId: request.passportId,
        missionId: request.missionId,
        workItemId: request.workItemId,
        destinationLane: request.destinationLane,
        destinationTarget: request.destinationTarget,
        sharedItemCount: 0,
        missionRefCount: 0,
        status: "blocked",
        blocker: "unused")
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
  }

  func testNoClientFailsClosedWithoutFakeMission() async {
    let vm = ShareIntakeViewModel(client: nil, sharedText: "summarize this")
    await vm.submit()

    XCTAssertEqual(
      vm.phase,
      .unavailable("Share Intake is unavailable - live mobile write is not enabled."))
  }

  func testSubmitCreatesMobileShareMissionIntake() async throws {
    let client = FakeMissionClient(result: MissionIntakeResultWire(
      fridayConversationId: "fconv_mobile_share_fixed",
      missionId: "mission-mobile-share-fixed",
      workItemId: "work-mobile-share-fixed",
      surfaceThreadId: "surface-mobile-share-fixed",
      status: "ready",
      createdOrReady: true))
    let vm = ShareIntakeViewModel(
      client: client,
      sharedText: "Important note",
      sharedURL: "https://example.com/a",
      newId: { "fixed" })

    await vm.submit()

    XCTAssertEqual(client.requests.count, 1)
    let request = try XCTUnwrap(client.requests.first)
    XCTAssertEqual(request.fridayConversationId, "fconv_mobile_share_fixed")
    XCTAssertEqual(request.ownerPrincipal, liveAgentRunOwnerPrincipal)
    XCTAssertEqual(request.surfaceKind, "mobile")
    XCTAssertEqual(request.deliveryRoute, "ios://friday-mobile/share/fixed")
    XCTAssertEqual(request.visibilityPolicy, "compact")
    XCTAssertEqual(request.missionId, "mission-mobile-share-fixed")
    XCTAssertEqual(request.workItemId, "work-mobile-share-fixed")
    XCTAssertEqual(request.lane, "auto")
    XCTAssertFalse(request.includesSensitiveContext)
    XCTAssertTrue(request.intent.contains("url: https://example.com/a"))
    XCTAssertTrue(request.intent.contains("shared_text: Important note"))

    XCTAssertEqual(vm.phase, .submitted(ShareIntakeReceipt(
      missionId: "mission-mobile-share-fixed",
      workItemId: "work-mobile-share-fixed",
      surfaceThreadId: "surface-mobile-share-fixed",
      status: "ready",
      createdOrReady: true,
      clarificationQuestions: [])))
    guard case .submitted(let receipt) = vm.phase else {
      return XCTFail("expected submitted receipt")
    }
    XCTAssertEqual(receipt.chatLaunchContext, ChatLaunchContext(
      source: "Share Intake",
      missionId: "mission-mobile-share-fixed",
      workItemId: "work-mobile-share-fixed",
      surfaceThreadId: "surface-mobile-share-fixed",
      status: "ready",
      createdOrReady: true))
    XCTAssertEqual(
      receipt.chatLaunchContext.evidenceRef,
      "swift://mobile/fridayChat/launch-context/mission-mobile-share-fixed")

    try writeShareIntakeActionEvidenceIfRequested(request: request)
  }

  func testClarificationDoesNotRenderAsSubmitted() async {
    let client = FakeMissionClient(result: MissionIntakeResultWire(
      fridayConversationId: "fconv",
      missionId: "mission",
      surfaceThreadId: "surface",
      status: "needs_clarification",
      createdOrReady: false,
      clarificationQuestions: ["What should Friday do with this link?"]))
    let vm = ShareIntakeViewModel(client: client, sharedURL: "https://example.com", newId: { "c" })

    await vm.submit()

    XCTAssertEqual(vm.phase, .blocked("What should Friday do with this link?"))
  }

  func testBlankInputDoesNotSubmit() async {
    let client = FakeMissionClient(result: MissionIntakeResultWire(
      fridayConversationId: "fconv",
      missionId: "mission",
      surfaceThreadId: "surface",
      status: "ready",
      createdOrReady: true))
    let vm = ShareIntakeViewModel(client: client, sharedText: "   ", sharedURL: "\n")

    await vm.submit()

    XCTAssertTrue(client.requests.isEmpty)
    XCTAssertEqual(vm.phase, .blocked("Add shared text or a URL before submitting."))
  }

  private func writeShareIntakeActionEvidenceIfRequested(request: MissionIntakeRequestWire) throws {
    guard let rawDir = ProcessInfo.processInfo.environment["FRIDAY_MOBILE_SHARE_INTAKE_ACTION_EVIDENCE_DIR"],
          !rawDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    let dir = URL(fileURLWithPath: rawDir, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let payload: [String: Any] = [
      "truth": "mobile_share_intake_swift_viewmodel_runtime_not_live_hub_not_endbar",
      "status": "ready",
      "actions": [
        [
          "surface": "mobile",
          "screen": "shareIntake",
          "action_id": "mobile/share/send",
          "capability_id": "ask_friday_chat",
          "status": "pass",
          "evidence_ref": "swift://mobile/shareIntake/send/\(request.missionId)",
          "proof": [
            "mission_id": request.missionId,
            "work_item_id": request.workItemId,
            "friday_conversation_id": request.fridayConversationId,
            "surface_thread_id": request.surfaceThreadId,
            "surface_kind": request.surfaceKind,
            "delivery_route": request.deliveryRoute,
            "owner_principal": request.ownerPrincipal,
            "lane": request.lane,
            "includes_sensitive_context": request.includesSensitiveContext,
          ],
          "source": "ios_share_intake_viewmodel_mission_intake_runtime",
          "truth_label": "swift_viewmodel_mission_intake_write_seam_runtime_not_live_hub_not_endbar",
        ],
        [
          "surface": "mobile",
          "screen": "shareIntake",
          "action_id": "mobile/share/open-chat-loop",
          "capability_id": "ask_friday_chat",
          "status": "pass",
          "evidence_ref": "swift://mobile/shareIntake/open-chat-loop/\(request.missionId)",
          "proof": [
            "mission_id": request.missionId,
            "work_item_id": request.workItemId,
            "surface_thread_id": request.surfaceThreadId,
            "status": "ready",
            "chat_launch_context_ref": "swift://mobile/fridayChat/launch-context/\(request.missionId)",
          ],
          "source": "ios_share_intake_viewmodel_chat_launch_context_runtime",
          "truth_label": "swift_viewmodel_chat_launch_context_runtime_not_live_hub_not_endbar",
        ],
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: dir.appendingPathComponent("mobile-share-intake-action-evidence.json"), options: .atomic)
  }
}
