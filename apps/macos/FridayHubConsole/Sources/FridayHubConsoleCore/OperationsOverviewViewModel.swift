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

public enum ReadProjectionDetailArm: Sendable, Equatable {
  case runReadback(runId: String)
  case providersDoctor(probe: String?)
  case sessionList
  case sessionOpen(agentSessionId: String)
  case sessionLinkState(agentSessionId: String)
  case runFileView(runId: String)
  case activityNeedsMe(runId: String)

  public var title: String {
    switch self {
    case .runReadback: return "Run readback"
    case .providersDoctor: return "Provider doctor"
    case .sessionList: return "Session list"
    case .sessionOpen: return "Session open"
    case .sessionLinkState: return "Session link state"
    case .runFileView: return "Run files"
    case .activityNeedsMe: return "Needs-me activity"
    }
  }
}

public struct ReadProjectionDetail: Sendable, Equatable {
  public let title: String
  public let generatedAtMs: Int64
  public let summary: String
  public let refs: [String]

  public init(title: String, snapshot: ReadProjectionSnapshot) {
    let raw = snapshot.raw
    self.title = title
    self.generatedAtMs = snapshot.generatedAtMs
    self.summary = Self.summary(from: raw)
    self.refs = Self.refs(from: raw)
  }

  private static func summary(from raw: [String: Any]) -> String {
    let parts = [
      firstString(raw, ["missionId", "mission_id"]).map { "mission=\($0)" },
      firstString(raw, ["runId", "run_id"]).map { "run=\($0)" },
      firstString(raw, ["status", "outcome"]).map { "status=\($0)" },
      firstString(raw, ["truthLabel", "truth_label"]).map { "truth=\($0)" },
    ].compactMap { $0 }
    return parts.isEmpty ? "projection loaded" : parts.joined(separator: " | ")
  }

  private static func refs(from raw: [String: Any]) -> [String] {
    let keys = [
      "proofRef", "proof_ref", "evidenceRef", "evidence_ref", "providerRef", "provider_ref",
      "channelRef", "channel_ref", "timelineRef", "timeline_ref", "receiptRef", "receipt_ref",
    ]
    var refs = keys.compactMap { raw[$0] as? String }
    for key in ["proofRefs", "proof_refs", "evidenceRefs", "evidence_refs", "receiptRefs", "receipt_refs"] {
      refs.append(contentsOf: raw[key] as? [String] ?? [])
    }
    var seen = Set<String>()
    return refs.filter { !$0.isEmpty && seen.insert($0).inserted }
  }

  private static func firstString(_ raw: [String: Any], _ keys: [String]) -> String? {
    keys.lazy.compactMap { raw[$0] as? String }.first
  }
}

public enum ReadProjectionDetailState: Sendable, Equatable {
  case idle
  case loading(ReadProjectionDetailArm)
  case loaded(ReadProjectionDetail)
  case unavailable(title: String, reason: String)

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }
}

public struct ChatTurnRefs: Sendable, Equatable {
  public let missionId: String
  public let workItemId: String?
  public let runIds: [String]

  public init(missionId: String, workItemId: String?, runIds: [String]) {
    self.missionId = missionId
    self.workItemId = workItemId
    var seen = Set<String>()
    self.runIds = runIds.filter { !$0.isEmpty && seen.insert($0).inserted }
  }
}

public struct ChatNeedsMeItem: Sendable, Equatable, Identifiable {
  public let runId: String
  public let kind: String
  public let title: String
  public let refId: String
  public let state: String
  public let deepLink: String?
  public let actionDigest: String?
  public let signingSummary: String?

  public var id: String { "\(runId):\(kind):\(refId)" }

  public init(
    runId: String,
    kind: String,
    title: String,
    refId: String,
    state: String,
    deepLink: String?,
    actionDigest: String? = nil,
    signingSummary: String? = nil
  ) {
    self.runId = runId
    self.kind = kind
    self.title = title
    self.refId = refId
    self.state = state
    self.deepLink = deepLink
    self.actionDigest = actionDigest
    self.signingSummary = signingSummary
  }
}

