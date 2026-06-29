import FridayMobileShellCore
import SwiftUI

struct FridayNewSessionScreen: View {
  @ObservedObject var viewModel: NewSessionViewModel
  var onOpenFridayChat: (ChatLaunchContext) -> Void = { _ in }
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
        FridayChip(text: "action gated", bg: MobileTheme.chipPendingBG, fg: MobileTheme.chipPendingFG)
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
        .buttonStyle(FridayButtonStyle(variant: .primary))
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
    case .launched(let summary, let missionId, let workItemId, let surfaceThreadId, let status, let createdOrReady):
      let context = ChatLaunchContext(
        source: "New Session",
        missionId: missionId,
        workItemId: workItemId,
        surfaceThreadId: surfaceThreadId,
        status: status,
        createdOrReady: createdOrReady)
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Submitted", count: nil)
          Text(summary)
            .font(.caption)
            .foregroundStyle(MobileTheme.textPrimary)
          FridayProofLine(label: "mission_id", ref: missionId)
          FridayProofLine(label: "work_item_id", ref: workItemId)
          FridayProofLine(label: "surface", ref: surfaceThreadId)
          FridayChip(
            text: createdOrReady ? "created_or_ready" : status,
            bg: MobileTheme.chipDoneBG,
            fg: MobileTheme.chipDoneFG)
          Text("Refs-only receipt. Provider execution and readable results still require the governed live loop to finish.")
            .font(.caption2)
            .foregroundStyle(MobileTheme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
          Divider().opacity(0.5)
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrowshape.turn.up.right.circle")
              .foregroundStyle(MobileTheme.cyan)
              .frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
              Text("Friday Chat handoff is armed")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(MobileTheme.textPrimary)
              Text("The next tap carries these mission refs into Chat as a prefilled governed turn. It still cannot invent missing provider results.")
                .font(.caption2)
                .foregroundStyle(MobileTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
              FridayProofLine(label: "handoff", ref: context.evidenceRef)
              FridayProofLine(label: "action", ref: "mobile/newSession/open-chat-loop")
            }
          }
          Button {
            onOpenFridayChat(context)
          } label: {
            Label("Continue in Friday Chat", systemImage: "bubble.left.and.bubble.right")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(FridayButtonStyle(variant: .primary))
          .tint(MobileTheme.cyan)
          .accessibilityIdentifier("friday.new-session.open-chat-loop")
        }
      }
    case .blocked(let reason):
      GlassPanel {
        VStack(alignment: .leading, spacing: MobileTheme.rowSpacing) {
          cardHeader("Needs Connection", count: nil)
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
        FridayChip(text: "\(count)", bg: MobileTheme.chipNeutralBG, fg: MobileTheme.chipNeutralFG)
      }
    }
  }
}
