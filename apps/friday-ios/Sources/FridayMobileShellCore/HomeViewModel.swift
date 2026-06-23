import Foundation
import FridayRustClient

/// **The Home (Status) read view model — wired to the REAL `SealedWSReadClient`.**
///
/// The Home surface reads the refs-only Mission Workbench projection over the sealed-WS READ
/// seam. It depends on the PACKAGE's `FridayRustReadClient` protocol + `WorkbenchSnapshot`
/// (the package's types WIN — there is ONE snapshot/protocol across desktop + mobile), and on
/// the real `SealedWSReadClient` in production (a mock behind a preview/debug flag).
///
/// ## The `: Sendable` reconciliation
/// The package's `FridayRustReadClient` is deliberately NOT `Sendable` (its `SealedWSReadClient`
/// is a `final class` driving an injected transport; its `WorkbenchSnapshot` carries a
/// `raw: [String: Any]` that is not `Sendable`). To consume it cleanly from this `@MainActor`
/// view model under Swift 6 strict concurrency, we do NOT force the non-`Sendable` client or
/// snapshot across an actor hop. Instead the client is created + driven ON the main actor (the
/// `async` `fetchWorkbench()` suspends without crossing an isolation boundary), and the view
/// model surfaces a small `Sendable` `HomeProjection` projection of the refs (NOT the raw
/// snapshot) for the UI/state. This keeps the package's types authoritative while giving the
/// UI a value type that is safe to publish. (This is the SAME adapter pattern the prior mobile
/// chat-S6 PR #683 used; the desktop #682 console is the D-PR1 mock shell and does NOT yet wire
/// the package, so #683's `HomeProjection` lift — not #682 — is the integration reference.)
///
/// ## Honest-unavailable (truth rule)
/// The Rust read-projection server is DARK until the slice-6 flip, so `fetchWorkbench()` is
/// EXPECTED to throw (offline / no enrolled peer). Every throw renders as a first-class
/// `.unavailable(reason:)` — NEVER a fabricated "ready" snapshot, NEVER a label upgrade. The
/// status truth label (`runtimeFeedStatus`) and any `statusLabels` ride AS-IS.

/// A `Sendable` refs-only projection of the Home read snapshot — the fields the Home surface
/// renders, lifted off the package's (non-`Sendable`) `WorkbenchSnapshot`. Refs/labels/counts
/// only (INV-5); never a body.
public struct HomeProjection: Sendable, Equatable {
  public let missionId: String
  public let fridayConversationId: String
  /// The runtime feed status TRUTH label (e.g. `live_rust_hub_projection`). Rides AS-IS.
  public let runtimeFeedStatus: String
  /// Status labels the projection surfaced (`stale`/`offline`/`error`). Rides AS-IS.
  public let statusLabels: [String]
  /// Optional owner-gated agent session ref for session-specific read arms.
  public let agentSessionId: String?
  public let routeDecisionSummary: String?
  /// Work-item id REFS (counts/ids only — never a body).
  public let workItemIds: [String]
  public let routeSelected: String?
  public let routeAlternatives: [String]
  public let providerReceiptRefs: [String]
  public let channelReceiptRefs: [String]
  public let workItems: [HomeWorkItem]
  public let memoryCandidates: [HomeMemoryCandidate]
  public let runOutcomeLearningCandidates: [HomeRunOutcomeLearningCandidate]
  public let capabilityStates: [HomeCapabilityState]
  public let transcriptEvents: [HomeTranscriptEvent]
  /// The Hub epoch-millis the snapshot was generated (lets the UI flag staleness).
  public let generatedAtMs: Int64

  public init(_ snapshot: WorkbenchSnapshot) {
    let raw = snapshot.raw
    let route = raw["routeDecision"] as? [String: Any]
    self.missionId = snapshot.missionId
    self.fridayConversationId = snapshot.fridayConversationId
    self.runtimeFeedStatus = snapshot.runtimeFeedStatus
    self.statusLabels = snapshot.statusLabels
    self.agentSessionId = Self.firstString(
      raw,
      ["agentSessionId", "agent_session_id", "fridaySessionId", "friday_session_id"])
      ?? Self.firstStringArray(raw, ["agentSessionIds", "agent_session_ids", "fridaySessionIds", "friday_session_ids"]).first
    self.routeDecisionSummary = snapshot.routeDecisionSummary
    self.workItemIds = snapshot.workItemIds
    self.routeSelected = route?["selectedRoute"] as? String
    self.routeAlternatives = route?["alternatives"] as? [String] ?? []
    self.providerReceiptRefs = raw["providerReceiptRefs"] as? [String] ?? []
    self.channelReceiptRefs = raw["channelReceiptRefs"] as? [String] ?? []
    self.workItems = Self.parseWorkItems(raw["workItems"])
    self.memoryCandidates = Self.parseMemoryCandidates(raw["memoryCandidates"])
    self.runOutcomeLearningCandidates = Self.parseRunOutcomeLearningCandidates(
      raw["runOutcomeLearningCandidates"])
    self.capabilityStates = Self.parseCapabilityStates(raw["capabilityStates"])
    self.transcriptEvents = Self.parseTranscriptEvents(raw["transcriptSections"])
    self.generatedAtMs = snapshot.generatedAtMs
  }

