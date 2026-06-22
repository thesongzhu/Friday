import Foundation
import Testing

@testable import FridayHubConsoleCore
@testable import FridayRustClient

@Test
@MainActor
func refreshLoadsRepresentativeSnapshot() async {
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded))
  await vm.refresh()
  let snapshot = vm.state.snapshot
  #expect(snapshot != nil)
  #expect(snapshot?.missionId == "mission_workbench_probe_20260605")
  #expect(snapshot?.runtimeFeedStatus == .liveRustHubProjection)
}

@Test
@MainActor
func refreshRendersUnavailableAsTruthOn503() async {
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .unavailable(.hubUnavailable(statusCode: 503))))
  await vm.refresh()
  // A 503 throw must land in `.unavailable`, NOT a fake-ready snapshot.
  guard case let .unavailable(reason) = vm.state else {
    Issue.record("expected .unavailable, got \(vm.state)")
    return
  }
  #expect(reason.contains("503"))
  #expect(vm.state.snapshot == nil)
}

@Test
@MainActor
func refreshRendersUnavailableWhenOffline() async {
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .unavailable(.offline)))
  await vm.refresh()
  guard case .unavailable = vm.state else {
    Issue.record("expected .unavailable for offline")
    return
  }
  #expect(vm.state.snapshot == nil)
}

@Test
func snapshotExercisesEveryHonestRenderingRule() {
  let snapshot = MockReadClient.representativeSnapshot

  // A provider_ack / linked_only item must be NOT done.
  let provider = snapshot.workItems.first { $0.id == "work_probe_provider" }
  #expect(provider?.state == .providerAck)
  #expect(provider?.owner == .linkedOnly)
  #expect(provider?.done == false)

  // A completed item must be done + friday_owned.
  let done = snapshot.workItems.first { $0.id == "work_probe_done" }
  #expect(done?.state == .completedWithProof)
  #expect(done?.owner == .fridayOwned)
  #expect(done?.done == true)

  // There must be a blocked NO-GO row (never made executable; not done).
  let blocked = snapshot.workItems.first { $0.state == .blocked }
  #expect(blocked != nil)
  #expect(blocked?.done == false)

  // Honest status: stale must be present.
  #expect(snapshot.statusLabels.contains(.stale))

  // Memory candidates never grant authority.
  #expect(snapshot.memoryCandidates.allSatisfy { !$0.grantsMemoryAuthority })
  #expect(snapshot.runOutcomeLearningCandidates.first?.state == "pending")
  #expect(snapshot.runOutcomeLearningCandidates.first?.evidenceRef.hasPrefix("proof://") == true)
}

@Test
func loadedEmptySnapshotIsConnectedEmptyNotUnavailable() {
  let snapshot = snapshotWithWorkItems(
    missionId: "mission-empty",
    fridayConversationId: "fconv-empty",
    workItemIds: [])
  #expect(snapshot.isLoadedEmpty)
  #expect(snapshot.runtimeFeedStatus == .liveRustHubProjection)
  #expect(snapshot.statusLabels.isEmpty)
}

@Test
func representativeSnapshotIsNotLoadedEmpty() {
  let snapshot = MockReadClient.representativeSnapshot
  #expect(!snapshot.isLoadedEmpty)
}

@Test
@MainActor
func inspectorReturnsRefsOnlyForSelection() async {
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded))
  await vm.refresh()

  vm.select(.workItem(id: "work_probe_done"))
  let refs = vm.inspectorRefs
  #expect(!refs.isEmpty)
  // Every inspector entry is a ref string (no body content). proof:// refs are
  // redacted fingerprints, never raw bodies.
  #expect(refs.contains { $0.label == "proofRef" })
  #expect(refs.allSatisfy { !$0.ref.isEmpty })
}

@Test
func unknownEnumValuesDecodeToUnavailableNotReady() throws {
  // truth_status must NOT be upgraded by the UI: an unknown lifecycle/truth value
  // must decode to `.unknown` (honest unavailable), never `.ready`/`.fridayOwned`.
  let json = """
    {
      "id": "wi_unknown",
      "title": "Unknown-state item",
      "state": "some_future_state_we_dont_know",
      "owner": "some_future_owner",
      "done": false
    }
    """.data(using: .utf8)!
  let item = try JSONDecoder().decode(MissionWorkbenchWorkItem.self, from: json)
  #expect(item.state == .unknown)
  #expect(item.owner == .unknown)
  #expect(item.state != .ready)
  #expect(item.owner != .fridayOwned)
}

@Test
func snapshotRoundTripsThroughContractJSON() throws {
  // Proves the Swift model is wire-compatible with the camelCase contract JSON
  // the future FridayRustClient package will decode.
  let original = MockReadClient.representativeSnapshot
  let encoded = try JSONEncoder().encode(original)
  let decoded = try JSONDecoder().decode(WorkbenchSnapshot.self, from: encoded)
  #expect(decoded == original)
}

