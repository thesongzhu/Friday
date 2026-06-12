import Foundation
import FridayRustClient

/// **The Home (Status) read view model — wired to the REAL `SealedWSReadClient`.**
///
/// The Home surface reads the refs-only Mission Workbench projection over the sealed-WS READ
/// seam. It depends on the PACKAGE's `FridayRustReadClient` protocol + `WorkbenchSnapshot`
/// (the package's types WIN — there is ONE snapshot/protocol across desktop + mobile), and on
/// the real `SealedWSReadClient` in production (a mock behind a preview/debug flag).
///
/// ## The `: Sendable` reconciliation
/// The package's `FridayRustReadClient` is deliberately NOT `Sendable` (its `SealedWSReadClient`
/// is a `final class` driving an injected transport; its `WorkbenchSnapshot` carries a
/// `raw: [String: Any]` that is not `Sendable`). To consume it cleanly from this `@MainActor`
/// view model under Swift 6 strict concurrency, we do NOT force the non-`Sendable` client or
/// snapshot across an actor hop. Instead the client is created + driven ON the main actor (the
/// `async` `fetchWorkbench()` suspends without crossing an isolation boundary), and the view
/// model surfaces a small `Sendable` `HomeProjection` projection of the refs (NOT the raw
/// snapshot) for the UI/state. This keeps the package's types authoritative while giving the
/// UI a value type that is safe to publish. (This is the SAME adapter pattern the prior mobile
/// chat-S6 PR #683 used; the desktop #682 console is the D-PR1 mock shell and does NOT yet wire
/// the package, so #683's `HomeProjection` lift — not #682 — is the integration reference.)
///
/// ## Honest-unavailable (truth rule)
/// The Rust read-projection server is DARK until the slice-6 flip, so `fetchWorkbench()` is
/// EXPECTED to throw (offline / no enrolled peer). Every throw renders as a first-class
/// `.unavailable(reason:)` — NEVER a fabricated "ready" snapshot, NEVER a label upgrade. The
/// status truth label (`runtimeFeedStatus`) and any `statusLabels` ride AS-IS.

/// A `Sendable` refs-only projection of the Home read snapshot — the fields the Home surface
/// renders, lifted off the package's (non-`Sendable`) `WorkbenchSnapshot`. Refs/labels/counts
/// only (INV-5); never a body.
public struct HomeProjection: Sendable, Equatable {
  public let missionId: String
  public let fridayConversationId: String
  /// The runtime feed status TRUTH label (e.g. `live_rust_hub_projection`). Rides AS-IS.
  public let runtimeFeedStatus: String
  /// Status labels the projection surfaced (`stale`/`offline`/`error`). Rides AS-IS.
  public let statusLabels: [String]
  public let routeDecisionSummary: String?
  /// Work-item id REFS (counts/ids only — never a body).
  public let workItemIds: [String]
  /// The Hub epoch-millis the snapshot was generated (lets the UI flag staleness).
  public let generatedAtMs: Int64

  public init(_ snapshot: WorkbenchSnapshot) {
    self.missionId = snapshot.missionId
    self.fridayConversationId = snapshot.fridayConversationId
    self.runtimeFeedStatus = snapshot.runtimeFeedStatus
    self.statusLabels = snapshot.statusLabels
    self.routeDecisionSummary = snapshot.routeDecisionSummary
    self.workItemIds = snapshot.workItemIds
    self.generatedAtMs = snapshot.generatedAtMs
  }
}

/// The loadable state of the Home read surface. `.unavailable` is a FIRST-CLASS state — a
/// dark server / 503 / offline / stale throw renders here as honest "unavailable", never as a
/// fabricated ready projection.
public enum HomeLoadState: Sendable, Equatable {
  case idle
  case loading
  case loaded(HomeProjection)
  case unavailable(reason: String)

  public var projection: HomeProjection? {
    if case let .loaded(p) = self { return p }
    return nil
  }

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }

  /// `true` only when a real projection loaded — the UI's ONLY "online" signal. A dark/offline
  /// server can never make this true (honest-unavailable).
  public var isOnline: Bool {
    projection != nil
  }
}

@MainActor
public final class HomeViewModel: ObservableObject {
  @Published public private(set) var state: HomeLoadState = .idle

