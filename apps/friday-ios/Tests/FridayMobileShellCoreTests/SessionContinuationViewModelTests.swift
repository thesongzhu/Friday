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
    private let needsMeRaw: [String: Any]?
    private let lock = NSLock()
    private var requested: [String] = []

    init(_ script: Script = .success, needsMeRaw: [String: Any]? = nil) {
      self.script = script
      self.needsMeRaw = needsMeRaw
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

    func fetchRunReadback(runId: String) async throws -> ReadProjectionSnapshot {
      try recordAndReturn(
        request: "run-readback:\(runId)",
        status: "finished",
        runId: runId,
        proofRef: "proof://run-readback/\(runId)",
        extra: [
          "run_state": "finished",
          "loop_status_derived": "finished",
          "event_count": 3,
          "db_wide_token_total": 99,
          "prompt_tokens": 41,
          "completion_tokens": 58,
          "total_tokens": 99,
          "cost_usd": "0.0123",
          "audit_chain_verified": true,
        ])
    }

    func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot {
      try recordAndReturn(
        request: "run-files:\(runId)",
        status: "ready",
        runId: runId,
        proofRef: "proof://run-files/\(runId)")
    }

    func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
      if let needsMeRaw {
        return try recordAndReturnRaw(request: "needs-me:\(runId)", raw: needsMeRaw)
      }
      return try recordAndReturn(
        request: "needs-me:\(runId)",
        status: "waiting",
        runId: runId,
        proofRef: "proof://needs/\(runId)")
    }

    private func recordAndReturnRaw(
      request: String,
      raw: [String: Any]
    ) throws -> ReadProjectionSnapshot {
      lock.lock()
      requested.append(request)
      lock.unlock()
      if case .fail(let error) = script {
        throw error
      }
      let data = try JSONSerialization.data(withJSONObject: raw)
      return try ReadProjectionSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_123)
    }

    private func recordAndReturn(
      request: String,
      status: String,
      runId: String? = nil,
      proofRef: String,
      extra: [String: Any] = [:]
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
      for (key, value) in extra {
        raw[key] = value
      }
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
    private(set) var resumedRunIds: [String] = []
    private(set) var relayedBlobs: [[UInt8]] = []
    private(set) var rejectedRunIds: [String] = []
    private(set) var rejectedApprovalIds: [String] = []

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
      resumedRunIds.append(runId)
      relayedBlobs.append(opaqueSignedBlob)
      switch script {
      case .accepted(let result), .refused(let result):
        return result
      case .fail(let error):
        throw error
      }
    }

    func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
      rejectedRunIds.append(runId)
      rejectedApprovalIds.append(approvalId)
      switch script {
      case .accepted(let result), .refused(let result):
        return result
      case .fail(let error):
        throw error
      }
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
      "run-readback:run-1",
      "run-files:run-1",
      "needs-me:run-1",
    ])
    XCTAssertEqual(snapshot.agentSessionId, "session-1")
    XCTAssertEqual(snapshot.runId, "run-1")
    XCTAssertEqual(snapshot.sections.map(\.id), ["session-open", "session-link", "run-files", "run-readback", "needs-me"])
    XCTAssertTrue(snapshot.sections.allSatisfy {
      if case .loaded = $0.status { return true }
      return false
    })
    XCTAssertTrue(snapshot.proofRefs.contains("proof://session/open/session-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://session/link/session-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://run-files/run-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://run-readback/run-1"))
    XCTAssertTrue(snapshot.proofRefs.contains("proof://needs/run-1"))
    let readback = snapshot.sections.first { $0.id == "run-readback" }
    XCTAssertTrue(readback?.summary.contains("db-wide tokens=99") == true)
    XCTAssertTrue(readback?.summary.contains("audit=verified") == true)
    XCTAssertEqual(readback?.facts, [
      SessionContinuationFact(id: "run-id", label: "run", value: "run-1"),
      SessionContinuationFact(id: "state", label: "state", value: "finished"),
      SessionContinuationFact(id: "loop", label: "loop", value: "finished"),
      SessionContinuationFact(id: "events", label: "events", value: "3"),
      SessionContinuationFact(id: "db-wide-tokens", label: "db tokens", value: "99"),
      SessionContinuationFact(id: "prompt-tokens", label: "prompt", value: "41"),
      SessionContinuationFact(id: "completion-tokens", label: "completion", value: "58"),
      SessionContinuationFact(id: "total-tokens", label: "total", value: "99"),
      SessionContinuationFact(id: "cost", label: "cost", value: "0.0123"),
      SessionContinuationFact(id: "audit", label: "audit", value: "verified"),
    ])
    XCTAssertEqual(snapshot.sections.first?.generatedAtMs, 1_780_640_000_123)
    XCTAssertEqual(snapshot.controls.map(\.title), ["Send", "Stop", "Resume", "Reject", "Fork"])
    XCTAssertTrue(snapshot.controls.allSatisfy { !$0.isEnabled && $0.truthLabel == "NO-GO" })
    XCTAssertNil(snapshot.pendingApproval)
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

  func testRefreshParsesNeedsMeApprovalAndEnablesOperatorGatedResume() async {
    let raw: [String: Any] = [
      "run_id": "run-1",
      "status": "waiting",
      "truthLabel": "friday_owned",
      "proofRef": "proof://needs/run-1",
      "needs_me": [
        "kind": "approval",
        "ref_id": "approval-1",
        "action_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "summary": "write_file pending",
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-1",
          "action_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "summary": "write_file pending",
        ],
      ],
    ]
    let vm = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: FakeSessionWriteClient(),
      signer: MockOperatorSigner(),
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded session continuation, got \(vm.state)")
    }
    XCTAssertEqual(snapshot.pendingApproval, SessionContinuationApproval(
      runId: "run-1",
      approvalId: "approval-1",
      actionDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      summary: "write_file pending"))
    let resume = snapshot.controls.first { $0.id == "resume" }
    XCTAssertEqual(resume?.truthLabel, "operator-gated")
    XCTAssertEqual(resume?.isEnabled, true)
    XCTAssertTrue(resume?.reason.contains("operator signer") == true)
    let reject = snapshot.controls.first { $0.id == "reject" }
    XCTAssertEqual(reject?.truthLabel, "guarded")
    XCTAssertEqual(reject?.isEnabled, true)
    XCTAssertTrue(reject?.reason.contains("without executing") == true)
  }

  func testRefreshParsesActionableNeedsMeApprovalFallback() async {
    let raw: [String: Any] = [
      "run_id": "run-1",
      "status": "waiting",
      "truthLabel": "friday_owned",
      "actionable_needs_me": [[
        "kind": "approval_required",
        "title": "approval required for write_file",
        "ref_id": "approval-2",
        "action_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-2",
          "action_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "summary": "approval required for write_file",
        ],
      ]],
    ]
    let vm = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: FakeSessionWriteClient(),
      signer: MockOperatorSigner(),
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded session continuation, got \(vm.state)")
    }
    XCTAssertEqual(snapshot.pendingApproval?.approvalId, "approval-2")
    XCTAssertEqual(snapshot.pendingApproval?.summary, "approval required for write_file")
  }

  func testPendingApprovalWithoutSignerKeepsResumeNoGoButAllowsRejectRelay() async {
    let raw: [String: Any] = [
      "run_id": "run-1",
      "status": "waiting",
      "truthLabel": "friday_owned",
      "needs_me": [
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-1",
          "action_digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          "summary": "write_file pending",
        ],
      ],
    ]
    let write = FakeSessionWriteClient(.accepted(ResumeRelayResult(
      runId: "run-1",
      op: "reject",
      accepted: true,
      status: "rejected",
      auditRef: "audit://reject/run-1")))
    let vm = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: write,
      signer: nil,
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")

    guard case .loaded(let snapshot) = vm.state else {
      return XCTFail("expected loaded session continuation, got \(vm.state)")
    }
    XCTAssertEqual(snapshot.pendingApproval?.approvalId, "approval-1")
    let resume = snapshot.controls.first { $0.id == "resume" }
    XCTAssertEqual(resume?.truthLabel, "NO-GO")
    XCTAssertEqual(resume?.isEnabled, false)
    XCTAssertTrue(resume?.reason.contains("operator signer relay") == true)
    let reject = snapshot.controls.first { $0.id == "reject" }
    XCTAssertEqual(reject?.truthLabel, "guarded")
    XCTAssertEqual(reject?.isEnabled, true)

    await vm.resume()
    XCTAssertTrue(write.resumedRunIds.isEmpty, "missing signer must not relay a resume")
    guard case .error(let resumeReason) = vm.controlStates["resume"] else {
      return XCTFail("expected resume signer error, got \(String(describing: vm.controlStates["resume"]))")
    }
    XCTAssertTrue(resumeReason.contains("operator signer relay"), "reason: \(resumeReason)")

    await vm.reject()
    XCTAssertEqual(write.rejectedRunIds, ["run-1"])
    XCTAssertEqual(write.rejectedApprovalIds, ["approval-1"])
    XCTAssertTrue(write.relayedBlobs.isEmpty, "reject must stay refs-only")
  }

  func testResumeRelaysSignerBlobVerbatimAndSurfacesReceipt() async {
    let digest = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    let raw: [String: Any] = [
      "run_id": "run-1",
      "status": "waiting",
      "truthLabel": "friday_owned",
      "needs_me": [
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-1",
          "action_digest": digest,
          "summary": "write_file pending",
        ],
      ],
    ]
    let write = FakeSessionWriteClient(.accepted(ResumeRelayResult(
      runId: "run-1",
      op: "resume",
      accepted: true,
      status: "resumed",
      auditRef: "audit://resume/run-1")))
    let signer = MockOperatorSigner()
    let vm = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: write,
      signer: signer,
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")
    await vm.resume()

    let expectedBlob = try! await signer.signApproval(ApprovalSigningRequest(
      runId: "run-1",
      approvalId: "approval-1",
      actionDigest: digest,
      summary: "write_file pending"))
    XCTAssertEqual(write.resumedRunIds, ["run-1"])
    XCTAssertEqual(write.relayedBlobs, [expectedBlob])
    XCTAssertEqual(
      vm.controlStates["resume"],
      .succeeded(summary: "resume: resumed · accepted · audit://resume/run-1"))
  }

  func testResumeSignerFailureDoesNotRelay() async {
    let raw: [String: Any] = [
      "run_id": "run-1",
      "needs_me": [
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-1",
          "action_digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          "summary": "write_file pending",
        ],
      ],
    ]
    let write = FakeSessionWriteClient(.accepted(ResumeRelayResult(
      runId: "run-1",
      op: "resume",
      accepted: true,
      status: "resumed",
      auditRef: nil)))
    let vm = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: write,
      signer: MockOperatorSigner(throwing: .declined),
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")
    await vm.resume()

    XCTAssertEqual(write.resumedRunIds, [])
    guard case .error(let reason) = vm.controlStates["resume"] else {
      return XCTFail("expected signer error, got \(String(describing: vm.controlStates["resume"]))")
    }
    XCTAssertTrue(reason.contains("declined"), "reason: \(reason)")
  }

  func testRejectRelaysApprovalRefWithoutResumingMutation() async {
    let raw: [String: Any] = [
      "run_id": "run-1",
      "needs_me": [
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-1",
          "action_digest": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          "summary": "write_file pending",
        ],
      ],
    ]
    let write = FakeSessionWriteClient(.accepted(ResumeRelayResult(
      runId: "run-1",
      op: "reject",
      accepted: true,
      status: "rejected",
      auditRef: "audit://reject/run-1")))
    let vm = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: write,
      runControlEnabled: true)

    await vm.refresh(agentSessionId: "session-1", runId: "run-1")
    await vm.reject()

    XCTAssertEqual(write.rejectedRunIds, ["run-1"])
    XCTAssertEqual(write.rejectedApprovalIds, ["approval-1"])
    XCTAssertTrue(write.resumedRunIds.isEmpty, "reject must not resume the paused mutation")
    XCTAssertTrue(write.relayedBlobs.isEmpty, "reject uses refs only and must not relay a signed blob")
    XCTAssertEqual(
      vm.controlStates["reject"],
      .succeeded(summary: "reject: rejected · accepted · audit://reject/run-1"))
  }

  func testRejectRefusalAndTransportFailureRenderErrorWithoutResume() async {
    let raw: [String: Any] = [
      "run_id": "run-1",
      "needs_me": [
        "signing_request": [
          "run_id": "run-1",
          "approval_id": "approval-1",
          "action_digest": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          "summary": "write_file pending",
        ],
      ],
    ]

    let refused = FakeSessionWriteClient(.refused(ResumeRelayResult(
      runId: "run-1",
      op: "reject",
      accepted: false,
      status: "already_terminal",
      auditRef: nil)))
    let refusedVM = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: refused,
      runControlEnabled: true)
    await refusedVM.refresh(agentSessionId: "session-1", runId: "run-1")
    await refusedVM.reject()
    guard case .error(let refusedReason) = refusedVM.controlStates["reject"] else {
      return XCTFail("expected reject refusal error, got \(String(describing: refusedVM.controlStates["reject"]))")
    }
    XCTAssertTrue(refusedReason.contains("already_terminal"), "reason: \(refusedReason)")
    XCTAssertTrue(refused.resumedRunIds.isEmpty)

    let failed = FakeSessionWriteClient(.fail(.transport("server dark")))
    let failedVM = SessionContinuationViewModel(
      client: FakeSessionReadClient(needsMeRaw: raw),
      writeClient: failed,
      runControlEnabled: true)
    await failedVM.refresh(agentSessionId: "session-1", runId: "run-1")
    await failedVM.reject()
    guard case .error(let failedReason) = failedVM.controlStates["reject"] else {
      return XCTFail("expected reject transport error, got \(String(describing: failedVM.controlStates["reject"]))")
    }
    XCTAssertTrue(failedReason.contains("offline"), "reason: \(failedReason)")
    XCTAssertTrue(failed.resumedRunIds.isEmpty)
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
    XCTAssertEqual(snapshot.sections.map(\.id), ["session-open", "session-link", "run-files", "run-readback", "needs-me"])
    let runSections = snapshot.sections.suffix(3)
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
    XCTAssertEqual(snapshot.sections.count, 5)
    XCTAssertTrue(snapshot.sections.allSatisfy {
      if case .unavailable(let reason) = $0.status {
        return reason.contains("offline")
      }
      return false
    })
    XCTAssertTrue(snapshot.controls.allSatisfy { !$0.isEnabled && $0.truthLabel == "NO-GO" })
  }
}