public enum ChatReviewState: Sendable, Equatable {
  case idle
  case loading(runIds: [String])
  case loaded(items: [ChatNeedsMeItem])
  case unavailable(reason: String)

  public var isLoading: Bool {
    if case .loading = self { return true }
    return false
  }
}

/// The state of a single spine-WRITE action (mission intake / memory decision).
///
/// Mirrors `WorkbenchLoadState`'s honest vocabulary: a `.sent` action shows pending, a terminal
/// `.confirmed` carries a coarse refs-only summary, and any failure (transport / typed Error / a
/// server `status:"blocked"`) renders AS `.error` — never upgraded to a fake-confirmed look.
public enum WriteActionState: Sendable, Equatable {
  /// No action attempted (or reset) — the control is enabled.
  case ready
  /// The request is in flight (handshake + sealed send + awaiting the refs-only receipt).
  case sent
  /// A terminal SUCCESS receipt. `summary` is a coarse line (status + ids + recallable);
  /// `answerBody` is populated only by the explicit owner-gated answer-body readback arm.
  /// `clarificationQuestions` is non-empty ONLY for a `needs_clarification` intake.
  case confirmed(summary: String, clarificationQuestions: [String] = [], answerBody: String? = nil)
  /// A terminal FAILURE rendered AS truth — a transport/honest-unavailable error, a typed server
  /// Error, OR a server `status:"blocked"` receipt (e.g. the synthetic-candidate-id block). Never a
  /// fabricated success.
  case error(reason: String)

  public var isSent: Bool {
    if case .sent = self { return true }
    return false
  }

  /// `true` once a terminal outcome has been reached (success or error) — the control disables.
  public var isTerminal: Bool {
    switch self {
    case .confirmed, .error: return true
    case .ready, .sent: return false
    }
  }
}

/// View model for the Operations Overview screen.
///
/// READ-FIRST: the read projection (`refresh()` + `select(_:)`) stays a pure read — it NEVER writes.
/// The spine-WRITE surface is an ADDITIVE, separately-injected collaborator (`writeClient`), used
/// ONLY by the two explicit organic-loop drivers below; it is never folded into `refresh()`:
///  - `refresh()`              — re-fetch the projection (RefreshStatus),
///  - `select(_:)`             — focus a row in the proof inspector (OpenEvidence-class nav),
///  - `submitIntake(intent:)`  — drive ONE operator-typed Mission intake over the sealed WRITE seam,
///  - `decideMemory(...)`      — drive ONE owner confirm/reject of a memory candidate.
/// The write drivers are gated: with no `writeClient` (or an honest-unavailable one) they render the
/// truth, never a fabricated confirm. No provider-admin / arbitrary-mutation method is exposed.
@MainActor
public final class OperationsOverviewViewModel: ObservableObject {
  @Published public private(set) var state: WorkbenchLoadState = .idle
  @Published public private(set) var detailState: ReadProjectionDetailState = .idle
  @Published public var selection: InspectorSelection = .none

  /// The mission-intake compose action's honest state.
  @Published public private(set) var intakeState: WriteActionState = .ready
  /// Per-candidate memory-decision action state, keyed by the candidate's display id.
  @Published public private(set) var memoryDecisionStates: [String: WriteActionState] = [:]
  /// Per-candidate A1 run-outcome learning decision state, keyed by candidate id.
  @Published public private(set) var runOutcomeLearningDecisionStates: [String: WriteActionState] = [:]
  /// Structured refs for the latest desktop Chat turn. This avoids parsing status prose in the UI.
  @Published public private(set) var latestChatTurn: ChatTurnRefs?
  /// Refs-only Needs-Me rows for the latest Chat turn's runs.
  @Published public private(set) var chatReviewState: ChatReviewState = .idle

  public let devicePairing: DesktopDevicePairingReadiness

