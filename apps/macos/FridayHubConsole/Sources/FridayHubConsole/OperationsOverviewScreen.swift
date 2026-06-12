import FridayHubConsoleCore
import SwiftUI

/// The center pane: Operations Overview — a READ-ONLY typed projection of hub truth.
///
/// Truth rules enforced here:
///  - refs only (ledger/result/activity refs shown, never inline bodies),
///  - 503 / stale / offline render AS truth (honest unavailable banner/state),
///  - the only actions are RefreshStatus and OpenEvidence-class selection,
///  - NO mutating action, NO provider-admin exec, NO NO-GO row made executable.
struct OperationsOverviewScreen: View {
  @ObservedObject var viewModel: OperationsOverviewViewModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header

      Group {
        switch viewModel.state {
        case .idle, .loading:
          loadingView
        case let .loaded(snapshot):
          loadedView(snapshot)
        case let .unavailable(reason):
          UnavailableView(reason: reason)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .background(HubTheme.backgroundWarmOffWhite)
  }

  // MARK: Header (title + the single read-only refresh action)

  private var header: some View {
    HStack(alignment: .center) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Operations Overview")
          .font(.system(size: 20, weight: .semibold))
          .foregroundStyle(HubTheme.textPrimary)
        Text("Read-only projection of Rust Hub Mission truth")
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

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading hub projection…")
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  // MARK: Loaded

  @ViewBuilder
  private func loadedView(_ snapshot: WorkbenchSnapshot) -> some View {
    ScrollView {
      loadedContent(snapshot)
    }
  }

  /// The loaded card stack. Factored out of `ScrollView` so the visual-QA proof harness can
  /// rasterize it directly (`ImageRenderer` does not expand a `ScrollView`'s lazy content).
  @ViewBuilder
  func loadedContent(_ snapshot: WorkbenchSnapshot) -> some View {
    VStack(alignment: .leading, spacing: 16) {
      // Honest status banner — stale/offline/error labels render AS truth.
      if !snapshot.statusLabels.isEmpty || !snapshot.runtimeFeedStatus.isHealthy {
        StatusBanner(snapshot: snapshot)
      }

      missionCard(snapshot)
      routeDecisionCard(snapshot)
      workItemsCard(snapshot)
      capabilityCard(snapshot)
      receiptsCard(snapshot)
      transcriptCard(snapshot)
      memoryCard(snapshot)
    }
    .padding(20)
  }

  private func missionCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Mission")
        HStack(spacing: 8) {
          snapshot.runtimeFeedStatus.isHealthy
            ? StatusChip(
              text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipPendingBG,
              fg: HubTheme.chipPendingFG)
            : StatusChip(
              text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipWarnBG,
              fg: HubTheme.chipWarnFG)
        }
        RefPill(label: "mission_id", ref: snapshot.missionId)
        RefPill(label: "friday_conversation_id", ref: snapshot.fridayConversationId)
      }
    }
  }

  private func routeDecisionCard(_ snapshot: WorkbenchSnapshot) -> some View {
    SelectableCard(isSelected: viewModel.selection == .routeDecision) {
      viewModel.select(.routeDecision)
    } content: {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        HStack {
          cardTitle("Route Decision")
          Spacer()
          snapshot.routeDecision.truthLabel.chip
        }
        Text(snapshot.routeDecision.advisorSummary)
          .font(.system(size: 12))
          .foregroundStyle(HubTheme.textSecondary)
        RefPill(label: "selectedRoute", ref: snapshot.routeDecision.selectedRoute)
        Text("Advisory only — the UI does not choose routes.")
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
      }
    }
  }

  private func workItemsCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Work Items")
        ForEach(snapshot.workItems) { item in
          WorkItemRow(
            item: item,
            isSelected: viewModel.selection == .workItem(id: item.id)
          ) {
            viewModel.select(.workItem(id: item.id))
          }
        }
      }
    }
  }

  private func capabilityCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Capabilities")
        Text("Approval / dispatch state shown as status only — never executable from here.")
          .font(.system(size: 10))
          .foregroundStyle(HubTheme.textSecondary)
        ForEach(snapshot.capabilityStates) { cap in
          CapabilityRow(
            capability: cap,
            isSelected: viewModel.selection == .capability(id: cap.id)
          ) {
            viewModel.select(.capability(id: cap.id))
          }
        }
      }
    }
  }

  private func receiptsCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Receipt Refs")
        if !snapshot.providerReceiptRefs.isEmpty {
          Text("Provider").font(.system(size: 11, weight: .semibold)).foregroundStyle(
            HubTheme.textSecondary)
          ForEach(snapshot.providerReceiptRefs, id: \.self) { RefPill(label: nil, ref: $0) }
        }
        if !snapshot.channelReceiptRefs.isEmpty {
          Text("Channel").font(.system(size: 11, weight: .semibold)).foregroundStyle(
            HubTheme.textSecondary)
          ForEach(snapshot.channelReceiptRefs, id: \.self) { RefPill(label: nil, ref: $0) }
        }
      }
    }
  }

  private func transcriptCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Transcript Sections")
        ForEach(snapshot.transcriptSections) { section in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(section.title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(HubTheme.textPrimary)
              Spacer()
              section.status.chip
            }
            ForEach(section.events) { event in
              TranscriptEventRow(
                event: event,
                isSelected: viewModel.selection == .transcriptEvent(id: event.id)
              ) {
                viewModel.select(.transcriptEvent(id: event.id))
              }
            }
          }
          .padding(.vertical, 4)
        }
      }
    }
  }

  private func memoryCard(_ snapshot: WorkbenchSnapshot) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: HubTheme.rowSpacing) {
        cardTitle("Memory Candidates")
        ForEach(snapshot.memoryCandidates) { candidate in
          VStack(alignment: .leading, spacing: 4) {
            HStack {
              Text(candidate.preview)
                .font(.system(size: 12))
                .foregroundStyle(HubTheme.textPrimary)
              Spacer()
              StatusChip(text: "review only", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
            }
            RefPill(label: "evidenceRef", ref: candidate.evidenceRef)
          }
        }
      }
    }
  }

  private func cardTitle(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(HubTheme.textPrimary)
  }
}

