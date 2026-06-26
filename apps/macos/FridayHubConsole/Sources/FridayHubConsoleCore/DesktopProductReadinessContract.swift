import Foundation

public enum DesktopProductLoopTier: String, CaseIterable, Sendable, Equatable {
  case liveWorkbench
  case liveChatWorkbench
  case providerAdmin
  case liveReadProjection
  case governedActionGated
  case readinessOnly
  case navigationShell

  public var label: String {
    switch self {
    case .liveWorkbench: return "workbench"
    case .liveChatWorkbench: return "chat"
    case .providerAdmin: return "provider admin"
    case .liveReadProjection: return "live read"
    case .governedActionGated: return "action gated"
    case .readinessOnly: return "readiness"
    case .navigationShell: return "shell"
    }
  }

  public var summary: String {
    switch self {
    case .liveWorkbench:
      return "Reads the real Hub workbench projection and proof refs when the live read seam is configured."
    case .liveChatWorkbench:
      return "Surfaces chat, approvals, memory, and proof refs through governed read/write seams."
    case .providerAdmin:
      return "Shows provider auth, route readiness, and failover truth from Hub read arms."
    case .liveReadProjection:
      return "Reads real Hub projection details; it does not complete a product action by itself."
    case .governedActionGated:
      return "Shows governed action controls; mutations still require live write and approval gates."
    case .readinessOnly:
      return "Reports setup/readiness truth only."
    case .navigationShell:
      return "Navigation exists for selected UI coverage; closed-loop product behavior is still pending."
    }
  }
}

public enum DesktopProductBlockerKind: String, CaseIterable, Sendable, Equatable {
  case needsLiveWrite
  case needsOperatorSignature
  case needsProviderCredential
  case needsRuntimeEvidence
  case needsNativeSurface
  case needsLongRunSoak
}

public struct DesktopProductBlocker: Sendable, Equatable, Identifiable {
  public let id: String
  public let kind: DesktopProductBlockerKind
  public let label: String

  public init(_ kind: DesktopProductBlockerKind, id: String? = nil, label: String) {
    self.kind = kind
    self.id = id ?? kind.rawValue
    self.label = label
  }
}

