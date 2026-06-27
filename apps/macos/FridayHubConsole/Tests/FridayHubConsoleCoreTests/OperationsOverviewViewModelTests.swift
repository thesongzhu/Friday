import Foundation
import Testing

@testable import FridayHubConsoleCore
@testable import FridayRustClient

@Test
@MainActor
func refreshLoadsRepresentativeSnapshot() async {
  let readiness = DesktopDevicePairingReadiness(
    mode: .ready,
    publicKeyHex: String(repeating: "b", count: 64),
    readHost: "127.0.0.1",
    readPort: 48751,
    ownerPrincipal: "admin-001",
    reason: "Desktop read-seam peer is derived and ready.",
    nextStep: "Pair mobile devices separately.")
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    devicePairing: readiness)
  await vm.refresh()
  let snapshot = vm.state.snapshot
  #expect(snapshot != nil)
  #expect(snapshot?.missionId == "mission_workbench_probe_20260605")
  #expect(snapshot?.runtimeFeedStatus == .liveRustHubProjection)
  #expect(vm.devicePairing == readiness)
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "operations-refresh",
    screen: "operations",
    additionalScreens: ["channels"],
    actionId: "desktop/operations/refresh",
    capabilityId: "desktop_operations_live_read_projection",
    evidenceRef: "swift://desktop/operations/refresh/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "mission_id": snapshot?.missionId ?? "",
      "runtime_feed_status": snapshot?.runtimeFeedStatus.rawValue ?? "",
      "channel_receipt_refs": snapshot?.channelReceiptRefs ?? [],
      "provider_receipt_refs": snapshot?.providerReceiptRefs ?? [],
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "operations-mission-resolve-or-create",
    screen: "operations",
    actionId: "desktop/operations/mission-resolve-or-create",
    capabilityId: "desktop_operations_mission_resolve_or_create_projection",
    evidenceRef: "swift://desktop/operations/mission-resolve-or-create/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "mission_id": snapshot?.missionId ?? "",
      "duplicate_preflight_status": snapshot?.duplicatePreflight.status ?? "",
      "duplicate_mission_id": snapshot?.duplicatePreflight.duplicateMissionId ?? "",
      "duplicate_work_item_id": snapshot?.duplicatePreflight.duplicateWorkItemId ?? "",
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "channels-receipts",
    screen: "channels",
    actionId: "desktop/channels/receipts",
    capabilityId: "desktop_channels_receipt_projection",
    evidenceRef: "swift://desktop/channels/receipts/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "channel_receipt_refs": snapshot?.channelReceiptRefs ?? [],
      "provider_receipt_refs": snapshot?.providerReceiptRefs ?? [],
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "channels-surface-events",
    screen: "channels",
    actionId: "desktop/channels/surface-events",
    capabilityId: "desktop_channels_surface_event_projection",
    evidenceRef: "swift://desktop/channels/surface-events/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "channel_receipt_refs": snapshot?.channelReceiptRefs ?? [],
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "diagnostics-proof-refs",
    screen: "diagnostics",
    actionId: "desktop/diagnostics/proof-refs",
    capabilityId: "desktop_diagnostics_proof_refs",
    evidenceRef: "swift://desktop/diagnostics/proof-refs/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "runtime_feed_status": snapshot?.runtimeFeedStatus.rawValue ?? "",
      "status_labels": snapshot?.statusLabels.map(\.rawValue) ?? [],
      "provider_receipt_refs": snapshot?.providerReceiptRefs ?? [],
      "channel_receipt_refs": snapshot?.channelReceiptRefs ?? [],
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "evidence-index-read",
    screen: "evidence",
    actionId: "desktop/evidence/index-read",
    capabilityId: "desktop_evidence_index_read",
    evidenceRef: "swift://desktop/evidence/index-read/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "transcript_section_count": snapshot?.transcriptSections.count ?? 0,
      "timeline_page_count": snapshot?.timelinePages.count ?? 0,
      "mission_id": snapshot?.missionId ?? "",
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "settings-hub-posture",
    screen: "settings",
    actionId: "desktop/settings/hub-posture",
    capabilityId: "desktop_settings_hub_posture",
    evidenceRef: "swift://desktop/settings/hub-posture/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "runtime_feed_status": snapshot?.runtimeFeedStatus.rawValue ?? "",
      "t3_provisioning_status": snapshot?.t3ProvisioningStatus?.desktopStatusLabel ?? "",
      "device_pairing_mode": vm.devicePairing.mode.rawValue,
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "skills-capability-matrix",
    screen: "skills",
    actionId: "desktop/skills/capability-matrix",
    capabilityId: "desktop_skills_capability_matrix",
    evidenceRef: "swift://desktop/skills/capability-matrix/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "capability_count": snapshot?.capabilityStates.count ?? 0,
      "dispatch_allowed_count": snapshot?.capabilityStates.filter(\.dispatchAllowed).count ?? 0,
      "capability_truth_labels": snapshot?.capabilityStates.map(\.truthLabel.rawValue) ?? [],
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "media-evidence-refs",
    screen: "media",
    actionId: "desktop/media/evidence-refs",
    capabilityId: "desktop_media_link_evidence_refs",
    evidenceRef: "swift://desktop/media/evidence-refs/mission_workbench_probe_20260605",
    source: "macos_operations_viewmodel_refresh_runtime",
    proof: [
      "provider_receipt_refs": snapshot?.providerReceiptRefs ?? [],
      "channel_receipt_refs": snapshot?.channelReceiptRefs ?? [],
      "timeline_page_count": snapshot?.timelinePages.count ?? 0,
      "media_adapters_live": false,
    ])
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
  #expect(blocked?.recoveryKind == "needs_operator")
  #expect(blocked?.canRetry == false)
  #expect(blocked?.canCancel == true)

  // A stale retryable row must keep its recovery affordance facts on desktop.
  let retryable = snapshot.workItems.first { $0.id == "work_probe_stale_retryable" }
  #expect(retryable?.state == .stale)
  #expect(retryable?.blockingReason.contains("operator may retry") == true)
  #expect(retryable?.recoveryKind == "retryable")
  #expect(retryable?.canRetry == true)
  #expect(retryable?.canCancel == true)

  // Honest status: stale must be present.
  #expect(snapshot.statusLabels.contains(.stale))

  // Memory candidates never grant authority.
  #expect(snapshot.memoryCandidates.allSatisfy { !$0.grantsMemoryAuthority })
  #expect(snapshot.runOutcomeLearningCandidates.first?.state == "pending")
  #expect(snapshot.runOutcomeLearningCandidates.first?.evidenceRef.hasPrefix("proof://") == true)
  #expect(snapshot.t3ProvisioningStatus?.truthLabel == "rust_hub_t3_provisioning_read_only_no_mint")
  #expect(snapshot.t3ProvisioningStatus?.isFullyProvisioned == true)
  #expect(snapshot.t3ProvisioningStatus?.desktopStatusLabel == "fully provisioned")
  #expect(snapshot.t3ProvisioningStatus?.missingOperatorSteps == [])
  #expect(snapshot.t3ProvisioningStatus?.latestDevice?.deviceId.hasPrefix("proof://device/") == true)
  #expect(snapshot.t3ProvisioningStatus?.latestDevice?.pubkeyFingerprint == "abcd1234:dcba4321")
}

