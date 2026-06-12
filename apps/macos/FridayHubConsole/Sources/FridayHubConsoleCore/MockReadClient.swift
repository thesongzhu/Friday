import Foundation
import FridayRustClient

/// In-memory `FridayRustReadClient` used for SwiftUI previews and view-model truth-rule
/// tests, so the app builds + previews + `swift test` run without a live read-projection
/// server. The REAL path is `SealedWSReadClient` (see RealReadClientFactory).
///
/// The representative snapshot mirrors the Rust `mission_workbench_probe` fixture
/// and intentionally exercises every honest-rendering rule:
///  - a `completed_with_proof` + `friday_owned` + `done` item,
///  - a `provider_ack` + `linked_only` + NOT-done item (provider ack ≠ done),
///  - a `blocked` NO-GO row (non-actionable),
///  - non-empty `statusLabels` (`[.stale]`) so the honest status banner shows,
///  - capability states with `dispatchAllowed` true/false (status only, never wired).
public struct MockReadClient: FridayRustReadClient {
  public enum Behavior: Sendable {
    /// Return the representative loaded snapshot.
    case loaded
    /// Throw to exercise the honest "unavailable" path (default: hub 503).
    case unavailable(FridayRustReadClientError)
  }

  private let behavior: Behavior

  public init(behavior: Behavior = .loaded) {
    self.behavior = behavior
  }

  /// Conform to the unified `FridayRustReadClient` protocol: it returns the package's THIN
  /// refs-only wire snapshot (`FridayRustClient.WorkbenchSnapshot`). The mock encodes its rich
  /// `representativeSnapshot` to the camelCase contract JSON and wraps it as the wire snapshot
  /// (its `raw` then carries the full projection), so the view model's adapter re-decodes it
  /// back to the rich display model — exercising the SAME wire→display path the real client uses.
  public func fetchWorkbench() async throws -> FridayRustClient.WorkbenchSnapshot {
    switch behavior {
    case .loaded:
      return try MockReadClient.representativeWireSnapshot()
    case let .unavailable(error):
      throw error
    }
  }

  /// The rich representative snapshot, encoded to contract JSON and wrapped as the package's
  /// thin wire snapshot (so its `raw` carries the full projection for the adapter to re-decode).
  ///
  /// A throwing factory (not a stored `let`): the package's wire `WorkbenchSnapshot` carries an
  /// `[String: Any] raw` and is intentionally NOT `Sendable`, so it cannot be a global `let`.
  public static func representativeWireSnapshot() throws -> FridayRustClient.WorkbenchSnapshot {
    let json = try JSONEncoder().encode(representativeSnapshot)
    return try FridayRustClient.WorkbenchSnapshot(projectionJSON: json, generatedAtMs: 0)
  }

