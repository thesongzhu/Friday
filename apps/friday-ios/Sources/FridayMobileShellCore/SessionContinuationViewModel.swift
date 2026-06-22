import Foundation
import FridayRustClient

public enum SessionContinuationSectionStatus: Sendable, Equatable {
  case loaded
  case unavailable(reason: String)
  case notRequested(reason: String)
}

public struct SessionContinuationSection: Sendable, Identifiable, Equatable {
  public let id: String
  public let title: String
  public let status: SessionContinuationSectionStatus
  public let summary: String
  public let generatedAtMs: Int64?
  public let refs: [String]
}

public struct SessionContinuationControl: Sendable, Identifiable, Equatable {
  public let id: String
  public let title: String
  public let systemImage: String
  public let truthLabel: String
  public let reason: String
  public let isEnabled: Bool
}

public struct SessionContinuationSnapshot: Sendable, Equatable {
  public let agentSessionId: String
  public let runId: String?
  public let sections: [SessionContinuationSection]
  public let controls: [SessionContinuationControl]

  public var proofRefs: [String] {
    var seen = Set<String>()
    return sections.flatMap(\.refs).filter { seen.insert($0).inserted }
  }
}

public enum SessionContinuationLoadState: Sendable, Equatable {
  case idle
  case loading(agentSessionId: String)
  case loaded(SessionContinuationSnapshot)
  case unavailable(reason: String)

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }
}

@MainActor
public final class SessionContinuationViewModel: ObservableObject {
  @Published public private(set) var state: SessionContinuationLoadState = .idle

  private let client: FridayRustReadClient

  public init(client: FridayRustReadClient) {
    self.client = client
  }

  public func refresh(agentSessionId: String?, runId: String?) async {
    let sessionId = agentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !sessionId.isEmpty else {
      state = .unavailable(reason: "Session detail requires an owner-gated agent session ref.")
      return
    }

    let trimmedRunId = runId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedRunId = (trimmedRunId?.isEmpty == false) ? trimmedRunId : nil
    state = .loading(agentSessionId: sessionId)

    async let open = Self.fetchSessionOpen(client: client, agentSessionId: sessionId)
    async let link = Self.fetchSessionLinkState(client: client, agentSessionId: sessionId)

    var sections = await [open, link]
    if let resolvedRunId {
      async let files = Self.fetchRunFileView(client: client, runId: resolvedRunId)
      async let needsMe = Self.fetchActivityNeedsMe(client: client, runId: resolvedRunId)
      sections.append(contentsOf: await [files, needsMe])
    } else {
      sections.append(SessionContinuationSection(
        id: "run-files",
        title: "Run Files",
        status: .notRequested(reason: "No run ref is available in the current projection."),
        summary: "run file view not requested",
        generatedAtMs: nil,
        refs: []))
      sections.append(SessionContinuationSection(
        id: "needs-me",
        title: "Needs Me",
        status: .notRequested(reason: "No run ref is available in the current projection."),
        summary: "needs-me activity not requested",
        generatedAtMs: nil,
        refs: []))
    }

    state = .loaded(SessionContinuationSnapshot(
      agentSessionId: sessionId,
      runId: resolvedRunId,
      sections: sections,
      controls: Self.disabledControls()))
  }

  private nonisolated static func fetchSessionOpen(
    client: FridayRustReadClient,
    agentSessionId: String
  ) async -> SessionContinuationSection {
    await fetch(
      id: "session-open",
      title: "Session Open",
      read: { try await client.fetchSessionOpen(agentSessionId: agentSessionId) })
  }

  private nonisolated static func fetchSessionLinkState(
    client: FridayRustReadClient,
    agentSessionId: String
  ) async -> SessionContinuationSection {
    await fetch(
      id: "session-link",
      title: "Link State",
      read: { try await client.fetchSessionLinkState(agentSessionId: agentSessionId) })
  }

  private nonisolated static func fetchRunFileView(
    client: FridayRustReadClient,
    runId: String
  ) async -> SessionContinuationSection {
    await fetch(
      id: "run-files",
      title: "Run Files",
      read: { try await client.fetchRunFileView(runId: runId) })
  }

  private nonisolated static func fetchActivityNeedsMe(
    client: FridayRustReadClient,
    runId: String
  ) async -> SessionContinuationSection {
    await fetch(
      id: "needs-me",
      title: "Needs Me",
      read: { try await client.fetchActivityNeedsMe(runId: runId) })
  }

  private nonisolated static func fetch(
    id: String,
    title: String,
    read: () async throws -> ReadProjectionSnapshot
  ) async -> SessionContinuationSection {
    do {
      let detail = HomeReadDetail(title: title, snapshot: try await read())
      return SessionContinuationSection(
        id: id,
        title: title,
        status: .loaded,
        summary: detail.summary,
        generatedAtMs: detail.generatedAtMs,
        refs: detail.refs)
    } catch {
      return SessionContinuationSection(
        id: id,
        title: title,
        status: .unavailable(reason: reason(for: error)),
        summary: "unavailable",
        generatedAtMs: nil,
        refs: [])
    }
  }

  private nonisolated static func disabledControls() -> [SessionContinuationControl] {
    [
      SessionContinuationControl(
        id: "send",
        title: "Send",
        systemImage: "paperplane",
        truthLabel: "NO-GO",
        reason: "Session send mutation is not built on mobile.",
        isEnabled: false),
      SessionContinuationControl(
        id: "stop",
        title: "Stop",
        systemImage: "stop.circle",
        truthLabel: "NO-GO",
        reason: "Stop requires a governed mutation endpoint; none is wired here.",
        isEnabled: false),
      SessionContinuationControl(
        id: "resume",
        title: "Resume",
        systemImage: "play.circle",
        truthLabel: "NO-GO",
        reason: "Resume is display-only until the governed continuation endpoint exists.",
        isEnabled: false),
      SessionContinuationControl(
        id: "fork",
        title: "Fork",
        systemImage: "arrow.triangle.branch",
        truthLabel: "NO-GO",
        reason: "Fork is not a built mobile mutation.",
        isEnabled: false),
    ]
  }

  private nonisolated static func reason(for error: Error) -> String {
    if let e = error as? FridayReadClientError {
      switch e {
      case .badServerPubkey, .badSessionNonce:
        return "Friday could not establish a trusted connection"
      case let .serverError(code, message):
        return "Friday is unavailable (\(code.rawValue)) — \(message)"
      case let .unexpectedResponse(kind):
        return "Friday returned an unexpected response (\(kind))"
      case let .malformedProjection(why):
        return "Status unavailable — \(why)"
      case let .transport(why):
        return "Friday is offline — \(why)"
      }
    }
    return "Friday is unavailable — \(error)"
  }
}
