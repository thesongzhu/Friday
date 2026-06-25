import FridayMobileShellCore
import SwiftUI

struct FridayNewSessionScreen: View {
  @ObservedObject var viewModel: NewSessionViewModel
  @State private var intent = ""

  var body: some View {
    ScrollView {
      VStack(spacing: 16) {
        header
        launcher
        launchState
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  private var header: some View {
    GlassPanel {
      HStack(spacing: 12) {
        Image(systemName: "plus")
          .font(.system(size: 24, weight: .semibold))
          .foregroundStyle(MobileTheme.cyan)
          .frame(width: 34, height: 34)
        VStack(alignment: .leading, spacing: 4) {
          Text("New Session")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          Text("governed mission launch")
            .font(.caption)
            .foregroundStyle(MobileTheme.textSecondary)
        }
        Spacer()
        StatusChip(text: "action gated", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
      }
    }
  }

  private var launcher: some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
        cardHeader("Launch", count: nil)
        TextField("What should Friday do?", text: $intent, axis: .vertical)
          .lineLimit(2...5)
          .textInputAutocapitalization(.sentences)
          .autocorrectionDisabled(false)
          .font(.subheadline)
          .padding(10)
          .background(Color.white.opacity(0.54), in: RoundedRectangle(cornerRadius: 8))
          .accessibilityIdentifier("friday.new-session.intent-input")
        Button {
          let goal = intent
          Task { await viewModel.launch(intent: goal) }
        } label: {
          Label("Launch", systemImage: "play.fill")
            .frame(maxWidth: .infinity, minHeight: 38)
        }
        .buttonStyle(.borderedProminent)
        .tint(MobileTheme.cyan)
        .disabled(intent.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || launchInFlight)
        .accessibilityIdentifier("friday.new-session.launch-button")
        Text("Launch submits a governed Mission Intake. It is not provider-backed until the Hub accepts it and returns refs.")
          .font(.caption2)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  @ViewBuilder
  private var launchState: some View {
    switch viewModel.launchState {
    case .idle:
      EmptyView()
    case .launching:
      GlassPanel {
        HStack(spacing: 12) {
          ProgressView()
          Text("Submitting Mission Intake")
            .font(.footnote)
            .foregroundStyle(MobileTheme.textSecondary)
        }
      }
    case .launched(let summary, let missionId, let workItemId):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Submitted", count: nil)
          Text(summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
          RefPill(label: "mission_id", ref: missionId)
          RefPill(label: "work_item_id", ref: workItemId)
        }
      }
    case .blocked(let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Unavailable", count: nil)
          Text(reason)
            .font(.caption)
            .foregroundStyle(MobileTheme.coral)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .accessibilityIdentifier("friday.new-session.unavailable")
    }
  }

  private var launchInFlight: Bool {
    if case .launching = viewModel.launchState { return true }
    return false
  }

  private func cardHeader(_ title: String, count: Int?) -> some View {
    HStack {
      Text(title)
        .font(.headline)
        .foregroundStyle(MobileTheme.textPrimary)
      if let count {
        StatusChip(text: "\(count)", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }
}
