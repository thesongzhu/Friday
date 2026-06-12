import Foundation

extension MissionWorkbenchRuntimeFeedStatus {
  /// A pending / unknown feed is NOT healthy — it must never render as "live/ready".
  /// (Core-level so the Home view model can classify feed health without the UI.)
  public var isHealthy: Bool { self == .liveRustHubProjection }
}

/// The loadable state of the Friday Home screen.
///
/// `.unavailable` is a first-class state — a hub 503 / offline / stale-read throw
/// renders here as honest "unavailable", never as a fabricated ready Home.
/// (Mirrors the desktop `WorkbenchLoadState` truth contract, D-PR1/#676.)
public enum HomeLoadState: Sendable, Equatable {
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

/// A provider card on Home (cardsQueues layout). Identity is the small mark + name;
/// the card opens the provider workspace (workspaceHome) in a LATER slice — in
/// M-PR1 it is an honest, non-executable placeholder destination.
public struct HomeProviderCard: Sendable, Equatable, Identifiable {
  public let id: String
  public let name: String
  /// Receipt/evidence ref count attached to this provider (refs only — never bodies).
  public let receiptRefCount: Int

  public init(id: String, name: String, receiptRefCount: Int) {
    self.id = id
    self.name = name
    self.receiptRefCount = receiptRefCount
  }
}

/// View model for the Friday Home screen (Status + heroPet + cardsQueues).
///
/// READ-ONLY by construction. The only action it exposes is `refresh()` — which
/// only re-reads the projection; it never writes. There is no mutate / dispatch /
/// approve / mark-done path, and none can be added without violating the M-PR1
/// truth contract (read-only actions only, no mutating action).
@MainActor
public final class HomeViewModel: ObservableObject {
  @Published public private(set) var state: HomeLoadState = .idle

  private let client: FridayRustReadClient

  public init(client: FridayRustReadClient) {
    self.client = client
  }

  /// Re-fetch the Workbench projection. The only mutating-looking action — and it
  /// only re-reads truth; it never writes.
  public func refresh() async {
    state = .loading
    do {
      let snapshot = try await client.fetchWorkbench()
      state = .loaded(snapshot)
    } catch {
      // Render the failure AS truth. Never fall back to a fake-ready Home.
      state = .unavailable(reason: Self.reason(for: error))
    }
  }

  private static func reason(for error: Error) -> String {
    if let clientError = error as? FridayRustReadClientError {
      return clientError.description
    }
    return "Hub unavailable — \(error)"
  }

  // MARK: - Derived Home content (refs only, truth never upgraded)

  /// Whether the projection is online/healthy (drives the heroPet "here vs offline"
  /// mood and the status chip). A pending/unknown feed is NOT healthy.
  public var isOnline: Bool {
    guard let snapshot = state.snapshot else { return false }
    return snapshot.runtimeFeedStatus.isHealthy && snapshot.statusLabels.isEmpty
  }

  /// Honest status labels (`stale` / `offline` / `error`) surfaced AS truth.
  public var statusLabels: [MissionWorkbenchStatusLabel] {
    state.snapshot?.statusLabels ?? []
  }

  /// "Needs Me" queue: work items that need operator attention and are NOT done.
  ///
  /// Truth rules baked in:
  ///  - a done / completed_with_proof item is NEVER in Needs-Me,
  ///  - a `blocked` NO-GO row IS surfaced here (as truth) but the row carries
  ///    `isExecutable == false` so the UI must render it non-actionable,
  ///  - provider_ack is NOT done, so a mission-bound provider ack that still
  ///    awaits the operator stays in the queue.
  public var needsMe: [HomeQueueItem] {
    guard let snapshot = state.snapshot else { return [] }
    return snapshot.workItems
      .filter { !$0.done && Self.needsAttention($0.state) }
      .map { HomeQueueItem(item: $0) }
  }

  /// "Running" queue: in-flight work items that are neither done nor awaiting the
  /// operator (queued / provider_ack-in-progress / reconnecting). Never includes a
  /// done item; never includes a blocked NO-GO row (that belongs to Needs-Me).
  public var running: [HomeQueueItem] {
    guard let snapshot = state.snapshot else { return [] }
    return snapshot.workItems
      .filter { !$0.done && Self.isRunning($0.state) }
      .map { HomeQueueItem(item: $0) }
  }

  /// Provider cards derived from the projection's receipt refs (small-mark identity).
  /// M-PR1 surfaces the providers that have receipt refs attached to this Mission.
  public var providerCards: [HomeProviderCard] {
    guard let snapshot = state.snapshot else { return [] }
    var cards: [HomeProviderCard] = []
    if !snapshot.providerReceiptRefs.isEmpty {
      cards.append(
        HomeProviderCard(
          id: "provider", name: "Provider session",
          receiptRefCount: snapshot.providerReceiptRefs.count))
    }
    if !snapshot.channelReceiptRefs.isEmpty {
      cards.append(
        HomeProviderCard(
          id: "channel", name: "Channel",
          receiptRefCount: snapshot.channelReceiptRefs.count))
    }
    return cards
  }

  // MARK: - Lifecycle classification

  /// States that mean "the operator must look" → Needs-Me. `blocked` is included
  /// (a NO-GO row rendered AS truth), `waiting`/`error` need a human.
  private static func needsAttention(_ state: MissionLifecycleState) -> Bool {
    switch state {
    case .blocked, .waiting, .error, .providerAck:
      return true
    case .ready, .queued, .reconnecting, .stale, .timelineRead, .completedWithProof, .unknown:
      return false
    }
  }

  /// States that mean "in flight, no operator action needed yet" → Running.
  private static func isRunning(_ state: MissionLifecycleState) -> Bool {
    switch state {
    case .ready, .queued, .reconnecting:
      return true
    case .blocked, .waiting, .error, .providerAck, .stale, .timelineRead, .completedWithProof,
      .unknown:
      return false
    }
  }
}

/// A single row in a Home queue (Needs-Me / Running). Carries refs + labels only.
public struct HomeQueueItem: Sendable, Equatable, Identifiable {
  public let id: String
  public let title: String
  public let state: MissionLifecycleState
  public let owner: MissionTruthLabel
  public let proofRef: String?
  public let done: Bool

  /// TRUTH GUARD: a `blocked` NO-GO row is surfaced AS truth in the queue but is
  /// NEVER executable. The view must not wire any dispatch/approve affordance to a
  /// row where this is false. In M-PR1 NOTHING is executable (read-only), so this
  /// is a row-level honesty signal, not a gate on a (nonexistent) action.
  public var isExecutable: Bool { false }

  public init(item: MissionWorkbenchWorkItem) {
    self.id = item.id
    self.title = item.title
    self.state = item.state
    self.owner = item.owner
    self.proofRef = item.proofRef
    self.done = item.done
  }
}
