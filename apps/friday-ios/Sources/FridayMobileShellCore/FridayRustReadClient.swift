import Foundation

/// Read-only client over hub truth.
///
/// The real implementation lives in a separate `FridayRustClient` package
/// (integrated later) and decodes the Rust Hub Mission Workbench projection JSON
/// into `WorkbenchSnapshot`. This protocol is deliberately READ-ONLY: there is no
/// mutate / dispatch / provider-admin entry point. The Hub Console consumes truth;
/// it does not author it.
///
/// `Sendable` so a concurrent/actor-backed real client conforms cleanly under
/// Swift 6 strict concurrency.
public protocol FridayRustReadClient: Sendable {
  /// Fetch the current Mission Workbench projection.
  ///
  /// Throws on transport / hub unavailability (e.g. a 503, offline, or stale-read
  /// failure). Callers must render that throw AS an honest "unavailable" state —
  /// never as a fake-ready snapshot.
  func fetchWorkbench() async throws -> WorkbenchSnapshot
}

/// Errors a read client surfaces. Each maps to an honest UI "unavailable" reason;
/// none of them is recoverable by the UI pretending the hub is ready.
public enum FridayRustReadClientError: Error, Sendable, Equatable, CustomStringConvertible {
  /// Hub responded but with a service-unavailable status (e.g. 503).
  case hubUnavailable(statusCode: Int)
  /// No connection to the hub (process down / socket closed / network offline).
  case offline
  /// Hub reachable but the projection could not be produced (no active mission, etc).
  case projectionUnavailable(reason: String)

  public var description: String {
    switch self {
    case let .hubUnavailable(statusCode):
      return "Hub unavailable (HTTP \(statusCode))"
    case .offline:
      return "Hub offline — no connection"
    case let .projectionUnavailable(reason):
      return "Projection unavailable: \(reason)"
    }
  }
}