@Test
func desktopDevicePairingReadinessSurfacesOnlyMasterDerivedPublicKey() throws {
  let home = try temporaryHome()
  let master = String(repeating: "11", count: 32)

  let readiness = DesktopDevicePairingReadiness.evaluate(
    config: ReadProjectionServerConfig(host: "127.0.0.1", port: 48751),
    ownerPrincipal: "admin-001",
    environment: [MasterKeyPeer.masterKeyEnv: master],
    homeDirectory: home)

  #expect(readiness.mode == .ready)
  #expect(readiness.publicKeyHex?.count == 64)
  #expect(readiness.publicKeyHex?.allSatisfy { $0.isHexDigit && ($0.isNumber || $0.isLowercase) } == true)
  #expect(readiness.readHost == "127.0.0.1")
  #expect(readiness.readPort == 48751)
  #expect(readiness.ownerPrincipal == "admin-001")
  #expect(!readiness.reason.lowercased().contains("secret"))
  #expect(!readiness.nextStep.lowercased().contains("secret"))
}

@Test
func desktopDevicePairingReadinessFailsClosedWhenMasterKeyMissing() throws {
  let home = try temporaryHome()

  let readiness = DesktopDevicePairingReadiness.evaluate(
    environment: [:],
    homeDirectory: home)

  #expect(readiness.mode == .unavailable)
  #expect(readiness.publicKeyHex == nil)
  #expect(readiness.readPort == 48751)
  #expect(!readiness.reason.lowercased().contains("secret"))
  #expect(!readiness.nextStep.lowercased().contains("secret"))
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
func attentionSummarySurfacesOnlyUnfinishedRecoveryRelevantWorkItems() {
  let snapshot = MockReadClient.representativeSnapshot
  let attentionIds = snapshot.attentionWorkItems.map(\.id)

  #expect(attentionIds.contains("work_probe_provider"))
  #expect(attentionIds.contains("work_probe_blocked"))
  #expect(attentionIds.contains("work_probe_stale_retryable"))
  #expect(!attentionIds.contains("work_probe_done"))
  #expect(!attentionIds.contains("workbench_timeline_read_mission_workbench_probe_20260605"))
  #expect(snapshot.attentionSummary == "3 work items need attention.")
  #expect(
    snapshot.attentionWorkItems.first { $0.id == "work_probe_provider" }?.attentionReason
      == "provider acknowledged; cancel is the only safe recovery action")
  #expect(
    snapshot.attentionWorkItems.first { $0.id == "work_probe_stale_retryable" }?.recoveryKind
      == "retryable")
}

@Test
func attentionSummaryStaysClearForCompletedAndTimelineOnlySnapshots() {
  let snapshot = FridayHubConsoleCore.WorkbenchSnapshot(
    missionId: "mission-clear",
    fridayConversationId: "fconv-clear",
    runtimeFeedStatus: .liveRustHubProjection,
    statusLabels: [],
    duplicatePreflight: MissionWorkbenchDuplicatePreflight(
      status: "none", duplicateMissionId: "", duplicateWorkItemId: ""),
    routeDecision: MissionWorkbenchRouteDecision(
      advisorSummary: "complete",
      selectedRoute: "proof://route-decision/clear",
      alternatives: [],
      truthLabel: .fridayOwned),
    providerReceiptRefs: [],
    channelReceiptRefs: [],
    workItems: [
      MissionWorkbenchWorkItem(
        id: "work-done",
        title: "Done",
        state: .completedWithProof,
        owner: .fridayOwned,
        proofRef: "proof://done",
        done: true),
      MissionWorkbenchWorkItem(
        id: "work-timeline",
        title: "Timeline read",
        state: .timelineRead,
        owner: .fridayOwned,
        proofRef: "proof://timeline",
        done: false),
    ],
    timelinePages: [],
    memoryCandidates: [],
    capabilityStates: [],
    transcriptSections: [])

  #expect(snapshot.attentionWorkItems.isEmpty)
  #expect(snapshot.attentionSummary == "No work items need attention.")
}

private func temporaryHome() throws -> URL {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("friday-console-tests-\(UUID().uuidString)")
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

private func writeDesktopActionEvidenceIfRequested(
  fileSuffix: String,
  screen: String,
  additionalScreens: [String] = [],
  actionId: String,
  capabilityId: String,
  evidenceRef: String,
  source: String,
  proof: [String: Any]
) throws {
  let env = ProcessInfo.processInfo.environment
  let rawDir = (
    env["FRIDAY_DESKTOP_PROJECTION_ACTION_EVIDENCE_DIR"]
      ?? env["FRIDAY_DESKTOP_CHAT_MEMORY_ACTION_EVIDENCE_DIR"]
      ?? ""
  ).trimmingCharacters(in: .whitespacesAndNewlines)
  guard !rawDir.isEmpty else {
    return
  }

  let actionRows: [[String: Any]] = ([screen] + additionalScreens).map { screenName in
    [
      "surface": "desktop",
      "screen": screenName,
      "action_id": actionId,
      "capability_id": capabilityId,
      "status": "pass",
      "evidence_ref": evidenceRef,
      "source": source,
      "truth_label": "swift_viewmodel_write_client_runtime_not_live_hub_not_operator_key_not_endbar",
    ]
  }

  let payload: [String: Any] = [
    "truth": "desktop_chat_memory_action_swift_viewmodel_runtime_not_live_hub_not_endbar",
    "status": "ready",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "proof": proof,
    "actions": actionRows,
    "caveat": "Partial runtime evidence only: macOS product ViewModel action delegates to the read/write seam and renders refs-only results. This is not a live Hub audit receipt, not a user tap, not operator true-key approval, not END-BAR, and not adoption.",
  ]

  let dir = URL(fileURLWithPath: rawDir)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let out = dir.appendingPathComponent("desktop-\(fileSuffix)-action-evidence.json")
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: out, options: .atomic)
  print("[desktop-chat-memory-action-evidence] proofOut=\(out.path)")
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
         "proofRef": "proof://provider-receipt/1", "done": false,
         "blockingReason": "provider acknowledged; cancel only",
         "recoveryKind": "in_flight", "canRetry": false, "canCancel": true}
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
      "t3ProvisioningStatus": {
        "truthLabel": "rust_hub_t3_provisioning_read_only_no_mint",
        "paired": true,
        "deviceIdentityCount": 1,
        "trustedDeviceCount": 1,
        "activeTrustedDeviceCount": 1,
        "trustGrantCount": 1,
        "activeTrustGrantCount": 1,
        "contextPassportCount": 1,
        "contextPassportItemCount": 2,
        "latestDevice": {
          "deviceId": "proof://device/paired-desktop-1",
          "label": "Friday iPhone",
          "pairedAt": 1780640000123,
          "pubkeyFingerprint": "abcd1234:dcba4321"
        }
      },
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
  #expect(snapshot.workItems.first?.blockingReason == "provider acknowledged; cancel only")
  #expect(snapshot.workItems.first?.recoveryKind == "in_flight")
  #expect(snapshot.workItems.first?.canRetry == false)
  #expect(snapshot.workItems.first?.canCancel == true)
  #expect(snapshot.runOutcomeLearningCandidates.first?.id == "a1:run_x:preference")
  #expect(snapshot.t3ProvisioningStatus?.paired == true)
  #expect(snapshot.t3ProvisioningStatus?.latestDevice?.deviceId == "proof://device/paired-desktop-1")
  #expect(snapshot.t3ProvisioningStatus?.latestDevice?.pubkeyFingerprint == "abcd1234:dcba4321")
  #expect(snapshot.t3ProvisioningStatus?.missingOperatorSteps == [])
  #expect(snapshot.transcriptSections.first?.events.first?.evidenceRefs.timelineRef != nil)
}