  public var needsMeCount: Int {
    workItems.filter { $0.needsAttention }.count
      + memoryCandidates.count
      + runOutcomeLearningCandidates.count
  }

  public var isLoadedEmpty: Bool {
    workItemIds.isEmpty
      && providerReceiptRefs.isEmpty
      && channelReceiptRefs.isEmpty
      && memoryCandidates.isEmpty
      && runOutcomeLearningCandidates.isEmpty
      && capabilityStates.isEmpty
      && transcriptEvents.isEmpty
  }

  private static func parseWorkItems(_ value: Any?) -> [HomeWorkItem] {
    guard let rows = value as? [[String: Any]] else { return [] }
    return rows.compactMap { row in
      let id = (row["workItemId"] as? String) ?? (row["id"] as? String)
      guard let id else { return nil }
      return HomeWorkItem(
        id: id,
        title: (row["title"] as? String) ?? id,
        state: (row["state"] as? String) ?? "unknown",
        owner: (row["owner"] as? String) ?? "unknown",
        proofRef: row["proofRef"] as? String,
        done: row["done"] as? Bool ?? false,
        blockingReason: (row["blockingReason"] as? String) ?? "",
        recoveryKind: (row["recoveryKind"] as? String) ?? "none",
        canRetry: row["canRetry"] as? Bool ?? false,
        canCancel: row["canCancel"] as? Bool ?? false)
    }
  }

  private static func parseMemoryCandidates(_ value: Any?) -> [HomeMemoryCandidate] {
    guard let rows = value as? [[String: Any]] else { return [] }
    return rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      return HomeMemoryCandidate(
        id: id,
        preview: (row["preview"] as? String) ?? id,
        state: (row["state"] as? String) ?? "candidate_review_only",
        grantsMemoryAuthority: row["grantsMemoryAuthority"] as? Bool ?? false,
        evidenceRef: (row["evidenceRef"] as? String) ?? "")
    }
  }

  private static func parseRunOutcomeLearningCandidates(_ value: Any?) -> [HomeRunOutcomeLearningCandidate] {
    guard let rows = value as? [[String: Any]] else { return [] }
    return rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      return HomeRunOutcomeLearningCandidate(
        id: id,
        runId: (row["runId"] as? String) ?? "",
        workItemId: (row["workItemId"] as? String) ?? "",
        kind: (row["kind"] as? String) ?? "unknown",
        state: (row["state"] as? String) ?? "unknown",
        summary: (row["summary"] as? String) ?? id,
        evidenceRef: (row["evidenceRef"] as? String) ?? "")
    }
  }

  private static func parseCapabilityStates(_ value: Any?) -> [HomeCapabilityState] {
    guard let rows = value as? [[String: Any]] else { return [] }
    return rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      return HomeCapabilityState(
        id: id,
        label: (row["label"] as? String) ?? id,
        kind: (row["kind"] as? String) ?? "unknown",
        truthLabel: (row["truthLabel"] as? String) ?? "unknown",
        approvalState: (row["approvalState"] as? String) ?? "unknown",
        dispatchAllowed: row["dispatchAllowed"] as? Bool ?? false,
        summary: (row["summary"] as? String) ?? "",
        proofRef: (row["proofRef"] as? String) ?? "")
    }
  }

  private static func parseTranscriptEvents(_ value: Any?) -> [HomeTranscriptEvent] {
    guard let sections = value as? [[String: Any]] else { return [] }
    return sections.flatMap { section -> [HomeTranscriptEvent] in
      let sectionTitle = (section["title"] as? String) ?? "Transcript"
      guard let events = section["events"] as? [[String: Any]] else { return [] }
      return events.compactMap { event in
        guard let id = event["id"] as? String else { return nil }
        return HomeTranscriptEvent(
          id: id,
          sectionTitle: sectionTitle,
          summary: (event["summary"] as? String) ?? id,
          status: (event["status"] as? String) ?? "unknown",
          truthLabel: (event["truthLabel"] as? String) ?? "unknown",
          proofRef: event["proofRef"] as? String,
          capturedAt: (event["capturedAt"] as? String) ?? "")
      }
    }
  }

  private static func firstString(_ raw: [String: Any], _ keys: [String]) -> String? {
    keys.lazy.compactMap { raw[$0] as? String }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty }
  }

  private static func firstStringArray(_ raw: [String: Any], _ keys: [String]) -> [String] {
    keys.lazy.compactMap { raw[$0] as? [String] }.first ?? []
  }
}

