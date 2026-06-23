import Foundation

// MARK: - Workbench truth model
//
// This is a faithful Swift mirror of the Rust Hub Mission Workbench projection
// and the TypeScript `MissionWorkbenchSnapshot` contract
// (ui/src/lib/mission-workbench/mission-workbench-contract.ts +
//  rust-core/crates/friday-hub/src/bin/mission_workbench_projection.rs).
//
// The real read client (a separate `FridayRustClient` package) will Codable-decode
// the exact same camelCase JSON into these types. Field names + the string-union
// raw values MUST stay in lockstep with that contract.
//
// TRUTH RULES baked into this model:
//  - Refs only: we carry `proofRef` / evidence ref strings / `eventRefs`, never
//    inline bodies. There is intentionally no body/content field anywhere.
//  - truth_status is never upgraded by the UI. Unknown enum values decode to an
//    explicit `.unknown` case that renders as an honest "unavailable" chip — they
//    are never silently mapped to a ready/owned/done-looking default.

public enum MissionTruthLabel: String, Codable, Sendable, Equatable {
  case fridayOwned = "friday_owned"
  case fridayAdopted = "friday_adopted"
  case observedOnly = "observed_only"
  case linkedOnly = "linked_only"
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionTruthLabel(rawValue: raw) ?? .unknown
  }
}

public enum MissionSurfaceKind: String, Codable, Sendable, Equatable {
  case mobile
  case desktop
  case telegram
  case timeline
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionSurfaceKind(rawValue: raw) ?? .unknown
  }
}

public enum MissionLifecycleState: String, Codable, Sendable, Equatable {
  case ready
  case queued
  case providerAck = "provider_ack"
  case waiting
  case stale
  case reconnecting
  case timelineRead = "timeline_read"
  case completedWithProof = "completed_with_proof"
  case blocked
  case error
  // Truth guard: an unrecognized lifecycle state must degrade to an honest
  // "unavailable", never to a ready/done-looking default.
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionLifecycleState(rawValue: raw) ?? .unknown
  }
}

public enum MissionWorkbenchRuntimeFeedStatus: String, Codable, Sendable, Equatable {
  case liveRustHubProjection = "live_rust_hub_projection"
  case pendingRustHubProjection = "pending_rust_hub_projection"
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionWorkbenchRuntimeFeedStatus(rawValue: raw) ?? .unknown
  }
}

/// Honest status-banner labels surfaced AS truth (never suppressed by the UI).
public enum MissionWorkbenchStatusLabel: String, Codable, Sendable, Equatable {
  case stale
  case offline
  case error
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionWorkbenchStatusLabel(rawValue: raw) ?? .unknown
  }
}

public enum MissionWorkbenchCapabilityKind: String, Codable, Sendable, Equatable {
  case skill
  case capability
  case advisor
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionWorkbenchCapabilityKind(rawValue: raw) ?? .unknown
  }
}

public enum MissionWorkbenchApprovalState: String, Codable, Sendable, Equatable {
  case notRequired = "not_required"
  case required
  case approved
  case blocked
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionWorkbenchApprovalState(rawValue: raw) ?? .unknown
  }
}

public enum MissionTranscriptGroupKind: String, Codable, Sendable, Equatable {
  case mission
  case workItem = "work_item"
  case providerSession = "provider_session"
  case skillRun = "skill_run"
  case channelTask = "channel_task"
  case workflow
  case surface
  case status
  case time
  case unknown

  public init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = MissionTranscriptGroupKind(rawValue: raw) ?? .unknown
  }
}