@Test
func desktopT3ProvisioningStatusNamesOperatorGapsWithoutClaimingReady() throws {
  let status = MissionWorkbenchT3ProvisioningStatus(
    truthLabel: "rust_hub_t3_provisioning_read_only_no_mint",
    paired: true,
    deviceIdentityCount: 1,
    trustedDeviceCount: 1,
    activeTrustedDeviceCount: 1,
    trustGrantCount: 0,
    activeTrustGrantCount: 0,
    contextPassportCount: 0,
    contextPassportItemCount: 0,
    latestDevice: MissionWorkbenchTrustedDeviceSummary(
      deviceId: "proof://device/friday-iphone",
      label: "Friday iPhone",
      pairedAt: 1782208748151,
      pubkeyFingerprint: "f2ccff9e:69f7de33"))

  #expect(status.isFullyProvisioned == false)
  #expect(status.desktopStatusLabel == "operator action needed")
  #expect(status.missingOperatorSteps == ["trust grant", "context passport"])
  #expect(status.desktopSummary == "Missing trust grant, context passport.")
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
  #expect(snapshot.t3ProvisioningStatus == expected.t3ProvisioningStatus)
  #expect(snapshot.t3ProvisioningStatus?.latestDevice?.deviceId.hasPrefix("proof://device/") == true)
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
final class MockMissionSpineWriteClient: FridayMissionSpineWriteClient, FridayMissionBoundRunWriteClient, FridayRustWriteClient, @unchecked Sendable {
  enum Behavior: Sendable {
    case intakeReady
    case intakeNeedsClarification
    case intakeBlocked
    case memoryConfirmed
    case memoryBlocked
    case learningConfirmed
    case learningBlocked
    case activityDone
    case activityBlocked
    case throwsTransport
  }
  let behavior: Behavior
  private let lock = NSLock()
  private var _lastIntake: MissionIntakeRequestWire?
  private var _lastDecision: MemoryDecisionRequestWire?
  private var _lastContextPassportTransfer: ContextPassportTransferRequestWire?
  private var _lastLearningDecision: RunOutcomeLearningDecisionRequestWire?
  private var _lastActivityMarkDone: ActivityMarkDoneRequestWire?
  private var _lastWorkItemStatus: WorkItemStatusRequestWire?
  private var _lastMissionContext: MissionWorkItemContextWire?
  private var _lastMissionRunConstraints: AgentRunConstraintsWire?
  private var _lastResumeRunId: String?
  private var _lastResumeBlob: [UInt8]?
  private var _lastRejectRunId: String?
  private var _lastRejectApprovalId: String?
  private var _lastCancelRunId: String?
  private var _lastCancelReason: String?
  private var _missionContexts: [MissionWorkItemContextWire] = []
  private var _dispatchedTasks: [String] = []
  var lastIntake: MissionIntakeRequestWire? { lock.withLock { _lastIntake } }
  var lastDecision: MemoryDecisionRequestWire? { lock.withLock { _lastDecision } }
  var lastContextPassportTransfer: ContextPassportTransferRequestWire? {
    lock.withLock { _lastContextPassportTransfer }
  }
  var lastLearningDecision: RunOutcomeLearningDecisionRequestWire? {
    lock.withLock { _lastLearningDecision }
  }
  var lastActivityMarkDone: ActivityMarkDoneRequestWire? { lock.withLock { _lastActivityMarkDone } }
  var lastWorkItemStatus: WorkItemStatusRequestWire? { lock.withLock { _lastWorkItemStatus } }
  var lastMissionContext: MissionWorkItemContextWire? { lock.withLock { _lastMissionContext } }
  var lastMissionRunConstraints: AgentRunConstraintsWire? { lock.withLock { _lastMissionRunConstraints } }
  var lastResumeRunId: String? { lock.withLock { _lastResumeRunId } }
  var lastResumeBlob: [UInt8]? { lock.withLock { _lastResumeBlob } }
  var lastRejectRunId: String? { lock.withLock { _lastRejectRunId } }
  var lastRejectApprovalId: String? { lock.withLock { _lastRejectApprovalId } }
  var lastCancelRunId: String? { lock.withLock { _lastCancelRunId } }
  var lastCancelReason: String? { lock.withLock { _lastCancelReason } }
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

  func submitContextPassportTransfer(
    _ request: ContextPassportTransferRequestWire
  ) async throws -> ContextPassportTransferResultWire {
    lock.withLock { _lastContextPassportTransfer = request }
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    return ContextPassportTransferResultWire(
      passportId: request.passportId,
      missionId: request.missionId,
      workItemId: request.workItemId,
      destinationLane: request.destinationLane,
      destinationTarget: request.destinationTarget,
      sharedItemCount: UInt64(request.items.count),
      missionRefCount: 1,
      linkId: "context-passport-\(request.passportId)-1",
      status: "confirmed")
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

  func submitActivityMarkDone(_ request: ActivityMarkDoneRequestWire) async throws -> ActivityMarkDoneResultWire {
    lock.withLock { _lastActivityMarkDone = request }
    switch behavior {
    case .throwsTransport:
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    case .activityBlocked:
      return ActivityMarkDoneResultWire(
        activityId: request.activityId, state: "unknown", status: "blocked",
        blocker: "unknown_activity")
    default:
      return ActivityMarkDoneResultWire(activityId: request.activityId, state: "done", status: "done")
    }
  }

  func submitWorkItemStatus(_ request: WorkItemStatusRequestWire) async throws -> WorkItemStatusResultWire {
    lock.withLock { _lastWorkItemStatus = request }
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    return WorkItemStatusResultWire(
      workItemId: request.workItemId,
      missionId: "mission-\(request.workItemId)",
      previousStatus: request.targetStatus == "ready_to_dispatch" ? "failed_retryable" : "ready_to_dispatch",
      status: request.targetStatus,
      actorRef: request.actorRef,
      reason: request.reason,
      proofReceiptCount: request.proofReceipt == nil ? 0 : 1,
      updatedAtMs: 1_780_640_000_123)
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

  func dispatchAgentRun(
    task: String,
    constraints: AgentRunConstraintsWire?
  ) async throws -> AgentRunDispatchOutcome {
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    return .result(AgentRunResultWire(runId: "run-direct-1", status: "completed", turns: 1))
  }

  func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
    lock.withLock {
      _lastResumeRunId = runId
      _lastResumeBlob = opaqueSignedBlob
    }
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    if opaqueSignedBlob.isEmpty {
      throw FridayWriteClientError.emptySignedBlob
    }
    return ResumeRelayResult(
      runId: runId,
      op: "resume",
      accepted: true,
      status: "mutation_completed",
      auditRef: "audit://resume/1")
  }

  func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
    lock.withLock {
      _lastRejectRunId = runId
      _lastRejectApprovalId = approvalId
    }
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    return ResumeRelayResult(
      runId: runId,
      op: "reject",
      accepted: true,
      status: "rejected",
      auditRef: "audit://reject/1")
  }

  func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
    lock.withLock {
      _lastCancelRunId = runId
      _lastCancelReason = reason
    }
    if case .throwsTransport = behavior {
      throw FridayWriteClientError.transport("connection refused (write server dark)")
    }
    return ResumeRelayResult(
      runId: runId,
      op: "cancel",
      accepted: true,
      status: "cancelled",
      auditRef: "audit://cancel/1")
  }
}

