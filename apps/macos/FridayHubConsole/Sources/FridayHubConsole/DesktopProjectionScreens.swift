import FridayHubConsoleCore
import SwiftUI

private enum DesktopProjectionSurface {
  case providerAdmin
  case parity
  case workflow
  case channels
  case evidence

  init?(_ destination: HubDestination) {
    switch destination {
    case .operations, .chat, .pairingProvisioning:
      return nil
    case .providerAdmin:
      self = .providerAdmin
    case .parity:
      self = .parity
    case .workflow:
      self = .workflow
    case .channels:
      self = .channels
    case .evidence:
      self = .evidence
    }
  }

  var title: String {
    switch self {
    case .providerAdmin: return "Provider Admin"
    case .parity: return "Provider Parity"
    case .workflow: return "Workflow Builder"
    case .channels: return "Channels"
    case .evidence: return "Evidence Search"
    }
  }

  var icon: String {
    switch self {
    case .providerAdmin: return "person.badge.key"
    case .parity: return "square.grid.3x3"
    case .workflow: return "point.3.connected.trianglepath.dotted"
    case .channels: return "antenna.radiowaves.left.and.right"
    case .evidence: return "doc.text.magnifyingglass"
    }
  }

  var statusLabel: String {
    switch self {
    case .providerAdmin: return "status-only provider controls"
    case .parity: return "route and receipt parity"
    case .workflow: return "mission work-item projection"
    case .channels: return "surface and channel receipts"
    case .evidence: return "refs-only evidence index"
    }
  }
}

struct DesktopProjectionScreen: View {
  let destination: HubDestination
  @ObservedObject var viewModel: OperationsOverviewViewModel

  var body: some View {
    let surface = DesktopProjectionSurface(destination)
    VStack(alignment: .leading, spacing: 0) {
      if let surface {
        header(surface)
        stateContent(surface)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(HubTheme.backgroundWarmOffWhite)
  }

  private func header(_ surface: DesktopProjectionSurface) -> some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: surface.icon)
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(HubTheme.cyan)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text(surface.title)
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text(surface.statusLabel)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
      Spacer()
      Button {
        Task { await viewModel.refresh() }
      } label: {
        Label("Refresh Status", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.borderedProminent)
      .tint(HubTheme.cyan)
      .disabled(viewModel.state.isLoading)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
  }

  @ViewBuilder
  private func stateContent(_ surface: DesktopProjectionSurface) -> some View {
    switch viewModel.state {
    case .idle, .loading:
      loadingView
    case let .loaded(snapshot):
      ScrollView {
        loadedContent(snapshot)
      }
    case let .unavailable(reason):
      UnavailableView(reason: reason)
    }
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading hub projection...")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  @ViewBuilder
  func loadedContent(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if !snapshot.statusLabels.isEmpty || !snapshot.runtimeFeedStatus.isHealthy {
        StatusBanner(snapshot: snapshot)
      }
      detailActions(snapshot)
      detailResult

      switch DesktopProjectionSurface(destination) {
      case .providerAdmin:
        providerStatus(snapshot)
      case .parity:
        parityStatus(snapshot)
      case .workflow:
        workflowStatus(snapshot)
      case .channels:
        channelStatus(snapshot)
      case .evidence:
        evidenceStatus(snapshot)
      case nil:
        EmptyView()
      }
    }
    .padding(20)
  }

  private func detailActions(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Read Arms")
        HStack(spacing: 8) {
          Button {
            Task { await viewModel.loadDetail(.providersDoctor(probe: nil)) }
          } label: {
            Label("Providers", systemImage: "stethoscope")
          }
          .disabled(viewModel.detailState.isLoading)

          Button {
            Task { await viewModel.loadDetail(.sessionList) }
          } label: {
            Label("Sessions", systemImage: "rectangle.stack")
          }
          .disabled(viewModel.detailState.isLoading)

          if let agentSessionId = snapshot.agentSessionId {
            Button {
              Task { await viewModel.loadDetail(.sessionOpen(agentSessionId: agentSessionId)) }
            } label: {
              Label("Open", systemImage: "text.bubble")
            }
            .disabled(viewModel.detailState.isLoading)

            Button {
              Task { await viewModel.loadDetail(.sessionLinkState(agentSessionId: agentSessionId)) }
            } label: {
              Label("Link", systemImage: "link")
            }
            .disabled(viewModel.detailState.isLoading)
          }

          if let runId = snapshot.runOutcomeLearningCandidates.first?.runId, !runId.isEmpty {
            Button {
              Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
            } label: {
              Label("Run", systemImage: "doc.text.magnifyingglass")
            }
            .disabled(viewModel.detailState.isLoading)

            Button {
              Task { await viewModel.loadDetail(.runFileView(runId: runId)) }
            } label: {
              Label("Files", systemImage: "folder")
            }
            .disabled(viewModel.detailState.isLoading)

            Button {
              Task { await viewModel.loadDetail(.activityNeedsMe(runId: runId)) }
            } label: {
              Label("Needs Me", systemImage: "bell.badge")
            }
            .disabled(viewModel.detailState.isLoading)
          }
        }
        if snapshot.agentSessionId == nil {
          Text("Session detail arms require an agent session ref in the projection.")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
    }
  }

  @ViewBuilder
  private var detailResult: some View {
    switch viewModel.detailState {
    case .idle:
      EmptyView()
    case let .loading(arm):
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text(arm.title)
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
    case let .loaded(detail):
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          HStack {
            cardTitle(detail.title)
            Spacer()
            StatusChip(text: "\(detail.refs.count)", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
          }
          Text(detail.summary)
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textPrimary)
          if let providerReadiness = detail.providerReadiness {
            ProviderReadinessDetailView(readiness: providerReadiness)
          }
          RefPill(label: "generated", ref: "\(detail.generatedAtMs)")
          ForEach(detail.refs, id: \.self) { ref in
            RefPill(label: nil, ref: ref)
          }
        }
      }
    case let .unavailable(title, reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle(title)
          Text(reason)
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
    }
  }