  private let client: FridayRustReadClient
  /// The spine-WRITE collaborator. `nil` ⇒ the write seam is not configured (the drivers render
  /// honest-unavailable). Separate from `client` so the read contract stays a pure read.
  private let writeClient: FridayMissionSpineWriteClient?
  /// Optional model-turn bridge. When present, a ready MissionIntake receipt immediately dispatches
  /// a read-only mission-bound run using the server-produced Mission handle.
  private let missionRunClient: FridayMissionBoundRunWriteClient?
  /// The owner principal the WRITE body self-supplies — MUST equal the server's `--owner`
  /// (`admin-001`); the server fail-closes a mismatch (FIX-Q3b). Wired from config, not UI input.
  private let writeOwnerPrincipal: String
  /// A fresh-id factory for the client-supplied mission/work-item ids (the server births rows from
  /// them). Injectable for deterministic tests.
  private let newId: @Sendable () -> String
  private let missionIdPrefix: String

  public init(
    client: FridayRustReadClient,
    writeClient: FridayMissionSpineWriteClient? = nil,
    missionRunClient: FridayMissionBoundRunWriteClient? = nil,
    writeOwnerPrincipal: String = liveReadProjectionOwnerPrincipal,
    devicePairing: DesktopDevicePairingReadiness = .evaluate(),
    newId: @escaping @Sendable () -> String = { UUID().uuidString },
    missionIdPrefix: String = "mission-desktop-"
  ) {
    self.client = client
    self.writeClient = writeClient
    self.missionRunClient = missionRunClient
    self.writeOwnerPrincipal = writeOwnerPrincipal
    self.devicePairing = devicePairing
    self.newId = newId
    self.missionIdPrefix = missionIdPrefix
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

  public func loadDetail(_ arm: ReadProjectionDetailArm) async {
    detailState = .loading(arm)
    do {
      let snapshot = try await readDetail(arm)
      detailState = .loaded(ReadProjectionDetail(title: arm.title, snapshot: snapshot))
    } catch {
      detailState = .unavailable(title: arm.title, reason: Self.reason(for: error))
    }
  }

  public func loadLatestChatReview() async {
    guard let turn = latestChatTurn, !turn.runIds.isEmpty else {
      chatReviewState = .idle
      return
    }
    chatReviewState = .loading(runIds: turn.runIds)
    do {
      var items: [ChatNeedsMeItem] = []
      for runId in turn.runIds {
        let snapshot = try await client.fetchActivityNeedsMe(runId: runId)
        items.append(contentsOf: Self.chatNeedsMeItems(from: snapshot.raw, runId: runId))
      }
      chatReviewState = .loaded(items: items)
    } catch {
      chatReviewState = .unavailable(reason: Self.reason(for: error))
    }
  }

  private func readDetail(_ arm: ReadProjectionDetailArm) async throws -> ReadProjectionSnapshot {
    switch arm {
    case let .runReadback(runId):
      return try await client.fetchRunReadback(runId: runId)
    case let .providersDoctor(probe):
      return try await client.fetchProvidersDoctor(probe: probe)
    case .sessionList:
      return try await client.fetchSessionList()
    case let .sessionOpen(agentSessionId):
      return try await client.fetchSessionOpen(agentSessionId: agentSessionId)
    case let .sessionLinkState(agentSessionId):
      return try await client.fetchSessionLinkState(agentSessionId: agentSessionId)
    case let .runFileView(runId):
      return try await client.fetchRunFileView(runId: runId)
    case let .activityNeedsMe(runId):
      return try await client.fetchActivityNeedsMe(runId: runId)
    }
  }

  // MARK: - Spine-WRITE drivers (Lane-D entry-point-A organic loop)

  /// Submit ONE operator-typed Mission intake over the sealed WRITE seam. Births a Mission +
  /// WorkItem(Draft) server-side, then dispatches a mission-bound read-only model run when the
  /// model-turn bridge is configured; renders the refs-only receipt honestly:
  ///  - `ready`               ⇒ `.confirmed` (status + mission/work-item ids),
  ///  - `needs_clarification` ⇒ `.confirmed` carrying the questions (rendered as a clarification ask),
  ///  - `blocked`             ⇒ `.error` (the blockers),
  ///  - a transport/honest-unavailable throw ⇒ `.error` (the truth).
  /// On any SUCCESS path it then `await refresh()`s so the new Mission appears in the read projection.
  public func submitIntake(intent: String) async {
    let trimmed = intent.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      intakeState = .error(reason: "Enter an intent before submitting.")
      return
    }
    guard let writeClient else {
      intakeState = .error(reason: "Write seam not configured — cannot submit an intake.")
      latestChatTurn = nil
      chatReviewState = .idle
      return
    }
    intakeState = .sent
    latestChatTurn = nil
    chatReviewState = .idle
    let request = Self.buildIntakeRequest(
      intent: trimmed, owner: writeOwnerPrincipal, idFactory: newId,
      missionIdPrefix: missionIdPrefix)
    do {
      let result = try await writeClient.submitMissionIntake(request)
      switch result.status {
      case "blocked":
        let why = result.blockers.isEmpty ? "blocked" : result.blockers.joined(separator: ", ")
        intakeState = .error(reason: "Intake blocked — \(why)")
      case "needs_clarification":
        intakeState = .confirmed(
          summary: "Needs clarification — no rows written yet (mission \(result.missionId))",
          clarificationQuestions: result.clarificationQuestions)
        await refresh()
      default:
        // ready / created_or_ready
        var summary = "Mission intake \(result.status) · mission_id=\(result.missionId)"
        var answerBodies: [String] = []
        var runIds: [String] = []
        if let workItemId = result.workItemId { summary += " · work_item_id=\(workItemId)" }
        if let workItemId = result.workItemId, let missionRunClient {
          let context = MissionWorkItemContextWire(
            fridayConversationId: result.fridayConversationId,
            missionId: result.missionId,
            workItemId: workItemId)
          do {
            let outcome = try await missionRunClient.dispatchMissionBoundAgentRun(
              task: trimmed,
              missionContext: context,
              constraints: AgentRunConstraintsWire(readOnly: true))
            summary += Self.dispatchSummary(for: outcome)
            runIds.append(contentsOf: Self.runIds(for: outcome))
            let codexAnswerBody = await answerBodyText(for: outcome, label: "Codex")
            if let codexAnswerBody {
              answerBodies.append(codexAnswerBody)
            }
            if let followUpSummary = try await dispatchClaudeFollowUpIfPresent(
              sourceWorkItemId: workItemId,
              firstOutcome: outcome,
              firstAnswerBody: codexAnswerBody,
              intakeResult: result,
              missionRunClient: missionRunClient)
            {
              summary += followUpSummary.summary
              runIds.append(contentsOf: Self.runIds(for: followUpSummary.outcome))
              if let answerBody = await answerBodyText(for: followUpSummary.outcome, label: "Claude follow-up") {
                answerBodies.append(answerBody)
              }
            }
            intakeState = .confirmed(
              summary: summary,
              clarificationQuestions: result.clarificationQuestions,
              answerBody: Self.joinAnswerBodies(answerBodies))
          } catch {
            intakeState = .error(
              reason: "Mission intake ready, but model dispatch failed — \(Self.writeReason(for: error))")
          }
        } else {
          intakeState = .confirmed(summary: summary, clarificationQuestions: result.clarificationQuestions)
        }
        latestChatTurn = ChatTurnRefs(
          missionId: result.missionId,
          workItemId: result.workItemId,
          runIds: runIds)
        await refresh()
        await loadLatestChatReview()
      }
    } catch {
      intakeState = .error(reason: Self.writeReason(for: error))
      latestChatTurn = nil
      chatReviewState = .idle
    }
  }

