import FridayMobileShellCore
import FridayRustClient
import SwiftUI

private enum ProjectionSurface {
  case platform
  case activity
  case workflows
  case settings

  init?(_ destination: MobileDestination) {
    switch destination {
    case .home:
      return nil
    case .platform:
      self = .platform
    case .activity:
      self = .activity
    case .workflows:
      self = .workflows
    case .settings:
      self = .settings
    }
  }

  var icon: String {
    switch self {
    case .platform: return "square.grid.2x2"
    case .activity: return "bell.badge"
    case .workflows: return "arrow.triangle.branch"
    case .settings: return "gearshape"
    }
  }

  var title: String {
    switch self {
    case .platform: return "Platform"
    case .activity: return "Activity"
    case .workflows: return "Workflows"
    case .settings: return "Settings"
    }
  }

  var statusLabel: String {
    switch self {
    case .platform: return "runtime"
    case .activity: return "activity"
    case .workflows: return "routing"
    case .settings: return "read seam"
    }
  }

  func detailRows(for projection: HomeProjection) -> [ProjectionRow] {
    switch self {
    case .platform:
      return [
        .init(label: "feed", value: projection.runtimeFeedStatus),
        .init(label: "mission_id", value: projection.missionId),
        .init(label: "conversation_id", value: projection.fridayConversationId),
        .init(label: "route", value: projection.routeDecisionSummary ?? "no route ref"),
      ]
    case .activity:
      return [
        .init(label: "mission_id", value: projection.missionId),
        .init(label: "work_item_refs", value: "\(projection.workItemIds.count)"),
        .init(label: "labels", value: projection.statusLabels.isEmpty ? "none" : projection.statusLabels.joined(separator: ", ")),
        .init(label: "generated", value: ProjectionSurface.generatedText(projection.generatedAtMs)),
      ]
    case .workflows:
      return [
        .init(label: "route", value: projection.routeDecisionSummary ?? "no route ref"),
        .init(label: "mission_id", value: projection.missionId),
        .init(label: "work_item_refs", value: "\(projection.workItemIds.count)"),
      ]
    case .settings:
      return [
        .init(label: "mode", value: "live-read projection"),
        .init(label: "protocol", value: "v\(fridayCurrentSchemaVersion)"),
        .init(label: "feed", value: projection.runtimeFeedStatus),
        .init(label: "generated", value: ProjectionSurface.generatedText(projection.generatedAtMs)),
      ]
    }
  }

  private static func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}

private struct ProjectionRow: Identifiable {
  var id: String { label }
  let label: String
  let value: String
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

  private func loadedContent(_ surface: ProjectionSurface, _ projection: HomeProjection) -> some View {
    VStack(spacing: 16) {
      if !projection.statusLabels.isEmpty {
        StatusBanner(labels: projection.statusLabels)
      }
      detailCard(surface, projection)
      if surface != .settings {
        refsCard(projection)
      }
    }
  }

  private func detailCard(_ surface: ProjectionSurface, _ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        ForEach(surface.detailRows(for: projection)) { row in
          VStack(alignment: .leading, spacing: 4) {
            Text(row.label)
              .font(.caption2)
              .foregroundStyle(MobileTheme.textSecondary)
            Text(row.value)
              .font(.system(size: 13, design: .monospaced))
              .foregroundStyle(MobileTheme.textMono)
              .lineLimit(2)
              .truncationMode(.middle)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }

  private func refsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Work item refs")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: "\(projection.workItemIds.count)",
            bg: MobileTheme.chipNeutralBG,
            fg: MobileTheme.chipNeutralFG)
        }
        if projection.workItemIds.isEmpty {
          Text("No refs in this projection.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        } else {
          ForEach(projection.workItemIds, id: \.self) { id in
            RefPill(label: "workItemId", ref: id)
          }
        }
      }
    }
  }
}
