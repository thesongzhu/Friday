import Foundation

public enum MobileProductLoopTier: String, CaseIterable, Sendable, Equatable {
  case liveWriteRead
  case liveReadProjection
  case nativeDeviceLoop
  case providerWorkspace
  case governedActionGated
  case readinessOnly
  case statusProjection
  case navigationShell

  public var label: String {
    switch self {
    case .liveWriteRead: return "live write"
    case .liveReadProjection: return "live read"
    case .nativeDeviceLoop: return "device loop"
    case .providerWorkspace: return "workspace"
    case .governedActionGated: return "action gated"
    case .readinessOnly: return "readiness"
    case .statusProjection: return "projection"
    case .navigationShell: return "shell"
    }
  }

  public var summary: String {
    switch self {
    case .liveWriteRead:
      return "Real read/write loop exists when the governed live seams are configured."
    case .liveReadProjection:
      return "Reads real Hub projection state; it does not create or mutate work."
    case .nativeDeviceLoop:
      return "Runs local device I/O from the native app; product completion still needs runtime proof."
    case .providerWorkspace:
      return "Opens provider readiness, route/session refs, and native-control truth; read-only pieces are labeled."
    case .governedActionGated:
      return "Shows governed action controls; mutations require the live write seam and approval gates."
    case .readinessOnly:
      return "Reports device/provider readiness only; it is not a completed product loop."
    case .statusProjection:
      return "Shows current status from projection refs; no product action is completed here."
    case .navigationShell:
      return "Route exists for selected UI coverage, but closed-loop product behavior is still pending."
    }
  }
}

public enum MobileProductBlockerKind: String, CaseIterable, Sendable, Equatable {
  case needsLiveWrite
  case needsLiveRead
  case needsOperatorSignature
  case needsDevicePairing
  case needsProviderCredential
  case needsRuntimeEvidence
  case needsNativeSurface
}

public struct MobileProductBlocker: Sendable, Equatable, Identifiable {
  public let id: String
  public let kind: MobileProductBlockerKind
  public let label: String

  public init(_ kind: MobileProductBlockerKind, id: String? = nil, label: String) {
    self.kind = kind
    self.id = id ?? kind.rawValue
    self.label = label
  }
}

public struct MobileProductDestinationContract: Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let systemImage: String
  public let tier: MobileProductLoopTier
  public let routeBuilt: Bool
  public let selectedDesignLocked: Bool
  public let runtimeActionIds: [String]
  public let blockers: [MobileProductBlocker]

  public init(
    id: String,
    title: String,
    systemImage: String,
    tier: MobileProductLoopTier,
    routeBuilt: Bool,
    selectedDesignLocked: Bool,
    runtimeActionIds: [String],
    blockers: [MobileProductBlocker]
  ) {
    self.id = id
    self.title = title
    self.systemImage = systemImage
    self.tier = tier
    self.routeBuilt = routeBuilt
    self.selectedDesignLocked = selectedDesignLocked
    self.runtimeActionIds = runtimeActionIds
    self.blockers = blockers
  }

  public var isEndBarReady: Bool {
    routeBuilt && selectedDesignLocked && blockers.isEmpty && tier == .liveWriteRead
  }

  public var productReadinessSummary: String {
    if blockers.isEmpty {
      return tier.summary
    }
    let first = blockers.prefix(2).map(\.label).joined(separator: " · ")
    if blockers.count <= 2 {
      return first
    }
    return "\(first) · +\(blockers.count - 2)"
  }
}

public enum MobileProductDestinationID: String, CaseIterable, Sendable, Equatable, Identifiable {
  case home
  case missions
  case session
  case contextPassport
  case tokenLedger
  case shareIntake
  case voice
  case pairing
  case newSession
  case needsMe
  case memory
  case platform
  case providerAuth
  case activity
  case workflows
  case onboarding
  case settings

  public var id: String { rawValue }

