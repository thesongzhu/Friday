import FridayHubConsoleCore
import SwiftUI

/// Friday Hub Console — the v1 desktop UI shell (D-PR1).
///
/// A read-only operator workbench over Rust Hub Mission truth. D-PR1 wires the
/// shell to a `MockReadClient`; the real `FridayRustClient` package is integrated
/// in a later PR via the same `FridayRustReadClient` protocol.
@main
struct FridayHubConsoleApp: App {
  var body: some Scene {
    WindowGroup("Friday Hub Console") {
      HubConsoleShell(client: MockReadClient(behavior: .loaded))
    }
    .windowStyle(.titleBar)
    .defaultSize(width: 1180, height: 720)
  }
}
