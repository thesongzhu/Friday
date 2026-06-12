import Foundation

// The READ-ONLY client protocol the Console consumes is now the SINGLE source of truth
// from the `FridayRustClient` package (`FridayRustReadClient` — re-exported below). The
// Console's former duplicate protocol + its rich `WorkbenchSnapshot` are reconciled like
// so:
//   - PROTOCOL: deleted here; the package's `FridayRustReadClient` (now `: Sendable`,
//     aligned with the Console's old constraint) is the survivor. `import FridayRustClient`
//     makes the bare name resolve to it across Core.
//   - SNAPSHOT: the package's `WorkbenchSnapshot` is a THIN refs-only wire type
//     (workItemIds/routeDecisionSummary/raw). The Console's rich, fully-typed
//     `WorkbenchSnapshot` (the whole UI consumes its work-items/capabilities/transcript
//     tree) is KEPT as the display model. The local declaration shadows the imported one
//     within Core, so bare `WorkbenchSnapshot` stays the rich type; the wire type is
//     qualified `FridayRustClient.WorkbenchSnapshot` in the adapter + real-client factory.
//   - ADAPTER: `WorkbenchSnapshotAdapter` bridges the wire snapshot's `raw` JSON into the
//     rich display model (see WorkbenchSnapshotAdapter.swift).

// Re-export ONLY the protocol so the executable can name `FridayRustReadClient` without
// importing FridayRustClient directly. The package's thin `WorkbenchSnapshot` is deliberately
// NOT re-exported: within Core the local rich `WorkbenchSnapshot` declaration shadows it, and
// re-exporting the wire type would make the bare name ambiguous downstream. The adapter +
// factory qualify the wire type as `FridayRustClient.WorkbenchSnapshot` where they need it.
@_exported import protocol FridayRustClient.FridayRustReadClient

/// Errors the Console's MOCK read client surfaces (and the view model maps to an honest UI
/// "unavailable" reason). Kept Console-local on purpose: it is the mock/preview/test error
/// vocabulary (503 / offline / projection-unavailable). The REAL client throws the package's
/// `FridayReadClientError`; the view model's `reason(for:)` maps BOTH to honest unavailable.
/// None of these is recoverable by the UI pretending the hub is ready.
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