final class MockOperatorApprovalSigner: OperatorApprovalSigner, @unchecked Sendable {
  private let lock = NSLock()
  private(set) var lastRequest: OperatorApprovalSigningRequest?
  var blob: [UInt8] = Array("{\"signed\":\"blob\"}".utf8)
  var error: Error?

  func signApproval(_ request: OperatorApprovalSigningRequest) async throws -> [UInt8] {
    lock.withLock { lastRequest = request }
    if let error { throw error }
    return blob
  }
}

private struct ApprovalRequestFileMirror: Decodable {
  let approvalId: String
  let actionDigest: String
  let expiresAt: Int64
  let decision: String
  let surface: String
  let summary: String?

  enum CodingKeys: String, CodingKey {
    case approvalId = "approval_id"
    case actionDigest = "action_digest"
    case expiresAt = "expires_at"
    case decision, surface, summary
  }
}

struct StaticWorkbenchReadClient: FridayRustReadClient {
  let snapshot: FridayHubConsoleCore.WorkbenchSnapshot
  var answerBodies: [String: String] = [:]
  var activityNeedsMe: [String: String] = [:]

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

  func fetchActivityNeedsMe(runId: String) async throws -> ReadProjectionSnapshot {
    guard let json = activityNeedsMe[runId]?.data(using: .utf8) else {
      throw FridayReadClientError.transport("activity needs-me unavailable")
    }
    return try ReadProjectionSnapshot(projectionJSON: json, generatedAtMs: 1)
  }
}

func activityNeedsMeJSON(runId: String, actionableKind: String, refId: String) -> String {
  """
  {
    "run_id": "\(runId)",
    "status": "waiting",
    "truth_label": "friday_owned",
    "needs_me": {
      "kind": "approval",
      "title": "Approval required",
      "ref_id": "approval-pause-\(runId)",
      "status": "awaiting_approval",
      "action_digest": "digest-pause-\(runId)",
      "summary": "paused on write_file",
      "signing_request": {
        "run_id": "\(runId)",
        "approval_id": "approval-pause-\(runId)",
        "action_digest": "digest-pause-\(runId)",
        "summary": "paused on write_file"
      }
    },
    "actionable_needs_me": [
      {
        "kind": "\(actionableKind)",
        "title": "\(actionableKind) ready",
        "ref_id": "\(refId)",
        "state": "pending",
        "deep_link": "\(actionableKind == "memory_review" ? "memory/session/\(refId)" : "run/\(runId)/approval/\(refId)")",
        "action_digest": "digest-\(refId)",
        "summary": "\(actionableKind) ready"
      }
    ],
    "actionable_needs_me_count": 1
  }
  """
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
    try record(
      "providers:\(probe ?? "")",
      kind: "providers",
      status: "ready",
      proofRef: "proof://provider/doctor",
      extra: [
        "key_validation_probed": true,
        "suggested_text_route": "deepseek",
        "suggested_strong_route": "codex",
        "route_readiness": [
          [
            "provider_id": "deepseek",
            "model": "deepseek-v4-flash",
            "model_size": "small",
            "strength": "cheap",
            "dispatchable": true,
            "blockers": [],
          ],
          [
            "provider_id": "claude",
            "model": "claude-opus-4-8",
            "model_size": "large",
            "strength": "strong",
            "dispatchable": false,
            "blockers": [
              ["kind": "operator_flag", "code": "friday_claude_route_disabled"],
              ["kind": "credential", "code": "api_key_missing"],
            ],
          ],
        ],
        "failover_readiness": [
          [
            "direction": "deepseek_to_claude",
            "flag_enabled": false,
            "can_enable": false,
            "blockers": [["kind": "operator_flag", "code": "failover_flag_off"]],
          ]
        ],
      ])
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
    try record(
      "run:\(runId)",
      kind: "run",
      status: "complete",
      runId: runId,
      proofRef: "proof://run/\(runId)",
      extra: [
        "run_state": "complete",
        "loop_status_derived": "complete",
        "event_count": 7,
        "db_wide_token_total": 321,
        "prompt_tokens": 120,
        "completion_tokens": 201,
        "total_tokens": 321,
        "cost_usd": "0.0456",
        "audit_chain_verified": true,
      ])
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
    proofRef: String,
    extra: [String: Any] = [:]
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
    for (key, value) in extra {
      raw[key] = value
    }
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
  let readiness = detail.providerReadiness
  #expect(readiness?.keyValidationProbed == true)
  #expect(readiness?.suggestedTextRoute == "deepseek")
  #expect(readiness?.suggestedStrongRoute == "codex")
  #expect(readiness?.routes.first { $0.providerId == "deepseek" }?.dispatchable == true)
  #expect(readiness?.routes.first { $0.providerId == "claude" }?.blockers == [
    "friday_claude_route_disabled",
    "api_key_missing",
  ])
  #expect(readiness?.failovers.first?.blockers == ["failover_flag_off"])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "provider-admin-check",
    screen: "providerAdmin",
    actionId: "desktop/providerAdmin/check",
    capabilityId: "desktop_provider_admin_doctor_readiness",
    evidenceRef: "swift://desktop/providerAdmin/check",
    source: "macos_operations_viewmodel_provider_doctor_runtime",
    proof: [
      "requested": client.requested,
      "suggested_text_route": readiness?.suggestedTextRoute ?? "",
      "suggested_strong_route": readiness?.suggestedStrongRoute ?? "",
      "route_count": readiness?.routes.count ?? 0,
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "parity-route-readiness",
    screen: "parity",
    actionId: "desktop/parity/route-readiness",
    capabilityId: "desktop_provider_route_parity_readiness",
    evidenceRef: "swift://desktop/parity/route-readiness",
    source: "macos_operations_viewmodel_provider_doctor_runtime",
    proof: [
      "requested": client.requested,
      "routes": readiness?.routes.map(\.providerId) ?? [],
      "failover_blockers": readiness?.failovers.flatMap(\.blockers) ?? [],
    ])
}

