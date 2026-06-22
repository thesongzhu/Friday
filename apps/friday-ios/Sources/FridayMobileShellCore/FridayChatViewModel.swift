import Foundation
import FridayRustClient

/// **The Friday Chat read-WRITE view model — the strict needle (S6-in-product chat loop).**
///
/// This drives the 4-state chat loop over the package's REAL `SealedWSWriteClient`
/// (`FridayRustWriteClient`) + the `OperatorSigner` relay seam:
///
///   1. **Compose → Send**  — the operator types; `send(_:)` dispatches an agent-run via
///      `dispatchAgentRun(task:constraints:)` (read-only / no-grant by DEFAULT) and shows the
///      in-flight `.dispatching` state, then the refs-only `.answered` receipt.
///   2. **Mutating → Paused** — when the run pauses (`AgentRunPaused`), the loop enters
///      `.pendingApproval` carrying the refs-only approval card (the action summary VERB + the
///      owner-sealed summary + the action digest) — the S6 approval surface.
///   3. **Approve → Resume** — `approve()` asks the injected `OperatorSigner` for the operator's
///      OPAQUE Ed25519 blob over the action digest, then relays it VERBATIM via
///      `resumeWithApproval(runId:opaqueSignedBlob:)`; on a refs-only control receipt it shows
///      `.resumed` (accepted ⇒ the action executed; refused ⇒ a successful relay of a refusal).
///   4. **(implicit) Reject / Unavailable** — declining at the signer, or a dark server, leaves
///      the mutation PAUSED or surfaces `.unavailable` — never an executed action.
///
/// ## INVARIANTS (enforced HERE, structurally)
///   - **INV-1 (relay-only, no key):** the view model holds NO signing key and mints NO
///     signature. The ONLY way it obtains approval bytes is the injected `OperatorSigner`, and
///     it relays those bytes VERBATIM to `resumeWithApproval` — it inspects/derives nothing.
///   - **INV-2 (mutating ALWAYS pauses):** a mutation can ONLY execute via the resume path,
///     which is reachable ONLY from `.pendingApproval`, which is reached ONLY by a server pause.
///     `approve()` is a NO-OP unless the loop is `.pendingApproval`. There is NO method that
///     executes a mutation without first pausing for approval — no bypass.
///   - **INV-5 (answer-body carve-out):** write/dispatch receipts stay refs-only. An answer body is
///     shown only after the separate owner-gated readback grants the authenticated owner access.
///     The pause is `{summary, actionDigest}`; the receipt is `{op, accepted, status, auditRef}`.
///   - **Honest-unavailable:** the Rust write server is DARK; `dispatchAgentRun` /
///     `resumeWithApproval` are EXPECTED to throw — every throw renders `.unavailable`, never a
///     fabricated answer/approval/receipt, never a label upgrade.

// MARK: - Surfaced models

/// The ANSWER receipt the chat shows on a non-paused settle. The write receipt remains refs-only
/// (status/fingerprint/counts). `answerBody` is populated only by the separate owner-gated readback.
public struct ChatAnswerReceipt: Sendable, Equatable {
  public let runId: String
  public let status: String
  public let answerSha256: String?
  public let answerLen: UInt64?
  public let turns: UInt64?
  public let executedTools: UInt64?
  public let promptTokens: UInt64?
  public let completionTokens: UInt64?
  public let missionId: String?
  public let workItemId: String?
  public let followUpWorkItemId: String?
  public let followUpRunId: String?
  public let answerBody: String?
  public let answerBodyRunId: String?
  public let answerBodyOutcome: String?

  init(
    _ r: AgentRunResultWire,
    missionId: String? = nil,
    workItemId: String? = nil,
    followUpWorkItemId: String? = nil,
    followUpRunId: String? = nil,
    answerBody: String? = nil,
    answerBodyRunId: String? = nil,
    answerBodyOutcome: String? = nil
  ) {
    self.runId = r.runId
    self.status = r.status
    self.answerSha256 = r.answerSha256
    self.answerLen = r.answerLen
    self.turns = r.turns
    self.executedTools = r.executedTools
    self.promptTokens = r.promptTokens
    self.completionTokens = r.completionTokens
    self.missionId = missionId
    self.workItemId = workItemId
    self.followUpWorkItemId = followUpWorkItemId
    self.followUpRunId = followUpRunId
    self.answerBody = answerBody
    self.answerBodyRunId = answerBodyRunId
    self.answerBodyOutcome = answerBodyOutcome
  }
}

