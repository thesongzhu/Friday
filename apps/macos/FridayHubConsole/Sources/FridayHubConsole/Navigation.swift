import SwiftUI

/// The nav-rail destinations of the Hub Console.
///
/// Only `.operations` is built in D-PR1. The other destinations exist in the
/// LOCKED desktop design (provider admin, parity, workflow, channels, evidence)
/// and appear as honest "not in this PR" placeholders — never faked content.
enum HubDestination: String, CaseIterable, Identifiable {
  case operations
  case providerAdmin
  case parity
  case workflow
  case channels
  case evidence

  var id: String { rawValue }

  var title: String {
    switch self {
    case .operations: return "Operations Overview"
    case .providerAdmin: return "Provider Admin"
    case .parity: return "Provider Parity"
    case .workflow: return "Workflow Builder"
    case .channels: return "Channels"
    case .evidence: return "Evidence Search"
    }
  }

  var systemImage: String {
    switch self {
    case .operations: return "gauge.with.dots.needle.bottom.50percent"
    case .providerAdmin: return "person.badge.key"
    case .parity: return "square.grid.3x3"
    case .workflow: return "point.3.connected.trianglepath.dotted"
    case .channels: return "antenna.radiowaves.left.and.right"
    case .evidence: return "doc.text.magnifyingglass"
    }
  }

  /// Whether this destination is implemented in D-PR1.
  var isBuilt: Bool { self == .operations }
}
