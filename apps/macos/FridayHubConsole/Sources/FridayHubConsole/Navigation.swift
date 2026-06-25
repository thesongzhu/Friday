import FridayHubConsoleCore
import SwiftUI

/// The nav-rail destinations of the Hub Console.
///
/// Desktop destinations backed by the Rust Hub Workbench projection.
enum HubDestination: String, CaseIterable, Identifiable {
  case operations
  case chat
  case session
  case providerAdmin
  case parity
  case pairingProvisioning
  case workflow
  case channels
  case diagnostics
  case recovery
  case memory
  case tokenLedger
  case skills
  case media
  case settings
  case evidence

  var id: String { rawValue }

  var contract: DesktopProductDestinationContract {
    DesktopProductDestinationID(rawValue: rawValue)?.contract
      ?? DesktopProductDestinationContract(
        id: rawValue,
        title: rawValue,
        systemImage: "questionmark.square.dashed",
        tier: .navigationShell,
        routeBuilt: false,
        selectedDesignLocked: false,
        runtimeActionIds: [],
        blockers: [
          DesktopProductBlocker(.needsNativeSurface, label: "missing desktop route contract"),
        ])
  }

  var title: String {
    contract.title
  }

  var systemImage: String {
    contract.systemImage
  }

  /// Whether this destination is implemented by the desktop shell.
  var isBuilt: Bool { contract.routeBuilt }
}