public struct MissionWorkbenchWorkItem: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let title: String
  public let state: MissionLifecycleState
  public let owner: MissionTruthLabel
  public let proofRef: String?
  public let done: Bool
  public let blockingReason: String
  public let recoveryKind: String
  public let canRetry: Bool
  public let canCancel: Bool

  public init(
    id: String,
    title: String,
    state: MissionLifecycleState,
    owner: MissionTruthLabel,
    proofRef: String?,
    done: Bool,
    blockingReason: String = "",
    recoveryKind: String = "none",
    canRetry: Bool = false,
    canCancel: Bool = false
  ) {
    self.id = id
    self.title = title
    self.state = state
    self.owner = owner
    self.proofRef = proofRef
    self.done = done
    self.blockingReason = blockingReason
    self.recoveryKind = recoveryKind
    self.canRetry = canRetry
    self.canCancel = canCancel
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case title
    case state
    case owner
    case proofRef
    case done
    case blockingReason
    case recoveryKind
    case canRetry
    case canCancel
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = try container.decode(String.self, forKey: .id)
    self.title = try container.decode(String.self, forKey: .title)
    self.state = try container.decode(MissionLifecycleState.self, forKey: .state)
    self.owner = try container.decode(MissionTruthLabel.self, forKey: .owner)
    self.proofRef = try container.decodeIfPresent(String.self, forKey: .proofRef)
    self.done = try container.decode(Bool.self, forKey: .done)
    self.blockingReason = try container.decodeIfPresent(String.self, forKey: .blockingReason) ?? ""
    self.recoveryKind = try container.decodeIfPresent(String.self, forKey: .recoveryKind) ?? "none"
    self.canRetry = try container.decodeIfPresent(Bool.self, forKey: .canRetry) ?? false
    self.canCancel = try container.decodeIfPresent(Bool.self, forKey: .canCancel) ?? false
  }

  public var needsAttention: Bool {
    guard !done else { return false }
    if canRetry || canCancel { return true }
    switch state {
    case .completedWithProof, .timelineRead:
      return false
    case .ready:
      return owner != .fridayOwned
    case .queued, .providerAck, .waiting, .stale, .reconnecting, .blocked, .error, .unknown:
      return true
    }
  }

  public var attentionReason: String {
    if !blockingReason.isEmpty { return blockingReason }
    switch state {
    case .providerAck:
      return "provider acknowledged; waiting for proof"
    case .waiting:
      return "waiting for user, provider, or recovery path"
    case .stale:
      return "stale projection state"
    case .reconnecting:
      return "reconnecting"
    case .blocked:
      return "blocked"
    case .error:
      return "error"
    case .unknown:
      return "unknown lifecycle state"
    case .queued:
      return "queued"
    case .ready:
      return owner == .fridayOwned ? "ready" : "linked item not owned by Friday"
    case .completedWithProof:
      return "completed with proof"
    case .timelineRead:
      return "timeline read only"
    }
  }
}

public struct MissionWorkbenchTimelinePage: Codable, Sendable, Identifiable, Equatable {
  public var id: Int { page }
  public let page: Int
  public let cursor: String
  public let nextCursor: String?
  public let eventRefs: [String]

  public init(page: Int, cursor: String, nextCursor: String?, eventRefs: [String]) {
    self.page = page
    self.cursor = cursor
    self.nextCursor = nextCursor
    self.eventRefs = eventRefs
  }
}

public struct MissionWorkbenchMemoryCandidate: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let preview: String
  public let state: String  // always "candidate_review_only" in the contract
  public let grantsMemoryAuthority: Bool  // always false; carried so the UI can assert it
  public let evidenceRef: String

  public init(
    id: String,
    preview: String,
    state: String,
    grantsMemoryAuthority: Bool,
    evidenceRef: String
  ) {
    self.id = id
    self.preview = preview
    self.state = state
    self.grantsMemoryAuthority = grantsMemoryAuthority
    self.evidenceRef = evidenceRef
  }
}

public struct MissionWorkbenchRunOutcomeLearningCandidate: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let runId: String
  public let workItemId: String
  public let kind: String
  public let state: String
  public let summary: String
  public let evidenceRef: String
  public let turns: Int64
  public let executedTools: Int64

  public init(
    id: String,
    runId: String,
    workItemId: String,
    kind: String,
    state: String,
    summary: String,
    evidenceRef: String,
    turns: Int64,
    executedTools: Int64
  ) {
    self.id = id
    self.runId = runId
    self.workItemId = workItemId
    self.kind = kind
    self.state = state
    self.summary = summary
    self.evidenceRef = evidenceRef
    self.turns = turns
    self.executedTools = executedTools
  }
}