  private func dispatchClaudeFollowUpIfPresent(
    sourceWorkItemId: String,
    firstOutcome: AgentRunDispatchOutcome,
    firstAnswerBody: String?,
    intakeResult: MissionIntakeResultWire,
    missionRunClient: FridayMissionBoundRunWriteClient
  ) async throws -> FollowUpDispatch? {
    let followUpWorkItemId = "\(sourceWorkItemId)-claude-followup"
    let wire = try await client.fetchWorkbench()
    let snapshot = try WorkbenchSnapshotAdapter.display(from: wire)
    guard snapshot.missionId == intakeResult.missionId,
      snapshot.workItems.contains(where: { $0.id == followUpWorkItemId })
    else {
      return nil
    }

    let outcome = try await missionRunClient.dispatchMissionBoundAgentRun(
      task: Self.claudeFollowUpTask(
        sourceWorkItemId: sourceWorkItemId,
        followUpWorkItemId: followUpWorkItemId,
        firstRunId: Self.runId(for: firstOutcome),
        firstAnswerBody: firstAnswerBody),
      missionContext: MissionWorkItemContextWire(
        fridayConversationId: intakeResult.fridayConversationId,
        missionId: intakeResult.missionId,
        workItemId: followUpWorkItemId),
      constraints: AgentRunConstraintsWire(readOnly: true))
    return FollowUpDispatch(
      summary: " · follow_up_work_item_id=\(followUpWorkItemId)" + Self.dispatchSummary(for: outcome),
      outcome: outcome)
  }