/// The refs-only S6 APPROVAL CARD shown when a mutating run pauses. Mirrors `PausedOutcome`:
/// the single-use `approvalId` (nonce) + the `actionDigest` (hex fingerprint) + a coarse
/// body-free `summary`. The `actionVerb` is a coarse label DERIVED from the summary for the
/// "summary-then-proof" surface (never a body). It carries NO signing material (INV-1).
public struct ApprovalCard: Sendable, Equatable {
  /// The run that paused.
  public let runId: String
  /// The single-use approval nonce the operator signs over.
  public let approvalId: String
  /// Hex SHA-256 binding the EXACT paused action — the PROOF the operator signs over.
  public let actionDigest: String
  /// A coarse, body-free summary of WHAT paused (the owner-sealed summary). Never a body.
  public let ownerSealedSummary: String?
  /// Truth label — `rust_wired` at best (rides from the courier). NEVER upgraded.
  public let truthLabel: String

  /// A coarse action VERB for the "summary-then-proof" header — the first token of the summary
  /// (e.g. `write_file` → "write_file"), or a neutral `mutating action` when absent. A label,
  /// not a body.
  public var actionVerb: String {
    guard let s = ownerSealedSummary?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else {
      return "mutating action"
    }
    return String(s.split(whereSeparator: { $0 == " " || $0 == "(" || $0 == ":" }).first ?? Substring(s))
  }

  init(_ p: PausedOutcome) {
    self.runId = p.runId
    self.approvalId = p.approvalId
    self.actionDigest = p.actionDigest
    self.ownerSealedSummary = p.ownerSealedSummary
    self.truthLabel = p.truthLabel
  }

  /// The refs-only signing request handed to the operator signer (no body, no key).
  var signingRequest: ApprovalSigningRequest {
    ApprovalSigningRequest(
      runId: runId, approvalId: approvalId, actionDigest: actionDigest, summary: ownerSealedSummary)
  }
}

/// The refs-only RESUME RECEIPT shown after an operator-approved resume relays. Mirrors
/// `ResumeRelayResult`: a coarse `op`/`accepted`/`status` + an optional soft `auditRef`.
/// `accepted=false` is a SUCCESSFUL relay of a refusal (the action did NOT execute), NOT a
/// transport failure.
public struct ChatResumeReceipt: Sendable, Equatable {
  public let runId: String
  public let op: String
  public let accepted: Bool
  public let status: String
  public let auditRef: String?
  public let truthLabel: String

  init(_ r: ResumeRelayResult) {
    self.runId = r.runId
    self.op = r.op
    self.accepted = r.accepted
    self.status = r.status
    self.auditRef = r.auditRef
    self.truthLabel = r.truthLabel
  }
}

public struct ChatHistoryItem: Identifiable, Codable, Sendable, Equatable {
  public let id: String
  public let role: String
  public let text: String
  public let runId: String?
  public let createdAtMs: Int64

  public init(
    id: String,
    role: String,
    text: String,
    runId: String? = nil,
    createdAtMs: Int64
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.runId = runId
    self.createdAtMs = createdAtMs
  }
}

public protocol ChatHistoryStoring {
  func load() -> [ChatHistoryItem]
  func save(_ items: [ChatHistoryItem])
}

public struct UserDefaultsChatHistoryStore: ChatHistoryStoring {
  private let defaults: UserDefaults
  private let key: String

  public init(
    defaults: UserDefaults = .standard,
    key: String = "friday.mobile.chat.history.v1"
  ) {
    self.defaults = defaults
    self.key = key
  }

  public func load() -> [ChatHistoryItem] {
    guard let data = defaults.data(forKey: key) else { return [] }
    return (try? JSONDecoder().decode([ChatHistoryItem].self, from: data)) ?? []
  }

