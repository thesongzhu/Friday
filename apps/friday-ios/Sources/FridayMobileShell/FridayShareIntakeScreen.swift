import FridayMobileShellCore
import SwiftUI

struct FridayShareIntakeScreen: View {
  @ObservedObject var viewModel: ShareIntakeViewModel
  var onOpenFridayChat: (ShareIntakeReceipt) -> Void = { _ in }

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
            .buttonStyle(FridayButtonStyle(variant: .primary))
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
            .accessibilityIdentifier("friday.share.ready")
          FridayProofLine(label: "mission", ref: receipt.missionId)
          if let workItemId = receipt.workItemId {
            FridayProofLine(label: "work item", ref: workItemId)
          }
          FridayProofLine(label: "surface", ref: receipt.surfaceThreadId)
          FridayChip(
            text: receipt.createdOrReady ? "ready" : receipt.status,
            bg: MobileTheme.chipDoneBG,
            fg: MobileTheme.chipDoneFG)
          Divider().opacity(0.5)
          HStack(alignment: .top, spacing: 10) {
            Image(systemName: "arrowshape.turn.up.right.circle")
              .foregroundStyle(MobileTheme.cyan)
              .frame(width: 22)
            VStack(alignment: .leading, spacing: 6) {
              Text("Friday Chat handoff is armed")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(MobileTheme.textPrimary)
              Text("The next tap carries this shared context into Chat as a prefilled governed turn. Provider results will appear when the live loop returns them.")
                .font(.caption2)
                .foregroundStyle(MobileTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
              FridayProofLine(label: "handoff", ref: receipt.chatLaunchContext.evidenceRef)
              FridayProofLine(label: "action", ref: "mobile/share/open-chat-loop")
            }
          }
          Button {
            onOpenFridayChat(receipt)
          } label: {
            Label("Continue in Friday Chat", systemImage: "bubble.left.and.bubble.right")
              .frame(maxWidth: .infinity)
          }
          .buttonStyle(FridayButtonStyle(variant: .primary))
          .tint(MobileTheme.cyan)
          .accessibilityIdentifier("friday.share.open-chat-loop")
          Button("New share") { viewModel.reset() }
            .font(.caption)
            .foregroundStyle(MobileTheme.cyan)
        }
      }
    case .blocked(let reason):
      messageCard(
        title: "Needs Details",
        systemImage: "questionmark.circle",
        reason: userFacingReason(reason),
        tint: MobileTheme.coral,
        identifier: "friday.share.blocked")
    case .unavailable(let reason):
      messageCard(
        title: "Connect Friday",
        systemImage: "wifi.slash",
        reason: userFacingReason(reason),
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

  private func userFacingReason(_ reason: String) -> String {
    let normalized = reason.lowercased()
    if normalized.contains("offline") || normalized.contains("transport") || normalized.contains("connection") {
      return "Friday cannot reach the live Hub from this device. Check the connection, then try again."
    }
    return "Friday needs a fresh live Hub connection before this share can continue."
  }
}
