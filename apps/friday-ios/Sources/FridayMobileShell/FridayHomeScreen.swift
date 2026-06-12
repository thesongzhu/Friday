import FridayMobileShellCore
import SwiftUI

/// Friday Home (locked: launch = Home; homeLayout = Status + chat-entry;
/// platformLayout = cardsQueues; petProminence = heroPet).
///
/// Home = Status + heroPet + provider cards + Needs-Me / Running queues, all
/// derived from a READ-ONLY `WorkbenchSnapshot`. The Friday Chat entry is the
/// top-bar 💬 (wired in `RootView`) — there is NO on-Home chat card and NO
/// composer here.
///
/// Truth rules: 503 / offline / stale render AS truth (honest unavailable/banner);
/// the only action is Refresh (re-read); NO mutating action; a blocked NO-GO row is
/// shown in Needs-Me AS truth but is never executable.
struct FridayHomeScreen: View {
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    ScrollView {
      switch viewModel.state {
      case .idle, .loading:
        loadingView
      case .loaded:
        loadedView
      case let .unavailable(reason):
        UnavailableView(reason: reason)
      }
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
    .frame(maxWidth: .infinity, minHeight: 320)
  }

  @ViewBuilder
  private var loadedView: some View {
    VStack(spacing: 16) {
      // Hero Pet — mood companion, status shown honestly below.
      HeroPet(online: viewModel.isOnline).padding(.top, 6)

      // Honest status banner — stale/offline/error labels render AS truth.
      if !viewModel.statusLabels.isEmpty {
        StatusBanner(labels: viewModel.statusLabels)
      }

      statusCard
      providerCardsSection
      needsMeSection
      runningSection
    }
    .padding(16)
  }

  private var statusCard: some View {
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
        if let snapshot = viewModel.state.snapshot {
          HStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
              .foregroundStyle(MobileTheme.textSecondary).frame(width: 22)
            Text(snapshot.runtimeFeedStatus.displayText)
              .font(.subheadline).foregroundStyle(MobileTheme.textPrimary)
            Spacer()
          }
          RefPill(label: "mission_id", ref: snapshot.missionId)
        }
      }
    }
  }

  @ViewBuilder
  private var providerCardsSection: some View {
    if !viewModel.providerCards.isEmpty {
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          Text("Providers").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Text("cards open the provider workspace — not in this PR")
            .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
          ForEach(viewModel.providerCards) { card in
            HStack(spacing: 12) {
              // Small Mark provider identity (locked: providerIdentity = smallMark).
              Circle().fill(MobileTheme.cyan).frame(width: 12, height: 12)
              Text(card.name).font(.subheadline).foregroundStyle(MobileTheme.textPrimary)
              Spacer()
              StatusChip(
                text: "\(card.receiptRefCount) ref\(card.receiptRefCount == 1 ? "" : "s")",
                bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
            }
            .padding(.vertical, 4)
          }
        }
      }
    }
  }

  @ViewBuilder
  private var needsMeSection: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        HStack {
          Text("Needs Me").font(.headline).foregroundStyle(MobileTheme.textPrimary)
          Spacer()
          StatusChip(
            text: "\(viewModel.needsMe.count)", bg: MobileTheme.coralSoft,
            fg: MobileTheme.chipWarnFG)
        }
        if viewModel.needsMe.isEmpty {
          Text("Nothing needs you right now.")
            .font(.caption).foregroundStyle(MobileTheme.textSecondary)
        } else {
          ForEach(viewModel.needsMe) { QueueRow(item: $0) }
        }
      }
    }
  }

  @ViewBuilder
  private var runningSection: some View {
    if !viewModel.running.isEmpty {
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          HStack {
            Text("Running").font(.headline).foregroundStyle(MobileTheme.textPrimary)
            Spacer()
            StatusChip(
              text: "\(viewModel.running.count)", bg: MobileTheme.chipPendingBG,
              fg: MobileTheme.chipPendingFG)
          }
          ForEach(viewModel.running) { QueueRow(item: $0) }
        }
      }
    }
  }
}

/// A queue row (Needs-Me / Running). READ-ONLY: refs + truth chips only. A blocked
/// NO-GO row (`isExecutable == false`) is rendered AS truth but carries NO tap /
/// dispatch / approve affordance — there is no button here at all.
struct QueueRow: View {
  let item: HomeQueueItem

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(item.title)
          .font(.subheadline).foregroundStyle(MobileTheme.textPrimary)
        Spacer()
        // `done` strictly from the projection — provider_ack/blocked are NOT done.
        StatusChip(
          text: item.done ? "done" : "not done",
          bg: item.done ? MobileTheme.chipDoneBG : MobileTheme.chipNeutralBG,
          fg: item.done ? MobileTheme.chipDoneFG : MobileTheme.chipNeutralFG)
      }
      HStack(spacing: 6) {
        item.state.chip
        item.owner.chip
        if !item.isExecutable {
          // Honest: this row is non-actionable in this read-only shell.
          StatusChip(
            text: "not executable", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
        }
      }
      if let proof = item.proofRef {
        RefPill(label: "proofRef", ref: proof)
      }
    }
    .padding(.vertical, 6)
  }
}

/// Honest banner for stale/offline/error labels. Rendered AS truth, never upgraded.
struct StatusBanner: View {
  let labels: [MissionWorkbenchStatusLabel]

  var body: some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.circle").foregroundStyle(MobileTheme.chipWarnFG)
      ForEach(labels, id: \.rawValue) { label in
        StatusChip(text: label.displayText, bg: MobileTheme.chipWarnBG, fg: MobileTheme.chipWarnFG)
      }
      Text("flagged — rendered as-is")
        .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
      Spacer()
    }
    .padding(12)
    .background(
      RoundedRectangle(cornerRadius: MobileTheme.cornerRadius, style: .continuous)
        .fill(MobileTheme.coralSoft))
  }
}

/// Rendered when `fetchWorkbench()` throws (503 / offline / projection error).
/// The honest "unavailable" state — never a fake-ready Home.
struct UnavailableView: View {
  let reason: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: 28)).foregroundStyle(MobileTheme.coral)
      Text("Hub projection unavailable")
        .font(.headline).foregroundStyle(MobileTheme.textPrimary)
      Text(reason)
        .font(.footnote).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
      Text("Showing this as truth — no cached or fabricated status is presented.")
        .font(.caption2).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
    }
    .padding(28)
    .frame(maxWidth: .infinity, minHeight: 320)
  }
}

/// Honest placeholder for mobile design areas not implemented in M-PR1.
struct PlaceholderScreen: View {
  let destination: MobileDestination

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: destination.systemImage)
        .font(.system(size: 30)).foregroundStyle(MobileTheme.textSecondary)
      Text(destination.title)
        .font(.headline).foregroundStyle(MobileTheme.textPrimary)
      Text("This surface is part of the locked mobile design but is not built in M-PR1.")
        .font(.footnote).foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
        .frame(maxWidth: 320)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }
}