// MARK: - Honest unavailable + status banner

/// Rendered when `fetchWorkbench()` throws (503 / offline / projection error).
/// This is the honest "unavailable" state — never a fake-ready screen.
struct UnavailableView: View {
  let reason: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 28))
        .foregroundStyle(HubTheme.coral)
      Text("Hub projection unavailable")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(HubTheme.textPrimary)
      Text(reason)
        .font(.system(size: 12))
        .foregroundStyle(HubTheme.textSecondary)
        .multilineTextAlignment(.center)
      Text("Showing this as truth — no cached or fabricated status is presented.")
        .font(.system(size: 10))
        .foregroundStyle(HubTheme.textSecondary)
    }
    .padding(28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// Honest banner for stale/offline/error labels and pending feeds.
struct StatusBanner: View {
  let snapshot: WorkbenchSnapshot

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.circle")
        .foregroundStyle(HubTheme.chipWarnFG)
      ForEach(snapshot.statusLabels, id: \.rawValue) { label in
        StatusChip(text: label.displayText, bg: HubTheme.chipWarnBG, fg: HubTheme.chipWarnFG)
      }
      if !snapshot.runtimeFeedStatus.isHealthy {
        StatusChip(
          text: snapshot.runtimeFeedStatus.displayText, bg: HubTheme.chipWarnBG,
          fg: HubTheme.chipWarnFG)
      }
      Text("This projection is flagged — rendered as-is, not upgraded.")
        .font(.system(size: 11))
        .foregroundStyle(HubTheme.textSecondary)
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
        .fill(HubTheme.coralSoft)
    )
  }
}

