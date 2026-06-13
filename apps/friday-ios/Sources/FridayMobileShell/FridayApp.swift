// Friday — native iOS app shell (the v1 mobile UI), now wired to the REAL Rust clients.
//
// LOCKED mobile baseline (friday-design-handoff-20260602/saved/mobile-selection.json):
//   launch = Home; homeLayout = Status + chat-entry (the chat entry is the top-bar
//   💬 — NO on-Home chat card; the composer lives in a separate full-screen
//   pet-centered Friday Chat surface); platformLayout = cardsQueues; menuModel =
//   commandSheet (full-screen grid launcher from top-left); petProminence = heroPet;
//   palette = cyanCoral; background = warmOffWhite; form = glassNative; theme = light.
//
// This shell now consumes the PACKAGE's real sealed-WS clients (`FridayRustClient`): the
// Home reads the refs-only Mission Workbench projection over `SealedWSReadClient`; the
// Friday Chat surface drives the read-WRITE / S6 loop over `SealedWSWriteClient` + the
// `OperatorSigner` relay (mock now; the real desktop signer / PR #671 is the slice-6 gate).
// The live `NWConnection` transport is the DEFERRED slice-6 AC, so every surface renders
// honest-unavailable while the Rust servers are DARK — the EXPECTED state. Truth rules
// (refs-only, truth labels never upgraded, 503/stale/offline AS truth, no key on the app,
// a mutation ONLY via operator approval) are enforced in `FridayMobileShellCore`.

import FridayMobileShellCore
import FridayRustClient
import SwiftUI

/// The app's real-client wiring: the device X25519 transport keypair + the REAL sealed-WS
/// read/write clients (built via `FridayClientFactory`) + the operator-signer RELAY seam.
/// This is the single place the iOS app binds to the all-Rust core.
///
/// INV-1: the device keypair is the X25519 SESSION keypair (transport identity) — it is NOT a
/// signing key and CANNOT mint an approval. The operator's Ed25519 signing key lives ONLY in
/// the desktop signer's isolated SecureStore (PR #671); on the phone the signer is an injected
/// relay (`MockOperatorSigner` today — NOT a real signature).
///
/// The live network transport (a `NWConnection`-backed `SealedWSTransport`) is the DEFERRED
/// slice-6 AC; until it is wired the default factory transport throws and every surface renders
/// honest-unavailable — the EXPECTED state while the Rust servers are DARK.
@MainActor
final class FridaySession: ObservableObject {
  /// DEFAULT-OFF run-control (the S6 pause/approve/resume). Flipping this ON in production is
  /// part of the slice-6 operator gate; OFF ⇒ the chat loop is read-only (a pause fails closed).
  let runControlEnabled = false

  let readClient: FridayRustReadClient
  let writeClient: FridayRustWriteClient
  /// The operator-signing RELAY. Mock today (NOT a real signature); the real desktop signer
  /// (PR #671) is the slice-6 / operator-key gate. The phone holds NO signing key (INV-1).
  let signer: OperatorSigner

  /// - Parameter preview: when `true`, the Home read client is the labeled `PreviewReadClient`
  ///   (a static sample projection) so SwiftUI previews + UI iteration render a populated Home
  ///   without a live Hub. DEFAULT `false` ⇒ the REAL `SealedWSReadClient` (honest-unavailable
  ///   while the servers are dark). A real build NEVER passes `preview: true`.
  init(preview: Bool = false) {
    // SINGLE-PEER-TRAP SAFETY: the DEFAULT read client mints NO X25519 keypair, opens NO socket,
    // and touches NO SecureStore — it is the no-key `HonestlyUnavailableReadClient`, which always
    // renders the honest dark-server state. This deliberately does NOT generate a fresh peer key:
    // the live read-projection store enrolls EXACTLY the master-derived peer (count=1), so minting
    // any other key here would be wrong, and flipping the SHIPPED default to live at all is the
    // slice-6 operator FREEZE gate. The master-derived LIVE read path is the iOS I4 mirror of the
    // desktop `RealReadClientFactory.makeLive` / `MasterKeyPeer` derivation; it is now BUILT and
    // wired here behind an OPT-IN env/arg gate (`FRIDAY_MOBILE_LIVE_READ=1` / `--live-read`,
    // mirroring the desktop `FRIDAY_CONSOLE_LIVE`). The DEFAULT (gate OFF) stays the honest-
    // unavailable client — this PR does NOT flip the shipped default (that is the slice-6 gate).
    self.readClient = preview ? PreviewReadClient() : Self.defaultReadClient()

    // The write client (Friday Chat read-WRITE / S6 surface) also has NO live transport wired
    // (slice-6 deferred AC) ⇒ its default factory transport throws ⇒ honest-unavailable. Its
    // transport keypair is an ephemeral X25519 SESSION key (transport identity only, NOT a
    // signing key — INV-1) that NEVER reaches the live store because no socket is opened; it is
    // confined to honest-unavailable construction. When slice-6 lands, inject a master-derived
    // keypair + a live `NWConnection` transport here.
    let writeKeypair = FridayCrypto.DeviceKeypair()
    let endpoint = FridayClientFactory.Endpoint(
      forwardedPrincipal: "principal:owner-device",
      agentRunControlViaRust: runControlEnabled)
    self.writeClient = FridayClientFactory.makeWriteClient(keypair: writeKeypair, endpoint: endpoint)
    self.signer = MockOperatorSigner()
  }