  private struct FollowUpDispatch {
    let summary: String
    let outcome: AgentRunDispatchOutcome
  }

  private func answerBodyText(for outcome: AgentRunDispatchOutcome, label: String) async -> String? {
    guard case let .result(result) = outcome else { return nil }
    do {
      let body = try await client.fetchRunAnswerBody(runId: result.runId)
      if let answer = body.deliveredAnswer?.trimmingCharacters(in: .whitespacesAndNewlines),
        !answer.isEmpty
      {
        return "\(label): \(answer)"
      }
      let reason = body.denyReason ?? body.status ?? body.outcome
      return "\(label): answer body unavailable (\(reason))"
    } catch {
      return "\(label): answer body unavailable (\(Self.reason(for: error)))"
    }
  }

  private static func joinAnswerBodies(_ answerBodies: [String]) -> String? {
    let nonEmpty = answerBodies.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return nonEmpty.isEmpty ? nil : nonEmpty.joined(separator: "\n\n")
  }

  /// Submit ONE owner confirm/reject for a memory candidate over the sealed WRITE seam, keyed by the
  /// candidate's display id. `memoryId` is what the server decides on.
  ///
  /// HONEST-STATE NOTE (Layer-D prerequisite): the read projection currently surfaces a SYNTHETIC
  /// candidate id, not the durable `memory_item` row id, so a confirm against it returns
  /// `status:"blocked"` (`unknown_candidate`) — which is rendered AS `.error` (never a fake confirm).
  /// A real confirm closes only once the read projection surfaces the real memory_id (a cross-team
  /// Rust change, out of scope here). Either way the control is wired end-to-end and honest.
  public func decideMemory(candidateId: String, memoryId: String, confirm: Bool) async {
    guard let writeClient else {
      memoryDecisionStates[candidateId] = .error(reason: "Write seam not configured.")
      return
    }
    memoryDecisionStates[candidateId] = .sent
    let request = MemoryDecisionRequestWire(
      memoryId: memoryId, ownerPrincipal: writeOwnerPrincipal,
      decision: confirm ? "confirm" : "reject")
    do {
      let result = try await writeClient.submitMemoryDecision(request)
      switch result.status {
      case "confirmed", "rejected":
        memoryDecisionStates[candidateId] = .confirmed(
          summary: "\(result.status) · state=\(result.state) · recallable=\(result.recallable)")
        await refresh()
      default:  // "blocked"
        let why = result.blocker ?? "blocked"
        memoryDecisionStates[candidateId] = .error(reason: "Decision blocked — \(why)")
      }
    } catch {
      memoryDecisionStates[candidateId] = .error(reason: Self.writeReason(for: error))
    }
  }