  /// The package's `FridayRustReadClient` is deliberately NOT `Sendable` (its `WorkbenchSnapshot`
  /// carries a non-`Sendable` `raw: [String: Any]`), so awaiting its `nonisolated async`
  /// `fetchWorkbench()` from this `@MainActor` VM would "send" main-actor state across the hop.
  /// `nonisolated(unsafe)` drops the isolation and is SOUND here: the package clients are
  /// `final class`, every stored property is an immutable `let` (no post-init mutation), and each
  /// fetch builds a FRESH transport via `makeTransport()` — there is no shared mutable state to
  /// race. We resolve the mismatch on the CONSUMER side (never editing the #677 package).
  nonisolated(unsafe) private let client: FridayRustReadClient

  /// - Parameter client: the read client. In production this is the real `SealedWSReadClient`
  ///   (built by `FridayClientFactory.makeReadClient`); a preview/debug build injects a mock.
  public init(client: FridayRustReadClient) {
    self.client = client
  }

  /// Whether the Home is online — derived from the load state (ONLY a real loaded projection is
  /// online). Convenience for the SwiftUI surface.
  public var isOnline: Bool { state.isOnline }

  /// Re-fetch the Home read projection over the sealed-WS read seam. The only action — and it
  /// only RE-READS truth; it never writes. A throw renders AS truth (honest-unavailable).
  public func refresh() async {
    state = .loading
    do {
      let snapshot = try await client.fetchWorkbench()
      state = .loaded(HomeProjection(snapshot))
    } catch {
      state = .unavailable(reason: Self.reason(for: error))
    }
  }

  /// Map a thrown error to an honest, body-free reason string. The Rust read seam ends a
  /// session fail-closed on any auth/availability failure, surfaced as a `transport`/server
  /// error here.
  static func reason(for error: Error) -> String {
    if let e = error as? FridayReadClientError {
      switch e {
      case .badServerPubkey, .badSessionNonce:
        return "Hub handshake failed — server unavailable"
      case let .serverError(code, message):
        return "Hub unavailable (\(code.rawValue)) — \(message)"
      case let .unexpectedResponse(kind):
        return "Hub returned an unexpected response (\(kind))"
      case let .malformedProjection(why):
        return "Projection unavailable — \(why)"
      case let .transport(why):
        return "Hub offline — \(why)"
      }
    }
    return "Hub unavailable — \(error)"
  }
}

// MARK: - HonestlyUnavailableReadClient (the no-key, no-network DEFAULT)

/// A `FridayRustReadClient` that ALWAYS throws — so the Home renders honest "unavailable".
///
/// This is the iOS app's DEFAULT read client (see `FridaySession`). It is the
/// SINGLE-PEER-TRAP-safe default: it mints NO X25519 keypair, opens NO socket, and touches NO
/// SecureStore — so the simulator render can never accidentally generate a fresh peer key or
/// connect to the live read-projection server. It can never fabricate readiness; every fetch is
/// the honest dark-server state (the EXPECTED state while the Rust servers are dark / slice-6 is
/// un-flipped). The master-derived live read path is the slice-6 deferred AC (mirrors the desktop
/// `RealReadClientFactory.makeLive` / `MasterKeyPeer` derivation — NOT wired on the phone, which
/// has no master key; that is the J2 pairing problem, deferred).
public struct HonestlyUnavailableReadClient: FridayRustReadClient {
  private let reason: String
  public init(reason: String = "live Hub transport not wired (Rust servers dark — slice-6 gate)") {
    self.reason = reason
  }
  public func fetchWorkbench() async throws -> WorkbenchSnapshot {
    throw FridayReadClientError.transport(reason)
  }
}

// MARK: - PreviewReadClient (PREVIEW / DEBUG ONLY — clearly labeled)

/// **A PREVIEW/DEBUG-ONLY read client returning a static sample projection.** Used behind a
/// preview/debug flag so SwiftUI previews + UI iteration render a populated Home WITHOUT a live
/// Hub. NOT used in a real build (production wires the real `SealedWSReadClient`). The sample is
/// refs-only (INV-5) and its truth label says `preview_sample` so it can NEVER be mistaken for a
/// live projection. Optionally throws to preview the honest-unavailable state.
public struct PreviewReadClient: FridayRustReadClient {
  private let failure: FridayReadClientError?
  public init(failure: FridayReadClientError? = nil) { self.failure = failure }

  public func fetchWorkbench() async throws -> WorkbenchSnapshot {
    if let failure { throw failure }
    let json = """
    {"missionId":"mission-preview","fridayConversationId":"conv-preview",\
    "runtimeFeedStatus":"preview_sample","statusLabels":[],\
    "workItems":[{"workItemId":"wi-preview-1"},{"workItemId":"wi-preview-2"}]}
    """
    return try WorkbenchSnapshot(projectionJSON: Data(json.utf8),
                                 generatedAtMs: Int64(Date().timeIntervalSince1970 * 1000))
  }
}
