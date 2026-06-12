// Friday — native iOS app shell (M-PR1, the v1 mobile UI).
//
// LOCKED mobile baseline (friday-design-handoff-20260602/saved/mobile-selection.json):
//   launch = Home; homeLayout = Status + chat-entry (the chat entry is the top-bar
//   💬 — NO on-Home chat card; the composer lives in a separate full-screen
//   pet-centered Friday Chat surface); platformLayout = cardsQueues; menuModel =
//   commandSheet (full-screen grid launcher from top-left); petProminence = heroPet;
//   palette = cyanCoral; background = warmOffWhite; form = glassNative; theme = light.
//
// M-PR1 is the READ-ONLY shell: it reads a `WorkbenchSnapshot` projection through
// the `FridayRustReadClient` protocol (the SAME shape the desktop sibling #676/#677
// uses) backed here by `MockReadClient`. The real `FridayRustClient` package is
// integrated in a later PR via the same protocol. Truth rules (refs-only,
// truth_status never upgraded, 503/stale/offline AS truth, read-only actions only,
// no mutating action, no NO-GO row executable) mirror #676.

import FridayMobileShellCore
import SwiftUI

/// The app shell: a NavigationStack with the top-left Command Sheet launcher and the
/// top-bar 💬 Friday Chat entry. Launch screen = Home (locked).
struct RootView: View {
  @StateObject private var homeVM: HomeViewModel
  @State private var destination: MobileDestination = .home
  @State private var commandOpen = false
  @State private var chatOpen = false

  init(client: FridayRustReadClient) {
    _homeVM = StateObject(wrappedValue: HomeViewModel(client: client))
  }

  var body: some View {
    NavigationStack {
      Group {
        switch destination {
        case .home:
          FridayHomeScreen(viewModel: homeVM)
        default:
          PlaceholderScreen(destination: destination)
        }
      }
      .navigationTitle(destination.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        // Top-LEFT: the Command Sheet launcher (locked: commandSheet from top-left).
        ToolbarItem(placement: .topBarLeading) {
          Button {
            commandOpen = true
          } label: {
            Image(systemName: "square.grid.2x2").foregroundStyle(MobileTheme.cyan)
          }
          .accessibilityLabel("Open Command Sheet")
        }
        // Top-BAR 💬: the Friday Chat entry (locked: the ONLY chat entry — no card).
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            chatOpen = true
          } label: {
            Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(MobileTheme.cyan)
          }
          .accessibilityLabel("Open Friday Chat")
        }
        ToolbarItem(placement: .topBarTrailing) {
          // Small Mark for the app itself.
          Button {
            Task { await homeVM.refresh() }
          } label: {
            Image(systemName: "arrow.clockwise").foregroundStyle(MobileTheme.cyan)
          }
          .accessibilityLabel("Refresh Status")
          .disabled(homeVM.state.isLoading)
        }
      }
      .navigationDestination(isPresented: $chatOpen) {
        FridayChatScreen(online: homeVM.isOnline)
      }
    }
    .tint(MobileTheme.cyan)
    .sheet(isPresented: $commandOpen) {
      CommandSheet(destination: $destination, isOpen: $commandOpen)
    }
    .task {
      // Initial read on launch.
      if case .idle = homeVM.state {
        await homeVM.refresh()
      }
    }
  }
}

@main
struct FridayApp: App {
  var body: some Scene {
    WindowGroup {
      // M-PR1 wires the shell to the MockReadClient; the real FridayRustClient
      // package is integrated later via the same FridayRustReadClient protocol.
      RootView(client: MockReadClient(behavior: .loaded))
    }
  }
}

// MARK: - Previews

#Preview("Home · loaded (mock)") {
  RootView(client: MockReadClient(behavior: .loaded))
}

#Preview("Home · unavailable (503)") {
  RootView(client: MockReadClient(behavior: .unavailable(.hubUnavailable(statusCode: 503))))
}

#Preview("Home · offline") {
  RootView(client: MockReadClient(behavior: .unavailable(.offline)))
}