@Test
@MainActor
func loadDetailCallsRunAndNeedsMeReadArms() async {
  let client = DetailReadClient()
  let vm = OperationsOverviewViewModel(client: client)
  await vm.loadDetail(.runReadback(runId: "run-desktop"))
  guard case let .loaded(runDetail) = vm.detailState else {
    Issue.record("expected run detail .loaded, got \(vm.detailState)")
    return
  }
  #expect(runDetail.title == "Run readback")
  #expect(runDetail.facts == [
    ReadProjectionDetailFact(id: "run-id", label: "run", value: "run-desktop"),
    ReadProjectionDetailFact(id: "state", label: "state", value: "complete"),
    ReadProjectionDetailFact(id: "loop", label: "loop", value: "complete"),
    ReadProjectionDetailFact(id: "events", label: "events", value: "7"),
    ReadProjectionDetailFact(id: "db-wide-tokens", label: "db tokens", value: "321"),
    ReadProjectionDetailFact(id: "prompt-tokens", label: "prompt", value: "120"),
    ReadProjectionDetailFact(id: "completion-tokens", label: "completion", value: "201"),
    ReadProjectionDetailFact(id: "total-tokens", label: "total", value: "321"),
    ReadProjectionDetailFact(id: "cost", label: "cost", value: "0.0456"),
    ReadProjectionDetailFact(id: "audit", label: "audit", value: "verified"),
  ])
  await vm.loadDetail(.activityNeedsMe(runId: "run-desktop"))

  #expect(client.requested == ["run:run-desktop", "needs-me:run-desktop"])
  guard case let .loaded(detail) = vm.detailState else {
    Issue.record("expected detail .loaded, got \(vm.detailState)")
    return
  }
  #expect(detail.title == "Needs-me activity")
  #expect(detail.refs.contains("proof://needs/run-desktop"))
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "token-ledger-run-readback",
    screen: "tokenLedger",
    actionId: "desktop/tokenLedger/run-readback",
    capabilityId: "desktop_token_ledger_run_readback",
    evidenceRef: "swift://desktop/tokenLedger/run-readback/run-desktop",
    source: "macos_operations_viewmodel_run_readback_runtime",
    proof: ["requested": client.requested])
}

@Test
@MainActor
func loadDetailCallsSessionAndRunFileReadArms() async {
  let client = DetailReadClient()
  let vm = OperationsOverviewViewModel(client: client)
  await vm.loadDetail(.sessionList)
  await vm.loadDetail(.sessionOpen(agentSessionId: "session-desktop"))
  await vm.loadDetail(.sessionLinkState(agentSessionId: "session-desktop"))
  await vm.loadDetail(.runFileView(runId: "run-desktop"))

  #expect(client.requested == [
    "sessions",
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
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "session-list",
    screen: "session",
    actionId: "desktop/session/list",
    capabilityId: "desktop_session_read_projection",
    evidenceRef: "swift://desktop/session/list",
    source: "macos_operations_viewmodel_detail_read_runtime",
    proof: ["requested": client.requested])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "session-open",
    screen: "session",
    actionId: "desktop/session/open",
    capabilityId: "desktop_session_read_projection",
    evidenceRef: "swift://desktop/session/open/session-desktop",
    source: "macos_operations_viewmodel_detail_read_runtime",
    proof: ["requested": client.requested])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "session-link",
    screen: "session",
    actionId: "desktop/session/link",
    capabilityId: "desktop_session_read_projection",
    evidenceRef: "swift://desktop/session/link/session-desktop",
    source: "macos_operations_viewmodel_detail_read_runtime",
    proof: ["requested": client.requested])
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
  #expect(write.lastIntake?.targetProviderOrAgent == nil)
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
func buildIntakeRequestCarriesRoutePreference() {
  let request = OperationsOverviewViewModel.buildIntakeRequest(
    intent: "use DeepSeek for the cheap first pass",
    owner: "admin-001",
    idFactory: { "fixed" },
    routePreference: .deepseek)

  #expect(request.lane == "deepseek")
  #expect(request.targetProviderOrAgent == "deepseek")
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
    answerBodies: [
      "run-bound-1":
        "I am still checking files before the final answer. FRIDAY_DESKTOP_PRODUCT_AUTO_FOLLOWUP_OK"
    ])
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
  #expect(write.dispatchedTasks[1].contains("task: produce the final owner-visible answer"))
  #expect(write.dispatchedTasks[1].contains("success = concise final synthesis"))
  #expect(write.dispatchedTasks[1].contains("constraints = read-only"))
  #expect(write.dispatchedTasks[1].contains("FRIDAY_DESKTOP_PRODUCT_AUTO_FOLLOWUP_OK"))
  #expect(!write.dispatchedTasks[1].contains("I am still checking files"))
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
    answerBodies: ["run-bound-1": "Readable desktop answer body"],
    activityNeedsMe: [
      "run-bound-1": activityNeedsMeJSON(
        runId: "run-bound-1",
        actionableKind: "approval_required",
        refId: "approval-nonce-1")
    ])
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
  #expect(vm.latestChatTurn == ChatTurnRefs(
    missionId: "mission-desktop-fixed",
    workItemId: "work-desktop-fixed",
    runIds: ["run-bound-1"]))
  #expect(vm.latestChatTurn?.receiptRefs == [
    ChatReceiptRef(label: "mission_id", ref: "mission-desktop-fixed"),
    ChatReceiptRef(label: "work_item_id", ref: "work-desktop-fixed"),
    ChatReceiptRef(label: "run_id", ref: "run-bound-1"),
  ])
  guard case let .loaded(items) = vm.chatReviewState else {
    Issue.record("expected loaded review state, got \(vm.chatReviewState)")
    return
  }
  #expect(items.map(\.kind).contains("approval_required"))
  #expect(items.map(\.refId).contains("approval-nonce-1"))
  let approval = items.first { $0.kind == "approval_required" }
  #expect(approval?.actionDigest == "digest-approval-nonce-1")
  #expect(approval?.signingSummary == "approval_required ready")
  #expect(approval?.receiptRefs == [
    ChatReceiptRef(label: "run_id", ref: "run-bound-1"),
    ChatReceiptRef(label: "approval_ref", ref: "approval-nonce-1"),
    ChatReceiptRef(label: "action_digest", ref: "digest-approval-nonce-1"),
    ChatReceiptRef(label: "deep_link", ref: "run/run-bound-1/approval/approval-nonce-1"),
  ])
}