public struct HomeWorkItem: Sendable, Identifiable, Equatable {
  public let id: String
  public let title: String
  public let state: String
  public let owner: String
  public let proofRef: String?
  public let done: Bool
  public let blockingReason: String
  public let recoveryKind: String
  public let canRetry: Bool
  public let canCancel: Bool

  public var needsAttention: Bool {
    !done && (["blocked", "waiting", "error", "stale"].contains(state) || canRetry || canCancel)
  }
}

public struct HomeMemoryCandidate: Sendable, Identifiable, Equatable {
  public let id: String
  public let preview: String
  public let state: String
  public let grantsMemoryAuthority: Bool
  public let evidenceRef: String
}

public struct HomeRunOutcomeLearningCandidate: Sendable, Identifiable, Equatable {
  public let id: String
  public let runId: String
  public let workItemId: String
  public let kind: String
  public let state: String
  public let summary: String
  public let evidenceRef: String
}

public struct HomeCapabilityState: Sendable, Identifiable, Equatable {
  public let id: String
  public let label: String
  public let kind: String
  public let truthLabel: String
  public let approvalState: String
  public let dispatchAllowed: Bool
  public let summary: String
  public let proofRef: String
}

public struct HomeTranscriptEvent: Sendable, Identifiable, Equatable {
  public let id: String
  public let sectionTitle: String
  public let summary: String
  public let status: String
  public let truthLabel: String
  public let proofRef: String?
  public let capturedAt: String
}

/// The loadable state of the Home read surface. `.unavailable` is a FIRST-CLASS state — a
/// dark server / 503 / offline / stale throw renders here as honest "unavailable", never as a
/// fabricated ready projection.
public enum HomeLoadState: Sendable, Equatable {
  case idle
  case loading
  case loaded(HomeProjection)
  case unavailable(reason: String)

  public var projection: HomeProjection? {
    if case let .loaded(p) = self { return p }
    return nil
  }

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }

  /// `true` only when a real projection loaded — the UI's ONLY "online" signal. A dark/offline
  /// server can never make this true (honest-unavailable).
  public var isOnline: Bool {
    projection != nil
  }
}

public enum HomeReadDetailArm: Sendable, Equatable {
  case runReadback(runId: String)
  case providersDoctor(probe: String?)
  case sessionList
  case sessionOpen(agentSessionId: String)
  case sessionLinkState(agentSessionId: String)
  case runFileView(runId: String)
  case activityNeedsMe(runId: String)

  public var title: String {
    switch self {
    case .runReadback: return "Run readback"
    case .providersDoctor: return "Provider doctor"
    case .sessionList: return "Session list"
    case .sessionOpen: return "Session open"
    case .sessionLinkState: return "Session link state"
    case .runFileView: return "Run files"
    case .activityNeedsMe: return "Needs-me activity"
    }
  }
}

public struct HomeReadDetail: Sendable, Equatable {
  public let title: String
  public let generatedAtMs: Int64
  public let summary: String
  public let refs: [String]
  public let providerReadiness: HomeProviderReadinessDetail?

  public init(title: String, snapshot: ReadProjectionSnapshot) {
    let raw = snapshot.raw
    self.title = title
    self.generatedAtMs = snapshot.generatedAtMs
    self.summary = Self.summary(from: raw)
    self.refs = Self.refs(from: raw)
    self.providerReadiness = HomeProviderReadinessDetail(raw: raw)
  }

  private static func summary(from raw: [String: Any]) -> String {
    let parts = [
      firstString(raw, ["missionId", "mission_id"]).map { "mission=\($0)" },
      firstString(raw, ["runId", "run_id"]).map { "run=\($0)" },
      firstString(raw, ["status", "outcome"]).map { "status=\($0)" },
      firstString(raw, ["truthLabel", "truth_label"]).map { "truth=\($0)" },
    ].compactMap { $0 }
    return parts.isEmpty ? "projection loaded" : parts.joined(separator: " | ")
  }

  private static func refs(from raw: [String: Any]) -> [String] {
    let keys = [
      "proofRef", "proof_ref", "evidenceRef", "evidence_ref", "providerRef", "provider_ref",
      "channelRef", "channel_ref", "timelineRef", "timeline_ref", "receiptRef", "receipt_ref",
    ]
    var refs = keys.compactMap { raw[$0] as? String }
    for key in ["proofRefs", "proof_refs", "evidenceRefs", "evidence_refs", "receiptRefs", "receipt_refs"] {
      refs.append(contentsOf: raw[key] as? [String] ?? [])
    }
    var seen = Set<String>()
    return refs.filter { !$0.isEmpty && seen.insert($0).inserted }
  }

  private static func firstString(_ raw: [String: Any], _ keys: [String]) -> String? {
    keys.lazy.compactMap { raw[$0] as? String }.first
  }
}

