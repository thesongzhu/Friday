import FridayHubConsoleCore
import SwiftUI

/// Friday Hub Console — the v1 desktop UI shell (D-PR1).
///
/// A read-only operator workbench over Rust Hub Mission truth.
///
/// LAUNCH MODES (mock is the SAFE DEFAULT):
///   - DEFAULT — the in-memory `MockReadClient(.loaded)`. Keeps SwiftUI previews + design/demo
///     work running without a live read-projection server, and keeps CI green (CI never flips
///     to the live seam, never reads the host master key).
///   - LIVE — set env `FRIDAY_CONSOLE_LIVE=1` (or launch arg `--live-read`) to wire the REAL
///     `SealedWSReadClient` (the `FridayRustClient` package) over the read-projection server's
///     loopback seam (127.0.0.1:48751) as the enrolled MASTER-DERIVED peer, authenticating as
///     the LaunchAgent owner `admin-001` — "the app actually reads the live Rust core".
///
/// HONEST-UNAVAILABLE: in LIVE mode, if the server is dark / the peer is not enrolled / the host
/// master key is absent, the real client fails closed and the Console renders the HONEST
/// "unavailable" state — never a fabricated mock-loaded view, never a crash.
///
/// NOTE — this INVERTS PR #682's scheme (which defaulted to the real client behind
/// `--use-mock-read-client`). The task pins mock-as-default + an explicit live opt-in; this is
/// purely a launch-behavior choice (tests inject their own clients, so CI is unaffected).
@main
struct FridayHubConsoleApp: App {
  var body: some Scene {
    WindowGroup("Friday Hub Console") {
      HubConsoleShell(client: Self.readClient)
    }
    .windowStyle(.titleBar)
    .defaultSize(width: 1180, height: 720)
  }

  /// The read client the shell uses. DEFAULT = mock; LIVE only when explicitly requested.
  static var readClient: FridayRustReadClient {
    let args = ProcessInfo.processInfo.arguments
    let env = ProcessInfo.processInfo.environment
    let useLive = args.contains("--live-read") || env["FRIDAY_CONSOLE_LIVE"] == "1"
    guard useLive else {
      return MockReadClient(behavior: .loaded)
    }
    // LIVE: derive the enrolled master-derived peer + target 48751 as `admin-001`. If the host
    // master key is unavailable, surface the truth (honest unavailable) — NEVER fall back to the
    // mock, which would fabricate a ready view the live seam did not produce.
    do {
      return try RealReadClientFactory.makeLive()
    } catch {
      return RealReadClientFactory.makeHonestlyUnavailable(reason: "\(error)")
    }
  }
}
