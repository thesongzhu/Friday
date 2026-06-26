import FridayMobileShellCore
import SwiftUI

struct FridayProviderAuthScreen: View {
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        header
        workspaceStateCard
        doctorActionCard
        detailCard
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
    .task {
      if case .idle = viewModel.detailState {
        await viewModel.loadDetail(.providersDoctor(probe: nil))
      }
    }
  }

  private var header: some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: "person.badge.key")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(MobileTheme.cyan)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("Provider Workspace")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("provider readiness, queues, sessions, and native-control truth")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
      }
    }
    .accessibilityIdentifier("friday.provider-auth.header")
  }

  private var doctorActionCard: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        Text("Provider Doctor")
          .font(.headline)
          .foregroundStyle(MobileTheme.textPrimary)
        Text("Checks provider CLI/auth/route readiness through the Hub read arm. This surface never asks for, stores, or displays provider secrets.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        Button {
          Task { await viewModel.loadDetail(.providersDoctor(probe: nil)) }
        } label: {
          Label("Check Provider Auth", systemImage: "stethoscope")
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(MobileTheme.cyan)
        .disabled(viewModel.detailState.isLoading)
        .accessibilityIdentifier("friday.provider-auth.check")
      }
    }
  }

  @ViewBuilder
  private var workspaceStateCard: some View {
    switch viewModel.state {
    case .idle, .loading:
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text("Reading Provider Workspace projection")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .unavailable(let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          workspaceHeader("Provider Workspace", chip: "offline", healthy: false)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Text("No provider status, session state, or capability readiness is fabricated while the Hub is unavailable.")
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .loaded(let projection):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          workspaceHeader("Provider Workspace", chip: "live read", healthy: true)
          routeDecisionCard(projection)
          providerQueueSummary(projection)
          ledgerAndReceiptSummary(projection)
          nativeControlTruth(projection)
          providerRefs(projection)
        }
      }
      .accessibilityIdentifier("friday.provider-workspace.overview")
    }
  }

  private func workspaceHeader(_ title: String, chip: String, healthy: Bool) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      StatusChip(
        text: chip,
        bg: healthy ? MobileTheme.chipDoneBG : MobileTheme.chipWarnBG,
        fg: healthy ? MobileTheme.chipDoneFG : MobileTheme.chipWarnFG)
    }
  }

  private func providerQueueSummary(_ projection: HomeProjection) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        metricPill("Needs Me", "\(projection.needsMeCount)")
        metricPill("Running", "\(projection.workItems.filter { !$0.done }.count)")
        metricPill("Capabilities", "\(projection.capabilityStates.count)")
      }
      Text("Provider Workspace Home: route, queue, session controls, and cost refs are surfaced from the Hub projection; unavailable actions stay explicit instead of becoming fake ready.")
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      let providerItems = projection.providerWorkItems
      if providerItems.isEmpty {
        Text("No provider-linked WorkItem refs in the current projection.")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
      } else {
        Text("Provider-linked WorkItems")
          .font(.caption.weight(.semibold))
          .foregroundStyle(MobileTheme.textPrimary)
        ForEach(providerItems.prefix(3)) { item in
          providerWorkItemRow(item)
        }
      }
    }
    .accessibilityIdentifier("friday.provider-workspace.provider-work-items")
  }

  private func providerWorkItemRow(_ item: HomeWorkItem) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Image(systemName: item.needsAttention ? "exclamationmark.triangle" : "circle.dashed")
          .foregroundStyle(item.needsAttention ? MobileTheme.coral : MobileTheme.textSecondary)
          .frame(width: 18)
        VStack(alignment: .leading, spacing: 2) {
          Text(item.title)
            .font(.caption.weight(.semibold))
            .foregroundStyle(MobileTheme.textPrimary)
            .lineLimit(1)
          Text("\(item.owner) · \(item.state)")
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
            .lineLimit(1)
        }
        Spacer()
        StatusChip(
          text: item.done ? "done" : (item.needsAttention ? "needs action" : "visible"),
          bg: item.done ? MobileTheme.chipDoneBG : (item.needsAttention ? MobileTheme.chipWarnBG : MobileTheme.chipNeutralBG),
          fg: item.done ? MobileTheme.chipDoneFG : (item.needsAttention ? MobileTheme.chipWarnFG : MobileTheme.chipNeutralFG))
      }
      if !item.blockingReason.isEmpty {
        Text(item.blockingReason)
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if let proofRef = item.proofRef, !proofRef.isEmpty {
        RefPill(label: "work_item_proof", ref: proofRef)
      }
      if item.canRetry || item.canCancel {
        HStack(spacing: 8) {
          if item.canRetry {
            StatusChip(text: "retry exposed on Home", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
          }
          if item.canCancel {
            StatusChip(text: "cancel exposed on Home", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
          }
        }
      }
    }
    .padding(10)
    .background(MobileTheme.chipNeutralBG, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func routeDecisionCard(_ projection: HomeProjection) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Route")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(MobileTheme.textPrimary)
      if let route = projection.routeSelected {
        controlRow("Selected provider", state: route, healthy: true)
      } else {
        controlRow("Selected provider", state: "not projected", healthy: false)
      }
      if let summary = projection.routeDecisionSummary, !summary.isEmpty {
        Text(summary)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      if !projection.routeAlternatives.isEmpty {
        Text("alternates: \(projection.routeAlternatives.joined(separator: ", "))")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityIdentifier("friday.provider-workspace.route")
  }

  private func ledgerAndReceiptSummary(_ projection: HomeProjection) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Cost & Evidence")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(MobileTheme.textPrimary)
      controlRow(
        "Token ledger",
        state: projection.tokenLedgerRunId == nil ? "needs run ref" : "run readback ready",
        healthy: projection.tokenLedgerRunId != nil)
      controlRow(
        "Provider receipts",
        state: projection.providerReceiptRefs.isEmpty ? "none projected" : "\(projection.providerReceiptRefs.count) refs",
        healthy: !projection.providerReceiptRefs.isEmpty)
      controlRow(
        "Channel receipts",
        state: projection.channelReceiptRefs.isEmpty ? "none projected" : "\(projection.channelReceiptRefs.count) refs",
        healthy: !projection.channelReceiptRefs.isEmpty)
      if let runId = projection.tokenLedgerRunId {
        Button {
          Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
        } label: {
          Label("Open Ledger", systemImage: "chart.bar.doc.horizontal")
        }
        .buttonStyle(.bordered)
        .disabled(viewModel.detailState.isLoading)
        .accessibilityIdentifier("friday.provider-workspace.open-ledger")
      }
    }
    .accessibilityIdentifier("friday.provider-workspace.cost-evidence")
  }

  private func nativeControlTruth(_ projection: HomeProjection) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Native Controls")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(MobileTheme.textPrimary)
      controlRow("Provider doctor", state: "live read", healthy: true)
      controlRow("Session list", state: "live read", healthy: true)
      controlRow(
        "Session open/link",
        state: projection.agentSessionId == nil ? "needs session ref" : "live read",
        healthy: projection.agentSessionId != nil)
      controlRow("Send / stop / steer / resume", state: "governed action gated", healthy: false)
      controlRow("Secrets / login custody", state: "never stored here", healthy: false)
      Text("Native session controls are visible here only when Friday has a session ref and the governed write/approval seams are configured. The app does not hold provider login custody or signing-key material.")
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        Button {
          Task { await viewModel.loadDetail(.sessionList) }
        } label: {
          Label("Sessions", systemImage: "rectangle.stack")
        }
        .disabled(viewModel.detailState.isLoading)
        .accessibilityIdentifier("friday.provider-workspace.sessions")
        if let agentSessionId = projection.agentSessionId {
          Button {
            Task { await viewModel.loadDetail(.sessionOpen(agentSessionId: agentSessionId)) }
          } label: {
            Label("Open", systemImage: "text.bubble")
          }
          .disabled(viewModel.detailState.isLoading)
          .accessibilityIdentifier("friday.provider-workspace.session-open")
          Button {
            Task { await viewModel.loadDetail(.sessionLinkState(agentSessionId: agentSessionId)) }
          } label: {
            Label("Link", systemImage: "link")
          }
          .disabled(viewModel.detailState.isLoading)
          .accessibilityIdentifier("friday.provider-workspace.session-link")
        }
      }
      .buttonStyle(.bordered)
    }
  }

  private func providerRefs(_ projection: HomeProjection) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      if let route = projection.routeSelected {
        RefPill(label: "selected_route", ref: route)
      }
      ForEach(projection.providerReceiptRefs.prefix(3), id: \.self) { ref in
        RefPill(label: "provider_receipt", ref: ref)
      }
      RefPill(label: "mission_id", ref: projection.missionId)
    }
  }

  private func metricPill(_ label: String, _ value: String) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(value)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      Text(label)
        .font(.caption2)
        .foregroundStyle(MobileTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(MobileTheme.chipNeutralBG, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
  }

  private func controlRow(_ title: String, state: String, healthy: Bool) -> some View {
    HStack(spacing: 8) {
      Image(systemName: healthy ? "checkmark.circle" : "lock.circle")
        .foregroundStyle(healthy ? MobileTheme.cyan : MobileTheme.textSecondary)
        .frame(width: 18)
      Text(title)
        .font(.caption)
        .foregroundStyle(MobileTheme.textPrimary)
      Spacer()
      StatusChip(
        text: state,
        bg: healthy ? MobileTheme.chipDoneBG : MobileTheme.chipNeutralBG,
        fg: healthy ? MobileTheme.chipDoneFG : MobileTheme.chipNeutralFG)
    }
  }

  @ViewBuilder
  private var detailCard: some View {
    switch viewModel.detailState {
    case .idle:
      EmptyView()
    case .loading:
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text("Reading provider doctor")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .loaded(let detail):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          HStack {
            Text(detail.title)
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            StatusChip(
              text: detail.providerReadiness == nil ? "readback" : "provider doctor",
              bg: MobileTheme.chipPendingBG,
              fg: MobileTheme.chipPendingFG)
          }
          Text(detail.summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          RefPill(label: "generated", ref: generatedText(detail.generatedAtMs))
          if let providerReadiness = detail.providerReadiness {
            ProviderReadinessPanel(detail: providerReadiness)
          } else {
            genericReadbackFacts(detail)
          }
          detailRefs(detail.refs)
        }
      }
      .accessibilityIdentifier("friday.provider-auth.detail")
    case .unavailable(let title, let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          Text(title)
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  @ViewBuilder
  private func genericReadbackFacts(_ detail: HomeReadDetail) -> some View {
    if detail.facts.isEmpty {
      Text("The latest read result returned no typed facts; refs below remain the only evidence.")
        .font(.caption)
        .foregroundStyle(MobileTheme.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    } else {
      VStack(alignment: .leading, spacing: 8) {
        Text("Readback Facts")
          .font(.caption.weight(.semibold))
          .foregroundStyle(MobileTheme.textPrimary)
        ForEach(detail.facts) { fact in
          factRow(fact)
        }
      }
      .accessibilityIdentifier("friday.provider-auth.readback-facts")
    }
  }

  @ViewBuilder
  private func detailRefs(_ refs: [String]) -> some View {
    if !refs.isEmpty {
      VStack(alignment: .leading, spacing: 8) {
        Text("Evidence Refs")
          .font(.caption.weight(.semibold))
          .foregroundStyle(MobileTheme.textPrimary)
        ForEach(refs, id: \.self) { ref in
          RefPill(label: "proof", ref: ref)
        }
      }
    }
  }

  private func factRow(_ fact: HomeReadDetailFact) -> some View {
    HStack(spacing: 10) {
      Text(fact.label)
        .font(.caption)
        .foregroundStyle(MobileTheme.textSecondary)
        .frame(width: 92, alignment: .leading)
      Text(fact.value)
        .font(.caption.monospacedDigit())
        .foregroundStyle(MobileTheme.textPrimary)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 8)
    .background(MobileTheme.chipNeutralBG, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
  }

  private func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
