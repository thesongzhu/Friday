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
          providerQueueSummary(projection)
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
      if projection.workItems.isEmpty {
        Text("No provider work-item refs in the current projection.")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
      } else {
        ForEach(projection.workItems.prefix(3)) { item in
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
          }
        }
      }
    }
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
      controlRow("Send / stop / steer / resume", state: "governed session surface", healthy: false)
      controlRow("Secrets / login custody", state: "never stored here", healthy: false)
      HStack(spacing: 8) {
        Button {
          Task { await viewModel.loadDetail(.sessionList) }
        } label: {
          Label("Sessions", systemImage: "rectangle.stack")
        }
        .disabled(viewModel.detailState.isLoading)
        if let agentSessionId = projection.agentSessionId {
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
              text: detail.providerReadiness == nil ? "not provider doctor" : "read",
              bg: detail.providerReadiness == nil ? MobileTheme.chipWarnBG : MobileTheme.chipPendingBG,
              fg: detail.providerReadiness == nil ? MobileTheme.chipWarnFG : MobileTheme.chipPendingFG)
          }
          Text(detail.summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if let providerReadiness = detail.providerReadiness {
            ProviderReadinessPanel(detail: providerReadiness)
          } else {
            Text("The latest read result is not a provider doctor projection.")
              .font(.caption)
              .foregroundStyle(MobileTheme.textSecondary)
          }
          ForEach(detail.refs, id: \.self) { ref in
            RefPill(label: "proof", ref: ref)
          }
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
}