  /// Submit ONE owner confirm/reject for an A1 run-outcome learning candidate over the sealed WRITE
  /// seam. This is governance for a refs-only candidate emitted from a real run outcome; `blocked`
  /// remains an error-shaped truth state, never a fake confirm.
  public func decideRunOutcomeLearning(candidateId: String, confirm: Bool) async {
    guard let writeClient else {
      runOutcomeLearningDecisionStates[candidateId] = .error(reason: "Write seam not configured.")
      return
    }
    runOutcomeLearningDecisionStates[candidateId] = .sent
    let request = RunOutcomeLearningDecisionRequestWire(
      candidateId: candidateId,
      decision: confirm ? "confirm" : "reject")
    do {
      let result = try await writeClient.submitRunOutcomeLearningDecision(request)
      switch result.status {
      case "confirmed", "rejected":
        let kind = result.kind ?? "unknown"
        runOutcomeLearningDecisionStates[candidateId] = .confirmed(
          summary: "\(result.status) · state=\(result.state) · kind=\(kind)")
        await refresh()
      default:
        let why = result.blocker ?? "blocked"
        runOutcomeLearningDecisionStates[candidateId] = .error(
          reason: "Learning decision blocked — \(why)")
      }
    } catch {
      runOutcomeLearningDecisionStates[candidateId] = .error(reason: Self.writeReason(for: error))
    }
  }

  /// Build a desktop Mission-intake request from one operator intent. The mission/work-item ids are
  /// CLIENT-supplied (the server births rows from them); `surface_kind`/`visibility_policy`/`lane`
  /// are server-accepted tokens; `delivery_route` is a non-empty desktop route hint. `owner` MUST
  /// equal the server `--owner` (FIX-Q3b). The title is a short prefix of the intent.
  static func buildIntakeRequest(
    intent: String, owner: String, idFactory: () -> String,
    missionIdPrefix: String = "mission-desktop-"
  ) -> MissionIntakeRequestWire {
    let title = String(intent.prefix(72))
    let id = idFactory()
    return MissionIntakeRequestWire(
      fridayConversationId: "fconv_desktop_\(id)",
      ownerPrincipal: owner,
      surfaceThreadId: "surface-desktop-\(id)",
      surfaceKind: "desktop",
      deliveryRoute: "desktop://hub-console/operations/\(id)",
      visibilityPolicy: "compact",
      missionId: "\(missionIdPrefix)\(id)",
      workItemId: "work-desktop-\(id)",
      title: title,
      intent: intent,
      lane: "auto")
  }

  /// Map a write-client error to an honest unavailable reason (mirrors `reason(for:)`'s tone).
  static func writeReason(for error: Error) -> String {
    if let writeError = error as? FridayWriteClientError {
      switch writeError {
      case let .transport(detail):
        return "Hub offline — write seam unavailable (\(detail))"
      case .badServerPubkey:
        return "Write seam unavailable — invalid server identity"
      case .badSessionNonce:
        return "Write seam unavailable — invalid session handshake"
      case let .serverError(code, message):
        return "Write rejected — server error \(code): \(message)"
      case let .unexpectedResponse(kind):
        return "Write seam unavailable — unexpected response (\(kind))"
      case let .missingRef(detail):
        return "Write seam unavailable — \(detail)"
      case .runControlDisabled:
        return "Write seam unavailable — run control disabled"
      case .emptySignedBlob:
        return "Write seam unavailable — empty signed blob"
      }
    }
    // The LoopbackSealedWSTransport throws the package READ error type from its frame I/O.
    if let readError = error as? FridayReadClientError {
      switch readError {
      case let .transport(detail):
        return "Hub offline — write seam unavailable (\(detail))"
      default:
        return "Write seam unavailable — \(readError)"
      }
    }
    return "Write seam unavailable — \(error)"
  }

  static func dispatchSummary(for outcome: AgentRunDispatchOutcome) -> String {
    switch outcome {
    case .result(let result):
      return " · run_id=\(result.runId) · run_status=\(result.status)"
    case .paused(let paused):
      return " · run_id=\(paused.runId) · paused_for_approval=\(paused.approvalId)"
    }
  }

  private static let claudeFollowUpTaskHeader =
    "Write a concise owner-visible summary for this Mission result."