@Test
func chatNeedsMeItemsParsesComputedPauseAndActionableRows() throws {
  let data = activityNeedsMeJSON(
    runId: "run-review",
    actionableKind: "memory_review",
    refId: "mem-review-1"
  ).data(using: .utf8)!
  let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]

  let items = OperationsOverviewViewModel.chatNeedsMeItems(from: raw, runId: "run-review")

  #expect(items.map(\.kind) == ["approval", "memory_review"])
  #expect(items.map(\.refId) == ["approval-pause-run-review", "mem-review-1"])
  #expect(items[0].actionDigest == "digest-pause-run-review")
  #expect(items[0].signingSummary == "paused on write_file")
  #expect(items[1].deepLink == "memory/session/mem-review-1")
}

@Test
func chatNeedsMeItemsParsesApprovalSigningRefsFromActionableRows() throws {
  let data = activityNeedsMeJSON(
    runId: "run-approval",
    actionableKind: "approval_required",
    refId: "approval-nonce-2"
  ).data(using: .utf8)!
  let raw = try JSONSerialization.jsonObject(with: data) as! [String: Any]

  let items = OperationsOverviewViewModel.chatNeedsMeItems(from: raw, runId: "run-approval")
  let approval = items.first { $0.kind == "approval_required" }

  #expect(approval?.runId == "run-approval")
  #expect(approval?.refId == "approval-nonce-2")
  #expect(approval?.actionDigest == "digest-approval-nonce-2")
  #expect(approval?.signingSummary == "approval_required ready")
}

@Test
@MainActor
func approveNeedsMeItemSignsRefsAndRelaysOpaqueBlob() async throws {
  let signer = MockOperatorApprovalSigner()
  signer.blob = Array("{\"decision\":\"approved\"}".utf8)
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let item = ChatNeedsMeItem(
    runId: "run-paused",
    kind: "approval_required",
    title: "approve write_file",
    refId: "approval-nonce-9",
    state: "pending",
    deepLink: nil,
    actionDigest: String(repeating: "a", count: 64),
    signingSummary: "write_file paused")
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: write,
    approvalSigner: signer,
    approvalResumeClient: write,
    nowMs: { 1_000 })

  await vm.approveNeedsMeItem(item)

  #expect(signer.lastRequest == OperatorApprovalSigningRequest(
    runId: "run-paused",
    approvalId: "approval-nonce-9",
    actionDigest: String(repeating: "a", count: 64),
    summary: "write_file paused",
    expiresAtMs: 301_000))
  #expect(write.lastResumeRunId == "run-paused")
  #expect(write.lastResumeBlob == Array("{\"decision\":\"approved\"}".utf8))
  guard case let .confirmed(summary, _, _) = vm.approvalRelayStates[item.id] else {
    Issue.record("expected approval relay .confirmed, got \(String(describing: vm.approvalRelayStates[item.id]))")
    return
  }
  #expect(summary.contains("mutation_completed"))
  #expect(summary.contains("audit://resume/1"))
  try writeDesktopActionEvidenceIfRequested(
    fileSuffix: "approval-approve",
    screen: "fridayChat",
    actionId: "check",
    capabilityId: "security_approval_bound_principal_gate_cat10_netnew",
    evidenceRef: "swift://desktop/approval/approve/run-paused/approval-nonce-9",
    source: "macos_operations_viewmodel_approval_approve_runtime",
    proof: [
      "run_id": item.runId,
      "approval_id": item.refId,
      "action_digest": item.actionDigest ?? "",
      "signed_blob_bytes": write.lastResumeBlob?.count ?? 0,
      "audit_ref": "audit://resume/1",
    ])
}

@Test
@MainActor
func approveNeedsMeItemWithoutSignerFailsClosedWithoutResume() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let item = ChatNeedsMeItem(
    runId: "run-paused",
    kind: "approval_required",
    title: "approve write_file",
    refId: "approval-nonce-9",
    state: "pending",
    deepLink: nil,
    actionDigest: String(repeating: "a", count: 64),
    signingSummary: "write_file paused")
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    approvalResumeClient: write)

  await vm.approveNeedsMeItem(item)

  guard case let .error(reason) = vm.approvalRelayStates[item.id] else {
    Issue.record("expected approval relay .error, got \(String(describing: vm.approvalRelayStates[item.id]))")
    return
  }
  #expect(reason.contains("not configured"))
  #expect(write.lastResumeRunId == nil)
}

@Test
@MainActor
func rejectNeedsMeApprovalUsesRunControlWithoutSigner() async throws {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let item = ChatNeedsMeItem(
    runId: "run-paused",
    kind: "approval_required",
    title: "reject write_file",
    refId: "approval-nonce-10",
    state: "pending",
    deepLink: nil,
    actionDigest: String(repeating: "b", count: 64),
    signingSummary: "write_file paused")
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    approvalResumeClient: write)

  await vm.rejectNeedsMeApproval(item)

  #expect(write.lastRejectRunId == "run-paused")
  #expect(write.lastRejectApprovalId == "approval-nonce-10")
  #expect(write.lastResumeRunId == nil)
  guard case let .confirmed(summary, _, _) = vm.approvalRelayStates[item.id] else {
    Issue.record("expected approval reject .confirmed, got \(String(describing: vm.approvalRelayStates[item.id]))")
    return
  }
  #expect(summary.contains("reject"))
  #expect(summary.contains("audit://reject/1"))
  try writeDesktopActionEvidenceIfRequested(
    fileSuffix: "approval-reject",
    screen: "fridayChat",
    actionId: "act",
    capabilityId: "security_approval_bound_principal_gate_cat10_netnew",
    evidenceRef: "swift://desktop/approval/reject/run-paused/approval-nonce-10",
    source: "macos_operations_viewmodel_approval_reject_runtime",
    proof: [
      "run_id": item.runId,
      "approval_id": item.refId,
      "rejected_run_id": write.lastRejectRunId ?? "",
      "rejected_approval_id": write.lastRejectApprovalId ?? "",
      "audit_ref": "audit://reject/1",
    ])
}