public struct MissionWorkbenchCapabilityState: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let label: String
  public let kind: MissionWorkbenchCapabilityKind
  public let truthLabel: MissionTruthLabel
  public let approvalState: MissionWorkbenchApprovalState
  /// Projected from Rust Hub approval gates. The UI renders this as a STATUS
  /// indicator only — it must never be wired to a dispatch/execute affordance.
  public let dispatchAllowed: Bool
  public let summary: String
  public let proofRef: String

  public init(
    id: String,
    label: String,
    kind: MissionWorkbenchCapabilityKind,
    truthLabel: MissionTruthLabel,
    approvalState: MissionWorkbenchApprovalState,
    dispatchAllowed: Bool,
    summary: String,
    proofRef: String
  ) {
    self.id = id
    self.label = label
    self.kind = kind
    self.truthLabel = truthLabel
    self.approvalState = approvalState
    self.dispatchAllowed = dispatchAllowed
    self.summary = summary
    self.proofRef = proofRef
  }
}

public struct MissionTranscriptEvidenceRefs: Codable, Sendable, Equatable {
  public let providerRef: String?
  public let skillRunRef: String?
  public let channelRef: String?
  public let workflowRef: String?
  public let surfaceThreadRef: String?
  public let timelineRef: String?
  public let proofReceiptRef: String?

  public init(
    providerRef: String? = nil,
    skillRunRef: String? = nil,
    channelRef: String? = nil,
    workflowRef: String? = nil,
    surfaceThreadRef: String? = nil,
    timelineRef: String? = nil,
    proofReceiptRef: String? = nil
  ) {
    self.providerRef = providerRef
    self.skillRunRef = skillRunRef
    self.channelRef = channelRef
    self.workflowRef = workflowRef
    self.surfaceThreadRef = surfaceThreadRef
    self.timelineRef = timelineRef
    self.proofReceiptRef = proofReceiptRef
  }

  /// All non-nil refs as ordered (label, ref) pairs for refs-only rendering.
  public var orderedPairs: [(label: String, ref: String)] {
    var out: [(String, String)] = []
    if let providerRef { out.append(("providerRef", providerRef)) }
    if let skillRunRef { out.append(("skillRunRef", skillRunRef)) }
    if let channelRef { out.append(("channelRef", channelRef)) }
    if let workflowRef { out.append(("workflowRef", workflowRef)) }
    if let surfaceThreadRef { out.append(("surfaceThreadRef", surfaceThreadRef)) }
    if let timelineRef { out.append(("timelineRef", timelineRef)) }
    if let proofReceiptRef { out.append(("proofReceiptRef", proofReceiptRef)) }
    return out
  }
}

public struct MissionTranscriptEvent: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let missionId: String
  public let workItemId: String?
  public let surface: MissionSurfaceKind
  public let status: MissionLifecycleState
  public let truthLabel: MissionTruthLabel
  public let summary: String
  public let proofRef: String?
  public let evidenceRefs: MissionTranscriptEvidenceRefs
  public let capturedAt: String

  public init(
    id: String,
    missionId: String,
    workItemId: String?,
    surface: MissionSurfaceKind,
    status: MissionLifecycleState,
    truthLabel: MissionTruthLabel,
    summary: String,
    proofRef: String?,
    evidenceRefs: MissionTranscriptEvidenceRefs,
    capturedAt: String
  ) {
    self.id = id
    self.missionId = missionId
    self.workItemId = workItemId
    self.surface = surface
    self.status = status
    self.truthLabel = truthLabel
    self.summary = summary
    self.proofRef = proofRef
    self.evidenceRefs = evidenceRefs
    self.capturedAt = capturedAt
  }
}

public struct MissionTranscriptSection: Codable, Sendable, Identifiable, Equatable {
  public let id: String
  public let title: String
  public let groupKind: MissionTranscriptGroupKind
  public let missionId: String
  public let workItemId: String?
  public let truthLabel: MissionTruthLabel
  public let status: MissionLifecycleState
  public let events: [MissionTranscriptEvent]