  private static func claudeFollowUpTask(
    sourceWorkItemId: String,
    followUpWorkItemId: String,
    firstRunId: String?,
    firstAnswerBody: String?
  ) -> String {
    var lines = [
      claudeFollowUpTaskHeader,
      "source_work_item_id=\(sourceWorkItemId)",
      "follow_up_work_item_id=\(followUpWorkItemId)",
    ]
    if let firstRunId {
      lines.append("codex_first_run_id=\(firstRunId)")
    }
    lines.append(
      "input refs: mission context, attached WorkItem refs, and the codex_first_run_id above are sufficient.")
    lines.append(
      "output destination: owner-visible answer body for \(followUpWorkItemId).")
    lines.append(
      "task: produce the final owner-visible answer for this follow-up WorkItem, not a plan.")
    lines.append(
      "success = concise final synthesis that preserves the outcome token or requested result below.")
    lines.append(
      "constraints = read-only; no file changes; no extra discovery; do not ask clarifying questions.")
    if let outcomeExcerpt = firstAnswerOutcomeExcerpt(firstAnswerBody) {
      lines.append("Codex first-leg outcome excerpt:")
      lines.append(outcomeExcerpt)
    }
    lines.append(
      "Use only the Mission context, attached refs, and outcome excerpt above; do not ask the operator for paths, IDs, or artifact locations that are listed above.")
    lines.append(
      "Return the owner-visible answer directly; do not continue any first-person action described in the Codex excerpt, and do not claim you verified unrelated files or artifacts.")
    return lines.joined(separator: "\n")
  }

  private static func firstAnswerOutcomeExcerpt(_ body: String?) -> String? {
    guard let raw = body?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return nil
    }
    if let sentinel = raw.range(of: #"FRIDAY_[A-Z0-9_]+_OK"#, options: .regularExpression) {
      return String(raw[sentinel])
    }
    let lines = raw.split(whereSeparator: { $0.isNewline })
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    let excerpt = lines.last ?? raw
    if excerpt.count <= 800 {
      return String(excerpt)
    }
    return String(excerpt.suffix(800))
  }

  private static func runId(for outcome: AgentRunDispatchOutcome) -> String? {
    guard case let .result(result) = outcome else { return nil }
    return result.runId
  }

  private static func runIds(for outcome: AgentRunDispatchOutcome) -> [String] {
    switch outcome {
    case .result(let result):
      return [result.runId]
    case .paused(let paused):
      return [paused.runId]
    }
  }

  nonisolated static func chatNeedsMeItems(from raw: [String: Any], runId: String) -> [ChatNeedsMeItem] {
    var items: [ChatNeedsMeItem] = []
    if let needsMe = raw["needs_me"] as? [String: Any],
      let item = chatNeedsMeItem(needsMe, runId: runId, fallbackKind: "approval")
    {
      items.append(item)
    }
    if let actionable = raw["actionable_needs_me"] as? [[String: Any]] {
      for rawItem in actionable {
        if let item = chatNeedsMeItem(rawItem, runId: runId, fallbackKind: "review") {
          items.append(item)
        }
      }
    }
    var seen = Set<String>()
    return items.filter { seen.insert($0.id).inserted }
  }

  nonisolated private static func chatNeedsMeItem(
    _ raw: [String: Any],
    runId: String,
    fallbackKind: String
  ) -> ChatNeedsMeItem? {
    let kind = string(raw["kind"]) ?? fallbackKind
    guard let refId = string(raw["ref_id"]), !refId.isEmpty else { return nil }
    let title = string(raw["title"]) ?? string(raw["summary"]) ?? kind
    let state = string(raw["state"]) ?? string(raw["status"]) ?? "pending"
    return ChatNeedsMeItem(
      runId: runId,
      kind: kind,
      title: title,
      refId: refId,
      state: state,
      deepLink: string(raw["deep_link"]),
      actionDigest: signingField("action_digest", raw),
      signingSummary: signingField("summary", raw))
  }

  nonisolated private static func signingField(_ key: String, _ raw: [String: Any]) -> String? {
    if let direct = string(raw[key]), !direct.isEmpty {
      return direct
    }
    if let signingRequest = raw["signing_request"] as? [String: Any],
      let nested = string(signingRequest[key]), !nested.isEmpty
    {
      return nested
    }
    return nil
  }

  nonisolated private static func string(_ value: Any?) -> String? {
    switch value {
    case let value as String:
      return value
    case let value as CustomStringConvertible:
      return value.description
    default:
      return nil
    }
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