@Test
func decodesRustProjectionShapedJSON() throws {
  // A minimal snapshot in the exact field shape emitted by
  // mission_workbench_projection.rs must decode cleanly.
  let json = """
    {
      "missionId": "mission_x",
      "fridayConversationId": "fconv_x",
      "runtimeFeedStatus": "live_rust_hub_projection",
      "statusLabels": ["stale", "offline", "error"],
      "duplicatePreflight": {
        "status": "opens_existing_mission",
        "duplicateMissionId": "mission_x",
        "duplicateWorkItemId": "wi_x"
      },
      "routeDecision": {
        "advisorSummary": "why",
        "selectedRoute": "proof://route-decision/abc",
        "alternatives": ["a", "b"],
        "truthLabel": "friday_owned"
      },
      "providerReceiptRefs": ["proof://provider-receipt/1"],
      "channelReceiptRefs": [],
      "workItems": [
        {"id": "wi_x", "title": "t", "state": "provider_ack", "owner": "linked_only",
         "proofRef": "proof://provider-receipt/1", "done": false}
      ],
      "timelinePages": [
        {"page": 1, "cursor": "start", "nextCursor": "offset:1", "eventRefs": ["e0"]}
      ],
      "memoryCandidates": [],
      "runOutcomeLearningCandidates": [
        {"id": "a1:run_x:preference", "runId": "run_x", "workItemId": "wi_x",
         "kind": "preference", "state": "pending",
         "summary": "refs-only run outcome: turns=1; executed_tools=0",
         "evidenceRef": "proof://run-outcome-learning-candidate/1",
         "turns": 1, "executedTools": 0}
      ],
      "capabilityStates": [
        {"id": "cap", "label": "Advisor", "kind": "advisor", "truthLabel": "friday_owned",
         "approvalState": "not_required", "dispatchAllowed": false, "summary": "s",
         "proofRef": "proof://route-decision/abc"}
      ],
      "transcriptSections": [
        {"id": "sec", "title": "Mission", "groupKind": "mission", "missionId": "mission_x",
         "truthLabel": "friday_owned", "status": "waiting", "events": [
           {"id": "e0", "missionId": "mission_x", "surface": "desktop", "status": "waiting",
            "truthLabel": "friday_owned", "summary": "s",
            "evidenceRefs": {"timelineRef": "timeline://mission/mission_x/0"},
            "capturedAt": "unix_ms:1"}
         ]}
      ]
    }
    """.data(using: .utf8)!
  let snapshot = try JSONDecoder().decode(WorkbenchSnapshot.self, from: json)
  #expect(snapshot.missionId == "mission_x")
  #expect(snapshot.statusLabels == [.stale, .offline, .error])
  #expect(snapshot.workItems.first?.state == .providerAck)
  #expect(snapshot.runOutcomeLearningCandidates.first?.id == "a1:run_x:preference")
  #expect(snapshot.transcriptSections.first?.events.first?.evidenceRefs.timelineRef != nil)
}

// MARK: - Real FridayRustClient integration (wire → display reconciliation)

@Test
func mockWireSnapshotRoundTripsThroughAdapterToRichDisplay() throws {
  // The reconciliation keystone: the package returns a THIN refs-only wire snapshot
  // (`FridayRustClient.WorkbenchSnapshot`); the Console's `WorkbenchSnapshotAdapter` re-decodes
  // its `raw` projection JSON into the rich display model. Adapting the representative wire
  // snapshot must reproduce an EQUAL rich snapshot — proving the bridge is lossless for the
  // fields the UI consumes (this is the same path the REAL client's response takes).
  let wire = try MockReadClient.representativeWireSnapshot()
  let display = try WorkbenchSnapshotAdapter.display(from: wire)
  #expect(display == MockReadClient.representativeSnapshot)
}

@Test
@MainActor
func refreshPreservesRenderCriticalProjectionFieldsFromWire() async {
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded))
  await vm.refresh()

  guard case let .loaded(snapshot) = vm.state else {
    Issue.record("expected loaded representative snapshot, got \(vm.state)")
    return
  }
  let expected = MockReadClient.representativeSnapshot
  #expect(snapshot.missionId == expected.missionId)
  #expect(snapshot.fridayConversationId == expected.fridayConversationId)
  #expect(snapshot.providerReceiptRefs == expected.providerReceiptRefs)
  #expect(snapshot.channelReceiptRefs == expected.channelReceiptRefs)
  #expect(snapshot.workItems.map(\.id) == expected.workItems.map(\.id))
  #expect(snapshot.workItems.map(\.state) == expected.workItems.map(\.state))
  #expect(snapshot.workItems.map(\.owner) == expected.workItems.map(\.owner))
  #expect(snapshot.memoryCandidates.map(\.evidenceRef) == expected.memoryCandidates.map(\.evidenceRef))
  #expect(snapshot.runOutcomeLearningCandidates.map(\.evidenceRef) == expected.runOutcomeLearningCandidates.map(\.evidenceRef))
  #expect(snapshot.transcriptSections.flatMap(\.events).map(\.proofRef) == expected.transcriptSections.flatMap(\.events).map(\.proofRef))
  #expect(!snapshot.isLoadedEmpty)
}