public struct HomeProviderReadinessDetail: Sendable, Equatable {
  public let truthLabel: String
  public let proofOnly: Bool
  public let ok: Bool
  public let detected: [HomeProviderAuthReadiness]
  public let routes: [HomeProviderRouteReadiness]
  public let failovers: [HomeProviderFailoverReadiness]
  public let readyProviders: [String]
  public let anyAuthenticated: Bool
  public let allAuthenticated: Bool
  public let suggestedTextRoute: String?
  public let suggestedStrongRoute: String?
  public let keyValidationProbed: Bool?

  init?(raw: [String: Any]) {
    let truthLabel = Self.firstString(raw, ["truth_label", "truthLabel"]) ?? "unknown"
    guard truthLabel == "rust_providers_detect" || truthLabel == "rust_capability_doctor" else {
      return nil
    }
    let rows = Self.firstRows(raw, ["detected", "cli_detected", "cliDetected"])
    self.truthLabel = truthLabel
    self.proofOnly = Self.firstBool(raw, ["proof_only", "proofOnly"]) ?? true
    self.ok = Self.firstBool(raw, ["ok"]) ?? false
    self.detected = rows.map(HomeProviderAuthReadiness.init(raw:))
    self.routes = Self.firstRows(raw, ["route_readiness", "routeReadiness"])
      .map(HomeProviderRouteReadiness.init(raw:))
    self.failovers = Self.firstRows(raw, ["failover_readiness", "failoverReadiness"])
      .map(HomeProviderFailoverReadiness.init(raw:))
    self.readyProviders = Self.firstStringArray(
      raw, ["ready_providers", "readyProviders", "cli_logged_in", "cliLoggedIn"])
    self.anyAuthenticated = Self.firstBool(raw, ["any_authenticated", "anyAuthenticated"])
      ?? self.detected.contains { $0.authenticated }
    self.allAuthenticated = Self.firstBool(raw, ["all_authenticated", "allAuthenticated"])
      ?? (!self.detected.isEmpty && self.detected.allSatisfy { $0.authenticated })
    self.suggestedTextRoute = Self.firstString(raw, ["suggested_text_route", "suggestedTextRoute"])
    self.suggestedStrongRoute = Self.firstString(raw, ["suggested_strong_route", "suggestedStrongRoute"])
    self.keyValidationProbed = Self.firstBool(raw, ["key_validation_probed", "keyValidationProbed"])
  }

  private static func firstString(_ raw: [String: Any], _ keys: [String]) -> String? {
    keys.lazy.compactMap { raw[$0] as? String }.first
  }

  private static func firstStringArray(_ raw: [String: Any], _ keys: [String]) -> [String] {
    keys.lazy.compactMap { raw[$0] as? [String] }.first ?? []
  }

  private static func firstBool(_ raw: [String: Any], _ keys: [String]) -> Bool? {
    keys.lazy.compactMap { raw[$0] as? Bool }.first
  }

  private static func firstRows(_ raw: [String: Any], _ keys: [String]) -> [[String: Any]] {
    keys.lazy.compactMap { raw[$0] as? [[String: Any]] }.first ?? []
  }
}

public struct HomeProviderAuthReadiness: Sendable, Equatable, Identifiable {
  public let provider: String
  public let installed: Bool
  public let authenticated: Bool
  public let detail: String
  public let truthLabel: String

  public var id: String { provider }

  init(raw: [String: Any]) {
    self.provider = raw["provider"] as? String ?? "unknown"
    self.installed = raw["installed"] as? Bool ?? false
    self.authenticated = raw["authenticated"] as? Bool ?? false
    self.detail = raw["detail"] as? String ?? "unknown"
    self.truthLabel = raw["truthLabel"] as? String ?? "linked_only"
  }
}

public struct HomeProviderRouteReadiness: Sendable, Equatable, Identifiable {
  public let providerId: String
  public let model: String
  public let modelSize: String
  public let strength: String
  public let dispatchable: Bool
  public let blockers: [String]

  public var id: String { providerId }

  init(raw: [String: Any]) {
    self.providerId = raw["provider_id"] as? String ?? raw["providerId"] as? String ?? "unknown"
    self.model = raw["model"] as? String ?? "unknown"
    self.modelSize = raw["model_size"] as? String ?? raw["modelSize"] as? String ?? "unknown"
    self.strength = raw["strength"] as? String ?? "unknown"
    self.dispatchable = raw["dispatchable"] as? Bool ?? false
    self.blockers = Self.blockerCodes(raw["blockers"])
  }

  static func blockerCodes(_ value: Any?) -> [String] {
    guard let rows = value as? [[String: Any]] else { return [] }
    return rows.compactMap { $0["code"] as? String }.filter { !$0.isEmpty }
  }
}

