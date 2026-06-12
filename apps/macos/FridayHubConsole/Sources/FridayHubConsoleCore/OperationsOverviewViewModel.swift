import Foundation
import FridayRustClient

/// What the right-docked proof inspector is currently focused on.
/// Each case carries only refs/labels — never a body to load.
public enum InspectorSelection: Sendable, Equatable {
  case none
  case workItem(id: String)
  case capability(id: String)
  case transcriptEvent(id: String)
  case routeDecision
}

/// The loadable state of the Operations Overview.
///
/// `.unavailable` is a first-class state — a hub 503 / offline / stale-read throw
/// renders here as honest "unavailable", never as a fabricated ready snapshot.
public enum WorkbenchLoadState: Sendable, Equatable {
  case idle
  case loading
  case loaded(WorkbenchSnapshot)
  case unavailable(reason: String)

  public var snapshot: WorkbenchSnapshot? {
    if case let .loaded(snapshot) = self { return snapshot }
    return nil
  }

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }
}

/// View model for the Operations Overview screen.
///
/// READ-ONLY by construction. The only actions it exposes are:
///  - `refresh()`         — re-fetch the projection (RefreshStatus),
///  - `select(_:)`        — focus a row in the proof inspector (OpenEvidence-class nav).
/// There is no mutate / dispatch / approve / provider-admin method, and none can
/// be added without violating the D-PR1 truth contract.
@MainActor
public final class OperationsOverviewViewModel: ObservableObject {
  @Published public private(set) var state: WorkbenchLoadState = .idle
  @Published public var selection: InspectorSelection = .none

  private let client: FridayRustReadClient

  public init(client: FridayRustReadClient) {
    self.client = client
  }

  /// Re-fetch the Workbench projection. The only mutating-looking action — and it
  /// only re-reads truth; it never writes.
  ///
  /// `client.fetchWorkbench()` returns the package's THIN refs-only wire snapshot; the
  /// adapter re-decodes its `raw` projection JSON into the rich display model. A transport
  /// throw (the dark/un-flipped read server — the NORMAL pre-slice-6 state) OR an adapter
  /// decode failure both land in `.unavailable`, rendered AS truth — never a fake-ready snapshot.
  public func refresh() async {
    state = .loading
    do {
      let wire = try await client.fetchWorkbench()
      let snapshot = try WorkbenchSnapshotAdapter.display(from: wire)
      state = .loaded(snapshot)
    } catch {
      // Render the failure AS truth. Never fall back to a fake-ready snapshot.
      state = .unavailable(reason: Self.reason(for: error))
    }
  }

  /// Focus a row in the proof inspector (read-only navigation).
  public func select(_ selection: InspectorSelection) {
    self.selection = selection
  }

  private static func reason(for error: Error) -> String {
    // Mock / preview / adapter vocabulary (503 / offline / projection-unavailable).
    if let clientError = error as? FridayRustReadClientError {
      return clientError.description
    }
    // The REAL `SealedWSReadClient` throws the package's error type. Each variant maps to an
    // honest "unavailable" reason — including a closed/refused transport, which is exactly the
    // dark/un-flipped read server (the NORMAL state until the slice-6 operator flip).
    if let readError = error as? FridayReadClientError {
      return Self.reason(for: readError)
    }
    return "Hub unavailable — \(error)"
  }

  /// Map the package read client's typed error to an honest unavailable reason string.
  private static func reason(for error: FridayReadClientError) -> String {
    switch error {
    case let .transport(detail):
      return "Hub offline — no connection (\(detail))"
    case .badServerPubkey:
      return "Hub unavailable — invalid server identity"
    case .badSessionNonce:
      return "Hub unavailable — invalid session handshake"
    case let .serverError(code, message):
      return "Hub unavailable — server error \(code): \(message)"
    case let .unexpectedResponse(kind):
      return "Hub unavailable — unexpected response (\(kind))"
    case let .malformedProjection(detail):
      return "Projection unavailable: \(detail)"
    }
  }

  // MARK: - Derived inspector content (refs only)

  /// The refs to show in the proof inspector for the current selection.
  /// Returns redacted ref strings only; there is no body-load path.
  public var inspectorRefs: [InspectorRef] {
    guard let snapshot = state.snapshot else { return [] }
    switch selection {
    case .none:
      return []
    case let .workItem(id):
      guard let item = snapshot.workItems.first(where: { $0.id == id }) else { return [] }
      var refs: [InspectorRef] = [InspectorRef(label: "work_item_id", ref: item.id)]
      if let proof = item.proofRef { refs.append(InspectorRef(label: "proofRef", ref: proof)) }
      return refs
    case let .capability(id):
      guard let cap = snapshot.capabilityStates.first(where: { $0.id == id }) else { return [] }
      return [
        InspectorRef(label: "capability_id", ref: cap.id),
        InspectorRef(label: "proofRef", ref: cap.proofRef),
      ]
    case let .transcriptEvent(id):
      for section in snapshot.transcriptSections {
        if let event = section.events.first(where: { $0.id == id }) {
          var refs: [InspectorRef] = [InspectorRef(label: "activity_id", ref: event.id)]
          if let proof = event.proofRef { refs.append(InspectorRef(label: "proofRef", ref: proof)) }
          refs.append(
            contentsOf: event.evidenceRefs.orderedPairs.map {
              InspectorRef(label: $0.label, ref: $0.ref)
            })
          return refs
        }
      }
      return []
    case .routeDecision:
      var refs = [InspectorRef(label: "selectedRoute", ref: snapshot.routeDecision.selectedRoute)]
      refs.append(
        contentsOf: snapshot.routeDecision.alternatives.enumerated().map {
          InspectorRef(label: "alternative_\($0.offset)", ref: $0.element)
        })
      return refs
    }
  }
}

/// A single labeled redacted ref shown in the proof inspector.
public struct InspectorRef: Sendable, Equatable, Identifiable {
  public let label: String
  public let ref: String
  public var id: String { "\(label):\(ref)" }

  public init(label: String, ref: String) {
    self.label = label
    self.ref = ref
  }
}
