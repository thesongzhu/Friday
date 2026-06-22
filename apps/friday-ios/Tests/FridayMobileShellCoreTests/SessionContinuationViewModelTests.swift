import XCTest
@testable import FridayMobileShellCore
@testable import FridayRustClient

@MainActor
final class SessionContinuationViewModelTests: XCTestCase {
  final class FakeSessionReadClient: FridayRustReadClient, @unchecked Sendable {
    enum Script {
      case success
      case fail(FridayReadClientError)
    }

    private let script: Script
    private let lock = NSLock()
    private var requested: [String] = []

    init(_ script: Script = .success) {
      self.script = script
    }

    var requests: [String] {
      lock.lock()
      defer { lock.unlock() }
      return requested
    }

    func fetchWorkbench() async throws -> WorkbenchSnapshot {
      throw FridayReadClientError.transport("unused")
    }

    func fetchSessionOpen(agentSessionId: String) async throws -> ReadProjectionSnapshot {
      try recordAndReturn(
        request: "session-open:\(agentSessionId)",
        status: "open",
        proofRef: "proof://session/open/\(agentSessionId)")
    }

    func fetchSessionLinkState(agentSessionId: String) async throws -> ReadProjectionSnapshot {
      try recordAndReturn(
        request: "session-link:\(agentSessionId)",
        status: "connected",
        proofRef: "proof://session/link/\(agentSessionId)")
    }

    func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot {
      try recordAndReturn(
        request: "run-files:\(runId)",
        status: "ready",
        runId: runId,
        proofRef: "proof://run-files/\(runId)")
    }

    func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
      try recordAndReturn(
        request: "needs-me:\(runId)",
        status: "waiting",
        runId: runId,
        proofRef: "proof://needs/\(runId)")
    }