public struct HomeProviderFailoverReadiness: Sendable, Equatable, Identifiable {
  public let direction: String
  public let flagEnabled: Bool
  public let canEnable: Bool
  public let blockers: [String]

  public var id: String { direction }

  init(raw: [String: Any]) {
    self.direction = raw["direction"] as? String ?? "unknown"
    self.flagEnabled = raw["flag_enabled"] as? Bool ?? raw["flagEnabled"] as? Bool ?? false
    self.canEnable = raw["can_enable"] as? Bool ?? raw["canEnable"] as? Bool ?? false
    self.blockers = HomeProviderRouteReadiness.blockerCodes(raw["blockers"])
  }
}

public enum HomeReadDetailState: Sendable, Equatable {
  case idle
  case loading(HomeReadDetailArm)
  case loaded(HomeReadDetail)
  case unavailable(title: String, reason: String)

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }
}

public enum HomeLearningDecisionState: Sendable, Equatable {
  case sent
  case confirmed(summary: String)
  case error(reason: String)

  public var isSent: Bool {
    if case .sent = self { return true }
    return false
  }

  public var isTerminal: Bool {
    switch self {
    case .confirmed, .error: return true
    case .sent: return false
    }
  }
}

public enum MobilePairingAttemptMode: String, Sendable, Equatable {
  case idle
  case sending
  case accepted
  case denied
  case unavailable
}

public struct MobilePairingAttempt: Sendable, Equatable {
  public let mode: MobilePairingAttemptMode
  public let pairingId: String?
  public let hubId: String?
  public let errorCode: String?
  public let reason: String

  public static let idle = MobilePairingAttempt(
    mode: .idle,
    pairingId: nil,
    hubId: nil,
    errorCode: nil,
    reason: "No PairAck has been received.")

  public static func sending(_ projection: FridayPairingManifestProjection?) -> MobilePairingAttempt {
    MobilePairingAttempt(
      mode: .sending,
      pairingId: projection?.pairingId,
      hubId: projection?.hubId,
      errorCode: nil,
      reason: "Pair request sent; waiting for Hub PairAck.")
  }

  public static func accepted(_ projection: FridayPairingManifestProjection?) -> MobilePairingAttempt {
    MobilePairingAttempt(
      mode: .accepted,
      pairingId: projection?.pairingId,
      hubId: projection?.hubId,
      errorCode: nil,
      reason: "Hub returned PairAck accepted. Trust grant/passport and write authority still require their own governed gates.")
  }

  public static func denied(
    _ projection: FridayPairingManifestProjection?,
    code: FridayErrorCode?
  ) -> MobilePairingAttempt {
    MobilePairingAttempt(
      mode: .denied,
      pairingId: projection?.pairingId,
      hubId: projection?.hubId,
      errorCode: code?.rawValue,
      reason: "Hub returned PairAck denied.")
  }

  public static func unavailable(
    _ projection: FridayPairingManifestProjection?,
    reason: String
  ) -> MobilePairingAttempt {
    MobilePairingAttempt(
      mode: .unavailable,
      pairingId: projection?.pairingId,
      hubId: projection?.hubId,
      errorCode: nil,
      reason: reason)
  }
}

@MainActor
public final class HomeViewModel: ObservableObject {
  @Published public private(set) var state: HomeLoadState = .idle
  @Published public private(set) var detailState: HomeReadDetailState = .idle
  @Published public private(set) var memoryDecisionStates: [String: HomeLearningDecisionState] = [:]
  @Published public private(set) var runOutcomeLearningDecisionStates: [String: HomeLearningDecisionState] = [:]
  @Published public private(set) var activityMarkDoneStates: [String: HomeLearningDecisionState] = [:]
  @Published public private(set) var pairingPreflight: MobilePairingPreflight = .empty
  @Published public private(set) var pairingAttempt: MobilePairingAttempt = .idle

  public let devicePairing: DevicePairingReadiness

  /// The package's read protocol is `Sendable`; the view model still publishes only small
  /// refs-only value projections, never the package snapshot's raw body map.
  private let client: FridayRustReadClient
  private let writeClient: FridayMissionSpineWriteClient?
  private let writeOwnerPrincipal: String
  private let makePairingClient: (DeviceKeypair) -> FridayPairingClient?

  /// - Parameter client: the read client. In production this is the real `SealedWSReadClient`
  ///   (built by `FridayClientFactory.makeReadClient`); a preview/debug build injects a mock.
  public init(
    client: FridayRustReadClient,
    writeClient: FridayMissionSpineWriteClient? = nil,
    writeOwnerPrincipal: String = liveAgentRunOwnerPrincipal,
    devicePairing: DevicePairingReadiness = .evaluate(
      deviceKeypairRequested: false,
      readLiveRequested: false,
      writeLiveRequested: false),
    makePairingClient: @escaping (DeviceKeypair) -> FridayPairingClient? = { _ in nil }
  ) {
    self.client = client
    self.writeClient = writeClient
    self.writeOwnerPrincipal = writeOwnerPrincipal
    self.devicePairing = devicePairing
    self.makePairingClient = makePairingClient
  }