@Test
func adapterSurfacesMalformedProjectionAsUnavailableNotReady() throws {
  // A wire snapshot whose `raw` is NOT a valid Workbench projection must throw (→ honest
  // unavailable), never a partial-but-ready snapshot. We never fabricate readiness from
  // unparseable JSON.
  let junk = try FridayRustClient.WorkbenchSnapshot(
    projectionJSON: #"{"missionId":"m"}"#.data(using: .utf8)!,
    generatedAtMs: 0)
  #expect(throws: FridayRustReadClientError.self) {
    _ = try WorkbenchSnapshotAdapter.display(from: junk)
  }
}

@Test
@MainActor
func realClientConnectionFailureRendersHonestUnavailable() async {
  // THE REQUIRED TRUTH TEST — exercises the REAL `SealedWSReadClient`, not the mock.
  //
  // Pre-slice-6 the Rust read-projection server is DARK / not flipped, so the real client
  // CANNOT connect — the EXPECTED normal state. We inject a transport that fails exactly as a
  // dark/refused server does (`makeTransport` throws, which `fetchWorkbench()` calls FIRST,
  // before any socket I/O — deterministic, no flaky real network). The view model MUST render
  // this as the honest `.unavailable` state, never a fake-ready snapshot and never a crash.
  let realClient = SealedWSReadClient(
    keypair: FridayCrypto.DeviceKeypair(),
    forwardedPrincipal: "owner:hub-console-desktop",
    makeTransport: {
      throw FridayReadClientError.transport("connection refused (read-projection server dark)")
    })
  let vm = OperationsOverviewViewModel(client: realClient)
  await vm.refresh()

  guard case let .unavailable(reason) = vm.state else {
    Issue.record("real-client connect failure must render .unavailable, got \(vm.state)")
    return
  }
  // The package error maps to an honest offline reason, and NO snapshot is fabricated.
  #expect(reason.contains("offline") || reason.contains("connection"))
  #expect(vm.state.snapshot == nil)
}

@Test
@MainActor
func loopbackTransportAgainstDarkServerRendersHonestUnavailable() async {
  // THE PRODUCTION HONEST-UNAVAILABLE PATH — drives the REAL `LoopbackSealedWSTransport`
  // (NWConnection + the synchronous bridge), NOT an injected throwing closure.
  //
  // Pre-slice-6 the read-projection server is DARK; nothing listens on the loopback port. The
  // transport must fail at connect (refused / `.waiting` / bounded timeout) and the view model
  // must render `.unavailable` — never fake-ready, never a hang, never a crash. We use a high
  // loopback port nothing listens on + a short connectTimeout so the bound is observable.
  let start = Date()
  let client = RealReadClientFactory.make(
    config: ReadProjectionServerConfig(host: "127.0.0.1", port: 49231, connectTimeout: 3),
    forwardedPrincipal: "owner:hub-console-desktop")
  let vm = OperationsOverviewViewModel(client: client)
  await vm.refresh()
  let elapsed = Date().timeIntervalSince(start)

  guard case .unavailable = vm.state else {
    Issue.record("dark loopback server must render .unavailable, got \(vm.state)")
    return
  }
  // No fabricated snapshot, and the failure is BOUNDED (did not hang) — well under the timeout
  // ceiling for a refused connect; comfortably under the test wall even if it times out.
  #expect(vm.state.snapshot == nil)
  #expect(elapsed < 10)
}

@Test
func realClientFactoryBuildsAgainstLoopbackConfig() {
  // The factory builds a real `SealedWSReadClient` (conforming to the unified protocol) for the
  // read-projection server's loopback seam. This is wiring-only; the live round-trip against a
  // RUNNING server is the deferred slice-6 acceptance criterion.
  let client = RealReadClientFactory.make(
    config: .slice6LoopbackPlaceholder,
    forwardedPrincipal: "owner:hub-console-desktop")
  #expect(client is SealedWSReadClient)
  #expect(ReadProjectionServerConfig.slice6LoopbackPlaceholder.host == "127.0.0.1")
}

// MARK: - Spine-WRITE drivers (Lane-D entry-point-A organic loop)

