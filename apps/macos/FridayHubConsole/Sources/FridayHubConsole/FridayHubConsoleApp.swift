import FridayHubConsoleCore
import SwiftUI

/// Friday Hub Console — the v1 desktop UI shell (D-PR1).
///
/// A read-only operator workbench over Rust Hub Mission truth. This build wires the shell to
/// the REAL `SealedWSReadClient` (the `FridayRustClient` package) over the read-projection
/// server's loopback seam — "the app actually reads the live Rust core".
///
/// Pre-slice-6 the Rust read-projection server is DARK / not flipped, so the real client
/// cannot connect and the Console renders the HONEST "unavailable" state (never fake-ready,
/// never a crash) — the correct behavior until the operator flips the server (slice-6 gate).
///
/// The in-memory `MockReadClient` is kept ONLY behind a debug/launch flag (and for previews).
@main
struct FridayHubConsoleApp: App {
  var body: some Scene {
    WindowGroup("Friday Hub Console") {
      HubConsoleShell(client: Self.readClient)
    }
    .windowStyle(.titleBar)
    .defaultSize(width: 1180, height: 720)
  }

  /// The read client the live shell uses.
  ///
  /// DEFAULT = the REAL `SealedWSReadClient`. Set the launch arg `--use-mock-read-client`
  /// (or env `FRIDAY_HUB_CONSOLE_USE_MOCK=1`) to fall back to the in-memory mock for local
  /// design/demo work without a running read-projection server. The mock is NEVER the default.
  static var readClient: FridayRustReadClient {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    let useMock =
      args.contains("--use-mock-read-client") || env["FRIDAY_HUB_CONSOLE_USE_MOCK"] == "1"
    if useMock {
      return MockReadClient(behavior: .loaded)
    }
    return RealReadClientFactory.make(
      config: .slice6LoopbackPlaceholder,
      forwardedPrincipal: "owner:hub-console-desktop"
    )
  }
}