  /// Whether the Home is online — derived from the load state (ONLY a real loaded projection is
  /// online). Convenience for the SwiftUI surface.
  public var isOnline: Bool { state.isOnline }

  /// Re-fetch the Home read projection over the sealed-WS read seam. The only action — and it
  /// only RE-READS truth; it never writes. A throw renders AS truth (honest-unavailable).
  public func refresh() async {
    state = .loading
    do {
      let snapshot = try await client.fetchWorkbench()
      state = .loaded(HomeProjection(snapshot))
    } catch {
      state = .unavailable(reason: Self.reason(for: error))
    }
  }

  public func loadDetail(_ arm: HomeReadDetailArm) async {
    detailState = .loading(arm)
    do {
      let snapshot = try await readDetail(arm)
      detailState = .loaded(HomeReadDetail(title: arm.title, snapshot: snapshot))
    } catch {
      detailState = .unavailable(title: arm.title, reason: Self.reason(for: error))
    }
  }

  public func decideMemory(candidateId: String, confirm: Bool) async {
    guard let writeClient else {
      memoryDecisionStates[candidateId] = .error(reason: "Write seam not configured.")
      return
    }
    memoryDecisionStates[candidateId] = .sent
    let request = MemoryDecisionRequestWire(
      memoryId: candidateId,
      ownerPrincipal: writeOwnerPrincipal,
      decision: confirm ? "confirm" : "reject")
    do {
      let result = try await writeClient.submitMemoryDecision(request)
      switch result.status {
      case "confirmed", "rejected":
        memoryDecisionStates[candidateId] = .confirmed(
          summary: "\(result.status) · state=\(result.state) · recallable=\(result.recallable)")
        await refresh()
      default:
        let why = result.blocker ?? "blocked"
        memoryDecisionStates[candidateId] = .error(reason: "Memory decision blocked — \(why)")
      }
    } catch {
      memoryDecisionStates[candidateId] = .error(reason: Self.reason(for: error))
    }
  }

  public func decideRunOutcomeLearning(candidateId: String, confirm: Bool) async {
    guard let writeClient else {
      runOutcomeLearningDecisionStates[candidateId] = .error(reason: "Write seam not configured.")
      return
    }
    runOutcomeLearningDecisionStates[candidateId] = .sent
    let request = RunOutcomeLearningDecisionRequestWire(
      candidateId: candidateId,
      decision: confirm ? "confirm" : "reject")
    do {
      let result = try await writeClient.submitRunOutcomeLearningDecision(request)
      switch result.status {
      case "confirmed", "rejected":
        let kind = result.kind ?? "unknown"
        runOutcomeLearningDecisionStates[candidateId] = .confirmed(
          summary: "\(result.status) · state=\(result.state) · kind=\(kind)")
        await refresh()
      default:
        let why = result.blocker ?? "blocked"
        runOutcomeLearningDecisionStates[candidateId] = .error(
          reason: "Learning decision blocked — \(why)")
      }
    } catch {
      runOutcomeLearningDecisionStates[candidateId] = .error(reason: Self.reason(for: error))
    }
  }

  public func markActivityDone(activityId: String) async {
    guard let writeClient else {
      activityMarkDoneStates[activityId] = .error(reason: "Write seam not configured.")
      return
    }
    activityMarkDoneStates[activityId] = .sent
    do {
      let result = try await writeClient.submitActivityMarkDone(
        ActivityMarkDoneRequestWire(activityId: activityId, reason: "owner cleared activity"))
      if result.status == "done" {
        activityMarkDoneStates[activityId] = .confirmed(summary: "done · activity_id=\(result.activityId)")
        await refresh()
      } else {
        let why = result.blocker ?? "blocked"
        activityMarkDoneStates[activityId] = .error(reason: "Activity mark done blocked — \(why)")
      }
    } catch {
      activityMarkDoneStates[activityId] = .error(reason: Self.reason(for: error))
    }
  }

  public func preflightPairingQR(
    _ qrPayload: String,
    nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
    backend: DeviceKeypairBackend = KeychainDeviceKeypairBackend()
  ) {
    pairingPreflight = MobilePairingPreflight.evaluate(
      qrPayload: qrPayload,
      nowMs: nowMs,
      backend: backend)
  }

  public func clearPairingPreflight() {
    pairingPreflight = .empty
    pairingAttempt = .idle
  }