  public func save(_ items: [ChatHistoryItem]) {
    guard let data = try? JSONEncoder().encode(items) else { return }
    defaults.set(data, forKey: key)
  }
}

// MARK: - The 4-state chat phase

/// The chat loop's phase. `.unavailable` is a FIRST-CLASS state (honest-unavailable); a dark
/// server can never advance to `.answered`/`.resumed` with fabricated content.
public enum ChatPhase: Sendable, Equatable {
  /// No run in flight — the composer is ready.
  case composing
  /// A run was dispatched and is settling (the streaming/loop indicator).
  case dispatching(task: String)
  /// The run settled with a refs-only answer (non-mutating path complete).
  case answered(ChatAnswerReceipt)
  /// The run PAUSED on a mutating tool — the S6 approval card is shown, awaiting approval.
  case pendingApproval(ApprovalCard)
  /// An approval is being signed + relayed (the resume is in flight).
  case resuming(ApprovalCard)
  /// The resume relayed and settled with a refs-only receipt (accepted ⇒ executed; refused ⇒
  /// a successful relay of a refusal — the action did NOT execute).
  case resumed(ChatResumeReceipt)
  /// A dark server / transport / signer failure — honest "unavailable", never a fabricated
  /// answer/approval/receipt.
  case unavailable(reason: String)

  /// `true` only while a mutating run is paused awaiting the operator's approval.
  public var isAwaitingApproval: Bool {
    if case .pendingApproval = self { return true }
    return false
  }

  public var isBusy: Bool {
    switch self {
    case .dispatching, .resuming: return true
    default: return false
    }
  }
}

@MainActor
public final class FridayChatViewModel: ObservableObject {
  @Published public private(set) var phase: ChatPhase = .composing
  @Published public private(set) var history: [ChatHistoryItem]

  /// The package's `FridayRustWriteClient` is not `Sendable` (same reason as the read client),
  /// so awaiting its `nonisolated async` dispatch/resume from this `@MainActor` VM would "send"
  /// main-actor state across the hop. `nonisolated(unsafe)` is SOUND here: the package write
  /// client is a `final class` with immutable `let` stored state, and each dispatch/resume builds
  /// a FRESH transport — no shared mutable state to race. Resolved on the CONSUMER side (the #677
  /// package is never edited). The `signer` is already `Sendable` (the protocol requires it).
  nonisolated(unsafe) private let writeClient: FridayRustWriteClient
  private let missionClient: (any FridayMobileMissionDispatchingWriteClient)?
  private let readClient: FridayRustReadClient?
  private let signer: OperatorSigner
  private let newId: () -> String
  private let missionIdPrefix: String
  private let nowMs: () -> Int64
  private let historyStore: any ChatHistoryStoring