  private func providerStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle("Provider State")
          Text("Dispatch is displayed as projected status only; this surface exposes no execute action.")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
          ForEach(snapshot.capabilityStates) { capability in
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(capability.label)
                  .font(.system(size: 13, weight: .medium))
                  .foregroundStyle(HubTheme.textPrimary)
                Spacer()
                StatusChip(
                  text: capability.dispatchAllowed ? "dispatch allowed" : "dispatch gated",
                  bg: capability.dispatchAllowed ? HubTheme.chipPendingBG : HubTheme.chipNeutralBG,
                  fg: capability.dispatchAllowed ? HubTheme.chipPendingFG : HubTheme.chipNeutralFG)
              }
              HStack(spacing: 6) {
                StatusChip(
                  text: capability.kind.rawValue, bg: HubTheme.chipNeutralBG,
                  fg: HubTheme.chipNeutralFG)
                StatusChip(
                  text: capability.approvalState.displayText, bg: HubTheme.chipNeutralBG,
                  fg: HubTheme.chipNeutralFG)
                capability.truthLabel.chip
              }
              Text(capability.summary)
                .font(.system(size: 11))
                .foregroundStyle(HubTheme.textSecondary)
              RefPill(label: "proofRef", ref: capability.proofRef)
            }
            .padding(.vertical, 4)
          }
        }
      }
      refsCard(title: "Provider Receipt Refs", refs: snapshot.providerReceiptRefs)
    }
  }

  private func parityStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle("Route Parity")
          HStack {
            Text(snapshot.routeDecision.advisorSummary)
              .font(.system(size: 12))
              .foregroundStyle(HubTheme.textSecondary)
            Spacer()
            snapshot.routeDecision.truthLabel.chip
          }
          RefPill(label: "selectedRoute", ref: snapshot.routeDecision.selectedRoute)
          ForEach(snapshot.routeDecision.alternatives, id: \.self) { alternative in
            RefPill(label: "alternative", ref: alternative)
          }
        }
      }
      refsCard(
        title: "Receipt Parity",
        refs: snapshot.providerReceiptRefs + snapshot.channelReceiptRefs)
    }
  }

  private func workflowStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Workflow Work Items")
        ForEach(snapshot.workItems) { item in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(item.title)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(HubTheme.textPrimary)
              Spacer()
              StatusChip(
                text: item.done ? "done" : "not done",
                bg: item.done ? HubTheme.chipDoneBG : HubTheme.chipNeutralBG,
                fg: item.done ? HubTheme.chipDoneFG : HubTheme.chipNeutralFG)
            }
            HStack(spacing: 6) {
              item.state.chip
              item.owner.chip
            }
            if let proofRef = item.proofRef {
              RefPill(label: "proofRef", ref: proofRef)
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
  }

  private func channelStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      refsCard(title: "Channel Receipt Refs", refs: snapshot.channelReceiptRefs)
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle("Surface Events")
          ForEach(surfaceSections(snapshot)) { section in
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(section.title)
                  .font(.system(size: 13, weight: .medium))
                  .foregroundStyle(HubTheme.textPrimary)
                Spacer()
                section.status.chip
              }
              ForEach(section.events) { event in
                Text(event.summary)
                  .font(.system(size: 11))
                  .foregroundStyle(HubTheme.textSecondary)
                ForEach(event.evidenceRefs.orderedPairs, id: \.ref) { pair in
                  RefPill(label: pair.label, ref: pair.ref)
                }
              }
            }
            .padding(.vertical, 4)
          }
        }
      }
    }
  }

  private func evidenceStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    refsCard(title: "Evidence Refs", refs: evidenceRefs(snapshot))
  }

  private func refsCard(title: String, refs: [String]) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle(title)
          Spacer()
          StatusChip(text: "\(refs.count)", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
        }
        if refs.isEmpty {
          Text("No refs in this projection.")
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        } else {
          ForEach(refs, id: \.self) { ref in
            RefPill(label: nil, ref: ref)
          }
        }
      }
    }
  }

  private func surfaceSections(_ snapshot: WorkbenchSnapshot) -> [MissionTranscriptSection] {
    snapshot.transcriptSections.filter {
      $0.groupKind == .surface || $0.groupKind == .channelTask || $0.events.contains {
        $0.surface == .desktop || $0.surface == .mobile
      }
    }
  }

  private func evidenceRefs(_ snapshot: WorkbenchSnapshot) -> [String] {
    var refs: [String] = []
    refs.append(contentsOf: snapshot.providerReceiptRefs)
    refs.append(contentsOf: snapshot.channelReceiptRefs)
    refs.append(snapshot.routeDecision.selectedRoute)
    refs.append(contentsOf: snapshot.routeDecision.alternatives)
    refs.append(contentsOf: snapshot.workItems.compactMap(\.proofRef))
    refs.append(contentsOf: snapshot.capabilityStates.map(\.proofRef))
    refs.append(contentsOf: snapshot.memoryCandidates.map(\.evidenceRef))
    refs.append(contentsOf: snapshot.runOutcomeLearningCandidates.map(\.evidenceRef))
    for section in snapshot.transcriptSections {
      for event in section.events {
        if let proofRef = event.proofRef { refs.append(proofRef) }
        refs.append(contentsOf: event.evidenceRefs.orderedPairs.map(\.ref))
      }
    }
    return unique(refs)
  }

  private func unique(_ refs: [String]) -> [String] {
    var seen = Set<String>()
    return refs.filter { seen.insert($0).inserted }
  }

  private func cardTitle(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(HubTheme.textPrimary)
  }
}

