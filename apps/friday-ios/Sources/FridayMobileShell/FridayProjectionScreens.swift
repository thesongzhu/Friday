import FridayMobileShellCore
import FridayRustClient
import SwiftUI
import UIKit

private enum ProjectionSurface {
  case missions
  case needsMe
  case memory
  case platform
  case activity
  case workflows
  case onboarding
  case settings
  case petEditor
  case proofViewer
  case entrypoints

  init?(_ destination: MobileDestination) {
    switch destination {
    case .home, .session, .contextPassport, .tokenLedger, .shareIntake, .voice, .pairing,
         .newSession, .providerAuth:
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
    case .petEditor:
      self = .petEditor
    case .proofViewer:
      self = .proofViewer
    case .entrypoints:
      self = .entrypoints
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
    case .petEditor: return "paintpalette"
    case .proofViewer: return "doc.text.magnifyingglass"
    case .entrypoints: return "rectangle.stack.badge.plus"
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
    case .petEditor: return "Pet Editor"
    case .proofViewer: return "Receipts"
    case .entrypoints: return "Launch Tools"
    }
  }

  var identifierSlug: String {
    switch self {
    case .missions: return "missions"
    case .needsMe: return "needs-me"
    case .memory: return "memory"
    case .platform: return "platform"
    case .activity: return "activity"
    case .workflows: return "workflows"
    case .onboarding: return "onboarding"
    case .settings: return "settings"
    case .petEditor: return "pet-editor"
    case .proofViewer: return "proof-viewer"
    case .entrypoints: return "entrypoints"
    }
  }

  var statusLabel: String {
    switch self {
    case .missions: return "mission status"
    case .needsMe: return "operator attention"
    case .memory: return "candidate review"
    case .platform: return "runtime"
    case .activity: return "timeline"
    case .workflows: return "routing and work"
    case .onboarding: return "local readiness"
    case .settings: return "read seam"
    case .petEditor: return "companion state"
    case .proofViewer: return "receipt review"
    case .entrypoints: return "mobile launch tools"
    }
  }
}

struct FridayProjectionScreen: View {
  let destination: MobileDestination
  @ObservedObject var viewModel: HomeViewModel
  @Environment(\.openURL) private var openURL
  var onOpenFridayChat: (ChatLaunchContext) -> Void = { _ in }
  var onOpenPairing: () -> Void = {}
  @State private var missionDispatchIntent = ""
  @StateObject private var missionDispatch: NewSessionViewModel
  @StateObject private var pushNotifications: PushNotificationReadinessViewModel

