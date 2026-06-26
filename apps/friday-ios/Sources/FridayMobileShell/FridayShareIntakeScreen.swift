import FridayMobileShellCore
import SwiftUI

struct FridayShareIntakeScreen: View {
  @ObservedObject var viewModel: ShareIntakeViewModel
  var onOpenFridayChat: () -> Void = {}

  var body: some View {
    ScrollView {
      VStack(spacing: 14) {
        GlassPanel {
          VStack(alignment: .leading, spacing: 12) {
            Label("Shared Item", systemImage: "square.and.arrow.down")
              .font(.headline)
              .foregroundStyle(MobileTheme.textPrimary)

            TextField("https://...", text: $viewModel.sharedURL)
              .textInputAutocapitalization(.never)
              .autocorrectionDisabled()
              .keyboardType(.URL)
              .padding(12)
              .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .fill(Color.black.opacity(0.05)))
              .accessibilityLabel("Shared URL")
              .accessibilityIdentifier("friday.share.url")

            TextEditor(text: $viewModel.sharedText)
              .frame(minHeight: 150)
              .padding(8)
              .scrollContentBackground(.hidden)
              .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .fill(Color.black.opacity(0.05)))
              .accessibilityLabel("Shared text")
              .accessibilityIdentifier("friday.share.text")

            Button {
              Task { await viewModel.submit() }
            } label: {
              Label("Send to Friday", systemImage: "paperplane.fill")
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .tint(MobileTheme.cyan)
            .disabled(!canSubmit)
            .accessibilityIdentifier("friday.share.submit")
          }
        }

        phaseCard
      }
      .padding(16)
    }
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
  }

  private var canSubmit: Bool {
    !viewModel.phase.isBusy
      && (!viewModel.sharedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        || !viewModel.sharedURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
  }

  @ViewBuilder private var phaseCard: some View {
    switch viewModel.phase {
    case .idle:
      EmptyView()
    case .submitting:
      GlassPanel {
        HStack(spacing: 8) {
          ProgressView()
          Text("Creating mission...")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
        }
      }
      .accessibilityIdentifier("friday.share.submitting")
    case .submitted(let receipt):
      GlassPanel {
        VStack(alignment: .leading, spacing: 10) {
          Label("Ready", systemImage: "checkmark.seal.fill")
            .font(.headline)
            .foregroundStyle(MobileTheme.textPrimary)
          RefPill(label: "mission_id", ref: receipt.missionId)
          if let workItemId = receipt.workItemId {
            RefPill(label: "work_item_id", ref: workItemId)
          }
          RefPill(label: "surface", ref: receipt.surfaceThreadId)
          StatusChip(
            text: receipt.createdOrReady ? "created_or_ready" : receipt.status,
            bg: MobileTheme.chipDoneBG,
            fg: MobileTheme.chipDoneFG)
          Button {
            onOpenFridayChat()
          } label: {
            Label("Continue in Chat", systemImage: "bubble.left.and.bubble.right")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(.borderedProminent)
          .tint(MobileTheme.cyan)
          .accessibilityIdentifier("friday.share.open-chat-loop")
          Button("New share") { viewModel.reset() }
            .font(.caption)
            .foregroundStyle(MobileTheme.cyan)
        }
      }
      .accessibilityIdentifier("friday.share.ready")
    case .blocked(let reason):
      messageCard(
        title: "Needs Details",
        systemImage: "questionmark.circle",
        reason: reason,
        tint: MobileTheme.coral,
        identifier: "friday.share.blocked")
    case .unavailable(let reason):
      messageCard(
        title: "Unavailable",
        systemImage: "wifi.slash",
        reason: reason,
        tint: MobileTheme.coral,
        identifier: "friday.share.unavailable")
    }
  }

  private func messageCard(
    title: String,
    systemImage: String,
    reason: String,
    tint: Color,
    identifier: String
  ) -> some View {
    GlassPanel {
      VStack(alignment: .leading, spacing: 8) {
        Label(title, systemImage: systemImage)
          .font(.headline)
          .foregroundStyle(tint)
        Text(reason)
          .font(.caption)
          .foregroundStyle(MobileTheme.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityIdentifier(identifier)
  }
}
