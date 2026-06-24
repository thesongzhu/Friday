import FridayHubConsoleCore
import SwiftUI

private enum DesktopProjectionSurface {
  case providerAdmin
  case parity
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
    case .diagnostics:
      self = .diagnostics
    case .recovery:
      self = .recovery
    case .memory:
      self = .memory
    case .tokenLedger:
      self = .tokenLedger
    case .skills:
      self = .skills
    case .media:
      self = .media
    case .settings:
      self = .settings
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
    case .diagnostics: return "Diagnostics"
    case .recovery: return "Recovery"
    case .memory: return "Memory"
    case .tokenLedger: return "Token Ledger"
    case .skills: return "Skills / Tools"
    case .media: return "Media / Link"
    case .settings: return "Settings"
    case .evidence: return "Evidence Search"
    }
  }

  var icon: String {
    switch self {
    case .providerAdmin: return "person.badge.key"
    case .parity: return "square.grid.3x3"
    case .workflow: return "point.3.connected.trianglepath.dotted"
    case .channels: return "antenna.radiowaves.left.and.right"
    case .diagnostics: return "stethoscope"
    case .recovery: return "arrow.counterclockwise.circle"
    case .memory: return "brain.head.profile"
    case .tokenLedger: return "chart.bar.doc.horizontal"
    case .skills: return "wrench.and.screwdriver"
    case .media: return "link.badge.plus"
    case .settings: return "gearshape"
    case .evidence: return "doc.text.magnifyingglass"
    }
  }

  var statusLabel: String {
    switch self {
    case .providerAdmin: return "status-only provider controls"
    case .parity: return "route and receipt parity"
    case .workflow: return "mission work-item projection"
    case .channels: return "surface and channel receipts"
    case .diagnostics: return "hub health and proof checks"
    case .recovery: return "retry and cancel affordance facts"
    case .memory: return "candidate review and A1 learning refs"
    case .tokenLedger: return "owner-gated spend readback"
    case .skills: return "tool and capability truth matrix"
    case .media: return "NO-GO media/link capability truth"
    case .settings: return "local Hub and trust posture"
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
      case .diagnostics:
        diagnosticsStatus(snapshot)
      case .recovery:
        recoveryStatus(snapshot)
      case .memory:
        memoryStatus(snapshot)
      case .tokenLedger:
        tokenLedgerStatus(snapshot)
      case .skills:
        skillsStatus(snapshot)
      case .media:
        mediaStatus(snapshot)
      case .settings:
        settingsStatus(snapshot)
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
          if !detail.facts.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(detail.facts) { fact in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                  Text(fact.label)
                    .font(.system(size: 11))
                    .foregroundStyle(HubTheme.textSecondary)
                    .frame(width: 78, alignment: .leading)
                  Text(fact.value)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(HubTheme.textPrimary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
                }
              }
            }
          }
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
          HStack {
            cardTitle("Provider Auth")
            Spacer()
            Button {
              Task { await viewModel.loadDetail(.providersDoctor(probe: nil)) }
            } label: {
              Label("Check", systemImage: "stethoscope")
            }
            .buttonStyle(.bordered)
            .disabled(viewModel.detailState.isLoading)
          }
          Text("Runs the existing read-only provider doctor. It reports installed/authenticated providers, suggested routes, and failover blockers without storing keys or changing routing.")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
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
              if item.recoveryKind != "none" {
                StatusChip(text: item.recoveryKind, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
              }
            }
            if !item.blockingReason.isEmpty {
              Text(item.blockingReason)
                .font(.system(size: 11))
                .foregroundStyle(HubTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            if item.canRetry || item.canCancel {
              HStack(spacing: 6) {
                if item.canRetry {
                  StatusChip(text: "retry available", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
                }
                if item.canCancel {
                  StatusChip(text: "cancel available", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
                }
              }
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
    VStack(alignment: .leading, spacing: 16) {
      refsCard(title: "Evidence Refs", refs: evidenceRefs(snapshot))
    }
  }

  private func diagnosticsStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle("Runtime Diagnostics")
          HStack(spacing: 8) {
            snapshot.runtimeFeedStatus.chip
            StatusChip(
              text: snapshot.isLoadedEmpty ? "loaded empty" : "projection loaded",
              bg: snapshot.isLoadedEmpty ? HubTheme.chipNeutralBG : HubTheme.chipPendingBG,
              fg: snapshot.isLoadedEmpty ? HubTheme.chipNeutralFG : HubTheme.chipPendingFG)
          }
          Text("Diagnostics render typed Hub projection state only. Unknown values stay honest-unavailable and never become ready.")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
          ForEach(snapshot.statusLabels, id: \.rawValue) { label in
            label.chip
          }
        }
      }
      refsCard(title: "Diagnostic Proof Refs", refs: evidenceRefs(snapshot))
    }
  }

  private func recoveryStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Recovery Queue")
        if snapshot.attentionWorkItems.isEmpty {
          Text("No WorkItems currently need retry, cancel, or operator attention.")
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        } else {
          ForEach(snapshot.attentionWorkItems) { item in
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(item.title)
                  .font(.system(size: 13, weight: .medium))
                  .foregroundStyle(HubTheme.textPrimary)
                Spacer()
                item.state.chip
              }
              Text(item.attentionReason)
                .font(.system(size: 11))
                .foregroundStyle(HubTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
              HStack(spacing: 6) {
                StatusChip(text: item.recoveryKind, bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
                if item.canRetry {
                  StatusChip(text: "retry available", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
                }
                if item.canCancel {
                  StatusChip(text: "cancel available", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
                }
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
  }

  private func memoryStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle("Memory Candidates")
          if snapshot.memoryCandidates.isEmpty {
            Text("No memory candidates are currently projected for operator review.")
              .font(.system(size: 12))
              .foregroundStyle(HubTheme.textSecondary)
          } else {
            ForEach(snapshot.memoryCandidates) { candidate in
              VStack(alignment: .leading, spacing: 6) {
                Text(candidate.preview)
                  .font(.system(size: 12))
                  .foregroundStyle(HubTheme.textPrimary)
                StatusChip(
                  text: candidate.grantsMemoryAuthority ? "authority requested" : "review only",
                  bg: candidate.grantsMemoryAuthority ? HubTheme.chipWarnBG : HubTheme.chipNeutralBG,
                  fg: candidate.grantsMemoryAuthority ? HubTheme.chipWarnFG : HubTheme.chipNeutralFG)
                RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
              }
              .padding(.vertical, 4)
            }
          }
        }
      }
      refsCard(
        title: "A1 Learning Refs",
        refs: snapshot.runOutcomeLearningCandidates.map(\.evidenceRef))
    }
  }

  private func tokenLedgerStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      if let runId = snapshot.runOutcomeLearningCandidates.first?.runId, !runId.isEmpty {
        GlassPanel {
          VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
            HStack {
              cardTitle("Token Ledger")
              Spacer()
              Button {
                Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
              } label: {
                Label("Read", systemImage: "chart.bar.doc.horizontal")
              }
              .buttonStyle(.bordered)
              .disabled(viewModel.detailState.isLoading)
            }
            Text("Reads owner-gated run readback. Token totals come from token_ledger projection; this surface never estimates spend.")
              .font(.system(size: 11))
              .foregroundStyle(HubTheme.textSecondary)
            RefPill(label: "run_id", ref: runId)
          }
        }
      } else {
        unavailableFactCard(
          title: "Token Ledger",
          reason: "No run ref is present in the current projection, so spend details stay unavailable.")
      }
      refsCard(title: "Provider Receipt Refs", refs: snapshot.providerReceiptRefs)
    }
  }

  private func skillsStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Skills / Tools Truth Matrix")
        Text("Capabilities remain projected facts. Dispatch gates and approval state are shown; this screen does not execute tools.")
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
        ForEach(snapshot.capabilityStates) { capability in
          HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 4) {
              Text(capability.label)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(HubTheme.textPrimary)
              Text(capability.summary)
                .font(.system(size: 11))
                .foregroundStyle(HubTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
              capability.truthLabel.chip
              StatusChip(
                text: capability.dispatchAllowed ? "dispatch allowed" : "dispatch gated",
                bg: capability.dispatchAllowed ? HubTheme.chipPendingBG : HubTheme.chipNeutralBG,
                fg: capability.dispatchAllowed ? HubTheme.chipPendingFG : HubTheme.chipNeutralFG)
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
  }

  private func mediaStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      unavailableFactCard(
        title: "Media / Link",
        reason: "OCR, PDF, TTS, browser fetch, and link-to-skill rows remain NO-GO until their adapters are built and live-proven.")
      refsCard(title: "Related Evidence Refs", refs: evidenceRefs(snapshot))
    }
  }

  private func settingsStatus(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      GlassPanel {
        VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
          cardTitle("Hub Settings")
          Text("Settings are local posture facts from the Hub projection. Signing-key custody is never held by the app.")
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
          snapshot.runtimeFeedStatus.chip
          if let t3 = snapshot.t3ProvisioningStatus {
            StatusChip(
              text: t3.desktopStatusLabel,
              bg: t3.isFullyProvisioned ? HubTheme.chipPendingBG : HubTheme.chipWarnBG,
              fg: t3.isFullyProvisioned ? HubTheme.chipPendingFG : HubTheme.chipWarnFG)
            if let device = t3.latestDevice {
              RefPill(label: "device", ref: device.deviceId)
              RefPill(label: "pubkey", ref: device.pubkeyFingerprint)
            }
          } else {
            StatusChip(text: "T3 not projected", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
          }
        }
      }
    }
  }

  private func unavailableFactCard(title: String, reason: String) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle(title)
        StatusChip(text: "NO-GO visible", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
        Text(reason)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
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