private struct ProviderReadinessDetailView: View {
  let readiness: ProviderReadinessDetail

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        StatusChip(
          text: readiness.keyValidationProbed == true ? "keys probed" : "keys not probed",
          bg: readiness.keyValidationProbed == true ? HubTheme.chipPendingBG : HubTheme.chipNeutralBG,
          fg: readiness.keyValidationProbed == true ? HubTheme.chipPendingFG : HubTheme.chipNeutralFG)
        if let suggestedTextRoute = readiness.suggestedTextRoute {
          RefPill(label: "text route", ref: suggestedTextRoute)
        }
        if let suggestedStrongRoute = readiness.suggestedStrongRoute {
          RefPill(label: "strong route", ref: suggestedStrongRoute)
        }
      }

      ForEach(readiness.routes) { route in
        ProviderRouteReadinessRow(route: route)
      }

      if !readiness.failovers.isEmpty {
        Text("Failover")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(HubTheme.textSecondary)
        ForEach(readiness.failovers) { failover in
          ProviderFailoverReadinessRow(failover: failover)
        }
      }

      Text("Read-only projection — this surface does not select routes or enable failover.")
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .accessibilityIdentifier("friday.desktop.provider-readiness-detail")
  }
}

private struct ProviderRouteReadinessRow: View {
  let route: ProviderRouteReadinessDisplay

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Text(route.providerId)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text(route.model)
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
        Spacer()
        StatusChip(
          text: route.dispatchable ? "dispatchable" : "blocked",
          bg: route.dispatchable ? HubTheme.chipDoneBG : HubTheme.chipWarnBG,
          fg: route.dispatchable ? HubTheme.chipDoneFG : HubTheme.chipWarnFG)
      }
      HStack(spacing: 6) {
        StatusChip(text: route.strength, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
        StatusChip(text: route.modelSize, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
      }
      if !route.blockers.isEmpty {
        Text(route.blockers.joined(separator: ", "))
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 3)
  }
}

private struct ProviderFailoverReadinessRow: View {
  let failover: ProviderFailoverReadinessDisplay

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 8) {
        Text(failover.direction)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Spacer()
        StatusChip(
          text: failover.canEnable ? "ready" : "blocked",
          bg: failover.canEnable ? HubTheme.chipDoneBG : HubTheme.chipWarnBG,
          fg: failover.canEnable ? HubTheme.chipDoneFG : HubTheme.chipWarnFG)
        StatusChip(
          text: failover.flagEnabled ? "flag on" : "flag off",
          bg: failover.flagEnabled ? HubTheme.chipPendingBG : HubTheme.chipNeutralBG,
          fg: failover.flagEnabled ? HubTheme.chipPendingFG : HubTheme.chipNeutralFG)
      }
      if !failover.blockers.isEmpty {
        Text(failover.blockers.joined(separator: ", "))
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, 3)
  }
}