    private func recordAndReturn(
      request: String,
      status: String,
      runId: String? = nil,
      proofRef: String
    ) throws -> ReadProjectionSnapshot {
      lock.lock()
      requested.append(request)
      lock.unlock()
      if case .fail(let error) = script {
        throw error
      }
      var raw: [String: Any] = [
        "missionId": "mission-7",
        "status": status,
        "truthLabel": "friday_owned",
        "proofRef": proofRef,
        "evidenceRefs": ["proof://evidence/\(request)"],
        "timelineRef": "proof://timeline/\(request)",
      ]
      if let runId { raw["runId"] = runId }
      let data = try JSONSerialization.data(withJSONObject: raw)
      return try ReadProjectionSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_123)
    }
  }

  final class FakeSessionWriteClient: FridayRustWriteClient, @unchecked Sendable {
    enum Script {
      case accepted(ResumeRelayResult)
      case refused(ResumeRelayResult)
      case fail(FridayWriteClientError)
    }

    let script: Script
    private(set) var cancelledRunIds: [String] = []
    private(set) var cancelReasons: [String?] = []

    init(_ script: Script = .accepted(ResumeRelayResult(
      runId: "run-1",
      op: "cancel",
      accepted: true,
      status: "cancelled",
      auditRef: "audit://cancel/run-1"))) {
      self.script = script
    }

    func dispatchAgentRun(
      task: String,
      constraints: AgentRunConstraintsWire?
    ) async throws -> AgentRunDispatchOutcome {
      throw FridayWriteClientError.transport("unused")
    }

    func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
      throw FridayWriteClientError.transport("unused")
    }

    func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
      throw FridayWriteClientError.transport("unused")
    }

    func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
      cancelledRunIds.append(runId)
      cancelReasons.append(reason)
      switch script {
      case .accepted(let result), .refused(let result):
        return result
      case .fail(let error):
        throw error
      }
    }
  }

  func testRefreshWithSessionAndRunReadsAllContinuationArmsAndKeepsControlsNoGo() async {
    let client = FakeSessionReadClient()
    let vm = SessionContinuationViewModel(client: client)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded session continuation, got \(vm.state)")
    }
    XCTAssertEqual(Set(client.requests), [
      "session-open:session-1",
      "session-link:session-1",
      "run-files:run-1",
      "needs-me:run-1",
    ])
    XCTAssertEqual(snapshot.agentSessionId, "session-1")
    XCTAssertEqual(snapshot.runId, "run-1")
    XCTAssertEqual(snapshot.sections.map(\.id), ["session-open", "session-link", "run-files", "needs-me"])
    XCTAssertTrue(snapshot.sections.allSatisfy {
      if case .loaded = $0.status { return true }
      return false
    })
    XCTAssertTrue(snapshot.proofRefs.contains("proof://session/open/session-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://session/link/session-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://run-files/run-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://needs/run-1"))
    XCTAssertEqual(snapshot.sections.first?.generatedAtMs, 1_780_640_000_123)
    XCTAssertEqual(snapshot.controls.map(\.title), ["Send", "Stop", "Resume", "Fork"])
    XCTAssertTrue(snapshot.controls.allSatisfy { !$0.isEnabled && $0.truthLabel == "NO-GO" })
  }

  func testRefreshWithRunAndGateOnEnablesGuardedStop() async {
    let client = FakeSessionReadClient()
    let write = FakeSessionWriteClient()
    let vm = SessionContinuationViewModel(
      client: client,
      writeClient: write,
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded session continuation, got \(vm.state)")
    }
    let stop = snapshot.controls.first { $0.id == "stop" }
    XCTAssertEqual(stop?.truthLabel, "guarded")
    XCTAssertEqual(stop?.isEnabled, true)
    XCTAssertTrue(stop?.reason.contains("cancel") == true)
  }

  func testStopUsesGovernedCancelRunAndSurfacesReceipt() async {
    let client = FakeSessionReadClient()
    let write = FakeSessionWriteClient()
    let vm = SessionContinuationViewModel(
      client: client,
      writeClient: write,
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")
    await vm.stop()

    XCTAssertEqual(write.cancelledRunIds, ["run-1"])
    XCTAssertEqual(write.cancelReasons, ["operator stopped run from mobile session detail"])
    XCTAssertEqual(
      vm.controlStates["stop"],
      .succeeded(summary: "cancel: cancelled · accepted · audit://cancel/run-1"))
  }

  func testStopRefusalAndTransportFailureRenderError() async {
    let refused = FakeSessionWriteClient(.refused(ResumeRelayResult(
      runId: "run-1",
      op: "cancel",
      accepted: false,
      status: "already_terminal",
      auditRef: nil)))
    let refusedVM = SessionContinuationViewModel(
      client: FakeSessionReadClient(),
      writeClient: refused,
      runControlEnabled: true)
    await refusedVM.refresh(agentSessionId: "session-1", runId: "run-1")
    await refusedVM.stop()
    guard case .error(let refusedReason) = refusedVM.controlStates["stop"] else {
      return XCTFail("expected refused error, got \(String(describing: refusedVM.controlStates["stop"]))")
    }
    XCTAssertTrue(refusedReason.contains("already_terminal"), "reason: \(refusedReason)")

    let failed = FakeSessionWriteClient(.fail(.transport("server dark")))
    let failedVM = SessionContinuationViewModel(
      client: FakeSessionReadClient(),
      writeClient: failed,
      runControlEnabled: true)
    await failedVM.refresh(agentSessionId: "session-1", runId: "run-1")
    await failedVM.stop()
    guard case .error(let failedReason) = failedVM.controlStates["stop"] else {
      return XCTFail("expected transport error, got \(String(describing: failedVM.controlStates["stop"]))")
    }
    XCTAssertTrue(failedReason.contains("offline"), "reason: \(failedReason)")
  }

  func testRefreshWithoutRunRefDoesNotReadRunArms() async {
    let client = FakeSessionReadClient()
    let vm = SessionContinuationViewModel(client: client)

    await vm.refresh(agentSessionId: "session-1", runId: nil)

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded session continuation, got \(vm.state)")
    }
    XCTAssertEqual(Set(client.requests), [
      "session-open:session-1",
      "session-link:session-1",
    ])
    XCTAssertNil(snapshot.runId)
    XCTAssertEqual(snapshot.sections.map(\.id), ["session-open", "session-link", "run-files", "needs-me"])
    let runSections = snapshot.sections.suffix(2)
    XCTAssertTrue(runSections.allSatisfy {
      if case .notRequested(let reason) = $0.status {
        return reason.contains("No run ref")
      }
      return false
    })
  }

  func testRefreshWithoutSessionRefFailsClosedWithoutReading() async {
    let client = FakeSessionReadClient()
    let vm = SessionContinuationViewModel(client: client)

    await vm.refresh(agentSessionId: nil, runId: "run-1")

    guard case .unavailable(let reason) = vm.state else {
      return XCTFail("expected unavailable, got \(vm.state)")
    }
    XCTAssertTrue(reason.contains("agent session ref"))
    XCTAssertTrue(client.requests.isEmpty)
  }

  func testRefreshReadArmFailuresRenderUnavailableSections() async {
    let client = FakeSessionReadClient(.fail(.transport("server dark")))
    let vm = SessionContinuationViewModel(client: client)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded shell with unavailable sections, got \(vm.state)")
    }
    XCTAssertEqual(snapshot.proofRefs, [])
    XCTAssertEqual(snapshot.sections.count, 4)
    XCTAssertTrue(snapshot.sections.allSatisfy {
      if case .unavailable(let reason) = $0.status {
        return reason.contains("offline")
      }
      return false
    })
    XCTAssertTrue(snapshot.controls.allSatisfy { !$0.isEnabled && $0.truthLabel == "NO-GO" })
  }
}
