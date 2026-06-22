import FridayMobileShellCore
import FridayRustClient
import SwiftUI

/// Friday Home (locked: launch = Home; homeLayout = Status + chat-entry;
/// petProminence = heroPet).
///
/// Home = Status + heroPet, derived from a READ-ONLY refs-only `HomeProjection` read over the
/// sealed-WS read seam (`SealedWSReadClient`). The Friday Chat entry is the top-bar 💬 (wired in
/// `RootView`) — there is NO on-Home chat card and NO composer here.
///
/// Truth rules: the projection is refs-only (counts/labels/ids — never a body); the
/// `runtimeFeedStatus` + `statusLabels` ride AS-IS (never upgraded); a 503 / offline / dark
/// server renders AS truth (honest-unavailable), never a fabricated ready Home. The only action
/// is Refresh (re-read) — there is NO mutating action on this surface.
struct FridayHomeScreen: View {
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        // The 155px pure-dog Hero Pet card ALWAYS anchors Home (locked: petProminence = heroPet
        // on Friday Home, mobile-gallery.html `heroBlock()`). It is a LOCAL, zero-token mood
        // companion — independent of the read seam — so it renders regardless of read state
        // (loading / loaded / honest-unavailable). It carries NO status text/badges; the honest
        // read-seam status truth lives in the state-driven content below.
        HeroPet().padding(.top, 6)

        switch viewModel.state {
        case .idle, .loading:
          loadingView
        case .loaded(let projection):
          loadedContent(projection)
        case let .unavailable(reason):
          UnavailableView(reason: reason)
        }
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Reading hub projection…")
        .font(.footnote)
        .foregroundStyle(MobileTheme.textSecondary)
    }
    .frame(maxWidth: .infinity, minHeight: 160)
  }

  /// The state-driven Home content BELOW the always-present Hero Pet card. Refs-only (INV-5);
  /// truth labels ride AS-IS; never a fabricated ready view.
  @ViewBuilder
  private func loadedContent(_ projection: HomeProjection) -> some View {
    // Honest status banner — any stale/offline/error label rides AS truth.
    if !projection.statusLabels.isEmpty {
      StatusBanner(labels: projection.statusLabels)
    }

    statusCard(projection)
    if projection.isLoadedEmpty {
      loadedEmptyCard(projection)
    }
    workItemsCard(projection)
  }

  private func statusCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Status").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: viewModel.isOnline ? "online" : "offline / stale",
            bg: viewModel.isOnline ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
            fg: viewModel.isOnline ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
        }
        HStack(spacing: 8) {
          Image(systemName: "antenna.radiowaves.left.and.right")
            .foregroundStyle(MobileTheme.textSecondary).frame(width: 22)
          // The runtime feed status TRUTH label rides AS-IS — never upgraded.
          Text("feed: \(projection.runtimeFeedStatus)")
            .font(.subheadline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
        }
        RefPill(label: "mission_id", ref: projection.missionId)
        if let summary = projection.routeDecisionSummary {
          RefPill(label: "route", ref: summary)
        }
        RefPill(label: "protocol", ref: "v\(fridayCurrentSchemaVersion)")
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(viewModel.isOnline ? "Friday status online" : "Friday status offline or stale")
    .accessibilityIdentifier("friday.home.status-card")
  }

  private func loadedEmptyCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack(spacing: 8) {
          Image(systemName: "tray")
            .foregroundStyle(MobileTheme.textSecondary)
            .frame(width: 22)
            .accessibilityHidden(true)
          Text("No active Friday work yet")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
        }
        Text("Connected to \(projection.runtimeFeedStatus); this owner has no visible missions, work items, or learning candidates in the current projection.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday is connected, with no active work for this owner")
    .accessibilityIdentifier("friday.home.loaded-empty")
  }

  /// The refs-only work-item view: COUNTS + id refs only (INV-5) — never a body. The read-seam
  /// projection is refs-only, so this surface presents the work-item id refs honestly without
  /// fabricating per-item lifecycle/owner detail the read seam does not surface to this view.
  private func workItemsCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Work items").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: "\(projection.workItemIds.count) ref\(projection.workItemIds.count == 1 ? "" : "s")",
            bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
        if projection.workItemIds.isEmpty {
          Text("No work-item refs in this projection.")
            .font(.caption).foregroundStyle(MobileTheme.textSecondary)
        } else {
          Text("refs only — open the Mission Workbench for detail")
            .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
          ForEach(projection.workItemIds, id: \.self) { id in
            RefPill(label: "workItemId", ref: id)
          }
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Work items, \(projection.workItemIds.count) references")
    .accessibilityIdentifier("friday.home.work-items-card")
  }
}

/// Honest banner for stale/offline/error labels. Rendered AS truth, never upgraded. The labels
/// are the projection's raw `statusLabels` strings (ride AS-IS off the read-seam projection).
struct StatusBanner: View {
  let labels: [String]

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.circle").foregroundStyle(MobileTheme.chipWarnFG)
      ForEach(labels, id: \.self) { label in
        StatusChip(text: label.uppercased(), bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
      }
      Text("flagged — rendered as-is")
        .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .fill(MobileTheme.coralSoft))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday projection flagged: \(labels.joined(separator: ", "))")
    .accessibilityIdentifier("friday.home.status-banner")
  }
}

/// Rendered when `fetchWorkbench()` throws (503 / offline / dark server / projection error).
/// The honest "unavailable" state — never a fake-ready Home.
struct UnavailableView: View {
  let reason: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 28)).foregroundStyle(MobileTheme.coral)
      Text("Friday is offline")
        .font(.headline).foregroundStyle(MobileTheme.textPrimary)
      Text(reason)
        .font(.footnote).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
      Text("No cached or fabricated status is shown.")
        .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
    }
    .padding(28)
    .frame(maxWidth: .infinity, minHeight: 200)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Friday is offline. \(reason). No cached or fabricated status is shown.")
    .accessibilityIdentifier("friday.home.unavailable")
  }
}