  public init(
    id: String,
    title: String,
    groupKind: MissionTranscriptGroupKind,
    missionId: String,
    workItemId: String?,
    truthLabel: MissionTruthLabel,
    status: MissionLifecycleState,
    events: [MissionTranscriptEvent]
  ) {
    self.id = id
    self.title = title
    self.groupKind = groupKind
    self.missionId = missionId
    self.workItemId = workItemId
    self.truthLabel = truthLabel
    self.status = status
    self.events = events
  }
}

public struct MissionWorkbenchDuplicatePreflight: Codable, Sendable, Equatable {
  public let status: String
  public let duplicateMissionId: String
  public let duplicateWorkItemId: String

  public init(status: String, duplicateMissionId: String, duplicateWorkItemId: String) {
    self.status = status
    self.duplicateMissionId = duplicateMissionId
    self.duplicateWorkItemId = duplicateWorkItemId
  }
}

public struct MissionWorkbenchRouteDecision: Codable, Sendable, Equatable {
  public let advisorSummary: String
  public let selectedRoute: String
  public let alternatives: [String]
  public let truthLabel: MissionTruthLabel

  public init(
    advisorSummary: String,
    selectedRoute: String,
    alternatives: [String],
    truthLabel: MissionTruthLabel
  ) {
    self.advisorSummary = advisorSummary
    self.selectedRoute = selectedRoute
    self.alternatives = alternatives
    self.truthLabel = truthLabel
  }
}

/// The full read-only Mission Workbench projection.
///
/// Named `WorkbenchSnapshot` per the D-PR1 protocol spec; the typealias keeps
/// the contract name available too.
public struct WorkbenchSnapshot: Codable, Sendable, Equatable {
  public let missionId: String
  public let fridayConversationId: String
  public let agentSessionId: String?
  public let runtimeFeedStatus: MissionWorkbenchRuntimeFeedStatus
  public let statusLabels: [MissionWorkbenchStatusLabel]
  public let duplicatePreflight: MissionWorkbenchDuplicatePreflight
  public let routeDecision: MissionWorkbenchRouteDecision
  public let providerReceiptRefs: [String]
  public let channelReceiptRefs: [String]
  public let workItems: [MissionWorkbenchWorkItem]
  public let timelinePages: [MissionWorkbenchTimelinePage]
  public let memoryCandidates: [MissionWorkbenchMemoryCandidate]
  public let runOutcomeLearningCandidates: [MissionWorkbenchRunOutcomeLearningCandidate]
  public let capabilityStates: [MissionWorkbenchCapabilityState]
  public let t3ProvisioningStatus: MissionWorkbenchT3ProvisioningStatus?
  public let transcriptSections: [MissionTranscriptSection]

  public init(
    missionId: String,
    fridayConversationId: String,
    agentSessionId: String? = nil,
    runtimeFeedStatus: MissionWorkbenchRuntimeFeedStatus,
    statusLabels: [MissionWorkbenchStatusLabel],
    duplicatePreflight: MissionWorkbenchDuplicatePreflight,
    routeDecision: MissionWorkbenchRouteDecision,
    providerReceiptRefs: [String],
    channelReceiptRefs: [String],
    workItems: [MissionWorkbenchWorkItem],
    timelinePages: [MissionWorkbenchTimelinePage],
    memoryCandidates: [MissionWorkbenchMemoryCandidate],
    runOutcomeLearningCandidates: [MissionWorkbenchRunOutcomeLearningCandidate] = [],
    capabilityStates: [MissionWorkbenchCapabilityState],
    t3ProvisioningStatus: MissionWorkbenchT3ProvisioningStatus? = nil,
    transcriptSections: [MissionTranscriptSection]
  ) {
    self.missionId = missionId
    self.fridayConversationId = fridayConversationId
    self.agentSessionId = agentSessionId
    self.runtimeFeedStatus = runtimeFeedStatus
    self.statusLabels = statusLabels
    self.duplicatePreflight = duplicatePreflight
    self.routeDecision = routeDecision
    self.providerReceiptRefs = providerReceiptRefs
    self.channelReceiptRefs = channelReceiptRefs
    self.workItems = workItems
    self.timelinePages = timelinePages
    self.memoryCandidates = memoryCandidates
    self.runOutcomeLearningCandidates = runOutcomeLearningCandidates
    self.capabilityStates = capabilityStates
    self.t3ProvisioningStatus = t3ProvisioningStatus
    self.transcriptSections = transcriptSections
  }