  public func pairScannedQR(
    _ qrPayload: String,
    deviceId: String = "",
    nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
    backend: DeviceKeypairBackend = KeychainDeviceKeypairBackend()
  ) async {
    let payload = qrPayload.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !payload.isEmpty else {
      pairingPreflight = .empty
      pairingAttempt = .idle
      return
    }

    let manifest: FridayPairingManifest
    do {
      manifest = try JSONDecoder().decode(FridayPairingManifest.self, from: Data(payload.utf8))
      try manifest.validate(nowMs: nowMs)
    } catch {
      pairingPreflight = MobilePairingPreflight.evaluate(
        qrPayload: payload,
        nowMs: nowMs,
        backend: backend)
      pairingAttempt = .unavailable(pairingPreflight.projection, reason: Self.pairingReason(for: error))
      return
    }

    let device: DeviceKeypair
    do {
      device = try DeviceKeypairStore.loadOrGenerate(backend: backend)
      _ = try manifest.pairingProof(forDevicePublicKey: device.keypair.publicKey)
    } catch {
      pairingPreflight = MobilePairingPreflight.evaluate(
        qrPayload: payload,
        nowMs: nowMs,
        backend: backend)
      pairingAttempt = .unavailable(
        manifest.redactedProjection,
        reason: "Device keypair store is unavailable.")
      return
    }

    pairingPreflight = MobilePairingPreflight(
      mode: .ready,
      projection: manifest.redactedProjection,
      devicePublicKeyHex: device.publicKeyHex,
      proofReady: true,
      reason: "Pairing QR is valid and this device key is ready.",
      nextStep: "Pair request is bound to this device key; connected state requires PairAck.")

    guard let pairingClient = makePairingClient(device) else {
      pairingAttempt = .unavailable(
        manifest.redactedProjection,
        reason: "Pairing channel is not configured for this launch.")
      return
    }

    let resolvedDeviceId = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    let finalDeviceId = resolvedDeviceId.isEmpty
      ? "ios-\(device.publicKeyHex.prefix(12))"
      : resolvedDeviceId
    pairingAttempt = .sending(manifest.redactedProjection)
    do {
      let ack = try await pairingClient.pairDevice(manifest: manifest, deviceId: finalDeviceId)
      if ack.accepted {
        pairingAttempt = .accepted(manifest.redactedProjection)
        await refresh()
      } else {
        pairingAttempt = .denied(manifest.redactedProjection, code: ack.errorCode)
      }
    } catch {
      pairingAttempt = .unavailable(manifest.redactedProjection, reason: Self.pairingReason(for: error))
    }
  }

  private func readDetail(_ arm: HomeReadDetailArm) async throws -> ReadProjectionSnapshot {
    switch arm {
    case let .runReadback(runId):
      return try await client.fetchRunReadback(runId: runId)
    case .providersDoctor:
      return try await client.fetchCapabilityDoctor(validateKeys: true)
    case .sessionList:
      return try await client.fetchSessionList()
    case let .sessionOpen(agentSessionId):
      return try await client.fetchSessionOpen(agentSessionId: agentSessionId)
    case let .sessionLinkState(agentSessionId):
      return try await client.fetchSessionLinkState(agentSessionId: agentSessionId)
    case let .runFileView(runId):
      return try await client.fetchRunFileView(runId: runId)
    case let .activityNeedsMe(runId):
      return try await client.fetchActivityNeedsMe(runId: runId)
    }
  }

  /// Map a thrown error to an honest, body-free reason string. The Rust read seam ends a
  /// session fail-closed on any auth/availability failure, surfaced as a `transport`/server
  /// error here.
  static func reason(for error: Error) -> String {
    if let e = error as? FridayReadClientError {
      switch e {
      case .badServerPubkey, .badSessionNonce:
        return "Friday could not establish a trusted connection"
      case let .serverError(code, message):
        return "Friday is unavailable (\(code.rawValue)) — \(message)"
      case let .unexpectedResponse(kind):
        return "Friday returned an unexpected response (\(kind))"
      case let .malformedProjection(why):
        return "Status unavailable — \(why)"
      case let .transport(why):
        return "Friday is offline — \(why)"
      }
    }
    return "Friday is unavailable — \(error)"
  }

  static func pairingReason(for error: Error) -> String {
    if let e = error as? FridayPairingManifestError {
      switch e {
      case .expired:
        return "Pairing QR has expired."
      case .unsupportedKind, .badHubPublicKey, .missingWebSocketEndpoint:
        return "Pairing QR cannot be trusted."
      }
    }
    if let e = error as? FridayPairingClientError {
      switch e {
      case .badServerPubkey, .badSessionNonce, .serverPubkeyMismatch:
        return "Friday could not establish a trusted pairing connection."
      case let .serverError(code, message):
        return "Pairing unavailable (\(code.rawValue)) — \(message)"
      case let .unexpectedResponse(kind):
        return "Pairing returned an unexpected response (\(kind))."
      case let .transport(why):
        return "Pairing channel is offline — \(why)"
      }
    }
    return "Pairing unavailable — \(error)"
  }
}

