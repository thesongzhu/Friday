import XCTest
@testable import FridayMobileShellCore
@testable import FridayRustClient

@MainActor
final class NewSessionViewModelTests: XCTestCase {
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
      MemoryDecisionResultWire(memoryId: request.memoryId, state: "unknown", status: "blocked", blocker: "unused", recallable: false)
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
      RunOutcomeLearningDecisionResultWire(candidateId: request.candidateId, state: "unknown", status: "blocked", blocker: "unused")
    }

    func submitActivityMarkDone(_ request: ActivityMarkDoneRequestWire) async throws -> ActivityMarkDoneResultWire {
      ActivityMarkDoneResultWire(activityId: request.activityId, state: "unknown", status: "blocked", blocker: "unused")
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

  func testNoWriteClientFailsClosedWithoutFakeLaunch() async {
    let vm = NewSessionViewModel(client: nil, idFactory: { "fixed" })

    await vm.launch(intent: "summarize today's Friday closure state")

    XCTAssertEqual(vm.launchState, .blocked(reason: "Write seam not configured."))
  }

  func testLaunchSubmitsGovernedMissionIntake() async throws {
    let client = FakeMissionClient(result: MissionIntakeResultWire(
      fridayConversationId: "fconv_mobile_new_session_fixed",
      missionId: "mission-mobile-new-session-fixed",
      workItemId: "work-mobile-new-session-fixed",
      surfaceThreadId: "surface-mobile-new-session-fixed",
      status: "ready",
      createdOrReady: true))
    let vm = NewSessionViewModel(client: client, owner: "owner-ios", idFactory: { "fixed" })

    await vm.launch(intent: "Summarize current v1 closure risk.")

    XCTAssertEqual(client.requests.count, 1)
    let request = try XCTUnwrap(client.requests.first)
    XCTAssertEqual(request.fridayConversationId, "fconv_mobile_new_session_fixed")
    XCTAssertEqual(request.ownerPrincipal, "owner-ios")
    XCTAssertEqual(request.surfaceKind, "mobile")
    XCTAssertEqual(request.deliveryRoute, "ios://friday-mobile/new-session/fixed")
    XCTAssertEqual(request.visibilityPolicy, "compact")
    XCTAssertEqual(request.missionId, "mission-mobile-new-session-fixed")
    XCTAssertEqual(request.workItemId, "work-mobile-new-session-fixed")
    XCTAssertEqual(request.title, "Summarize current v1 closure risk.")
    XCTAssertEqual(request.intent, "Summarize current v1 closure risk.")
    XCTAssertEqual(request.lane, "auto")
    XCTAssertEqual(
      vm.launchState,
      .launched(
        summary: "ready · mission=mission-mobile-new-session-fixed · work_item=work-mobile-new-session-fixed",
        missionId: "mission-mobile-new-session-fixed",
        workItemId: "work-mobile-new-session-fixed"))

    try writeNewSessionActionEvidenceIfRequested()
  }

  private func writeNewSessionActionEvidenceIfRequested() throws {
    guard let rawDir = ProcessInfo.processInfo.environment["FRIDAY_MOBILE_NEW_SESSION_ACTION_EVIDENCE_DIR"],
          !rawDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return
    }
    let dir = URL(fileURLWithPath: rawDir, isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let payload: [String: Any] = [
      "truth": "mobile_new_session_launch_swift_viewmodel_runtime_not_live_hub_not_endbar",
      "status": "ready",
      "actions": [
        [
          "surface": "mobile",
          "screen": "newSession",
          "action_id": "play",
          "capability_id": "session_control_native_set",
          "status": "pass",
          "evidence_ref": "swift://mobile/newSession/play/mission-mobile-new-session-fixed",
          "proof": [
            "mission_id": "mission-mobile-new-session-fixed",
            "work_item_id": "work-mobile-new-session-fixed",
            "surface_kind": "mobile",
            "delivery_route": "ios://friday-mobile/new-session/fixed",
          ],
        ],
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: dir.appendingPathComponent("mobile-new-session-action-evidence.json"), options: .atomic)
  }
}
