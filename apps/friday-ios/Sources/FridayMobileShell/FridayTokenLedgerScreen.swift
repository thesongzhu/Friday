import FridayMobileShellCore
import SwiftUI

struct FridayTokenLedgerScreen: View {
  @ObservedObject var viewModel: HomeViewModel

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        switch viewModel.state {
        case .idle, .loading:
          header(status: "loading", ready: false)
          loadingView
        case .unavailable(let reason):
          header(status: "unavailable", ready: false)
          UnavailableView(reason: reason)
        case .loaded(let projection):
          loadedContent(projection)
        }
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  @ViewBuilder
  private func loadedContent(_ projection: HomeProjection) -> some View {
    let runId = projection.tokenLedgerRunId
    header(status: runId == nil ? "no run ref" : "readable", ready: runId != nil)

    if let runId {
      runRefCard(runId: runId, projection: projection)
      detailCard
    } else {
      noRunRefCard(projection)
    }
  }

  private func header(status: String, ready: Bool) -> some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: "chart.bar.doc.horizontal")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(ready ? MobileTheme.cyan : MobileTheme.coral)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("Token Ledger")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("refs-only provider usage readback")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
        StatusChip(
          text: status,
          bg: ready ? MobileTheme.chipPendingBG : MobileTheme.chipWarnBG,
          fg: ready ? MobileTheme.chipPendingFG : MobileTheme.chipWarnFG)
      }
    }
    .accessibilityIdentifier("friday.token-ledger.header")
  }

  private var loadingView: some View {
    GlassPanel {
      HStack(spacing: 12) {
        ProgressView()
        Text("Reading token ledger truth")
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
    }
  }

  private func runRefCard(runId: String, projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Selected Run", count: nil)
        Text("Friday will read the run readback arm for this run. No cost data is fabricated when the read arm is empty or unavailable.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        RefPill(label: "run_id", ref: runId)
        RefPill(label: "mission_id", ref: projection.missionId)
        Button {
          Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
        } label: {
          Label("Refresh Ledger", systemImage: "arrow.clockwise")
        }
        .disabled(viewModel.detailState.isLoading)
      }
    }
    .task(id: runId) {
      await viewModel.loadDetail(.runReadback(runId: runId))
    }
  }

  private func noRunRefCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("No Run Ref", count: nil)
        Text("The Home projection does not include a completed run ref yet, so Friday cannot show a token ledger from this app surface.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        RefPill(label: "mission_id", ref: projection.missionId)
        RefPill(label: "feed", ref: projection.runtimeFeedStatus)
      }
    }
    .accessibilityIdentifier("friday.token-ledger.no-run-ref")
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
          Text("Reading run ledger")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .loaded(let detail):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(detail.title, count: detail.refs.count)
          Text(detail.summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          RefPill(label: "generated", ref: generatedText(detail.generatedAtMs))
          ForEach(detail.refs, id: \.self) { ref in
            RefPill(label: nil, ref: ref)
          }
        }
      }
      .accessibilityIdentifier("friday.token-ledger.detail")
    case .unavailable(let title, let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(title, count: nil)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
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

  private func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }
}