@Test
@MainActor
func cancelNeedsMeRunUsesRunControlReason() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let item = ChatNeedsMeItem(
    runId: "run-paused",
    kind: "approval_required",
    title: "cancel paused run",
    refId: "approval-nonce-11",
    state: "pending",
    deepLink: nil,
    actionDigest: nil,
    signingSummary: nil)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    approvalResumeClient: write)

  await vm.cancelNeedsMeRun(item)

  #expect(write.lastCancelRunId == "run-paused")
  #expect(write.lastCancelReason == "operator cancelled from desktop Needs Review")
  #expect(write.lastResumeRunId == nil)
  guard case let .confirmed(summary, _, _) = vm.approvalRelayStates[item.id] else {
    Issue.record("expected cancel .confirmed, got \(String(describing: vm.approvalRelayStates[item.id]))")
    return
  }
  #expect(summary.contains("cancel"))
  #expect(summary.contains("audit://cancel/1"))
}

@Test
@MainActor
func rejectNeedsMeApprovalWithoutRunControlFailsClosed() async {
  let item = ChatNeedsMeItem(
    runId: "run-paused",
    kind: "approval_required",
    title: "reject write_file",
    refId: "approval-nonce-12",
    state: "pending",
    deepLink: nil,
    actionDigest: nil,
    signingSummary: nil)
  let vm = OperationsOverviewViewModel(client: MockReadClient(behavior: .loaded))

  await vm.rejectNeedsMeApproval(item)

  guard case let .error(reason) = vm.approvalRelayStates[item.id] else {
    Issue.record("expected reject .error, got \(String(describing: vm.approvalRelayStates[item.id]))")
    return
  }
  #expect(reason.contains("not configured"))
}

@Test
@MainActor
func markNeedsMeItemDoneUsesRefIdAndRefreshesReview() async {
  let write = MockMissionSpineWriteClient(behavior: .activityDone)
  let item = ChatNeedsMeItem(
    runId: "run-review",
    kind: "review",
    title: "review ready",
    refId: "activity-review-1",
    state: "pending",
    deepLink: "friday://activity/activity-review-1")
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: write)

  await vm.markNeedsMeItemDone(item)

  #expect(write.lastActivityMarkDone == ActivityMarkDoneRequestWire(
    activityId: "activity-review-1",
    reason: "owner cleared needs-me row"))
  guard case let .confirmed(summary, _, _) = vm.activityMarkDoneStates[item.id] else {
    Issue.record("expected activity mark-done .confirmed, got \(String(describing: vm.activityMarkDoneStates[item.id]))")
    return
  }
  #expect(summary.contains("done"))
  #expect(summary.contains("activity-review-1"))
}

@Test
@MainActor
func retryWorkItemSendsLifecycleWriteAndRefreshes() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let item = MissionWorkbenchWorkItem(
    id: "work-stale-1",
    title: "Retry stale provider turn",
    state: .stale,
    owner: .fridayOwned,
    proofRef: nil,
    done: false,
    blockingReason: "failed retryable",
    recoveryKind: "retryable",
    canRetry: true,
    canCancel: true)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: write,
    writeOwnerPrincipal: "owner-desktop")

  await vm.retryWorkItem(item)

  #expect(write.lastWorkItemStatus == WorkItemStatusRequestWire(
    workItemId: "work-stale-1",
    targetStatus: "ready_to_dispatch",
    actorRef: "desktop:owner-desktop",
    reason: "operator retries WorkItem from desktop recovery surface"))
  guard case .confirmed(let summary, _, _) = vm.workItemStatusStates[item.id] else {
    Issue.record("expected retry .confirmed, got \(String(describing: vm.workItemStatusStates[item.id]))")
    return
  }
  #expect(summary.contains("ready_to_dispatch"))
  #expect(summary.contains("previous=failed_retryable"))
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "workflow-retry",
    screen: "workflow",
    additionalScreens: ["recovery"],
    actionId: "desktop/workflow/retry",
    capabilityId: "desktop_work_item_lifecycle_control",
    evidenceRef: "swift://desktop/workflow/retry/work-stale-1",
    source: "macos_operations_viewmodel_work_item_lifecycle_runtime",
    proof: [
      "work_item_id": write.lastWorkItemStatus?.workItemId ?? "",
      "target_status": write.lastWorkItemStatus?.targetStatus ?? "",
      "actor_ref": write.lastWorkItemStatus?.actorRef ?? "",
      "reason": write.lastWorkItemStatus?.reason ?? "",
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "recovery-retry",
    screen: "recovery",
    actionId: "desktop/recovery/retry",
    capabilityId: "desktop_recovery_lifecycle_control",
    evidenceRef: "swift://desktop/recovery/retry/work-stale-1",
    source: "macos_operations_viewmodel_work_item_lifecycle_runtime",
    proof: [
      "work_item_id": write.lastWorkItemStatus?.workItemId ?? "",
      "target_status": write.lastWorkItemStatus?.targetStatus ?? "",
    ])
}

@Test
@MainActor
func cancelWorkItemSendsLifecycleWriteAndRefreshes() async {
  let write = MockMissionSpineWriteClient(behavior: .intakeReady)
  let item = MissionWorkbenchWorkItem(
    id: "work-inflight-1",
    title: "Cancel in-flight provider turn",
    state: .providerAck,
    owner: .fridayOwned,
    proofRef: nil,
    done: false,
    blockingReason: "provider acknowledged",
    recoveryKind: "in_flight",
    canRetry: false,
    canCancel: true)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: write,
    writeOwnerPrincipal: "owner-desktop")

  await vm.cancelWorkItem(item)

  #expect(write.lastWorkItemStatus == WorkItemStatusRequestWire(
    workItemId: "work-inflight-1",
    targetStatus: "cancelled",
    actorRef: "desktop:owner-desktop",
    reason: "operator cancels WorkItem from desktop recovery surface"))
  guard case .confirmed(let summary, _, _) = vm.workItemStatusStates[item.id] else {
    Issue.record("expected cancel .confirmed, got \(String(describing: vm.workItemStatusStates[item.id]))")
    return
  }
  #expect(summary.contains("cancelled"))
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "workflow-cancel",
    screen: "workflow",
    additionalScreens: ["recovery"],
    actionId: "desktop/workflow/cancel",
    capabilityId: "desktop_work_item_lifecycle_control",
    evidenceRef: "swift://desktop/workflow/cancel/work-inflight-1",
    source: "macos_operations_viewmodel_work_item_lifecycle_runtime",
    proof: [
      "work_item_id": write.lastWorkItemStatus?.workItemId ?? "",
      "target_status": write.lastWorkItemStatus?.targetStatus ?? "",
      "actor_ref": write.lastWorkItemStatus?.actorRef ?? "",
      "reason": write.lastWorkItemStatus?.reason ?? "",
    ])
  try? writeDesktopActionEvidenceIfRequested(
    fileSuffix: "recovery-cancel",
    screen: "recovery",
    actionId: "desktop/recovery/cancel",
    capabilityId: "desktop_recovery_lifecycle_control",
    evidenceRef: "swift://desktop/recovery/cancel/work-inflight-1",
    source: "macos_operations_viewmodel_work_item_lifecycle_runtime",
    proof: [
      "work_item_id": write.lastWorkItemStatus?.workItemId ?? "",
      "target_status": write.lastWorkItemStatus?.targetStatus ?? "",
    ])
}