/// An in-memory `FridayMissionSpineWriteClient` for view-model tests. Returns a programmed
/// intake/decision outcome, OR throws to exercise the honest-unavailable path. Captures the last
/// request so a test can assert the owner_principal / decision the view model wired.
final class MockMissionSpineWriteClient: FridayMissionSpineWriteClient, FridayMissionBoundRunWriteClient, @unchecked Sendable {
  enum Behavior: Sendable {
    case intakeReady
    case intakeNeedsClarification
    case intakeBlocked
    case memoryConfirmed
    case memoryBlocked
    case learningConfirmed
    case learningBlocked
    case throwsTransport
  }
  let behavior: Behavior
  private let lock = NSLock()
  private var _lastIntake: MissionIntakeRequestWire?
  private var _lastDecision: MemoryDecisionRequestWire?
  private var _lastLearningDecision: RunOutcomeLearningDecisionRequestWire?
  private var _lastMissionContext: MissionWorkItemContextWire?
  private var _lastMissionRunConstraints: AgentRunConstraintsWire?
  private var _missionContexts: [MissionWorkItemContextWire] = []
  private var _dispatchedTasks: [String] = []
  var lastIntake: MissionIntakeRequestWire? { lock.withLock { _lastIntake } }
  var lastDecision: MemoryDecisionRequestWire? { lock.withLock { _lastDecision } }
  var lastLearningDecision: RunOutcomeLearningDecisionRequestWire? {
    lock.withLock { _lastLearningDecision }
  }
  var lastMissionContext: MissionWorkItemContextWire? { lock.withLock { _lastMissionContext } }
  var lastMissionRunConstraints: AgentRunConstraintsWire? { lock.withLock { _lastMissionRunConstraints } }
  var missionContexts: [MissionWorkItemContextWire] { lock.withLock { _missionContexts } }
  var dispatchedTasks: [String] { lock.withLock { _dispatchedTasks } }

  init(behavior: Behavior) { self.behavior = behavior }

  func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire {
    lock.withLock { _lastIntake = request }
    switch behavior {
    case .throwsTransport:
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    case .intakeNeedsClarification:
      return MissionIntakeResultWire(
        fridayConversationId: request.fridayConversationId, missionId: request.missionId,
        surfaceThreadId: request.surfaceThreadId, status: "needs_clarification",
        createdOrReady: false, clarificationQuestions: ["What is the deadline?"])
    case .intakeBlocked:
      return MissionIntakeResultWire(
        fridayConversationId: request.fridayConversationId, missionId: request.missionId,
        surfaceThreadId: request.surfaceThreadId, status: "blocked",
        blockers: ["duplicate_mission"], createdOrReady: false)
    default:
      return MissionIntakeResultWire(
        fridayConversationId: request.fridayConversationId, missionId: request.missionId,
        workItemId: request.workItemId, surfaceThreadId: request.surfaceThreadId,
        status: "ready", createdOrReady: true)
    }
  }

  func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire {
    lock.withLock { _lastDecision = request }
    switch behavior {
    case .throwsTransport:
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    case .memoryBlocked:
      return MemoryDecisionResultWire(
        memoryId: request.memoryId, state: "unknown", status: "blocked",
        blocker: "unknown_candidate", recallable: false)
    default:
      return MemoryDecisionResultWire(
        memoryId: request.memoryId,
        state: request.decision == "confirm" ? "confirmed" : "rejected",
        status: request.decision == "confirm" ? "confirmed" : "rejected",
        recallable: request.decision == "confirm")
    }
  }

  func submitRunOutcomeLearningDecision(
    _ request: RunOutcomeLearningDecisionRequestWire
  ) async throws -> RunOutcomeLearningDecisionResultWire {
    lock.withLock { _lastLearningDecision = request }
    switch behavior {
    case .throwsTransport:
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    case .learningBlocked:
      return RunOutcomeLearningDecisionResultWire(
        candidateId: request.candidateId, state: "unknown", status: "blocked",
        blocker: "unknown_candidate")
    default:
      return RunOutcomeLearningDecisionResultWire(
        candidateId: request.candidateId,
        runId: "run-a1",
        kind: "preference",
        state: request.decision == "confirm" ? "confirmed" : "rejected",
        status: request.decision == "confirm" ? "confirmed" : "rejected")
    }
  }

  func dispatchMissionBoundAgentRun(
    task: String,
    missionContext: MissionWorkItemContextWire,
    constraints: AgentRunConstraintsWire?
  ) async throws -> AgentRunDispatchOutcome {
    lock.withLock {
      _lastMissionContext = missionContext
      _lastMissionRunConstraints = constraints
      _missionContexts.append(missionContext)
      _dispatchedTasks.append(task)
    }
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    return .result(AgentRunResultWire(runId: "run-bound-1", status: "completed", turns: 1))
  }
}

struct StaticWorkbenchReadClient: FridayRustReadClient {
  let snapshot: FridayHubConsoleCore.WorkbenchSnapshot
  var answerBodies: [String: String] = [:]