public struct DesktopProductDestinationContract: Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let systemImage: String
  public let tier: DesktopProductLoopTier
  public let routeBuilt: Bool
  public let selectedDesignLocked: Bool
  public let runtimeActionIds: [String]
  public let blockers: [DesktopProductBlocker]

  public init(
    id: String,
    title: String,
    systemImage: String,
    tier: DesktopProductLoopTier,
    routeBuilt: Bool,
    selectedDesignLocked: Bool,
    runtimeActionIds: [String],
    blockers: [DesktopProductBlocker]
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
    routeBuilt && selectedDesignLocked && blockers.isEmpty && tier == .liveWorkbench
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

public enum DesktopProductDestinationID: String, CaseIterable, Sendable, Equatable, Identifiable {
  case operations
  case chat
  case session
  case providerAdmin
  case parity
  case pairingProvisioning
  case workflow
  case channels
  case diagnostics
  case recovery
  case memory
  case tokenLedger
  case skills
  case media
  case settings
  case evidence

  public var id: String { rawValue }

  public var contract: DesktopProductDestinationContract {
    switch self {
    case .operations:
      return contract(
        title: "Operations Overview",
        systemImage: "gauge.with.dots.needle.bottom.50percent",
        tier: .liveWorkbench,
        runtimeActionIds: ["desktop/operations/refresh"],
        blockers: [.init(.needsRuntimeEvidence, label: "same-run user proof")])
    case .chat:
      return contract(
        title: "Friday Chat",
        systemImage: "bubble.left.and.bubble.right",
        tier: .liveChatWorkbench,
        runtimeActionIds: [
          "desktop/fridayChat/act",
          "desktop/fridayChat/check",
        ],
        blockers: [.init(.needsRuntimeEvidence, label: "full desktop tap proof")])
    case .session:
      return contract(
        title: "Session Detail",
        systemImage: "rectangle.connected.to.line.below",
        tier: .liveReadProjection,
        runtimeActionIds: [
          "desktop/session/list",
          "desktop/session/open",
          "desktop/session/link",
        ],
        blockers: [.init(.needsRuntimeEvidence, label: "session detail read proof")])
    case .providerAdmin:
      return contract(
        title: "Provider Admin",
        systemImage: "person.badge.key",
        tier: .providerAdmin,
        runtimeActionIds: [],
        blockers: [.init(.needsProviderCredential, label: "all selected provider routes")])
    case .parity:
      return contract(
        title: "Provider Parity",
        systemImage: "square.grid.3x3",
        tier: .liveReadProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "multi-provider route proof")])
    case .pairingProvisioning:
      return contract(
        title: "Pairing",
        systemImage: "qrcode.viewfinder",
        tier: .readinessOnly,
        runtimeActionIds: ["desktop/pairing/manifest"],
        blockers: [.init(.needsRuntimeEvidence, label: "desktop+mobile pair proof")])
    case .workflow:
      return contract(
        title: "Workflow Builder",
        systemImage: "point.3.connected.trianglepath.dotted",
        tier: .governedActionGated,
        runtimeActionIds: ["desktop/workflow/retry", "desktop/workflow/cancel"],
        blockers: [.init(.needsRuntimeEvidence, label: "workflow canvas retry/cancel proof")])
    case .channels:
      return contract(
        title: "Channels",
        systemImage: "antenna.radiowaves.left.and.right",
        tier: .liveReadProjection,
        runtimeActionIds: [
          "desktop/channels/receipts",
          "desktop/channels/surface-events",
        ],
        blockers: [.init(.needsRuntimeEvidence, label: "channel admin app proof")])
    case .diagnostics:
      return contract(
        title: "Diagnostics",
        systemImage: "stethoscope",
        tier: .liveReadProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "doctor action proof")])
    case .recovery:
      return contract(
        title: "Recovery",
        systemImage: "arrow.counterclockwise.circle",
        tier: .governedActionGated,
        runtimeActionIds: ["desktop/recovery/retry", "desktop/recovery/cancel"],
        blockers: [.init(.needsRuntimeEvidence, label: "owner-bound recovery desktop proof")])
    case .memory:
      return contract(
        title: "Memory",
        systemImage: "brain.head.profile",
        tier: .governedActionGated,
        runtimeActionIds: ["desktop/memory/act", "desktop/memory/check"],
        blockers: [.init(.needsRuntimeEvidence, label: "confirmed memory behavior delta")])
    case .tokenLedger:
      return contract(
        title: "Token Ledger",
        systemImage: "chart.bar.doc.horizontal",
        tier: .liveReadProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "run-backed ledger proof")])
    case .skills:
      return contract(
        title: "Skills / Tools",
        systemImage: "wrench.and.screwdriver",
        tier: .navigationShell,
        runtimeActionIds: [],
        blockers: [.init(.needsNativeSurface, label: "tool install/run controls")])
    case .media:
      return contract(
        title: "Media / Link",
        systemImage: "link.badge.plus",
        tier: .navigationShell,
        runtimeActionIds: [],
        blockers: [.init(.needsNativeSurface, label: "media/link product surface")])
    case .settings:
      return contract(
        title: "Settings",
        systemImage: "gearshape",
        tier: .navigationShell,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "settings mutation proof")])
    case .evidence:
      return contract(
        title: "Evidence Search",
        systemImage: "doc.text.magnifyingglass",
        tier: .liveReadProjection,
        runtimeActionIds: [],
        blockers: [.init(.needsRuntimeEvidence, label: "search result proof")])
    }
  }

  private func contract(
    title: String,
    systemImage: String,
    tier: DesktopProductLoopTier,
    runtimeActionIds: [String],
    blockers: [DesktopProductBlocker]
  ) -> DesktopProductDestinationContract {
    DesktopProductDestinationContract(
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

public struct DesktopProductEndBarSnapshot: Sendable, Equatable {
  public let contracts: [DesktopProductDestinationContract]

  public init(contracts: [DesktopProductDestinationContract] = DesktopProductDestinationID.allCases.map(\.contract)) {
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

  public var uniqueBlockers: [DesktopProductBlocker] {
    var seen = Set<String>()
    return contracts
      .flatMap(\.blockers)
      .filter { seen.insert($0.id).inserted }
  }
}
