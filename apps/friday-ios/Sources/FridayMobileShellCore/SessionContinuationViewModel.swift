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

public enum SessionContinuationControlState: Sendable, Equatable {
  case idle
  case sending
  case succeeded(summary: String)
  case error(reason: String)
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
  @Published public private(set) var controlStates: [String: SessionContinuationControlState] = [:]

  private let client: FridayRustReadClient
  private let writeClient: FridayRustWriteClient?
  private let runControlEnabled: Bool

  public init(
    client: FridayRustReadClient,
    writeClient: FridayRustWriteClient? = nil,
    runControlEnabled: Bool = false
  ) {
    self.client = client
    self.writeClient = writeClient
    self.runControlEnabled = runControlEnabled
  }

  public func refresh(agentSessionId: String?, runId: String?) async {
    let sessionId = agentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !sessionId.isEmpty else {
      state = .unavailable(reason: "Session detail requires an owner-gated agent session ref.")
      return
    }

    let trimmedRunId = runId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let resolvedRunId = (trimmedRunId?.isEmpty == false) ? trimmedRunId : nil
    controlStates = [:]
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
      controls: Self.controls(
        runId: resolvedRunId,
        hasWriteClient: writeClient != nil,
        runControlEnabled: runControlEnabled)))
  }

  public func stop() async {
    guard case .loaded(let snapshot) = state else { return }
    guard let runId = snapshot.runId?.trimmingCharacters(in: .whitespacesAndNewlines), !runId.isEmpty else {
      controlStates["stop"] = .error(reason: "Stop requires a run ref.")
      return
    }
    guard runControlEnabled else {
      controlStates["stop"] = .error(reason: "Stop is gated off for this session.")
      return
    }
    guard let writeClient else {
      controlStates["stop"] = .error(reason: "Stop requires the governed write client.")
      return
    }
    controlStates["stop"] = .sending
    do {
      let result = try await writeClient.cancelRun(
        runId: runId,
        reason: "operator stopped run from mobile session detail")
      if result.accepted {
        controlStates["stop"] = .succeeded(summary: Self.controlSummary(for: result))
      } else {
        controlStates["stop"] = .error(reason: "Stop refused: \(Self.controlSummary(for: result))")
      }
    } catch {
      controlStates["stop"] = .error(reason: Self.writeReason(for: error, verb: "stop"))
    }
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

  private nonisolated static func controls(
    runId: String?,
    hasWriteClient: Bool,
    runControlEnabled: Bool
  ) -> [SessionContinuationControl] {
    let stopReady = runId != nil && hasWriteClient && runControlEnabled
    let stopReason: String
    if stopReady {
      stopReason = "Owner-authenticated cancel is wired through the governed write seam."
    } else if runId == nil {
      stopReason = "Stop requires a run ref."
    } else if !runControlEnabled {
      stopReason = "Stop is gated off for this session."
    } else {
      stopReason = "Stop requires the governed write client."
    }
    return [
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
        truthLabel: stopReady ? "guarded" : "NO-GO",
        reason: stopReason,
        isEnabled: stopReady),
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

  private nonisolated static func controlSummary(for result: ResumeRelayResult) -> String {
    var parts = ["\(result.op): \(result.status)"]
    parts.append(result.accepted ? "accepted" : "refused")
    if let auditRef = result.auditRef, !auditRef.isEmpty {
      parts.append(auditRef)
    }
    return parts.joined(separator: " · ")
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

  private nonisolated static func writeReason(for error: Error, verb: String) -> String {
    if let e = error as? FridayWriteClientError {
      switch e {
      case .badServerPubkey, .badSessionNonce:
        return "Friday could not establish a trusted connection"
      case let .serverError(code, message):
        return "Friday is unavailable (\(code.rawValue)) — \(message)"
      case let .unexpectedResponse(kind):
        return "Friday returned an unexpected response (\(kind))"
      case let .missingRef(why):
        return "Friday returned an incomplete \(verb) response — \(why)"
      case .runControlDisabled:
        return "Stop is gated off for this session"
      case .emptySignedBlob:
        return "Stop unavailable — unexpected empty signature state"
      case let .transport(why):
        return "Friday is offline — \(why)"
      }
    }
    return "Friday is unavailable — \(error)"
  }
}