  func fetchWorkbench() async throws -> FridayRustClient.WorkbenchSnapshot {
    let json = try JSONEncoder().encode(snapshot)
    return try FridayRustClient.WorkbenchSnapshot(projectionJSON: json, generatedAtMs: 0)
  }

  func fetchRunAnswerBody(runId: String) async throws -> RunAnswerBody {
    guard let answer = answerBodies[runId] else {
      throw FridayReadClientError.transport("run answer body unavailable")
    }
    let data = """
      {
        "run_id": "\(runId)",
        "outcome": "delivered",
        "status": "finished",
        "answer": "\(answer)",
        "truth_label": "owner_gated_answer_body"
      }
      """.data(using: .utf8)!
    return try RunAnswerBody(answerJSON: data, generatedAtMs: 1)
  }
}

final class DetailReadClient: FridayRustReadClient, @unchecked Sendable {
  private let lock = NSLock()
  private var _requested: [String] = []
  var failWith: FridayReadClientError?

  var requested: [String] {
    lock.withLock { _requested }
  }

  func fetchWorkbench() async throws -> FridayRustClient.WorkbenchSnapshot {
    try MockReadClient.representativeWireSnapshot()
  }

  func fetchProvidersDoctor(probe: String?) async throws -> ReadProjectionSnapshot {
    try record("providers:\(probe ?? "")", kind: "providers", status: "ready", proofRef: "proof://provider/doctor")
  }

  func fetchSessionList() async throws -> ReadProjectionSnapshot {
    try record("sessions", kind: "sessions", status: "ready", proofRef: "proof://session/list")
  }

  func fetchSessionOpen(agentSessionId: String) async throws -> ReadProjectionSnapshot {
    try record("session-open:\(agentSessionId)", kind: "session-open", status: "open", proofRef: "proof://session/open/\(agentSessionId)")
  }

  func fetchSessionLinkState(agentSessionId: String) async throws -> ReadProjectionSnapshot {
    try record("session-link:\(agentSessionId)", kind: "session-link", status: "connected", proofRef: "proof://session/link/\(agentSessionId)")
  }

  func fetchRunReadback(runId: String) async throws -> ReadProjectionSnapshot {
    try record("run:\(runId)", kind: "run", status: "complete", runId: runId, proofRef: "proof://run/\(runId)")
  }

  func fetchRunFileView(runId: String) async throws -> ReadProjectionSnapshot {
    try record("run-files:\(runId)", kind: "run-files", status: "ready", runId: runId, proofRef: "proof://run-files/\(runId)")
  }

  func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
    try record("needs-me:\(runId)", kind: "needs-me", status: "waiting", runId: runId, proofRef: "proof://needs/\(runId)")
  }

  private func record(
    _ request: String,
    kind: String,
    status: String,
    runId: String? = nil,
    proofRef: String
  ) throws -> ReadProjectionSnapshot {
    if let failWith { throw failWith }
    lock.withLock { _requested.append(request) }
    var raw: [String: Any] = [
      "missionId": "mission-desktop",
      "status": status,
      "truthLabel": "friday_owned",
      "proofRef": proofRef,
      "evidenceRefs": ["proof://evidence/\(kind)"],
    ]
    if let runId { raw["runId"] = runId }
    let data = try JSONSerialization.data(withJSONObject: raw)
    return try ReadProjectionSnapshot(projectionJSON: data, generatedAtMs: 1_780_640_000_123)
  }
}

func snapshotWithWorkItems(
  missionId: String,
  fridayConversationId: String,
  workItemIds: [String]
) -> FridayHubConsoleCore.WorkbenchSnapshot {
  FridayHubConsoleCore.WorkbenchSnapshot(
    missionId: missionId,
    fridayConversationId: fridayConversationId,
    runtimeFeedStatus: .liveRustHubProjection,
    statusLabels: [],
    duplicatePreflight: MissionWorkbenchDuplicatePreflight(
      status: "none", duplicateMissionId: "", duplicateWorkItemId: ""),
    routeDecision: MissionWorkbenchRouteDecision(
      advisorSummary: "Codex first with Claude follow-up.",
      selectedRoute: "proof://route-decision/test",
      alternatives: ["combination: Codex first, Claude follow-up"],
      truthLabel: .fridayOwned),
    providerReceiptRefs: [],
    channelReceiptRefs: [],
    workItems: workItemIds.map {
      MissionWorkbenchWorkItem(
        id: $0,
        title: $0,
        state: .ready,
        owner: .fridayOwned,
        proofRef: nil,
        done: false)
    },
    timelinePages: [],
    memoryCandidates: [],
    capabilityStates: [],
    transcriptSections: [])
}