  @MainActor
  init(
    destination: MobileDestination,
    viewModel: HomeViewModel,
    missionClient: (any FridayMissionSpineWriteClient)? = nil,
    onOpenFridayChat: @escaping (ChatLaunchContext) -> Void = { _ in },
    onOpenPairing: @escaping () -> Void = {},
    pushNotifications: PushNotificationReadinessViewModel? = nil
  ) {
    self.destination = destination
    self.viewModel = viewModel
    self.onOpenFridayChat = onOpenFridayChat
    self.onOpenPairing = onOpenPairing
    _missionDispatch = StateObject(wrappedValue: NewSessionViewModel(client: missionClient))
    _pushNotifications = StateObject(wrappedValue: pushNotifications
      ?? PushNotificationReadinessViewModel(authorizer: SystemPushNotificationAuthorizer()))
  }

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
      UnavailableView(
        reason: displayReason(reason),
        title: "Connect \(surface.title)",
        detail: "Friday needs the live Hub projection before this destination can show current state.",
        systemImage: surface.icon,
        identifier: "friday.\(surface.identifierSlug).unavailable")
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
        FridayChip(
          text: viewModel.isOnline ? "online" : "connect",
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
      if projection.shouldPromoteStatusLabelsToBlockingBanner {
        StatusBanner(labels: projection.statusLabels)
      }
      detailActionsCard(projection)
      detailResultCard

      switch surface {
      case .missions:
        missionCard(projection)
        missionDispatchCard(projection)
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
      case .petEditor:
        petEditorCard(projection)
      case .proofViewer:
        proofViewerCard(projection)
      case .entrypoints:
        entrypointsCard(projection)
      }
    }
  }

  private func detailActionsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Live controls", count: nil)
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
        if let runId = projection.runOutcomeLearningCandidates.first?.runId, !runId.isEmpty {
          HStack(spacing: 8) {
            Button {
              Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
            } label: {
              Label("Token Ledger", systemImage: "chart.bar.doc.horizontal")
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
          Text("Session details appear after Friday receives a live session link.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        if let runId = projection.runOutcomeLearningCandidates.first?.runId, !runId.isEmpty {
          HStack(spacing: 8) {
            Button {
              Task { await viewModel.loadDetail(.runFileView(runId: runId)) }
            } label: {
              Label("Files", systemImage: "folder")
            }
            .disabled(viewModel.detailState.isLoading)
          }
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
          FridayProofLine(label: "updated", ref: generatedText(detail.generatedAtMs))
          if let providerReadiness = detail.providerReadiness {
            ProviderReadinessPanel(detail: providerReadiness)
          }
          ForEach(detail.refs, id: \.self) { ref in
            FridayProofLine(label: nil, ref: ref)
          }
        }
      }
    case let .unavailable(title, reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(title, count: nil)
          Text(displayReason(reason))
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
        FridayProofLine(label: "mission", ref: projection.missionId)
        FridayProofLine(label: "thread", ref: projection.fridayConversationId)
        if let route = projection.routeDecisionSummary {
          Text(route)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        if let selected = projection.routeSelected {
          FridayProofLine(label: "route", ref: selected)
        }
      }
    }
    .accessibilityIdentifier("friday.missions.read")
  }

  private func missionDispatchCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Dispatch", count: nil)
        Text("Create governed work from the current mission context. This uses the same Mission Intake write seam as New Session; it does not bypass approval or invent provider results.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        TextField("What should Friday do next?", text: $missionDispatchIntent, axis: .vertical)
          .lineLimit(2...4)
          .textInputAutocapitalization(.sentences)
          .font(.subheadline)
          .padding(10)
          .background(Color.white.opacity(0.54), in: RoundedRectangle(cornerRadius: 8))
          .accessibilityIdentifier("friday.missions.dispatch-input")
        Button {
          let goal = missionDispatchIntent.trimmingCharacters(in: .whitespacesAndNewlines)
          Task { await missionDispatch.launch(intent: goal) }
        } label: {
          Label("Dispatch Mission", systemImage: "play.fill")
            .frame(maxWidth: .infinity, minHeight: 38)
        }
        .buttonStyle(FridayButtonStyle(variant: .primary))
        .tint(MobileTheme.cyan)
        .disabled(missionDispatchIntent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || missionDispatchInFlight)
        .accessibilityIdentifier("friday.missions.dispatch-button")
        missionDispatchState
      }
    }
  }

  @ViewBuilder
  private var missionDispatchState: some View {
    switch missionDispatch.launchState {
    case .idle:
      EmptyView()
    case .launching:
      HStack(spacing: 10) {
        ProgressView()
        Text("Submitting Mission Intake")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      .accessibilityIdentifier("friday.missions.dispatch-submitting")
    case .launched(let summary, let missionId, let workItemId, let surfaceThreadId, let status, let createdOrReady):
      let context = ChatLaunchContext(
        source: "Missions",
        missionId: missionId,
        workItemId: workItemId,
        surfaceThreadId: surfaceThreadId,
        status: status,
        createdOrReady: createdOrReady)
      VStack(alignment: .leading, spacing: 8) {
        Text(summary)
          .font(.caption)
          .foregroundStyle(MobileTheme.textPrimary)
          .accessibilityIdentifier("friday.missions.dispatch-ready")
        FridayProofLine(label: "mission", ref: missionId)
        FridayProofLine(label: "work item", ref: workItemId)
        FridayProofLine(label: "action", ref: "mobile/missions/dispatch")
        Button {
          onOpenFridayChat(context)
        } label: {
          Label("Continue in Friday Chat", systemImage: "bubble.left.and.bubble.right")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(FridayButtonStyle(variant: .secondary))
        .tint(MobileTheme.cyan)
        .accessibilityIdentifier("friday.missions.open-chat-loop")
      }
    case .blocked(let reason):
      Text(displayReason(reason))
        .font(.caption)
        .foregroundStyle(MobileTheme.coral)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier("friday.missions.dispatch-blocked")
    }
  }

  private var missionDispatchInFlight: Bool {
    if case .launching = missionDispatch.launchState { return true }
    return false
  }

  private func workItemsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Work Items", count: projection.workItems.count)
        if projection.workItems.isEmpty {
          emptyText("No active work items are visible right now.")
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
          emptyText("No approvals, memory reviews, or recovery items need your attention.")
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
          Text("Live connection: \(projection.runtimeFeedStatus)")
            .font(.subheadline)
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
        }
        FridayProofLine(label: "protocol", ref: "v\(fridayCurrentSchemaVersion)")
        FridayProofLine(label: "updated", ref: generatedText(projection.generatedAtMs))
      }
    }
  }

  private func capabilityCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Capabilities", count: projection.capabilityStates.count)
        if projection.capabilityStates.isEmpty {
          emptyText("No capability updates are visible right now.")
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
                FridayProofLine(label: "receipt", ref: capability.proofRef)
              }
            }
            .padding(.vertical, 4)
          }
        }
      }
    }
    .accessibilityIdentifier("friday.platform.capability-matrix")
  }

  private func activityCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Activity", count: projection.transcriptEvents.count)
        if projection.transcriptEvents.isEmpty {
          emptyText("No recent activity is visible right now.")
        } else {
          ForEach(projection.transcriptEvents.prefix(12)) { event in
            let doneState = viewModel.activityMarkDoneStates[event.id]
            VStack(alignment: .leading, spacing: 5) {
              HStack {
                Text(displayEventSection(event.sectionTitle))
                  .font(.system(size: 12, weight: .semibold))
                  .foregroundStyle(MobileTheme.textPrimary)
                Spacer()
                statusChip(displayStatus(event.status))
              }
              Text(displayEventSummary(event.summary))
                .font(.caption)
                .foregroundStyle(MobileTheme.textSecondary)
              HStack(spacing: 8) {
                FridayProofLine(label: "activity", ref: event.id)
                Spacer()
                Button {
                  Task { await viewModel.markActivityDone(activityId: event.id) }
                } label: {
                  Image(systemName: "checkmark.circle")
                    .frame(width: 26, height: 26)
                }
                .buttonStyle(FridayButtonStyle(variant: .secondary))
                .disabled(candidateDecisionControlsDisabled(doneState))
                .accessibilityLabel("Mark activity done")
                .accessibilityIdentifier("friday.activity.mark-done")
              }
              candidateDecisionStateView(doneState, pendingText: "Marking activity done...")
              if let proofRef = event.proofRef {
                FridayProofLine(label: "receipt", ref: proofRef)
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
        cardHeader("Workflow Control", count: projection.workItems.count)
          .accessibilityIdentifier("friday.workflow.control-surface")
        Text("Friday shows the current route and work controls from the live Hub. Retry and cancel stay guarded, and they become available only when this app session can act safely.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if let selected = projection.routeSelected {
          FridayProofLine(label: "route", ref: selected)
        }
        if !projection.routeAlternatives.isEmpty {
          VStack(alignment: .leading, spacing: 6) {
            Text("Route Alternatives")
              .font(.caption.weight(.semibold))
              .foregroundStyle(MobileTheme.textSecondary)
            ForEach(projection.routeAlternatives, id: \.self) { alternative in
              FridayProofLine(label: "option", ref: alternative)
            }
          }
        }
        HStack(spacing: 6) {
          FridayProofLine(label: "action", ref: "mobile/workflow/retry")
          FridayProofLine(label: "action", ref: "mobile/workflow/cancel")
        }
        if projection.workItems.isEmpty {
          emptyText("No workflow work items are visible right now.")
        } else {
          VStack(alignment: .leading, spacing: 8) {
            ForEach(projection.workItems) { item in
              workItemRow(item)
            }
          }
        }
      }
    }
  }

  private func receiptRefsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader(
          "Receipts",
          count: projection.providerReceiptRefs.count + projection.channelReceiptRefs.count)
        if projection.providerReceiptRefs.isEmpty && projection.channelReceiptRefs.isEmpty {
          emptyText("No receipts are visible right now.")
        } else {
          ForEach(projection.providerReceiptRefs, id: \.self) {
            FridayProofLine(label: "provider", ref: $0)
          }
          ForEach(projection.channelReceiptRefs, id: \.self) {
            FridayProofLine(label: "channel", ref: $0)
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
          value: viewModel.isOnline ? "connected" : "needs connection",
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
          value: projection.t3ProvisioningStatus?.paired == true ? "paired in Hub" : "no paired device in Hub",
          healthy: projection.t3ProvisioningStatus?.paired == true)
        t3ProvisioningRows(projection.t3ProvisioningStatus)
        Button {
          onOpenPairing()
        } label: {
          Label("Open Device Pairing", systemImage: "qrcode.viewfinder")
        }
        .buttonStyle(FridayButtonStyle(variant: .primary))
        .tint(MobileTheme.cyan)
        .accessibilityIdentifier("friday.onboarding.open-device-pairing")
        FridayProofLine(label: "action", ref: "mobile/onboarding/open-device-pairing")
        readinessRow(
          title: "Provider auth",
          value: "read-only doctor; never stores provider secrets",
          healthy: viewModel.isOnline)
        Button {
          Task { await viewModel.loadDetail(.providersDoctor(probe: nil)) }
        } label: {
          Label("Check Provider Auth", systemImage: "stethoscope")
        }
        .disabled(viewModel.detailState.isLoading)
        FridayProofLine(label: "mission", ref: projection.missionId)
      }
    }
  }

  @ViewBuilder
  private func t3ProvisioningRows(_ status: HomeT3ProvisioningStatus?) -> some View {
    if let status {
      readinessRow(
        title: "Approval grant",
        value: status.activeTrustGrantCount > 0 ? "active" : "approval needed",
        healthy: status.activeTrustGrantCount > 0)
      readinessRow(
        title: "Shared context",
        value: status.contextPassportCount > 0 ? "\(status.contextPassportCount) ready" : "setup needed",
        healthy: status.contextPassportCount > 0 && status.contextPassportItemCount > 0)
      if let device = status.latestDevice {
        FridayProofLine(label: "device", ref: device.deviceId)
        FridayProofLine(label: "device key", ref: device.pubkeyFingerprint)
      }
      FridayProofLine(label: "setup status", ref: status.truthLabel)
    } else {
      readinessRow(
        title: "Approval grant",
        value: "connect Hub projection",
        healthy: false)
      readinessRow(
        title: "Shared context",
        value: "connect Hub projection",
        healthy: false)
    }
  }

  @ViewBuilder
  private func settingsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Settings", count: nil)
        FridayProofLine(label: "mode", ref: "live-read projection")
        FridayProofLine(label: "protocol", ref: "v\(fridayCurrentSchemaVersion)")
        FridayProofLine(label: "feed", ref: projection.runtimeFeedStatus)
        FridayProofLine(label: "updated", ref: generatedText(projection.generatedAtMs))
        Button {
          Task { await viewModel.loadDetail(.providersDoctor(probe: nil)) }
        } label: {
          Label("Provider Auth", systemImage: "person.badge.key")
        }
        .disabled(viewModel.detailState.isLoading)
        if let runId = projection.runOutcomeLearningCandidates.first?.runId, !runId.isEmpty {
          Button {
            Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
          } label: {
            Label("Token Ledger", systemImage: "chart.bar.doc.horizontal")
          }
          .disabled(viewModel.detailState.isLoading)
        } else {
          Text("Token ledger appears after a real run ref is present.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    }
    pushNotificationCard()
  }

  private func petEditorCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Companion State", count: nil)
        Text("Friday keeps the companion visible without inventing mood or work state. Live status will shape the companion only after the Hub reports a trustworthy state.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        readinessRow(
          title: "Hero pet",
          value: "rendered locally from bundled v9 assets",
          healthy: true)
        readinessRow(
          title: "Live state mapping",
          value: projection.runtimeFeedStatus.isEmpty ? "connect Hub projection" : displayStatus(projection.runtimeFeedStatus),
          healthy: false)
        FridayProofLine(label: "action", ref: "mobile/pet/state-mapping")
        FridayProofLine(label: "mission", ref: projection.missionId)
      }
    }
    .accessibilityIdentifier("friday.pet-editor.readiness")
  }

  private func proofViewerCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader(
          "Receipts",
          count: projection.providerReceiptRefs.count + projection.channelReceiptRefs.count)
        Text("Receipts appear here only after the live Hub reports them. Friday keeps details private until a trusted session can open them.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        if projection.providerReceiptRefs.isEmpty && projection.channelReceiptRefs.isEmpty {
          emptyText("No receipts are visible right now.")
        } else {
          ForEach(projection.providerReceiptRefs, id: \.self) {
            FridayProofLine(label: "provider", ref: $0)
          }
          ForEach(projection.channelReceiptRefs, id: \.self) {
            FridayProofLine(label: "channel", ref: $0)
          }
        }
        FridayProofLine(label: "action", ref: "mobile/proof/viewer-open")
      }
    }
    .accessibilityIdentifier("friday.proof-viewer.receipts")
  }

  private func entrypointsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Launch Tools", count: nil)
        Text("Widgets, controls, push entry, share intake, and deep links stay grouped here as Friday launch surfaces.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        readinessRow(title: "Share intake", value: "friday://share deep link wired", healthy: true)
        readinessRow(title: "Command sheet", value: "top-left launcher routes selected surfaces", healthy: true)
        readinessRow(title: "Push entry", value: "local permission ready; remote delivery setup next", healthy: false)
        readinessRow(title: "Widget/control", value: "native launcher setup next", healthy: false)
        FridayProofLine(label: "action", ref: "mobile/entrypoints/readiness")
        FridayProofLine(label: "thread", ref: projection.fridayConversationId)
      }
    }
    .accessibilityIdentifier("friday.entrypoints.readiness")
  }

  @ViewBuilder
  private func pushNotificationCard() -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Push Notifications", count: nil)
          .accessibilityIdentifier("friday.settings.push-notifications-card")
        switch pushNotifications.state {
        case .idle:
          readinessRow(title: "Permission", value: "not checked", healthy: false)
        case .loading:
          HStack(spacing: 12) {
            ProgressView()
            Text("Checking notification permission")
              .font(.caption)
              .foregroundStyle(MobileTheme.textSecondary)
          }
        case let .loaded(readiness):
          HStack(spacing: 6) {
            statusChip(readiness.settings.authorizationStatus.rawValue)
            statusChip(readiness.truthLabel)
          }
          readinessRow(
            title: "Local delivery",
            value: readiness.localNotificationUsable ? "permission usable" : readiness.summary,
            healthy: readiness.localNotificationUsable)
          readinessRow(
            title: "Remote APNs",
            value: readiness.remoteDeliveryConfigured ? "configured" : "set up remote delivery",
            healthy: readiness.remoteDeliveryConfigured)
          HStack(spacing: 6) {
            statusChip(readiness.settings.alertSettingEnabled ? "alerts on" : "alerts muted")
            statusChip(readiness.settings.badgeSettingEnabled ? "badges on" : "badges muted")
            statusChip(readiness.settings.soundSettingEnabled ? "sounds on" : "sounds muted")
          }
        case let .unavailable(reason):
          readinessRow(title: "Permission", value: displayReason(reason), healthy: false)
        }
        HStack(spacing: 8) {
          Button {
            Task { await pushNotifications.refresh() }
          } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
          }
          .disabled(pushNotifications.state == .loading)

          Button {
            if pushNotifications.state.readiness?.canRequestPermission == false,
               let settingsURL = URL(string: UIApplication.openSettingsURLString) {
              openURL(settingsURL)
            } else {
              Task { await pushNotifications.requestPermission() }
            }
          } label: {
            Label(pushNotifications.state.readiness?.canRequestPermission == false ? "Manage" : "Allow",
                  systemImage: "bell.badge")
          }
          .buttonStyle(FridayButtonStyle(variant: .primary))
          .tint(MobileTheme.cyan)
          .disabled(pushNotifications.state == .loading)
          .accessibilityIdentifier("friday.settings.push-permission")
        }
      }
    }
    .task {
      if pushNotifications.state == .idle {
        await pushNotifications.refresh()
      }
    }
  }

  private func workItemRow(_ item: HomeWorkItem) -> some View {
    let recoveryState = viewModel.workItemStatusStates[item.id]
    return VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(displayWorkItemTitle(item.title, fallback: item.id))
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(MobileTheme.textPrimary)
          .accessibilityIdentifier("friday.workflow.work-item.\(item.id)")
        Spacer()
        FridayChip(
          text: item.done ? "done" : "not done",
          bg: item.done ? MobileTheme.chipDoneBG : MobileTheme.chipNeutralBG,
          fg: item.done ? MobileTheme.chipDoneFG : MobileTheme.chipNeutralFG)
      }
      HStack(spacing: 6) {
        statusChip(displayStatus(item.state))
        statusChip(displayOwner(item.owner))
        statusChip(displayStatus(item.recoveryKind))
      }
      if !item.blockingReason.isEmpty {
        Text(displaySentence(item.blockingReason))
          .font(.system(size: 11))
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if item.canRetry || item.canCancel {
        HStack(spacing: 8) {
          if item.canRetry {
            Button {
              Task { await viewModel.retryWorkItem(item) }
            } label: {
              Image(systemName: "arrow.clockwise")
                .frame(width: 26, height: 26)
            }
            .buttonStyle(FridayButtonStyle(variant: .secondary))
            .disabled(candidateDecisionControlsDisabled(recoveryState))
            .accessibilityLabel("Retry WorkItem")
            .accessibilityIdentifier("friday.workflow.retry-work-item")
          }
          if item.canCancel {
            Button {
              Task { await viewModel.cancelWorkItem(item) }
            } label: {
              Image(systemName: "stop.circle")
                .frame(width: 26, height: 26)
            }
            .buttonStyle(FridayButtonStyle(variant: .secondary))
            .disabled(candidateDecisionControlsDisabled(recoveryState))
            .accessibilityLabel("Cancel WorkItem")
            .accessibilityIdentifier("friday.workflow.cancel-work-item")
          }
        }
        candidateDecisionStateView(recoveryState, pendingText: "Updating WorkItem...")
      }
      if let proofRef = item.proofRef {
        FridayProofLine(label: "receipt", ref: proofRef)
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
          .buttonStyle(FridayButtonStyle(variant: .primary))
          .tint(MobileTheme.cyan)
          .disabled(candidateDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Confirm memory candidate")
          .accessibilityIdentifier("friday.memory.confirm-candidate")

          Button {
            Task { await viewModel.decideMemory(candidateId: candidate.id, confirm: false) }
          } label: {
            Image(systemName: "xmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(FridayButtonStyle(variant: .secondary))
          .disabled(candidateDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Reject memory candidate")
          .accessibilityIdentifier("friday.memory.reject-candidate")
        }
      }
      HStack(spacing: 6) {
        statusChip(candidate.state)
        statusChip(candidate.grantsMemoryAuthority ? "grants authority" : "review only")
      }
      candidateDecisionStateView(decisionState, pendingText: "Applying memory decision...")
      if !candidate.evidenceRef.isEmpty {
        FridayProofLine(label: "evidence", ref: candidate.evidenceRef)
      }
    }
    .padding(.vertical, 4)
  }

  private func learningCandidateRow(_ candidate: HomeRunOutcomeLearningCandidate) -> some View {
    let decisionState = viewModel.runOutcomeLearningDecisionStates[candidate.id]
    return VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .top, spacing: 8) {
        VStack(alignment: .leading, spacing: 3) {
          Text(displayLearningTitle(kind: candidate.kind))
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(MobileTheme.textPrimary)
          Text(displayLearningSubtitle(candidate))
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
        }
          .font(.system(size: 13, weight: .medium))
          .frame(maxWidth: .infinity, alignment: .leading)
        HStack(spacing: 6) {
          Button {
            Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: true) }
          } label: {
            Image(systemName: "checkmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(FridayButtonStyle(variant: .primary))
          .tint(MobileTheme.cyan)
          .disabled(learningDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Confirm run outcome learning candidate")

          Button {
            Task { await viewModel.decideRunOutcomeLearning(candidateId: candidate.id, confirm: false) }
          } label: {
            Image(systemName: "xmark")
              .frame(width: 26, height: 26)
          }
          .buttonStyle(FridayButtonStyle(variant: .secondary))
          .disabled(learningDecisionControlsDisabled(decisionState))
          .accessibilityLabel("Reject run outcome learning candidate")
        }
      }
      HStack(spacing: 6) {
        statusChip(displayStatus(candidate.kind))
        statusChip(displayStatus(candidate.state))
      }
      learningDecisionStateView(decisionState)
      if !candidate.runId.isEmpty {
        FridayProofLine(label: "run", ref: candidate.runId)
      }
      if !candidate.workItemId.isEmpty {
        FridayProofLine(label: "work item", ref: candidate.workItemId)
      }
      if !candidate.evidenceRef.isEmpty {
        FridayProofLine(label: "evidence", ref: candidate.evidenceRef)
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
      Text(displayReason(reason))
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

  private func cardHeader(_ title: String, count: Int?) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      if let count {
        FridayChip(text: "\(count)", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }

  private func emptyText(_ text: String) -> some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(MobileTheme.textSecondary)
  }

  private func statusChip(_ text: String) -> some View {
    FridayChip(text: text, bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
  }

  private func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }

  private func displayWorkItemTitle(_ raw: String, fallback: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = trimmed.lowercased()
    if normalized.contains("refs-only") && normalized.contains("round-trip") {
      return "Review live device round-trip"
    }
    if normalized.contains("bounded mission timeline") {
      return "Mission timeline updated"
    }
    if normalized.contains("desktop surface") {
      return "Desktop surface linked"
    }
    if normalized.hasPrefix("proof://") || normalized.hasPrefix("proof:/") {
      return "Route decision"
    }
    return displayTitle(trimmed.isEmpty ? fallback : trimmed)
  }

  private func displayEventSection(_ raw: String) -> String {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalized.contains("transcript") {
      return "Activity"
    }
    return displayTitle(raw)
  }

  private func displayEventSummary(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = trimmed.lowercased()
    if normalized.contains("bounded mission timeline") {
      return "Mission timeline updated"
    }
    if normalized.contains("desktop surface") {
      return "Desktop surface linked"
    }
    if normalized.hasPrefix("proof://") || normalized.hasPrefix("proof:/") {
      return "Route decision receipt"
    }
    return displayTitle(trimmed.isEmpty ? "Activity update" : trimmed)
  }

  private func displayOwner(_ raw: String) -> String {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalized == "friday_owned" || normalized == "friday-owned" {
      return "Friday"
    }
    return displayStatus(raw)
  }

  private func displayStatus(_ raw: String) -> String {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch normalized {
    case "ready_to_dispatch", "ready for dispatch":
      return "ready"
    case "timeline_read":
      return "timeline"
    case "completed_with_proof":
      return "complete"
    case "waiting", "queued", "pending":
      return "in queue"
    case "blocked":
      return "needs attention"
    case "off", "disabled":
      return "needs setup"
    case "":
      return "status"
    default:
      return displaySentence(raw)
    }
  }

  private func displayReason(_ raw: String) -> String {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if normalized.isEmpty {
      return "Friday needs a live Hub connection before this action can continue."
    }
    if normalized.contains("server dark") || normalized.contains("transport")
      || normalized.contains("connection") || normalized.contains("offline")
    {
      return "Friday cannot reach the live Hub from this device. Check the connection, then try again."
    }
    if normalized.contains("api_key_missing") {
      return "Connect this provider account before Friday can route work there."
    }
    if normalized.contains("route_disabled") || normalized.contains("route_validation_not_ok") {
      return "Enable and recheck this route before Friday can use it."
    }
    if normalized.contains("approval") || normalized.contains("operator") {
      return "Approval is needed before Friday can continue."
    }
    return displaySentence(raw)
  }

  private func displayLearningTitle(kind: String) -> String {
    let label = displayStatus(kind)
    if label.contains("preference") {
      return "Review preference"
    }
    if label.contains("world") || label.contains("model") {
      return "Review world model"
    }
    if label.contains("memory") {
      return "Review memory learning"
    }
    return "Review learning"
  }

  private func displayLearningSubtitle(_ candidate: HomeRunOutcomeLearningCandidate) -> String {
    let summary = candidate.summary.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalized = summary.lowercased()
    if !summary.isEmpty
      && !normalized.contains("candidate_kind=")
      && !normalized.contains("kind=")
      && !normalized.contains("state=")
      && !normalized.contains(";")
    {
      return displaySentence(summary)
    }
    return "\(displayStatus(candidate.kind)) candidate is \(displayStatus(candidate.state))."
  }

  private func displayTitle(_ raw: String) -> String {
    let clean = displaySentence(raw)
    guard let first = clean.first else { return "Friday update" }
    return first.uppercased() + clean.dropFirst()
  }

  private func displaySentence(_ raw: String) -> String {
    raw
      .replacingOccurrences(of: "refs-only", with: "receipt")
      .replacingOccurrences(of: "Proof://", with: "")
      .replacingOccurrences(of: "proof://", with: "")
      .replacingOccurrences(of: "_", with: " ")
      .replacingOccurrences(of: "-", with: " ")
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }
}