  public var isLoadedEmpty: Bool {
    providerReceiptRefs.isEmpty
      && channelReceiptRefs.isEmpty
      && workItems.isEmpty
      && timelinePages.isEmpty
      && memoryCandidates.isEmpty
      && runOutcomeLearningCandidates.isEmpty
      && capabilityStates.isEmpty
      && t3ProvisioningStatus == nil
      && transcriptSections.isEmpty
  }

  public var attentionWorkItems: [MissionWorkbenchWorkItem] {
    workItems.filter(\.needsAttention)
  }

  public var attentionSummary: String {
    let count = attentionWorkItems.count
    if count == 0 { return "No work items need attention." }
    return "\(count) work item\(count == 1 ? "" : "s") need attention."
  }
}

public typealias MissionWorkbenchSnapshot = WorkbenchSnapshot

public struct MissionWorkbenchT3ProvisioningStatus: Codable, Sendable, Equatable {
  public let truthLabel: String
  public let paired: Bool
  public let deviceIdentityCount: Int
  public let trustedDeviceCount: Int
  public let activeTrustedDeviceCount: Int
  public let trustGrantCount: Int
  public let activeTrustGrantCount: Int
  public let contextPassportCount: Int
  public let contextPassportItemCount: Int
  public let latestDevice: MissionWorkbenchTrustedDeviceSummary?

  public init(
    truthLabel: String,
    paired: Bool,
    deviceIdentityCount: Int,
    trustedDeviceCount: Int,
    activeTrustedDeviceCount: Int,
    trustGrantCount: Int,
    activeTrustGrantCount: Int,
    contextPassportCount: Int,
    contextPassportItemCount: Int,
    latestDevice: MissionWorkbenchTrustedDeviceSummary?
  ) {
    self.truthLabel = truthLabel
    self.paired = paired
    self.deviceIdentityCount = deviceIdentityCount
    self.trustedDeviceCount = trustedDeviceCount
    self.activeTrustedDeviceCount = activeTrustedDeviceCount
    self.trustGrantCount = trustGrantCount
    self.activeTrustGrantCount = activeTrustGrantCount
    self.contextPassportCount = contextPassportCount
    self.contextPassportItemCount = contextPassportItemCount
    self.latestDevice = latestDevice
  }

  public var isFullyProvisioned: Bool {
    paired && activeTrustGrantCount > 0 && contextPassportCount > 0 && contextPassportItemCount > 0
  }

  public var missingOperatorSteps: [String] {
    var steps: [String] = []
    if !paired {
      steps.append("paired device")
    }
    if activeTrustGrantCount == 0 {
      steps.append("trust grant")
    }
    if contextPassportCount == 0 || contextPassportItemCount == 0 {
      steps.append("context passport")
    }
    return steps
  }

  public var desktopStatusLabel: String {
    if isFullyProvisioned {
      return "fully provisioned"
    }
    return paired ? "operator action needed" : "pairing needed"
  }

  public var desktopSummary: String {
    if isFullyProvisioned {
      return "Hub projection shows paired device, active trust grant, and context passport rows."
    }
    if missingOperatorSteps.isEmpty {
      return "Hub projection is incomplete."
    }
    return "Missing \(missingOperatorSteps.joined(separator: ", "))."
  }
}

public struct MissionWorkbenchTrustedDeviceSummary: Codable, Sendable, Equatable {
  public let deviceId: String
  public let label: String
  public let pairedAt: Int64
  public let revokedAt: Int64?
  public let keyRotatedAt: Int64?
  public let pubkeyFingerprint: String

  public init(
    deviceId: String,
    label: String,
    pairedAt: Int64,
    revokedAt: Int64? = nil,
    keyRotatedAt: Int64? = nil,
    pubkeyFingerprint: String
  ) {
    self.deviceId = deviceId
    self.label = label
    self.pairedAt = pairedAt
    self.revokedAt = revokedAt
    self.keyRotatedAt = keyRotatedAt
    self.pubkeyFingerprint = pubkeyFingerprint
  }
}