@Test
@MainActor
func loadDetailCallsProviderDoctorReadArm() async {
  let client = DetailReadClient()
  let vm = OperationsOverviewViewModel(client: client)
  await vm.loadDetail(.providersDoctor(probe: "anthropic"))

  #expect(client.requested == ["providers:anthropic"])
  guard case let .loaded(detail) = vm.detailState else {
    Issue.record("expected detail .loaded, got \(vm.detailState)")
    return
  }
  #expect(detail.title == "Provider doctor")
  #expect(detail.summary == "mission=mission-desktop | status=ready | truth=friday_owned")
  #expect(detail.refs == ["proof://provider/doctor", "proof://evidence/providers"])
}

@Test
@MainActor
func loadDetailCallsRunAndNeedsMeReadArms() async {
  let client = DetailReadClient()
  let vm = OperationsOverviewViewModel(client: client)
  await vm.loadDetail(.runReadback(runId: "run-desktop"))
  await vm.loadDetail(.activityNeedsMe(runId: "run-desktop"))

  #expect(client.requested == ["run:run-desktop", "needs-me:run-desktop"])
  guard case let .loaded(detail) = vm.detailState else {
    Issue.record("expected detail .loaded, got \(vm.detailState)")
    return
  }
  #expect(detail.title == "Needs-me activity")
  #expect(detail.refs.contains("proof://needs/run-desktop"))
}

@Test
@MainActor
func loadDetailCallsSessionAndRunFileReadArms() async {
  let client = DetailReadClient()
  let vm = OperationsOverviewViewModel(client: client)
  await vm.loadDetail(.sessionOpen(agentSessionId: "session-desktop"))
  await vm.loadDetail(.sessionLinkState(agentSessionId: "session-desktop"))
  await vm.loadDetail(.runFileView(runId: "run-desktop"))

  #expect(client.requested == [
    "session-open:session-desktop",
    "session-link:session-desktop",
    "run-files:run-desktop",
  ])
  guard case let .loaded(detail) = vm.detailState else {
    Issue.record("expected detail .loaded, got \(vm.detailState)")
    return
  }
  #expect(detail.title == "Run files")
  #expect(detail.refs.contains("proof://run-files/run-desktop"))
}

@Test
@MainActor
func loadDetailFailureRendersUnavailable() async {
  let client = DetailReadClient()
  client.failWith = .transport("detail server dark")
  let vm = OperationsOverviewViewModel(client: client)
  await vm.loadDetail(.sessionList)

  guard case let .unavailable(title, reason) = vm.detailState else {
    Issue.record("expected detail .unavailable, got \(vm.detailState)")
    return
  }
  #expect(title == "Session list")
  #expect(reason.contains("offline"))
}

@Test
@MainActor
func submitIntakeReadyRendersConfirmedAndWiresOwnerAdmin001() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded), writeClient: write,
    writeOwnerPrincipal: "admin-001", newId: { "fixed" })
  await vm.submitIntake(intent: "keep one Mission across every surface")

  guard case let .confirmed(summary, questions, _) = vm.intakeState else {
    Issue.record("expected .confirmed, got \(vm.intakeState)")
    return
  }
  #expect(summary.contains("ready"))
  #expect(summary.contains("mission-desktop-fixed"))
  #expect(questions.isEmpty)
  // FIX-Q3b: the body owner the view model wired MUST be the configured owner (admin-001).
  #expect(write.lastIntake?.ownerPrincipal == "admin-001")
  #expect(write.lastIntake?.surfaceKind == "desktop")
  #expect(write.lastIntake?.lane == "auto")
}

@Test
@MainActor
func buildIntakeRequestAcceptsSharedMissionPrefixForUiProofCapture() {
  let request = OperationsOverviewViewModel.buildIntakeRequest(
    intent: "keep one Mission across every surface",
    owner: "admin-001",
    idFactory: { "ui_proof_fixed" },
    missionIdPrefix: "mission_")

  #expect(request.missionId == "mission_ui_proof_fixed")
  #expect(request.workItemId == "work-desktop-ui_proof_fixed")
  #expect(request.surfaceKind == "desktop")
  #expect(request.deliveryRoute == "desktop://hub-console/operations/ui_proof_fixed")
}

@Test
@MainActor
func submitIntakeReadyDispatchesMissionBoundModelTurnWhenRunClientConfigured() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded), writeClient: write, missionRunClient: write,
    writeOwnerPrincipal: "admin-001", newId: { "fixed" })
  await vm.submitIntake(intent: "keep one Mission across every surface")

  guard case let .confirmed(summary, _, _) = vm.intakeState else {
    Issue.record("expected .confirmed, got \(String(describing: vm.intakeState))")
    return
  }
  #expect(summary.contains("run_id=run-bound-1"))
  #expect(write.lastMissionContext == MissionWorkItemContextWire(
    fridayConversationId: "fconv_desktop_fixed",
    missionId: "mission-desktop-fixed",
    workItemId: "work-desktop-fixed"))
  #expect(write.lastMissionRunConstraints?.readOnly == true)
  #expect(write.missionContexts.map(\.workItemId) == ["work-desktop-fixed"])
}

