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
          header(status: "connect", ready: false)
          UnavailableView(
            reason: userFacingReason(reason),
            title: "Connect Token Ledger",
            detail: "Friday needs a live run reference before it can show provider usage on this device.",
            systemImage: "chart.bar.doc.horizontal",
            identifier: "friday.token-ledger.unavailable")
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
    header(status: runId == nil ? "run needed" : "ready", ready: runId != nil)

    if let runId {
      runRefCard(runId: runId, projection: projection)
      receiptRefsCard(projection)
      detailCard
    } else {
      noRunRefCard(projection)
      receiptRefsCard(projection)
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
          Text("Usage and cost history")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
        FridayChip(
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
        Text("Reading usage ledger")
          .font(.footnote)
          .foregroundStyle(MobileTheme.textSecondary)
      }
      .frame(maxWidth: .infinity, minHeight: 86, alignment: .leading)
    }
  }

  private func runRefCard(runId: String, projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Usage Source", count: nil)
        Text("Friday reads provider usage from the live work item selected by the Hub.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        FridayProofDisclosure("Usage receipt") {
          FridayProofLine(label: "run", ref: runId)
          FridayProofLine(label: "mission", ref: projection.missionId)
        }
        Button {
          Task { await viewModel.loadDetail(.runReadback(runId: runId)) }
        } label: {
          Label("Refresh Ledger", systemImage: "arrow.clockwise")
        }
        .disabled(viewModel.detailState.isLoading)
        .accessibilityIdentifier("friday.token-ledger.refresh")
      }
    }
    .task(id: runId) {
      await viewModel.loadDetail(.runReadback(runId: runId))
    }
  }

  private func noRunRefCard(_ projection: HomeProjection) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Waiting for Usage", count: nil)
        Text("Token totals will appear after the current work produces a completed run reference.")
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
        FridayProofDisclosure("Receipt details") {
          FridayProofLine(label: "mission", ref: projection.missionId)
          FridayProofLine(label: "live state", ref: projection.runtimeFeedStatus)
        }
      }
    }
    .accessibilityIdentifier("friday.token-ledger.no-run-ref")
  }

  @ViewBuilder
  private func receiptRefsCard(_ projection: HomeProjection) -> some View {
    let count = projection.providerReceiptRefs.count + projection.channelReceiptRefs.count
    if count > 0 {
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Projected Receipts", count: count)
          Text("These receipts are already available from the Hub. Per-run token totals appear after a live run is selected.")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          FridayProofDisclosure("Projected receipts") {
            ForEach(projection.providerReceiptRefs.prefix(5), id: \.self) { ref in
              FridayProofLine(label: "provider", ref: ref)
            }
            ForEach(projection.channelReceiptRefs.prefix(5), id: \.self) { ref in
              FridayProofLine(label: "channel", ref: ref)
            }
          }
        }
      }
      .accessibilityIdentifier("friday.token-ledger.projected-receipts")
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
          Text("Reading run ledger")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .loaded(let detail):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(detail.title, count: detail.facts.isEmpty ? detail.refs.count : detail.facts.count)
          Text(detail.summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
          if !detail.facts.isEmpty {
            VStack(spacing: 8) {
              ForEach(detail.facts) { fact in
                factRow(fact)
              }
            }
            .accessibilityIdentifier("friday.token-ledger.facts")
          }
          FridayProofDisclosure("Ledger proof") {
            FridayProofLine(label: "updated", ref: generatedText(detail.generatedAtMs))
            ForEach(detail.refs, id: \.self) { ref in
              FridayProofLine(label: nil, ref: ref)
            }
          }
        }
      }
      .accessibilityIdentifier("friday.token-ledger.detail")
    case .unavailable(let title, let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader(title, count: nil)
          Text(userFacingReason(reason))
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
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

  private func generatedText(_ generatedAtMs: Int64) -> String {
    guard generatedAtMs > 0 else { return "unknown" }
    let date = Date(timeIntervalSince1970: Double(generatedAtMs) / 1000.0)
    return date.formatted(date: .abbreviated, time: .shortened)
  }

  private func userFacingReason(_ reason: String) -> String {
    let normalized = reason.lowercased()
    if normalized.contains("offline") || normalized.contains("transport")
      || normalized.contains("connection") || normalized.contains("server dark")
    {
      return "Friday cannot reach the live Hub from this device. Check the connection, then try again."
    }
    return "Usage appears after Friday has a live run reference for this mission."
  }
}