// MARK: - HonestlyUnavailableReadClient (the no-key, no-network DEFAULT)

/// A `FridayRustReadClient` that ALWAYS throws — so the Home renders honest "unavailable".
///
/// This is the iOS app's DEFAULT read client (see `FridaySession`). It is the
/// SINGLE-PEER-TRAP-safe default: it mints NO X25519 keypair, opens NO socket, and touches NO
/// SecureStore — so the simulator render can never accidentally generate a fresh peer key or
/// connect to the live read-projection server. It can never fabricate readiness; every fetch is
/// the honest dark-server state (the EXPECTED state while the Rust servers are dark / slice-6 is
/// un-flipped). The master-derived live read path is the slice-6 deferred AC (mirrors the desktop
/// `RealReadClientFactory.makeLive` / `MasterKeyPeer` derivation — NOT wired on the phone, which
/// has no master key; that is the J2 pairing problem, deferred).
public struct HonestlyUnavailableReadClient: FridayRustReadClient {
  private let reason: String
  public init(reason: String = "live connection is not set up yet") {
    self.reason = reason
  }
  public func fetchWorkbench() async throws -> WorkbenchSnapshot {
    throw FridayReadClientError.transport(reason)
  }
}

// MARK: - PreviewReadClient (PREVIEW / DEBUG ONLY — clearly labeled)

/// **A PREVIEW/DEBUG-ONLY read client returning a static sample projection.** Used behind a
/// preview/debug flag so SwiftUI previews + UI iteration render a populated Home WITHOUT a live
/// Hub. NOT used in a real build (production wires the real `SealedWSReadClient`). The sample is
/// refs-only (INV-5) and its truth label says `preview_sample` so it can NEVER be mistaken for a
/// live projection. Optionally throws to preview the honest-unavailable state.
public struct PreviewReadClient: FridayRustReadClient {
  private let failure: FridayReadClientError?
  public init(failure: FridayReadClientError? = nil) { self.failure = failure }

  public func fetchWorkbench() async throws -> WorkbenchSnapshot {
    if let failure { throw failure }
    let json = """
    {
      "missionId": "mission-preview",
      "fridayConversationId": "conv-preview",
      "runtimeFeedStatus": "preview_sample",
      "statusLabels": [],
      "routeDecision": {
        "advisorSummary": "route: deepseek (refs-only)",
        "selectedRoute": "deepseek",
        "alternatives": ["codex", "claude"],
        "truthLabel": "friday_owned"
      },
      "providerReceiptRefs": ["proof://provider/preview-1"],
      "channelReceiptRefs": ["proof://surface/mobile-preview-1"],
      "workItems": [
        {
          "workItemId": "wi-preview-1",
          "title": "Draft the Mission plan",
          "state": "ready",
          "owner": "friday_owned",
          "done": false
        },
        {
          "workItemId": "wi-preview-2",
          "title": "Waiting for governed approval",
          "state": "waiting",
          "owner": "linked_only",
          "proofRef": "proof://work-item/preview-2",
          "done": false
        }
      ],
      "memoryCandidates": [
        {
          "id": "cand-preview-1",
          "preview": "Remember the operator prefers concise status reports.",
          "state": "candidate_review_only",
          "grantsMemoryAuthority": false,
          "evidenceRef": "proof://memory/preview-1"
        }
      ],
      "runOutcomeLearningCandidates": [
        {
          "id": "learn-preview-1",
          "runId": "run-preview-1",
          "workItemId": "wi-preview-2",
          "kind": "preference",
          "state": "candidate",
          "summary": "DeepSeek handled the short planning leg well.",
          "evidenceRef": "proof://learning/preview-1"
        }
      ],
      "capabilityStates": [
        {
          "id": "cap-route",
          "label": "Route advisor",
          "kind": "advisor",
          "truthLabel": "friday_owned",
          "approvalState": "not_required",
          "dispatchAllowed": true,
          "summary": "Routes are advisory; execution still follows governed dispatch.",
          "proofRef": "proof://capability/route-preview"
        }
      ],
      "transcriptSections": [
        {
          "id": "sec-preview-1",
          "title": "Mission",
          "groupKind": "mission",
          "missionId": "mission-preview",
          "truthLabel": "friday_owned",
          "status": "ready",
          "events": [
            {
              "id": "evt-preview-1",
              "missionId": "mission-preview",
              "surface": "mobile",
              "status": "ready",
              "truthLabel": "friday_owned",
              "summary": "Mobile surface read the Mission projection.",
              "capturedAt": "2026-06-21T00:00:00Z"
            }
          ]
        }
      ]
    }
    """
    return try WorkbenchSnapshot(projectionJSON: Data(json.utf8),
                                 generatedAtMs: Int64(Date().timeIntervalSince1970 * 1000))
  }
}