@Test
@MainActor
func submitIntakeDispatchesClaudeFollowUpWhenProjectionExposesGeneratedWorkItem() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let read = StaticWorkbenchReadClient(
    snapshot: snapshotWithWorkItems(
      missionId: "mission-desktop-fixed",
      fridayConversationId: "fconv_desktop_fixed",
      workItemIds: ["work-desktop-fixed", "work-desktop-fixed-claude-followup"]),
    answerBodies: ["run-bound-1": "Desktop Codex first answer"])
  let vm = OperationsOverviewViewModel(
    client: read, writeClient: write, missionRunClient: write,
    writeOwnerPrincipal: "admin-001", newId: { "fixed" })

  await vm.submitIntake(intent: "route through Codex first and Claude follow-up")

  guard case let .confirmed(summary, _, _) = vm.intakeState else {
    Issue.record("expected .confirmed, got \(vm.intakeState)")
    return
  }
  #expect(summary.contains("follow_up_work_item_id=work-desktop-fixed-claude-followup"))
  #expect(
    write.missionContexts.map(\.workItemId)
      == ["work-desktop-fixed", "work-desktop-fixed-claude-followup"])
  #expect(write.dispatchedTasks.count == 2)
  #expect(write.dispatchedTasks[1].contains("source_work_item_id=work-desktop-fixed"))
  #expect(write.dispatchedTasks[1].contains("follow_up_work_item_id=work-desktop-fixed-claude-followup"))
  #expect(write.dispatchedTasks[1].contains("codex_first_run_id=run-bound-1"))
  #expect(write.dispatchedTasks[1].contains("output destination: owner-visible answer body"))
  #expect(write.dispatchedTasks[1].contains("success = concise final synthesis"))
  #expect(write.dispatchedTasks[1].contains("constraint = read-only"))
  #expect(write.dispatchedTasks[1].contains("Desktop Codex first answer"))
  #expect(write.dispatchedTasks[1].contains("do not ask the operator for paths"))
  #expect(write.dispatchedTasks[1].contains("do not claim you verified unrelated files"))
}

@Test
@MainActor
func submitIntakeDisplaysOwnerGatedRunAnswerBodyWhenDelivered() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let read = StaticWorkbenchReadClient(
    snapshot: snapshotWithWorkItems(
      missionId: "mission-desktop-fixed",
      fridayConversationId: "fconv_desktop_fixed",
      workItemIds: ["work-desktop-fixed"]),
    answerBodies: ["run-bound-1": "Readable desktop answer body"])
  let vm = OperationsOverviewViewModel(
    client: read, writeClient: write, missionRunClient: write,
    writeOwnerPrincipal: "admin-001", newId: { "fixed" })

  await vm.submitIntake(intent: "show the actual answer in desktop")

  guard case let .confirmed(summary, _, answerBody) = vm.intakeState else {
    Issue.record("expected .confirmed, got \(vm.intakeState)")
    return
  }
  #expect(summary.contains("run_id=run-bound-1"))
  #expect(answerBody?.contains("Readable desktop answer body") == true)
  #expect(answerBody?.contains("Codex:") == true)
}

@Test
@MainActor
func submitIntakeNeedsClarificationCarriesQuestionsHonestly() async {
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: MockMissionSpineWriteClient(behavior: .intakeNeedsClarification))
  await vm.submitIntake(intent: "do the thing")
  guard case let .confirmed(_, questions, _) = vm.intakeState else {
    Issue.record("expected .confirmed (with questions), got \(vm.intakeState)")
    return
  }
  #expect(questions == ["What is the deadline?"])
}

@Test
@MainActor
func submitIntakeBlockedRendersErrorNotConfirmed() async {
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: MockMissionSpineWriteClient(behavior: .intakeBlocked))
  await vm.submitIntake(intent: "duplicate intent")
  guard case let .error(reason) = vm.intakeState else {
    Issue.record("a blocked intake must render .error, got \(vm.intakeState)")
    return
  }
  #expect(reason.contains("blocked"))
}

@Test
@MainActor
func submitIntakeEmptyDraftRendersErrorWithoutCallingWrite() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded), writeClient: write)
  await vm.submitIntake(intent: "   ")
  guard case .error = vm.intakeState else {
    Issue.record("an empty intent must render .error, got \(vm.intakeState)")
    return
  }
  #expect(write.lastIntake == nil)
}

@Test
@MainActor
func submitIntakeWithNoWriteClientRendersHonestUnavailable() async {
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded))  // no write client
  await vm.submitIntake(intent: "something")
  guard case let .error(reason) = vm.intakeState else {
    Issue.record("no write client must render .error, got \(vm.intakeState)")
    return
  }
  #expect(reason.contains("not configured"))
}