// MARK: - Rows

/// A card whose whole body is a read-only select affordance (OpenEvidence nav).
struct SelectableCard<Content: View>: View {
  let isSelected: Bool
  let onSelect: () -> Void
  let content: Content

  init(isSelected: Bool, onSelect: @escaping () -> Void, @ViewBuilder content: () -> Content) {
    self.isSelected = isSelected
    self.onSelect = onSelect
    self.content = content()
  }

  var body: some View {
    Button(action: onSelect) {
      content
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(HubTheme.panelPadding)
        .background(
          RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
            .fill(HubTheme.glassPanel)
            .overlay(
              RoundedRectangle(cornerRadius: HubTheme.cornerRadius, style: .continuous)
                .strokeBorder(
                  isSelected ? HubTheme.cyan : HubTheme.glassPanelBorder,
                  lineWidth: isSelected ? 1.5 : 1)
            )
        )
    }
    .buttonStyle(.plain)
  }
}

struct WorkItemRow: View {
  let item: MissionWorkbenchWorkItem
  let isSelected: Bool
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(item.title)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(HubTheme.textPrimary)
          Spacer()
          // `done` strictly from the projection's done field — provider_ack/linked
          // items are explicitly NOT done.
          if item.done {
            StatusChip(text: "done", bg: HubTheme.chipDoneBG, fg: HubTheme.chipDoneFG)
          } else {
            StatusChip(text: "not done", bg: HubTheme.chipNeutralBG, fg: HubTheme.chipNeutralFG)
          }
        }
        HStack(spacing: 6) {
          item.state.chip
          item.owner.chip
        }
        if let proof = item.proofRef {
          RefPill(label: "proofRef", ref: proof)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(rowBackground)
    }
    .buttonStyle(.plain)
  }

  private var rowBackground: some View {
    RoundedRectangle(cornerRadius: 8, style: .continuous)
      .fill(isSelected ? HubTheme.cyanSoft : Color.black.opacity(0.02))
  }
}

struct CapabilityRow: View {
  let capability: MissionWorkbenchCapabilityState
  let isSelected: Bool
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Text(capability.label)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(HubTheme.textPrimary)
          Spacer()
          // dispatchAllowed shown as a STATUS indicator only — never a button.
          StatusChip(
            text: capability.dispatchAllowed ? "dispatch allowed" : "dispatch gated",
            bg: capability.dispatchAllowed ? HubTheme.chipPendingBG : HubTheme.chipNeutralBG,
            fg: capability.dispatchAllowed ? HubTheme.chipPendingFG : HubTheme.chipNeutralFG)
        }
        HStack(spacing: 6) {
          StatusChip(
            text: capability.approvalState.displayText, bg: HubTheme.chipNeutralBG,
            fg: HubTheme.chipNeutralFG)
          capability.truthLabel.chip
        }
        RefPill(label: "proofRef", ref: capability.proofRef)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(
        RoundedRectangle(cornerRadius: 8, style: .continuous)
          .fill(isSelected ? HubTheme.cyanSoft : Color.black.opacity(0.02)))
    }
    .buttonStyle(.plain)
  }
}

struct TranscriptEventRow: View {
  let event: MissionTranscriptEvent
  let isSelected: Bool
  let onSelect: () -> Void

  var body: some View {
    Button(action: onSelect) {
      VStack(alignment: .leading, spacing: 4) {
        HStack {
          Text(event.summary)
            .font(.system(size: 11))
            .foregroundStyle(HubTheme.textSecondary)
            .lineLimit(2)
          Spacer()
          event.truthLabel.chip
        }
        RefPill(label: "activity_id", ref: event.id)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(8)
      .background(
        RoundedRectangle(cornerRadius: 7, style: .continuous)
          .fill(isSelected ? HubTheme.cyanSoft : Color.clear))
    }
    .buttonStyle(.plain)
  }
}