  public var contract: MobileProductDestinationContract {
    switch self {
    case .home:
      return contract(
        title: "Friday Home",
        systemImage: "house",
        tier: .liveReadProjection,
        runtimeActionIds: ["mobile/home/refresh"],
        blockers: [
          .init(.needsRuntimeEvidence, label: "same-run mobile+desktop user proof"),
          .init(.needsRuntimeEvidence, id: "chat-write-action-proof", label: "Friday Chat write closes separately"),
        ])
    case .missions:
      return contract(
        title: "Missions",
        systemImage: "list.bullet.rectangle",
        tier: .liveReadProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsLiveWrite, label: "dispatch/action controls")])
    case .session:
      return contract(
        title: "Session",
        systemImage: "rectangle.connected.to.line.below",
        tier: .governedActionGated,
        runtimeActionIds: ["mobile/session/sidecar/open", "mobile/session/sidecar/close", "mobile/workflow/run-control"],
        blockers: [
          .init(.needsOperatorSignature, label: "approve-with-proof signature"),
          .init(.needsRuntimeEvidence, label: "real user tap proof"),
        ])
    case .contextPassport:
      return contract(
        title: "Context Passport",
        systemImage: "checklist.checked",
        tier: .liveReadProjection,
        runtimeActionIds: ["mobile/passport/send"],
        blockers: [.init(.needsRuntimeEvidence, label: "real app transfer proof")])
    case .tokenLedger:
      return contract(
        title: "Token Ledger",
        systemImage: "chart.bar.doc.horizontal",
        tier: .liveReadProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "run-backed ledger proof")])
    case .shareIntake:
      return contract(
        title: "Share Intake",
        systemImage: "square.and.arrow.down",
        tier: .governedActionGated,
        runtimeActionIds: ["mobile/share/send", "mobile/share/open-chat-loop"],
        blockers: [.init(.needsRuntimeEvidence, label: "share mission-intake app proof")])
    case .voice:
      return contract(
        title: "Voice",
        systemImage: "waveform",
        tier: .nativeDeviceLoop,
        runtimeActionIds: [
          "mobile/voice/permission",
          "mobile/fridayChat/voice-input",
          "mobile/fridayChat/voice-output",
          "mobile/voice/open-chat-loop",
        ],
        blockers: [
          .init(.needsRuntimeEvidence, label: "real microphone and speech-output tap proof"),
        ])
    case .pairing:
      return contract(
        title: "Device Pairing",
        systemImage: "qrcode.viewfinder",
        tier: .readinessOnly,
        runtimeActionIds: ["mobile/firstlaunch/scan", "mobile/firstlaunch/pairnow", "mobile/firstlaunch/retry", "mobile/firstlaunch/cancel"],
        blockers: [.init(.needsRuntimeEvidence, label: "real device pair proof")])
    case .newSession:
      return contract(
        title: "New Session",
        systemImage: "plus",
        tier: .governedActionGated,
        runtimeActionIds: ["mobile/newSession/play", "mobile/newSession/open-chat-loop"],
        blockers: [.init(.needsRuntimeEvidence, label: "provider result round-trip")])
    case .needsMe:
      return contract(
        title: "Needs Me",
        systemImage: "person.crop.circle.badge.exclamationmark",
        tier: .governedActionGated,
        runtimeActionIds: ["mobile/approval/check", "mobile/approval/reject"],
        blockers: [.init(.needsOperatorSignature, label: "approve-with-proof signature")])
    case .memory:
      return contract(
        title: "Memory",
        systemImage: "brain.head.profile",
        tier: .liveReadProjection,
        runtimeActionIds: ["mobile/memory/confirm", "mobile/memory/reject"],
        blockers: [.init(.needsRuntimeEvidence, label: "confirmed learning behavior delta")])
    case .platform:
      return contract(
        title: "Platform",
        systemImage: "square.grid.2x2",
        tier: .statusProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "capability matrix live proof")])
    case .providerAuth:
      return contract(
        title: "Provider Workspace",
        systemImage: "person.badge.key",
        tier: .providerWorkspace,
        runtimeActionIds: [],
        blockers: [.init(.needsProviderCredential, label: "all selected provider routes")])
    case .activity:
      return contract(
        title: "Activity",
        systemImage: "bell.badge",
        tier: .liveReadProjection,
        runtimeActionIds: ["mobile/activity/mark-done"],
        blockers: [.init(.needsRuntimeEvidence, label: "owner-bound mark-done app proof")])
    case .workflows:
      return contract(
        title: "Workflows",
        systemImage: "arrow.triangle.branch",
        tier: .navigationShell,
        runtimeActionIds: [],
        blockers: [.init(.needsNativeSurface, label: "workflow builder surface")])
    case .onboarding:
      return contract(
        title: "Onboarding",
        systemImage: "sparkles.rectangle.stack",
        tier: .readinessOnly,
        runtimeActionIds: ["mobile/onboarding/open-device-pairing"],
        blockers: [.init(.needsRuntimeEvidence, label: "zero-config launch app proof")])
    case .settings:
      return contract(
        title: "Settings",
        systemImage: "gearshape",
        tier: .statusProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "settings mutation proof")])
    }
  }

  private func contract(
    title: String,
    systemImage: String,
    tier: MobileProductLoopTier,
    runtimeActionIds: [String],
    blockers: [MobileProductBlocker]
  ) -> MobileProductDestinationContract {
    MobileProductDestinationContract(
      id: rawValue,
      title: title,
      systemImage: systemImage,
      tier: tier,
      routeBuilt: true,
      selectedDesignLocked: true,
      runtimeActionIds: runtimeActionIds,
      blockers: blockers)
  }
}

public struct MobileProductEndBarSnapshot: Sendable, Equatable {
  public let contracts: [MobileProductDestinationContract]

  public init(contracts: [MobileProductDestinationContract] = MobileProductDestinationID.allCases.map(\.contract)) {
    self.contracts = contracts
  }

  public var routeCoverageCount: Int {
    contracts.filter(\.routeBuilt).count
  }

  public var endBarReadyCount: Int {
    contracts.filter(\.isEndBarReady).count
  }

  public var totalCount: Int {
    contracts.count
  }

  public var hasAnyEndBarClaim: Bool {
    endBarReadyCount > 0
  }

  public var uniqueBlockers: [MobileProductBlocker] {
    var seen = Set<String>()
    return contracts
      .flatMap(\.blockers)
      .filter { seen.insert($0.id).inserted }
  }
}