@Test
@MainActor
func submitIntakeTransportFailureRendersHonestUnavailable() async {
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: MockMissionSpineWriteClient(behavior: .throwsTransport))
  await vm.submitIntake(intent: "something")
  guard case let .error(reason) = vm.intakeState else {
    Issue.record("a transport failure must render .error, got \(vm.intakeState)")
    return
  }
  #expect(reason.contains("offline") || reason.contains("unavailable"))
}

@Test
@MainActor
func decideMemoryConfirmRendersConfirmedRecallable() async {
  let write = MockMissionSpineWriteClient(behavior: .memoryConfirmed)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded), writeClient: write, writeOwnerPrincipal: "admin-001")
  await vm.decideMemory(candidateId: "cand-1", memoryId: "mem-1", confirm: true)
  guard case let .confirmed(summary, _, _) = vm.memoryDecisionStates["cand-1"] else {
    Issue.record("expected .confirmed, got \(String(describing: vm.memoryDecisionStates["cand-1"]))")
    return
  }
  #expect(summary.contains("confirmed"))
  #expect(summary.contains("recallable=true"))
  #expect(write.lastDecision?.decision == "confirm")
  #expect(write.lastDecision?.ownerPrincipal == "admin-001")
}

@Test
@MainActor
func decideMemoryBlockedRendersErrorNotConfirmed() async {
  // THE synthetic-candidate-id reality today: a confirm against the synthetic id returns
  // status:"blocked" — which MUST render .error (never a fabricated confirm).
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: MockMissionSpineWriteClient(behavior: .memoryBlocked))
  await vm.decideMemory(
    candidateId: "cand-synthetic", memoryId: "memory_candidate_mission_x_0", confirm: true)
  guard case let .error(reason) = vm.memoryDecisionStates["cand-synthetic"] else {
    Issue.record("a blocked decision must render .error, got \(String(describing: vm.memoryDecisionStates["cand-synthetic"]))")
    return
  }
  #expect(reason.contains("unknown_candidate") || reason.contains("blocked"))
}

@Test
@MainActor
func decideRunOutcomeLearningConfirmRendersConfirmedAndWiresCandidate() async {
  let write = MockMissionSpineWriteClient(behavior: .learningConfirmed)
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded), writeClient: write)
  await vm.decideRunOutcomeLearning(candidateId: "a1:run-a1:preference", confirm: true)

  guard case let .confirmed(summary, questions, _) =
    vm.runOutcomeLearningDecisionStates["a1:run-a1:preference"] else {
    Issue.record("expected .confirmed, got \(String(describing: vm.runOutcomeLearningDecisionStates["a1:run-a1:preference"]))")
    return
  }
  #expect(summary.contains("confirmed"))
  #expect(summary.contains("kind=preference"))
  #expect(questions.isEmpty)
  #expect(write.lastLearningDecision?.candidateId == "a1:run-a1:preference")
  #expect(write.lastLearningDecision?.decision == "confirm")
}

@Test
@MainActor
func decideRunOutcomeLearningBlockedRendersErrorNotConfirmed() async {
  let write = MockMissionSpineWriteClient(behavior: .learningBlocked)
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded), writeClient: write)
  await vm.decideRunOutcomeLearning(candidateId: "a1:missing:preference", confirm: false)

  guard case let .error(reason) =
    vm.runOutcomeLearningDecisionStates["a1:missing:preference"] else {
    Issue.record("expected .error, got \(String(describing: vm.runOutcomeLearningDecisionStates["a1:missing:preference"]))")
    return
  }
  #expect(reason.contains("unknown_candidate"))
  #expect(write.lastLearningDecision?.decision == "reject")
}

@Test
@MainActor
func realWriteClientFactoryBuildsLiveAgainst48750OrHonestUnavailable() {
  // The factory builds a real `SealedWSWriteClient` for the WRITE server's loopback seam (48750),
  // OR (if the host master key is absent) an honest-unavailable client — never a fabricated one.
  // Wiring-only; the live round-trip against a RUNNING server is the operator-gated AC.
  #expect(AgentRunWriteServerConfig.liveLoopback.port == 48750)
  #expect(AgentRunWriteServerConfig.liveLoopback.host == "127.0.0.1")
  // The client receive window must exceed the Rust Codex app-server watchdog (300s) so a
  // provider timeout can settle as an honest AgentRunResult instead of racing the socket timeout.
  #expect(AgentRunWriteServerConfig.liveLoopback.receiveTimeout > 300)
  let client = RealWriteClientFactory.make(
    config: .liveLoopback, forwardedPrincipal: "admin-001")
  #expect(client is SealedWSWriteClient)
}
