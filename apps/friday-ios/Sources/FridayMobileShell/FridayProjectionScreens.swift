import FridayMobileShellCore
import FridayRustClient
import SwiftUI

private enum ProjectionSurface {
  case missions
  case needsMe
  case memory
  case platform
  case activity
  case workflows
  case onboarding
  case settings

  init?(_ destination: MobileDestination) {
    switch destination {
    case .home, .session:
      return nil
    case .missions:
      self = .missions
    case .needsMe:
      self = .needsMe
    case .memory:
      self = .memory
    case .platform:
      self = .platform
    case .activity:
      self = .activity
    case .workflows:
      self = .workflows
    case .onboarding:
      self = .onboarding
    case .settings:
      self = .settings
    }
  }

  var icon: String {
    switch self {
    case .missions: return "list.bullet.rectangle"
    case .needsMe: return "person.crop.circle.badge.exclamationmark"
    case .memory: return "brain.head.profile"
    case .platform: return "square.grid.2x2"
    case .activity: return "bell.badge"
    case .workflows: return "arrow.triangle.branch"
    case .onboarding: return "sparkles.rectangle.stack"
    case .settings: return "gearshape"
    }
  }

  var title: String {
    switch self {
    case .missions: return "Missions"
    case .needsMe: return "Needs Me"
    case .memory: return "Memory"
    case .platform: return "Platform"
    case .activity: return "Activity"
    case .workflows: return "Workflows"
    case .onboarding: return "Onboarding"
    case .settings: return "Settings"
    }
  }

  var statusLabel: String {
    switch self {
    case .missions: return "mission truth"
    case .needsMe: return "operator attention"
    case .memory: return "candidate review"
    case .platform: return "runtime"
    case .activity: return "timeline"
    case .workflows: return "routing and work"
    case .onboarding: return "local readiness"
    case .settings: return "read seam"
    }
  }
}

struct FridayProjectionScreen: View {
  let destination: MobileDestination
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    let surface = ProjectionSurface(destination)
    ScrollView {
      VStack(spacing: 16) {
        if let surface {
          header(surface)
          stateContent(surface)
        }
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  @ViewBuilder
  private func stateContent(_ surface: ProjectionSurface) -> some View {
    switch viewModel.state {
    case .idle, .loading:
      loadingView
    case .loaded(let projection):
      loadedContent(surface, projection)
    case .unavailable(let reason):
      UnavailableView(reason: reason)
    }
  }

  private func header(_ surface: ProjectionSurface) -> some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: surface.icon)
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(MobileTheme.cyan)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text(surface.title)
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text(surface.statusLabel)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
        StatusChip(
          text: viewModel.isOnline ? "online" : "offline",
          bg: viewModel.isOnline ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: viewModel.isOnline ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
    }
  }

