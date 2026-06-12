import FridayMobileShellCore
import SwiftUI

/// The full-screen, pet-centered Friday Chat surface (locked: the Friday Chat
/// entry is the top-bar 💬; the composer lives HERE, on a separate screen — never
/// as an on-Home card).
///
/// M-PR1 SCOPE: this is a SKELETON. The chat read-WRITE loop and the S6 approval
/// flow are a LATER slice. Per the truth contract the composer is honestly INERT:
/// there is no send path, no mutating action, and no model/provider call. The
/// surface says so plainly rather than faking a working chat.
struct FridayChatScreen: View {
  @StateObject private var viewModel = ChatViewModel()
  /// Drives the heroPet mood — passed from Home's projection (mood only, not truth).
  let online: Bool

  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 24)

      // Pet-centered: the Hero Pet anchors the chat surface.
      HeroPet(online: online)

      Text("Friday Chat")
        .font(.title3).bold()
        .foregroundStyle(MobileTheme.textPrimary)
        .padding(.top, 12)

      // Honest skeleton notice — surfaced AS truth (not a fake "ready to chat").
      Text(viewModel.skeletonNotice)
        .font(.footnote)
        .foregroundStyle(MobileTheme.textSecondary)
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
        .padding(.top, 8)

      Spacer()

      composer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(MobileTheme.backgroundWarmOffWhite.ignoresSafeArea())
    .navigationTitle("Friday Chat")
    .navigationBarTitleDisplayMode(.inline)
  }

  /// The composer. INERT in M-PR1: the field is editable for layout review but the
  /// send button is disabled because `sendEnabled == false`. No send path exists.
  private var composer: some View {
    HStack(spacing: 10) {
      TextField("Ask Friday…", text: $viewModel.draft, axis: .vertical)
        .textFieldStyle(.plain)
        .lineLimit(1...4)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
          RoundedRectangle(cornerRadius: 18, style: .continuous)
            .fill(Color.black.opacity(0.05)))

      Button {
        // No-op in M-PR1. The send path is a LATER slice; nothing is sent.
      } label: {
        Image(systemName: "arrow.up.circle.fill")
          .font(.system(size: 30))
          .foregroundStyle(
            viewModel.sendEnabled ? MobileTheme.cyan : MobileTheme.cyan.opacity(0.25))
      }
      .disabled(!viewModel.sendEnabled)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .background(.ultraThinMaterial)
  }
}

#Preview("Friday Chat · skeleton (online)") {
  NavigationStack { FridayChatScreen(online: true) }
}

#Preview("Friday Chat · skeleton (offline)") {
  NavigationStack { FridayChatScreen(online: false) }
}