  /// The DEFAULT (non-preview) Home read client. DEFAULT = the no-key honest-unavailable client;
  /// LIVE only when explicitly opted in via env `FRIDAY_MOBILE_LIVE_READ=1` or launch arg
  /// `--live-read` (the iOS mirror of the desktop `FRIDAY_CONSOLE_LIVE`). This PR does NOT flip
  /// the shipped default — the live path is opt-in, gated, and never on by default (slice-6 gate).
  ///
  /// LIVE: derive the enrolled master-derived peer (`MasterKeyPeer`), target 48751 as `admin-001`,
  /// over the real `SealedWSReadClient` (the iOS `RealReadClientFactory.makeLive`). If the host
  /// master key is unavailable (e.g. a real phone — the J2 pairing problem), surface the TRUTH
  /// (honest unavailable) — NEVER fall back to the preview sample, which would fabricate a ready
  /// view the live seam did not produce.
  static func defaultReadClient() -> FridayRustReadClient {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    let useLive = args.contains("--live-read") || env["FRIDAY_MOBILE_LIVE_READ"] == "1"
    guard useLive else {
      // SHIPPED DEFAULT — unchanged: no key, no socket, no SecureStore touch.
      return HonestlyUnavailableReadClient()
    }
    do {
      return try RealReadClientFactory.makeLive()
    } catch {
      return RealReadClientFactory.makeHonestlyUnavailable(reason: "\(error)")
    }
  }

  #if DEBUG
  /// A preview/debug session whose Home renders a labeled sample projection (no live Hub).
  static let preview = FridaySession(preview: true)
  #endif
}

/// The app shell: a NavigationStack with the top-left Command Sheet launcher and the
/// top-bar 💬 Friday Chat entry. Launch screen = Home (locked).
struct RootView: View {
  @StateObject private var homeVM: HomeViewModel
  private let session: FridaySession
  @State private var destination: MobileDestination = .home
  @State private var commandOpen = false
  @State private var chatOpen = false

  init(session: FridaySession) {
    self.session = session
    _homeVM = StateObject(wrappedValue: HomeViewModel(client: session.readClient))
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
        // The Friday Chat read-WRITE / S6 surface, driven by the session's REAL write client
        // + the operator-signer relay.
        FridayChatScreen(session: session)
      }
    }
    .tint(MobileTheme.cyan)
    .sheet(isPresented: $commandOpen) {
      CommandSheet(destination: $destination, isOpen: $commandOpen)
    }
    .task {
      // Initial read on launch (dark server ⇒ honest-unavailable).
      if case .idle = homeVM.state {
        await homeVM.refresh()
      }
    }
  }
}

@main
struct FridayApp: App {
  @StateObject private var session = FridaySession()

  var body: some Scene {
    WindowGroup {
      // The shell wires the REAL clients via the session; the live transport is the slice-6
      // deferred AC, so the surfaces render honest-unavailable while the Rust servers are dark.
      RootView(session: session)
    }
  }
}

// MARK: - Previews

#if DEBUG
#Preview("Home · preview sample (labeled)") {
  RootView(session: .preview)
}

#Preview("Home · live client (dark ⇒ honest-unavailable)") {
  RootView(session: FridaySession())
}
#endif