  /// - Parameters:
  ///   - writeClient: the real `SealedWSWriteClient` (or a mock in tests/preview). DEFAULT
  ///     read-only / no-grant dispatch; the run-control flag lives on the client.
  ///   - signer: the operator-signing RELAY seam (INV-1). Mock now (`MockOperatorSigner`); the
  ///     real desktop signer (PR #671) is the slice-6 / operator-key gate.
  public init(
    writeClient: FridayRustWriteClient,
    signer: OperatorSigner,
    missionClient: (any FridayMobileMissionDispatchingWriteClient)? = nil,
    readClient: FridayRustReadClient? = nil,
    historyStore: any ChatHistoryStoring = UserDefaultsChatHistoryStore(),
    newId: @escaping () -> String = { UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "") },
    missionIdPrefix: String = "mission-mobile-",
    nowMs: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
  ) {
    self.writeClient = writeClient
    self.signer = signer
    self.missionClient = missionClient
    self.readClient = readClient
    self.historyStore = historyStore
    self.newId = newId
    self.missionIdPrefix = missionIdPrefix
    self.nowMs = nowMs
    self.history = historyStore.load()
  }

  // MARK: 1. Compose → Send

  /// Dispatch one agent-run for the typed task (read-only / no-grant by DEFAULT). Settles
  /// refs-only on the first inbound: an answer (`.answered`) or a pause (`.pendingApproval`).
  /// A blank task is a no-op (nothing to ask). A throw renders honest-unavailable.
  ///
  /// `constraints` defaults to `nil` (no tightening, no grant). A caller MAY pass constraints
  /// to TIGHTEN the run; the grant/gate admission hints never reach the wire (the mutation is
  /// operator-gated downstream + at the resume).
  public func send(_ task: String, constraints: AgentRunConstraintsWire? = nil) async {
    let trimmed = task.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    appendHistory(role: "you", text: trimmed)
    phase = .dispatching(task: trimmed)
    if let missionClient {
      await sendMission(trimmed, missionClient: missionClient)
      return
    }
    do {
      let outcome = try await writeClient.dispatchAgentRun(task: trimmed, constraints: constraints)
      switch outcome {
      case .result(let r):
        let answer = await fetchDeliveredAnswerBody(for: r.runId)
        appendAnswerHistory(runId: r.runId, status: r.status, answerBody: answer?.body)
        phase = .answered(ChatAnswerReceipt(
          r,
          answerBody: answer?.body,
          answerBodyRunId: answer?.runId,
          answerBodyOutcome: answer?.outcome))
      case .paused(let p):
        // INV-2: a mutating run PAUSED — surface the S6 approval card. No mutation has executed.
        appendHistory(
          role: "friday",
          text: "Approval required: \(p.ownerSealedSummary ?? "mutating action")",
          runId: p.runId)
        phase = .pendingApproval(ApprovalCard(p))
      }
    } catch {
      phase = .unavailable(reason: Self.dispatchReason(for: error))
    }
  }

  private func sendMission(
    _ task: String,
    missionClient: any FridayMobileMissionDispatchingWriteClient
  ) async {
    do {
      let request = Self.buildMissionIntakeRequest(
        intent: task,
        owner: liveAgentRunOwnerPrincipal,
        idFactory: newId,
        missionIdPrefix: missionIdPrefix)
      let result = try await missionClient.submitMissionIntake(request)
      guard result.status == "ready", let workItemId = result.workItemId else {
        phase = .unavailable(reason: "Mission intake not ready — \(result.status)")
        return
      }

      let firstOutcome = try await missionClient.dispatchMissionBoundAgentRun(
        task: task,
        missionContext: MissionWorkItemContextWire(
          fridayConversationId: result.fridayConversationId,
          missionId: result.missionId,
          workItemId: workItemId),
        constraints: AgentRunConstraintsWire(readOnly: true))
      guard case .result(let firstReceipt) = firstOutcome else {
        phase = .unavailable(reason: "Mission dispatch paused — approval required")
        return
      }

      let firstAnswer = await fetchDeliveredAnswerBody(for: firstReceipt.runId)
      let followUp = try await dispatchClaudeFollowUpIfPresent(
        sourceWorkItemId: workItemId,
        firstRunId: firstReceipt.runId,
        firstAnswerBody: firstAnswer?.body,
        intakeResult: result,
        missionClient: missionClient)
      let bodyRunId = followUp?.runId ?? firstReceipt.runId
      let answer = await fetchDeliveredAnswerBody(for: bodyRunId)
      appendAnswerHistory(runId: bodyRunId, status: firstReceipt.status, answerBody: answer?.body)
      phase = .answered(ChatAnswerReceipt(
        firstReceipt,
        missionId: result.missionId,
        workItemId: workItemId,
        followUpWorkItemId: followUp?.workItemId,
        followUpRunId: followUp?.runId,
        answerBody: answer?.body,
        answerBodyRunId: answer?.runId,
        answerBodyOutcome: answer?.outcome))
    } catch {
      phase = .unavailable(reason: Self.dispatchReason(for: error))
    }
  }

  private func dispatchClaudeFollowUpIfPresent(
    sourceWorkItemId: String,
    firstRunId: String,
    firstAnswerBody: String?,
    intakeResult: MissionIntakeResultWire,
    missionClient: any FridayMissionBoundRunWriteClient
  ) async throws -> (workItemId: String, runId: String)? {
    guard let readClient else { return nil }
    let followUpWorkItemId = "\(sourceWorkItemId)-claude-followup"
    let snapshot = try await readClient.fetchWorkbench()
    guard snapshot.missionId == intakeResult.missionId,
      snapshot.workItemIds.contains(followUpWorkItemId)
    else {
      return nil
    }

    let outcome = try await missionClient.dispatchMissionBoundAgentRun(
      task: Self.claudeFollowUpTask(
        sourceWorkItemId: sourceWorkItemId,
        followUpWorkItemId: followUpWorkItemId,
        firstRunId: firstRunId,
        firstAnswerBody: firstAnswerBody),
      missionContext: MissionWorkItemContextWire(
        fridayConversationId: intakeResult.fridayConversationId,
        missionId: intakeResult.missionId,
        workItemId: followUpWorkItemId),
      constraints: AgentRunConstraintsWire(readOnly: true))
    guard case .result(let receipt) = outcome else {
      return nil
    }
    return (followUpWorkItemId, receipt.runId)
  }

  private func fetchDeliveredAnswerBody(for runId: String) async -> (runId: String, body: String, outcome: String)? {
    guard let readClient else { return nil }
    do {
      let body = try await readClient.fetchRunAnswerBody(runId: runId)
      guard let answer = body.deliveredAnswer else {
        return nil
      }
      return (body.runId, answer, body.outcome)
    } catch {
      return nil
    }
  }

  // MARK: 3. Approve → Resume (the S6 relay — INV-1, INV-2)

  /// Approve the paused mutation: obtain the operator's OPAQUE signed blob from the injected
  /// signer (the app mints NOTHING — INV-1) and relay it VERBATIM via `resumeWithApproval`.
  ///
  /// INV-2 (HARD precondition): this is a NO-OP unless the loop is `.pendingApproval`. There is
  /// no other path to a mutation. A signer throw (declined / unavailable / no key) leaves the
  /// mutation PAUSED-as-unavailable — NO resume is relayed, so the mutation does NOT execute.
  public func approve() async {
    guard case .pendingApproval(let card) = phase else {
      // INV-2: approval is meaningless without a pending pause. No bypass.
      return
    }
    phase = .resuming(card)

    // INV-1: the ONLY source of approval bytes is the external signer. The app holds no key.
    let blob: [UInt8]
    do {
      blob = try await signer.signApproval(card.signingRequest)
    } catch {
      // No signature ⇒ no resume relayed ⇒ the mutation does NOT execute. Surface honestly and
      // return to the paused card so the operator can retry (INV-2 preserved).
      phase = .unavailable(reason: Self.signerReason(for: error))
      return
    }
    guard !blob.isEmpty else {
      // An empty blob can carry no signature — never relay it (matches the client's INV-1 guard).
      phase = .unavailable(reason: "Approval unavailable — the signer returned no signature")
      return
    }

    do {
      // INV-1: relay the OPAQUE blob VERBATIM. The view model inspects/derives nothing in it.
      let receipt = try await writeClient.resumeWithApproval(runId: card.runId, opaqueSignedBlob: blob)
      appendHistory(
        role: "friday",
        text: receipt.accepted ? "Approved action executed." : "Action refused.",
        runId: receipt.runId)
      phase = .resumed(ChatResumeReceipt(receipt))
    } catch {
      phase = .unavailable(reason: Self.resumeReason(for: error))
    }
  }

  // MARK: 4. Reject / dismiss (no mutation executes)

  /// Decline the paused mutation WITHOUT approving — the mutation does NOT execute (no resume is
  /// relayed). Returns the loop to composing. A reject is local-only here; the run's pause times
  /// out / is cancelled server-side (the resume is the ONLY thing that could execute it).
  public func reject() {
    guard phase.isAwaitingApproval else { return }
    if case .pendingApproval(let card) = phase {
      appendHistory(role: "friday", text: "Approval rejected.", runId: card.runId)
    }
    phase = .composing
  }

  public func clearHistory() {
    history = []
    historyStore.save(history)
  }

  /// Reset to a fresh composer after an answer / receipt / unavailable (start a new turn).
  public func newTurn() {
    switch phase {
    case .answered, .resumed, .unavailable:
      phase = .composing
    default:
      // Do NOT abandon an in-flight dispatch or a pending approval (would drop the S6 gate).
      break
    }
  }

  // MARK: Honest-unavailable reason mapping (refs-only, no body)

  static func dispatchReason(for error: Error) -> String {
    if let e = error as? FridayWriteClientError { return writeReason(e, verb: "dispatch") }
    return "Friday is unavailable — \(error)"
  }

  static func resumeReason(for error: Error) -> String {
    if let e = error as? FridayWriteClientError { return writeReason(e, verb: "resume") }
    return "Resume unavailable — \(error)"
  }

  static func signerReason(for error: Error) -> String {
    if let e = error as? OperatorSignerError { return e.description }
    return "Approval unavailable — \(error)"
  }

  private static func writeReason(_ e: FridayWriteClientError, verb: String) -> String {
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
      return "Approvals are not available yet — no action was resumed"
    case .emptySignedBlob:
      return "Approval unavailable — the signer returned no signature"
    case let .transport(why):
      return "Friday is offline — \(why)"
    }
  }

  private func appendAnswerHistory(runId: String, status: String, answerBody: String?) {
    let text: String
    if let body = answerBody?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
      text = body
    } else {
      text = "Friday answered (\(status)). Run \(runId)."
    }
    appendHistory(role: "friday", text: text, runId: runId)
  }

  private func appendHistory(role: String, text: String, runId: String? = nil) {
    let item = ChatHistoryItem(
      id: newId(),
      role: role,
      text: text,
      runId: runId,
      createdAtMs: nowMs())
    history.append(item)
    if history.count > 100 {
      history.removeFirst(history.count - 100)
    }
    historyStore.save(history)
  }

  static func buildMissionIntakeRequest(
    intent: String,
    owner: String,
    idFactory: () -> String,
    missionIdPrefix: String = "mission-mobile-"
  ) -> MissionIntakeRequestWire {
    let id = idFactory()
    return MissionIntakeRequestWire(
      fridayConversationId: "fconv_mobile_\(id)",
      ownerPrincipal: owner,
      surfaceThreadId: "surface-mobile-\(id)",
      surfaceKind: "mobile",
      deliveryRoute: "ios://friday-mobile/chat/\(id)",
      visibilityPolicy: "compact",
      missionId: "\(missionIdPrefix)\(id)",
      workItemId: "work-mobile-\(id)",
      title: String(intent.prefix(72)),
      intent: intent,
      lane: "auto")
  }

  private static let claudeFollowUpTaskHeader =
    "Summarize the generated Claude follow-up for this Mission."

  private static func claudeFollowUpTask(
    sourceWorkItemId: String,
    followUpWorkItemId: String,
    firstRunId: String,
    firstAnswerBody: String?
  ) -> String {
    var lines = [
      claudeFollowUpTaskHeader,
      "source_work_item_id=\(sourceWorkItemId)",
      "follow_up_work_item_id=\(followUpWorkItemId)",
      "codex_first_run_id=\(firstRunId)",
    ]
    lines.append(
      "input refs: mission context, attached WorkItem refs, and the codex_first_run_id above are sufficient.")
    lines.append(
      "output destination: owner-visible answer body for \(followUpWorkItemId).")
    lines.append(
      "success = concise final synthesis that preserves any requested sentinel or outcome from the Codex first-leg answer.")
    lines.append(
      "constraint = read-only; do not mutate the workspace, do not continue file discovery, and do not ask clarifying questions.")
    if let firstAnswerBody = firstAnswerBody?.trimmingCharacters(in: .whitespacesAndNewlines),
      !firstAnswerBody.isEmpty
    {
      lines.append("Codex first-leg answer:")
      lines.append(firstAnswerBody)
    }
    lines.append(
      "Use the Mission context and the proof/input refs already attached to this WorkItem; do not ask the operator for paths, IDs, or artifact locations that are listed above.")
    lines.append(
      "Keep the run read-only; summarize the Codex first-leg answer and this follow-up outcome, and do not claim you verified unrelated files or artifacts unless that evidence is explicitly present in the provided context.")
    return lines.joined(separator: "\n")
  }
}
