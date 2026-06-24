import SwiftUI

/// The nav-rail destinations of the Hub Console.
///
/// Desktop destinations backed by the Rust Hub Workbench projection.
enum HubDestination: String, CaseIterable, Identifiable {
  case operations
  case chat
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

  var title: String {
    switch self {
    case .operations: return "Operations Overview"
    case .chat: return "Friday Chat"
    case .providerAdmin: return "Provider Admin"
    case .parity: return "Provider Parity"
    case .pairingProvisioning: return "Pairing"
    case .workflow: return "Workflow Builder"
    case .channels: return "Channels"
    case .diagnostics: return "Diagnostics"
    case .recovery: return "Recovery"
    case .memory: return "Memory"
    case .tokenLedger: return "Token Ledger"
    case .skills: return "Skills / Tools"
    case .media: return "Media / Link"
    case .settings: return "Settings"
    case .evidence: return "Evidence Search"
    }
  }

  var systemImage: String {
    switch self {
    case .operations: return "gauge.with.dots.needle.bottom.50percent"
    case .chat: return "bubble.left.and.bubble.right"
    case .providerAdmin: return "person.badge.key"
    case .parity: return "square.grid.3x3"
    case .pairingProvisioning: return "qrcode.viewfinder"
    case .workflow: return "point.3.connected.trianglepath.dotted"
    case .channels: return "antenna.radiowaves.left.and.right"
    case .diagnostics: return "stethoscope"
    case .recovery: return "arrow.counterclockwise.circle"
    case .memory: return "brain.head.profile"
    case .tokenLedger: return "chart.bar.doc.horizontal"
    case .skills: return "wrench.and.screwdriver"
    case .media: return "link.badge.plus"
    case .settings: return "gearshape"
    case .evidence: return "doc.text.magnifyingglass"
    }
  }

  /// Whether this destination is implemented by the desktop shell.
  var isBuilt: Bool { true }
}