  /// Representative sample projection (refs are already-redacted `proof://` fingerprints,
  /// matching the Rust projection's redacted_ref output — never raw bodies).
  public static let representativeSnapshot: WorkbenchSnapshot = {
    let missionId = "mission_workbench_probe_20260605"
    let conversationId = "fconv_mission_workbench_probe"

    let workItems: [MissionWorkbenchWorkItem] = [
      // Provider-lane item: acknowledged by the provider but NOT done.
      MissionWorkbenchWorkItem(
        id: "work_probe_provider",
        title: "Mission-bound provider action",
        state: .providerAck,
        owner: .linkedOnly,
        proofRef: "proof://provider-receipt/3f9a1c2b7e004d18",
        done: false
      ),
      // Friday-owned item: completed and backed by a proof receipt.
      MissionWorkbenchWorkItem(
        id: "work_probe_done",
        title: "Completed only after proof receipt",
        state: .completedWithProof,
        owner: .fridayOwned,
        proofRef: "proof://work-item-proof/a1b2c3d4e5f60718",
        done: true
      ),
      // NO-GO / blocked row — surfaced as truth, never made executable.
      MissionWorkbenchWorkItem(
        id: "work_probe_blocked",
        title: "Provider login required before dispatch",
        state: .blocked,
        owner: .linkedOnly,
        proofRef: "proof://work-item-required/0c0ffee0deadbeef",
        done: false
      ),
      // Bounded timeline read appended by the projection — not completion.
      MissionWorkbenchWorkItem(
        id: "workbench_timeline_read_mission_workbench_probe_20260605",
        title: "Bounded Mission timeline read",
        state: .timelineRead,
        owner: .fridayOwned,
        proofRef: "proof://timeline-read/55aa55aa55aa55aa",
        done: false
      ),
    ]

    let capabilityStates: [MissionWorkbenchCapabilityState] = [
      MissionWorkbenchCapabilityState(
        id: "capability_mission_advisor",
        label: "Mission advisor",
        kind: .advisor,
        truthLabel: .fridayOwned,
        approvalState: .notRequired,
        dispatchAllowed: false,
        summary: "Advisor state is projected from Rust Hub route decisions; UI does not choose routes.",
        proofRef: "proof://route-decision/9988776655443322"
      ),
      MissionWorkbenchCapabilityState(
        id: "capability_skill_mission-advisor",
        label: "skill mission advisor",
        kind: .skill,
        truthLabel: .linkedOnly,
        approvalState: .required,
        dispatchAllowed: false,
        summary: "Capability availability is a Rust Hub projection and still follows canonical approval gates.",
        proofRef: "proof://capability-projection/1234abcd5678ef90"
      ),
      MissionWorkbenchCapabilityState(
        id: "capability_capability_proof-workbench",
        label: "capability proof workbench",
        kind: .capability,
        truthLabel: .fridayOwned,
        // dispatchAllowed == true is rendered as a status indicator ONLY.
        // The UI never wires an execute/dispatch button off this flag.
        approvalState: .approved,
        dispatchAllowed: true,
        summary: "Capability availability is a Rust Hub projection and still follows canonical approval gates.",
        proofRef: "proof://capability-projection/abcdef0123456789"
      ),
    ]

    let memoryCandidates: [MissionWorkbenchMemoryCandidate] = [
      MissionWorkbenchMemoryCandidate(
        id: "memory_candidate_mission_workbench_probe_20260605_0",
        preview: "Review-only memory candidate attached to this Mission.",
        state: "candidate_review_only",
        grantsMemoryAuthority: false,
        evidenceRef: "proof://memory-candidate/0fedcba987654321"
      )
    ]

    let providerReceiptRefs = [
      "proof://provider-receipt/3f9a1c2b7e004d18",
      "proof://provider-receipt/77ee66dd55cc44bb",
    ]
    let channelReceiptRefs = [
      "proof://channel-receipt/22334455667788aa"
    ]

    let missionSection = MissionTranscriptSection(
      id: "section_mission",
      title: "Mission projection",
      groupKind: .mission,
      missionId: missionId,
      workItemId: nil,
      truthLabel: .fridayOwned,
      status: .waiting,
      events: [
        MissionTranscriptEvent(
          id: "event_surface_projection_0",
          missionId: missionId,
          workItemId: nil,
          surface: .desktop,
          status: .waiting,
          truthLabel: .fridayOwned,
          summary: "desktop surface is attached to this Mission via a redacted surface thread projection.",
          proofRef: "proof://surface-thread/aa11bb22cc33dd44",
          evidenceRefs: MissionTranscriptEvidenceRefs(
            surfaceThreadRef: "proof://surface-thread/aa11bb22cc33dd44",
            timelineRef: "timeline://mission/mission_workbench_probe_20260605/surface-projection/0"
          ),
          capturedAt: "unix_ms:1780640000001"
        )
      ]
    )

    let providerSection = MissionTranscriptSection(
      id: "section_provider",
      title: "Provider session refs",
      groupKind: .providerSession,
      missionId: missionId,
      workItemId: nil,
      truthLabel: .fridayOwned,
      status: .providerAck,
      events: [
        MissionTranscriptEvent(
          id: "event_link_0",
          missionId: missionId,
          workItemId: "work_probe_provider",
          surface: .timeline,
          status: .providerAck,
          truthLabel: .linkedOnly,
          summary: "Provider evidence is represented as a redacted proof ref and is not completion.",
          proofRef: "proof://mission-link-proof/12ab34cd56ef7890",
          evidenceRefs: MissionTranscriptEvidenceRefs(
            providerRef: "proof://provider-session/aabbccdd11223344",
            timelineRef: "timeline://mission/mission_workbench_probe_20260605/provider-link/0",
            proofReceiptRef: "proof://provider-receipt/3f9a1c2b7e004d18"
          ),
          capturedAt: "unix_ms:1780640000009"
        )
      ]
    )

    let channelSection = MissionTranscriptSection(
      id: "section_channel",
      title: "Channel task refs",
      groupKind: .channelTask,
      missionId: missionId,
      workItemId: nil,
      truthLabel: .fridayOwned,
      status: .queued,
      events: [
        MissionTranscriptEvent(
          id: "event_link_1",
          missionId: missionId,
          workItemId: "work_probe_provider",
          surface: .telegram,
          status: .queued,
          truthLabel: .observedOnly,
          summary: "Channel receipt is redacted and attached to the Mission as evidence.",
          proofRef: nil,
          evidenceRefs: MissionTranscriptEvidenceRefs(
            channelRef: "proof://channel-receipt/22334455667788aa",
            timelineRef: "timeline://mission/mission_workbench_probe_20260605/channel-link/1",
            proofReceiptRef: "proof://channel-receipt/22334455667788aa"
          ),
          capturedAt: "unix_ms:1780640000010"
        )
      ]
    )

    let statusSection = MissionTranscriptSection(
      id: "section_status",
      title: "Status and timeline reads",
      groupKind: .status,
      missionId: missionId,
      workItemId: nil,
      truthLabel: .fridayOwned,
      status: .timelineRead,
      events: [
        MissionTranscriptEvent(
          id: "event_timeline_read_5",
          missionId: missionId,
          workItemId: "workbench_timeline_read_mission_workbench_probe_20260605",
          surface: .timeline,
          status: .timelineRead,
          truthLabel: .fridayOwned,
          summary: "This Workbench read is bounded and is not completion proof.",
          proofRef: "proof://timeline-read/55aa55aa55aa55aa",
          evidenceRefs: MissionTranscriptEvidenceRefs(
            workflowRef: "proof://timeline-read-workflow/66bb66bb66bb66bb",
            timelineRef: "timeline://mission/mission_workbench_probe_20260605/bounded-read"
          ),
          capturedAt: "unix_ms:0"
        )
      ]
    )

    let allEventRefs =
      missionSection.events.map(\.id)
      + providerSection.events.map(\.id)
      + channelSection.events.map(\.id)
      + statusSection.events.map(\.id)
    let split = max(allEventRefs.count, 2) / 2 + (max(allEventRefs.count, 2) % 2)

    return WorkbenchSnapshot(
      missionId: missionId,
      fridayConversationId: conversationId,
      runtimeFeedStatus: .liveRustHubProjection,
      // Honest status: the projection is flagged stale and must render as such.
      statusLabels: [.stale],
      duplicatePreflight: MissionWorkbenchDuplicatePreflight(
        status: "opens_existing_mission",
        duplicateMissionId: missionId,
        duplicateWorkItemId: "work_probe_provider"
      ),
      routeDecision: MissionWorkbenchRouteDecision(
        advisorSummary: "The Workbench must consume Rust Hub Mission truth.",
        selectedRoute: "proof://route-decision/9988776655443322",
        alternatives: ["route missing", "live Rust projection"],
        truthLabel: .fridayOwned
      ),
      providerReceiptRefs: providerReceiptRefs,
      channelReceiptRefs: channelReceiptRefs,
      workItems: workItems,
      timelinePages: [
        MissionWorkbenchTimelinePage(
          page: 1,
          cursor: "start",
          nextCursor: "offset:1",
          eventRefs: Array(allEventRefs.prefix(split))
        ),
        MissionWorkbenchTimelinePage(
          page: 2,
          cursor: "offset:1",
          nextCursor: nil,
          eventRefs: Array(allEventRefs.dropFirst(split))
        ),
      ],
      memoryCandidates: memoryCandidates,
      capabilityStates: capabilityStates,
      transcriptSections: [missionSection, providerSection, channelSection, statusSection]
    )
  }()
}
