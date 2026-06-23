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
  public let pendingApproval: SessionContinuationApproval?

  public var proofRefs: [String] {
    var seen = Set<String>()
    return sections.flatMap(\.refs).filter { seen.insert($0).inserted }
  }
}

public struct SessionContinuationApproval: Sendable, Equatable {
  public let runId: String
  public let approvalId: String
  public let actionDigest: String
  public let summary: String?

  public var signingRequest: ApprovalSigningRequest {
    ApprovalSigningRequest(
      runId: runId,
      approvalId: approvalId,
      actionDigest: actionDigest,
      summary: summary)
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
  private let signer: OperatorSigner?
  private let runControlEnabled: Bool

  public init(
    client: FridayRustReadClient,
    writeClient: FridayRustWriteClient? = nil,
    signer: OperatorSigner? = nil,
    runControlEnabled: Bool = false
  ) {
    self.client = client
    self.writeClient = writeClient
    self.signer = signer
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
    var pendingApproval: SessionContinuationApproval?
    if let resolvedRunId {
      async let files = Self.fetchRunFileView(client: client, runId: resolvedRunId)
      async let readback = Self.fetchRunReadback(client: client, runId: resolvedRunId)
      async let needsMe = Self.fetchActivityNeedsMeDetail(client: client, runId: resolvedRunId)
      let needsMeDetail = await needsMe
      pendingApproval = needsMeDetail.pendingApproval
      sections.append(contentsOf: await [files, readback, needsMeDetail.section])
    } else {
      sections.append(SessionContinuationSection(
        id: "run-files",
        title: "Run Files",
        status: .notRequested(reason: "No run ref is available in the current projection."),
        summary: "run file view not requested",
        generatedAtMs: nil,
        refs: []))
      sections.append(SessionContinuationSection(
        id: "run-readback",
        title: "Run Readback",
        status: .notRequested(reason: "No run ref is available in the current projection."),
        summary: "run readback not requested",
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
        hasPendingApproval: pendingApproval != nil,
        hasWriteClient: writeClient != nil,
        hasSigner: signer != nil,
        runControlEnabled: runControlEnabled),
      pendingApproval: pendingApproval))
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

  public func resume() async {
    guard case .loaded(let snapshot) = state else { return }
    guard let approval = snapshot.pendingApproval else {
      controlStates["resume"] = .error(reason: "Resume requires a pending approval ref.")
      return
    }
    guard runControlEnabled else {
      controlStates["resume"] = .error(reason: "Resume is gated off for this session.")
      return
    }
    guard let writeClient else {
      controlStates["resume"] = .error(reason: "Resume requires the governed write client.")
      return
    }
    guard let signer else {
      controlStates["resume"] = .error(reason: "Resume requires the operator signer relay.")
      return
    }

    controlStates["resume"] = .sending
    let blob: [UInt8]
    do {
      blob = try await signer.signApproval(approval.signingRequest)
    } catch {
      controlStates["resume"] = .error(reason: Self.signerReason(for: error))
      return
    }
    guard !blob.isEmpty else {
      controlStates["resume"] = .error(reason: "Approval unavailable — the signer returned no signature")
      return
    }
    do {
      let result = try await writeClient.resumeWithApproval(runId: approval.runId, opaqueSignedBlob: blob)
      if result.accepted {
        controlStates["resume"] = .succeeded(summary: Self.controlSummary(for: result))
      } else {
        controlStates["resume"] = .error(reason: "Resume refused: \(Self.controlSummary(for: result))")
      }
    } catch {
      controlStates["resume"] = .error(reason: Self.writeReason(for: error, verb: "resume"))
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

  private nonisolated static func fetchRunReadback(
    client: FridayRustReadClient,
    runId: String
  ) async -> SessionContinuationSection {
    do {
      let snapshot = try await client.fetchRunReadback(runId: runId)
      let detail = HomeReadDetail(title: "Run Readback", snapshot: snapshot)
      return SessionContinuationSection(
        id: "run-readback",
        title: "Run Readback",
        status: .loaded,
        summary: readbackSummary(from: snapshot.raw),
        generatedAtMs: detail.generatedAtMs,
        refs: detail.refs)
    } catch {
      return SessionContinuationSection(
        id: "run-readback",
        title: "Run Readback",
        status: .unavailable(reason: reason(for: error)),
        summary: "unavailable",
        generatedAtMs: nil,
        refs: [])
    }
  }

  private nonisolated static func fetchActivityNeedsMeDetail(
    client: FridayRustReadClient,
    runId: String
  ) async -> (section: SessionContinuationSection, pendingApproval: SessionContinuationApproval?) {
    do {
      let snapshot = try await client.fetchActivityNeedsMe(runId: runId)
      let detail = HomeReadDetail(title: "Needs Me", snapshot: snapshot)
      return (
        SessionContinuationSection(
          id: "needs-me",
          title: "Needs Me",
          status: .loaded,
          summary: detail.summary,
          generatedAtMs: detail.generatedAtMs,
          refs: detail.refs),
        approval(from: snapshot.raw, fallbackRunId: runId)
      )
    } catch {
      return (
        SessionContinuationSection(
          id: "needs-me",
          title: "Needs Me",
          status: .unavailable(reason: reason(for: error)),
          summary: "unavailable",
          generatedAtMs: nil,
          refs: []),
        nil
      )
    }
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
    hasPendingApproval: Bool,
    hasWriteClient: Bool,
    hasSigner: Bool,
    runControlEnabled: Bool
  ) -> [SessionContinuationControl] {
    let stopReady = runId != nil && hasWriteClient && runControlEnabled
    let resumeReady = hasPendingApproval && hasWriteClient && hasSigner && runControlEnabled
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
    let resumeReason: String
    if resumeReady {
      resumeReason = "Pending approval refs are present; the operator signer relay can resume through the governed write seam."
    } else if !hasPendingApproval {
      resumeReason = "Resume requires a pending approval ref from Needs-Me."
    } else if !runControlEnabled {
      resumeReason = "Resume is gated off for this session."
    } else if !hasSigner {
      resumeReason = "Resume requires the operator signer relay."
    } else {
      resumeReason = "Resume requires the governed write client."
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
        truthLabel: resumeReady ? "operator-gated" : "NO-GO",
        reason: resumeReason,
        isEnabled: resumeReady),
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

  private nonisolated static func readbackSummary(from raw: [String: Any]) -> String {
    var parts: [String] = []
    if let state = firstNonEmptyString(raw, ["run_state", "runState", "status"]) {
      parts.append("state=\(state)")
    }
    if let loop = firstNonEmptyString(raw, ["loop_status_derived", "loopStatusDerived"]) {
      parts.append("loop=\(loop)")
    }
    if let events = integerText(raw, ["event_count", "eventCount"]) {
      parts.append("events=\(events)")
    }
    if let total = integerText(raw, ["db_wide_token_total", "dbWideTokenTotal"]) {
      parts.append("db-wide tokens=\(total)")
    }
    if let audit = boolText(raw, ["audit_chain_verified", "auditChainVerified"]) {
      parts.append("audit=\(audit)")
    }
    return parts.isEmpty ? "run readback loaded" : parts.joined(separator: " | ")
  }

  private nonisolated static func approval(
    from raw: [String: Any],
    fallbackRunId: String
  ) -> SessionContinuationApproval? {
    if let needsMe = raw["needs_me"] as? [String: Any],
       let approval = approval(fromItem: needsMe, fallbackRunId: fallbackRunId) {
      return approval
    }
    guard let items = raw["actionable_needs_me"] as? [[String: Any]] else { return nil }
    return items.lazy.compactMap { item in
      guard (item["kind"] as? String) == "approval_required" else { return nil }
      return approval(fromItem: item, fallbackRunId: fallbackRunId)
    }.first
  }

  private nonisolated static func approval(
    fromItem item: [String: Any],
    fallbackRunId: String
  ) -> SessionContinuationApproval? {
    let signing = item["signing_request"] as? [String: Any] ?? item
    let runId = firstNonEmptyString(signing, ["run_id", "runId"]) ?? fallbackRunId
    guard let approvalId = firstNonEmptyString(signing, ["approval_id", "approvalId", "ref_id", "refId"]),
          let actionDigest = firstNonEmptyString(signing, ["action_digest", "actionDigest"]) else {
      return nil
    }
    return SessionContinuationApproval(
      runId: runId,
      approvalId: approvalId,
      actionDigest: actionDigest,
      summary: firstNonEmptyString(signing, ["summary"]) ?? firstNonEmptyString(item, ["summary", "title"]))
  }

  private nonisolated static func firstNonEmptyString(
    _ raw: [String: Any],
    _ keys: [String]
  ) -> String? {
    keys.lazy.compactMap { raw[$0] as? String }
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty }
  }

  private nonisolated static func integerText(
    _ raw: [String: Any],
    _ keys: [String]
  ) -> String? {
    for key in keys {
      if let value = raw[key] as? Int { return "\(value)" }
      if let value = raw[key] as? UInt64 { return "\(value)" }
      if let value = raw[key] as? Int64 { return "\(value)" }
      if let value = raw[key] as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() {
        return value.stringValue
      }
    }
    return nil
  }

  private nonisolated static func boolText(
    _ raw: [String: Any],
    _ keys: [String]
  ) -> String? {
    for key in keys {
      if let value = raw[key] as? Bool {
        return value ? "verified" : "unverified"
      }
    }
    return nil
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

  private nonisolated static func signerReason(for error: Error) -> String {
    if let e = error as? OperatorSignerError { return e.description }
    return "Approval unavailable — \(error)"
  }
}