@Test
func operatorApprovalCLISignerRejectsMalformedDigestBeforeInvokingSigner() async {
  let signer = OperatorApprovalCLISigner(keyPath: "/tmp/not-read-in-this-test")
  do {
    _ = try await signer.signApproval(OperatorApprovalSigningRequest(
      runId: "run-x",
      approvalId: "approval-x",
      actionDigest: "not-a-digest",
      summary: nil,
      expiresAtMs: 1_000))
    Issue.record("malformed digest must fail closed")
  } catch let error as OperatorApprovalSignerError {
    #expect(error.description.contains("action_digest"))
  } catch {
    Issue.record("unexpected error \(error)")
  }
}

@Test
func operatorApprovalCLISignerWritesRefsOnlyRequestAndRelaysOpaqueStdout() async throws {
  let temp = try temporaryHome()
  defer { try? FileManager.default.removeItem(at: temp) }

  let capturedArgs = temp.appendingPathComponent("args.txt")
  let capturedRequest = temp.appendingPathComponent("request.json")
  let fakeSigner = temp.appendingPathComponent("friday-operator-approve")
  let fakeKey = temp.appendingPathComponent("operator-test.key")
  try Data("not-a-real-key\n".utf8).write(to: fakeKey)
  let signedApproval = #"{"truth_label":"fake_cli_signed_approval","signature":"opaque"}"#
  let script = """
    #!/bin/sh
    set -eu
    printf '%s\\n' "$@" > '\(capturedArgs.path)'
    test "$1" = "sign"
    test "$2" = "--key"
    test "$3" = "\(fakeKey.path)"
    test "$4" = "--request"
    test -f "$5"
    cat "$5" > '\(capturedRequest.path)'
    printf '%s' '\(signedApproval)'
    """
  try script.write(to: fakeSigner, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes(
    [.posixPermissions: NSNumber(value: Int16(0o700))],
    ofItemAtPath: fakeSigner.path)

  let signer = OperatorApprovalCLISigner(
    executablePath: fakeSigner.path,
    keyPath: fakeKey.path,
    tempDirectory: temp)
  let blob = try await signer.signApproval(OperatorApprovalSigningRequest(
    runId: "run-paused-bridge",
    approvalId: "approval-bridge-1",
    actionDigest: String(repeating: "b", count: 64),
    summary: "write_file paused",
    expiresAtMs: 1_900_000_000_000))

  #expect(String(decoding: blob, as: UTF8.self) == signedApproval)

  let requestData = try Data(contentsOf: capturedRequest)
  let requestText = String(decoding: requestData, as: UTF8.self)
  let request = try JSONDecoder().decode(ApprovalRequestFileMirror.self, from: requestData)
  #expect(request.approvalId == "approval-bridge-1")
  #expect(request.actionDigest == String(repeating: "b", count: 64))
  #expect(request.expiresAt == 1_900_000_000_000)
  #expect(request.decision == "approved")
  #expect(request.surface == "desktop")
  #expect(request.summary == "write_file paused")
  #expect(!requestText.contains("run-paused-bridge"))
  #expect(!requestText.contains("private"))
  #expect(!requestText.contains("body"))

  let args = try String(contentsOf: capturedArgs, encoding: .utf8)
    .split(separator: "\n")
    .map(String.init)
  #expect(args.count == 5)
  #expect(args[0] == "sign")
  #expect(args[1] == "--key")
  #expect(args[2] == fakeKey.path)
  #expect(args[3] == "--request")
  #expect(!FileManager.default.fileExists(atPath: args[4]))
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
func decideMemoryConfirmRendersConfirmedRecallable() async throws {
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
  try writeDesktopActionEvidenceIfRequested(
    fileSuffix: "memory-confirm",
    screen: "fridayChat",
    additionalScreens: ["memory"],
    actionId: "check",
    capabilityId: "memory_review_no_silent_write_decide_candidate",
    evidenceRef: "swift://desktop/fridayChat/memory/confirm/cand-1/mem-1",
    source: "macos_operations_viewmodel_memory_confirm_runtime",
    proof: [
      "candidate_id": "cand-1",
      "memory_id": write.lastDecision?.memoryId ?? "",
      "owner_principal": write.lastDecision?.ownerPrincipal ?? "",
      "decision": write.lastDecision?.decision ?? "",
      "status": "confirmed",
      "recallable": true,
    ])
}

@Test
@MainActor
func decideMemoryRejectRendersRejectedNotRecallable() async throws {
  let write = MockMissionSpineWriteClient(behavior: .memoryConfirmed)
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded), writeClient: write, writeOwnerPrincipal: "admin-001")
  await vm.decideMemory(candidateId: "cand-2", memoryId: "mem-2", confirm: false)
  guard case let .confirmed(summary, _, _) = vm.memoryDecisionStates["cand-2"] else {
    Issue.record("expected .confirmed, got \(String(describing: vm.memoryDecisionStates["cand-2"]))")
    return
  }
  #expect(summary.contains("rejected"))
  #expect(summary.contains("recallable=false"))
  #expect(write.lastDecision?.decision == "reject")
  #expect(write.lastDecision?.ownerPrincipal == "admin-001")
  try writeDesktopActionEvidenceIfRequested(
    fileSuffix: "memory-reject",
    screen: "fridayChat",
    additionalScreens: ["memory"],
    actionId: "act",
    capabilityId: "memory_review_no_silent_write_decide_candidate",
    evidenceRef: "swift://desktop/fridayChat/memory/reject/cand-2/mem-2",
    source: "macos_operations_viewmodel_memory_reject_runtime",
    proof: [
      "candidate_id": "cand-2",
      "memory_id": write.lastDecision?.memoryId ?? "",
      "owner_principal": write.lastDecision?.ownerPrincipal ?? "",
      "decision": write.lastDecision?.decision ?? "",
      "status": "rejected",
      "recallable": false,
    ])
}

@Test
@MainActor
func decideMemoryBlockedRendersErrorNotConfirmed() async {
  // A stale or out-of-scope durable id still returns status:"blocked" and MUST render .error
  // rather than a fabricated confirm.
  let vm = OperationsOverviewViewModel(
    client: MockReadClient(behavior: .loaded),
    writeClient: MockMissionSpineWriteClient(behavior: .memoryBlocked))
  await vm.decideMemory(
    candidateId: "mem-stale", memoryId: "mem-stale", confirm: true)
  guard case let .error(reason) = vm.memoryDecisionStates["mem-stale"] else {
    Issue.record("a blocked decision must render .error, got \(String(describing: vm.memoryDecisionStates["mem-stale"]))")
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
