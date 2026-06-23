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
}
