import FridayHubConsoleCore
import SwiftUI

struct DesktopSessionDetailScreen: View {
  @ObservedObject var viewModel: OperationsOverviewViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      stateContent
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(HubTheme.backgroundWarmOffWhite)
    .accessibilityIdentifier("friday.desktop.session-detail")
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "rectangle.connected.to.line.below")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(HubTheme.cyan)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        Text("Session Detail")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text("Transcript, link state, and provider-session refs")
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
      }
      Spacer()
      Button {
        Task { await viewModel.refresh() }
      } label: {
        Label("Refresh", systemImage: "arrow.clockwise")
      }
      .buttonStyle(.borderedProminent)
      .tint(HubTheme.cyan)
      .disabled(viewModel.state.isLoading)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 16)
  }

  @ViewBuilder
  private var stateContent: some View {
    switch viewModel.state {
    case .idle, .loading:
      loadingView
    case let .loaded(snapshot):
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          sessionActions(snapshot)
          detailResult
          sessionFacts(snapshot)
          transcriptRefs(snapshot)
        }
        .padding(20)
      }
    case let .unavailable(reason):
      UnavailableView(reason: reason)
    }
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading session projection...")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private func sessionActions(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Session Read Arms")
          Spacer()
          if let agentSessionId = snapshot.agentSessionId {
            StatusChip(text: "session projected", bg: HubTheme.chipPendingBG, fg: HubTheme.chipPendingFG)
            RefPill(label: "agent_session_id", ref: agentSessionId)
          } else {
            StatusChip(text: "no session ref", bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
          }
        }

        Text("These controls read existing Hub session projections only. They do not execute provider actions, mint signatures, or mutate memory.")
          .font(.system(size: 11))
          .foregroundStyle(HubTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)

        HStack(spacing: 8) {
          Button {
            Task { await viewModel.loadDetail(.sessionList) }
          } label: {
            Label("List Sessions", systemImage: "rectangle.stack")
          }
          .buttonStyle(.bordered)
          .disabled(viewModel.detailState.isLoading)

          Button {
            if let agentSessionId = snapshot.agentSessionId {
              Task { await viewModel.loadDetail(.sessionOpen(agentSessionId: agentSessionId)) }
            }
          } label: {
            Label("Open Transcript", systemImage: "text.bubble")
          }
          .buttonStyle(.bordered)
          .disabled(viewModel.detailState.isLoading || snapshot.agentSessionId == nil)

          Button {
            if let agentSessionId = snapshot.agentSessionId {
              Task { await viewModel.loadDetail(.sessionLinkState(agentSessionId: agentSessionId)) }
            }
          } label: {
            Label("Link State", systemImage: "link")
          }
          .buttonStyle(.bordered)
          .disabled(viewModel.detailState.isLoading || snapshot.agentSessionId == nil)
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
            .fixedSize(horizontal: false, vertical: true)
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
          Text(userFacingReason(reason))
            .font(.system(size: 12))
            .foregroundStyle(HubTheme.textSecondary)
        }
      }
    }
  }

  private func sessionFacts(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Mission Session Context")
        factRow("mission", snapshot.missionId)
        factRow("conversation", snapshot.fridayConversationId)
        if let agentSessionId = snapshot.agentSessionId {
          factRow("agent session", agentSessionId)
        }
        HStack(spacing: 6) {
          snapshot.runtimeFeedStatus.chip
          if snapshot.isLoadedEmpty {
            StatusChip(text: "loaded empty", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
          }
        }
      }
    }
  }

  private func transcriptRefs(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Transcript Proof Refs")
          Spacer()
          StatusChip(text: "\(sessionRefs(snapshot).count)", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
        }
        let refs = sessionRefs(snapshot)
        if refs.isEmpty {
          Text("No provider-session refs are projected yet.")
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

  private func factRow(_ label: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(label)
        .font(.system(size: 11))
        .foregroundStyle(HubTheme.textSecondary)
        .frame(width: 96, alignment: .leading)
      Text(value)
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(HubTheme.textPrimary)
        .lineLimit(2)
        .minimumScaleFactor(0.8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func sessionRefs(_ snapshot: WorkbenchSnapshot) -> [String] {
    var refs: [String] = []
    if let agentSessionId = snapshot.agentSessionId {
      refs.append(agentSessionId)
    }
    for section in snapshot.transcriptSections {
      for event in section.events where section.groupKind == .providerSession || event.surface == .timeline {
        if let proofRef = event.proofRef { refs.append(proofRef) }
        refs.append(contentsOf: event.evidenceRefs.orderedPairs.map(\.ref))
      }
    }
    return unique(refs)
  }

  private func unique(_ refs: [String]) -> [String] {
    var seen = Set<String>()
    return refs.filter { !$0.isEmpty && seen.insert($0).inserted }
  }

  private func cardTitle(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(HubTheme.textPrimary)
  }

  private func userFacingReason(_ reason: String) -> String {
    let normalized = reason.lowercased()
    if normalized.contains("offline") || normalized.contains("transport") || normalized.contains("connection") {
      return "Friday cannot reach the live Hub from this window. Check the connection, then refresh."
    }
    return "Friday needs a fresh live session view before this screen can continue."
  }
}

#Preview("Session Detail · loaded") {
  HubConsoleShell(client: MockReadClient(behavior: .loaded))
    .frame(width: 1180, height: 720)
}
