import Foundation
import Testing

@testable import FridayHubConsoleCore

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
  #expect(snapshot.transcriptSections.first?.events.first?.evidenceRefs.timelineRef != nil)
}