  private var loadingView: some View {
    GlassPanel {
      HStack(spacing: 12) {
        ProgressView()
        Text("Reading projection")
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
    }
  }

  @ViewBuilder
  private func loadedContent(_ surface: ProjectionSurface, _ projection: HomeProjection) -> some View {
    VStack(spacing: 16) {
      if !projection.statusLabels.isEmpty {
        StatusBanner(labels: projection.statusLabels)
      }
      detailActionsCard(projection)
      detailResultCard

      switch surface {
      case .missions:
        missionCard(projection)
        workItemsCard(projection)
      case .needsMe:
        needsMeCard(projection)
      case .memory:
        memoryCard(projection)
      case .platform:
        platformCard(projection)
        capabilityCard(projection)
      case .activity:
        activityCard(projection)
      case .workflows:
        workflowCard(projection)
        receiptRefsCard(projection)
      case .onboarding:
        onboardingCard(projection)
      case .settings:
        settingsCard(projection)
      }
    }
  }

  private func detailActionsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Read Arms", count: nil)
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
        }
        if let agentSessionId = projection.agentSessionId {
          HStack(spacing: 8) {
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
        } else {
          Text("Session detail arms require an agent session ref in the projection.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        if let runId = projection.runOutcomeLearningCandidates.first?.runId, !runId.isEmpty {
          HStack(spacing: 8) {
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
          }
          Button {
            Task { await viewModel.loadDetail(.activityNeedsMe(runId: runId)) }
          } label: {
            Label("Needs Me", systemImage: "bell.badge")
          }
          .disabled(viewModel.detailState.isLoading)
        }
      }
    }
  }

  @ViewBuilder
  private var detailResultCard: some View {
    switch viewModel.detailState {
    case .idle:
      EmptyView()
    case let .loading(arm):
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text(arm.title)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case let .loaded(detail):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(detail.title, count: detail.refs.count)
          Text(detail.summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
          RefPill(label: "generated", ref: generatedText(detail.generatedAtMs))
          if let providerReadiness = detail.providerReadiness {
            providerReadinessRows(providerReadiness)
          }
          ForEach(detail.refs, id: \.self) { ref in
            RefPill(label: nil, ref: ref)
          }
        }
      }
    case let .unavailable(title, reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(title, count: nil)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    }
  }

  private func missionCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Mission", count: nil)
        RefPill(label: "mission_id", ref: projection.missionId)
        RefPill(label: "conversation_id", ref: projection.fridayConversationId)
        if let route = projection.routeDecisionSummary {
          Text(route)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        if let selected = projection.routeSelected {
          RefPill(label: "selectedRoute", ref: selected)
        }
      }
    }
  }

  private func workItemsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Work Items", count: projection.workItems.count)
        if projection.workItems.isEmpty {
          emptyText("No work-item refs in this projection.")
        } else {
          ForEach(projection.workItems) { item in
            workItemRow(item)
          }
        }
      }
    }
  }

  private func needsMeCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Needs Me", count: projection.needsMeCount)
        let attentionItems = projection.workItems.filter(\.needsAttention)
        if attentionItems.isEmpty && projection.memoryCandidates.isEmpty
          && projection.runOutcomeLearningCandidates.isEmpty
        {
          emptyText("No projected operator-attention refs.")
        } else {
          ForEach(attentionItems) { item in
            workItemRow(item)
          }
          ForEach(projection.memoryCandidates) { candidate in
            memoryCandidateRow(candidate)
          }
          ForEach(projection.runOutcomeLearningCandidates) { candidate in
            learningCandidateRow(candidate)
          }
        }
      }
    }
  }

  private func memoryCard(_ projection: HomeProjection) -> some View {
    VStack(spacing: 16) {
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Memory Candidates", count: projection.memoryCandidates.count)
          if projection.memoryCandidates.isEmpty {
            emptyText("No pending memory candidates.")
          } else {
            ForEach(projection.memoryCandidates) { candidate in
              memoryCandidateRow(candidate)
            }
          }
        }
      }
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Run Outcome Learning", count: projection.runOutcomeLearningCandidates.count)
          if projection.runOutcomeLearningCandidates.isEmpty {
            emptyText("No pending run-outcome learning candidates.")
          } else {
            ForEach(projection.runOutcomeLearningCandidates) { candidate in
              learningCandidateRow(candidate)
            }
          }
        }
      }
    }
  }

  private func platformCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Runtime", count: nil)
        HStack(spacing: 8) {
          Image(systemName: "antenna.radiowaves.left.and.right")
            .foregroundStyle(MobileTheme.textSecondary)
            .frame(width: 22)
          Text("feed: \(projection.runtimeFeedStatus)")
            .font(.subheadline)
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
        }
        RefPill(label: "protocol", ref: "v\(fridayCurrentSchemaVersion)")
        RefPill(label: "generated", ref: generatedText(projection.generatedAtMs))
      }
    }
  }

  private func capabilityCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Capabilities", count: projection.capabilityStates.count)
        if projection.capabilityStates.isEmpty {
          emptyText("No capability refs in this projection.")
        } else {
          ForEach(projection.capabilityStates) { capability in
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(capability.label)
                  .font(.system(size: 13, weight: .medium))
                  .foregroundStyle(MobileTheme.textPrimary)
                Spacer()
                statusChip(capability.dispatchAllowed ? "dispatch allowed" : "dispatch gated")
              }
              Text(capability.summary)
                .font(.caption)
                .foregroundStyle(MobileTheme.textSecondary)
              HStack(spacing: 6) {
                statusChip(capability.kind)
                statusChip(capability.approvalState)
                statusChip(capability.truthLabel)
              }
              if !capability.proofRef.isEmpty {
                RefPill(label: "proofRef", ref: capability.proofRef)
              }
            }
            .padding(.vertical, 4)
          }
        }
      }
    }
  }

  private func activityCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Activity", count: projection.transcriptEvents.count)
        if projection.transcriptEvents.isEmpty {
          emptyText("No transcript events in this projection.")
        } else {
          ForEach(projection.transcriptEvents.prefix(12)) { event in
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(event.sectionTitle)
                  .font(.system(size: 12, weight: .semibold))
                  .foregroundStyle(MobileTheme.textPrimary)
                Spacer()
                statusChip(event.status)
              }
              Text(event.summary)
                .font(.caption)
                .foregroundStyle(MobileTheme.textSecondary)
              if let proofRef = event.proofRef {
                RefPill(label: "proofRef", ref: proofRef)
              }
            }
            .padding(.vertical, 4)
          }
        }
      }
    }
  }

  private func workflowCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Workflow", count: nil)
        if let selected = projection.routeSelected {
          RefPill(label: "selectedRoute", ref: selected)
        }
        ForEach(projection.routeAlternatives, id: \.self) { alternative in
          RefPill(label: "alternative", ref: alternative)
        }
        if projection.workItems.isEmpty {
          emptyText("No workflow work-item refs.")
        } else {
          ForEach(projection.workItems) { item in
            workItemRow(item)
          }
        }
      }
    }
  }

  private func receiptRefsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader(
          "Receipt Refs",
          count: projection.providerReceiptRefs.count + projection.channelReceiptRefs.count)
        if projection.providerReceiptRefs.isEmpty && projection.channelReceiptRefs.isEmpty {
          emptyText("No receipt refs in this projection.")
        } else {
          ForEach(projection.providerReceiptRefs, id: \.self) {
            RefPill(label: "provider", ref: $0)
          }
          ForEach(projection.channelReceiptRefs, id: \.self) {
            RefPill(label: "channel", ref: $0)
          }
        }
      }
    }
  }

  private func onboardingCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Readiness", count: nil)
        readinessRow(
          title: "Read seam",
          value: viewModel.isOnline ? "connected" : "unavailable",
          healthy: viewModel.isOnline)
        readinessRow(
          title: "Write seam",
          value: "chat surface checks live transport at send time",
          healthy: true)
        readinessRow(
          title: "Operator signature",
          value: "operator-only",
          healthy: false)
        readinessRow(
          title: "Device pairing",
          value: "sim loopback now; physical device later",
          healthy: false)
        RefPill(label: "mission_id", ref: projection.missionId)
      }
    }
  }

  private func settingsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Settings", count: nil)
        RefPill(label: "mode", ref: "live-read projection")
        RefPill(label: "protocol", ref: "v\(fridayCurrentSchemaVersion)")
        RefPill(label: "feed", ref: projection.runtimeFeedStatus)
        RefPill(label: "generated", ref: generatedText(projection.generatedAtMs))
      }
    }
  }

  private func workItemRow(_ item: HomeWorkItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(item.title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
        Spacer()
        StatusChip(
          text: item.done ? "done" : "not done",
          bg: item.done ? MobileTheme.chipDoneBG : MobileTheme.chipNeutralBG,
          fg: item.done ? MobileTheme.chipDoneFG : MobileTheme.chipNeutralFG)
      }
      HStack(spacing: 6) {
        statusChip(item.state)
        statusChip(item.owner)
        statusChip(item.recoveryKind)
      }
      if !item.blockingReason.isEmpty {
        Text(item.blockingReason)
          .font(.system(size: 11))
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if item.canRetry || item.canCancel {
        HStack(spacing: 6) {
          if item.canRetry {
            statusChip("retry available")
          }
          if item.canCancel {
            statusChip("cancel available")
          }
        }
      }
      if let proofRef = item.proofRef {
        RefPill(label: "proofRef", ref: proofRef)
      }
    }
    .padding(.vertical, 4)
  }

  private func memoryCandidateRow(_ candidate: HomeMemoryCandidate) -> some View {
    let decisionState = viewModel.memoryDecisionStates[candidate.id]
    return VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 8) {
        Text(candidate.preview)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 6) {
          Button {
            Task { await viewModel.decideMemory(candidateId: candidate.id, confirm: true) }
          } label: {
            Image(systemName: "checkmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(.borderedProminent)
          .tint(MobileTheme.cyan)
          .disabled(candidateDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Confirm memory candidate")

          Button {
            Task { await viewModel.decideMemory(candidateId: candidate.id, confirm: false) }
          } label: {
            Image(systemName: "xmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(.bordered)
          .disabled(candidateDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Reject memory candidate")
        }
      }
      HStack(spacing: 6) {
        statusChip(candidate.state)
        statusChip(candidate.grantsMemoryAuthority ? "grants authority" : "review only")
      }
      candidateDecisionStateView(decisionState, pendingText: "Applying memory decision...")
      if !candidate.evidenceRef.isEmpty {
        RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
      }
    }
    .padding(.vertical, 4)
  }

  private func learningCandidateRow(_ candidate: HomeRunOutcomeLearningCandidate) -> some View {
    let decisionState = viewModel.runOutcomeLearningDecisionStates[candidate.id]
    return VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 8) {
        Text(candidate.summary)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 6) {
          Button {
            Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: true) }
          } label: {
            Image(systemName: "checkmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(.borderedProminent)
          .tint(MobileTheme.cyan)
          .disabled(learningDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Confirm run outcome learning candidate")

          Button {
            Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: false) }
          } label: {
            Image(systemName: "xmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(.bordered)
          .disabled(learningDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Reject run outcome learning candidate")
        }
      }
      HStack(spacing: 6) {
        statusChip(candidate.kind)
        statusChip(candidate.state)
      }
      learningDecisionStateView(decisionState)
      if !candidate.runId.isEmpty {
        RefPill(label: "runId", ref: candidate.runId)
      }
      if !candidate.workItemId.isEmpty {
        RefPill(label: "workItemId", ref: candidate.workItemId)
      }
      if !candidate.evidenceRef.isEmpty {
        RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
      }
    }
    .padding(.vertical, 4)
  }

  private func learningDecisionControlsDisabled(_ state: HomeLearningDecisionState?) -> Bool {
    candidateDecisionControlsDisabled(state)
  }

  private func candidateDecisionControlsDisabled(_ state: HomeLearningDecisionState?) -> Bool {
    guard let state else { return false }
    return state.isSent || state.isTerminal
  }

  @ViewBuilder
  private func learningDecisionStateView(_ state: HomeLearningDecisionState?) -> some View {
    candidateDecisionStateView(state, pendingText: "Applying learning decision...")
  }

  @ViewBuilder
  private func candidateDecisionStateView(_ state: HomeLearningDecisionState?, pendingText: String) -> some View {
    switch state {
    case .sent:
      Text(pendingText)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    case .confirmed(let summary):
      Text(summary)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    case .error(let reason):
      Text(reason)
        .font(.caption2)
        .foregroundStyle(MobileTheme.coral)
    case nil:
      EmptyView()
    }
  }

  private func readinessRow(title: String, value: String, healthy: Bool) -> some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: healthy ? "checkmark.circle" : "lock.circle")
        .foregroundStyle(healthy ? MobileTheme.cyan : MobileTheme.textSecondary)
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
        Text(value)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      Spacer()
    }
  }

  @ViewBuilder
  private func providerReadinessRows(_ detail: HomeProviderReadinessDetail) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        statusChip(detail.truthLabel)
        statusChip(detail.proofOnly ? "proof only" : "not proof only")
        StatusChip(
          text: detail.ok ? "doctor ok" : "doctor not ok",
          bg: detail.ok ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: detail.ok ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
      HStack(spacing: 6) {
        statusChip(detail.anyAuthenticated ? "some auth" : "none auth")
        statusChip(detail.allAuthenticated ? "all auth" : "partial auth")
      }
      if !detail.readyProviders.isEmpty {
        Text("ready: \(detail.readyProviders.joined(separator: ", "))")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let suggestedTextRoute = detail.suggestedTextRoute {
        Text("text route: \(suggestedTextRoute)")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let suggestedStrongRoute = detail.suggestedStrongRoute {
        Text("strong route: \(suggestedStrongRoute)")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let keyValidationProbed = detail.keyValidationProbed {
        statusChip(keyValidationProbed ? "keys probed" : "keys not probed")
      }
      ForEach(detail.detected) { provider in
        VStack(alignment: .leading, spacing: 5) {
          HStack {
            Text(provider.provider)
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            StatusChip(
              text: provider.authenticated ? "authenticated" : "not authenticated",
              bg: provider.authenticated ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
              fg: provider.authenticated ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
          }
          Text(provider.detail)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          HStack(spacing: 6) {
            statusChip(provider.installed ? "installed" : "not installed")
            statusChip(provider.truthLabel)
          }
        }
        .padding(.vertical, 3)
      }
      ForEach(detail.routes) { route in
        VStack(alignment: .leading, spacing: 5) {
          HStack {
            Text(route.providerId)
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            StatusChip(
              text: route.dispatchable ? "dispatchable" : "blocked",
              bg: route.dispatchable ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
              fg: route.dispatchable ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
          }
          Text("\(route.model) - \(route.modelSize) - \(route.strength)")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          if !route.blockers.isEmpty {
            Text("blockers: \(route.blockers.joined(separator: ", "))")
              .font(.caption2)
              .foregroundStyle(MobileTheme.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(.vertical, 3)
      }
      ForEach(detail.failovers) { failover in
        VStack(alignment: .leading, spacing: 5) {
          HStack {
            Text(failover.direction)
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            StatusChip(
              text: failover.flagEnabled ? "armed" : "off",
              bg: failover.flagEnabled ? MobileTheme.chipPendingBG : MobileTheme.chipNeutralBG,
              fg: failover.flagEnabled ? MobileTheme.chipPendingFG : MobileTheme.chipNeutralFG)
          }
          HStack(spacing: 6) {
            statusChip(failover.canEnable ? "can enable" : "blocked")
            if !failover.blockers.isEmpty {
              statusChip("blockers \(failover.blockers.count)")
            }
          }
        }
        .padding(.vertical, 3)
      }
    }
  }

  private func cardHeader(_ title: String, count: Int?) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      if let count {
        StatusChip(text: "\(count)", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }

  private func emptyText(_ text: String) -> some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(MobileTheme.textSecondary)
  }

  private func statusChip(_ text: String) -> some View {
    StatusChip(text: text, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
  }

  private func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
