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

public struct ChatReceiptRef: Codable, Sendable, Equatable, Identifiable {
  public var id: String { "\(label):\(ref)" }
  public let label: String
  public let ref: String

  public init(label: String, ref: String) {
    self.label = label
    self.ref = ref
  }
}

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

  public var receiptRefs: [ChatReceiptRef] {
    var refs = [ChatReceiptRef(label: "run_id", ref: runId)]
    appendReceiptRef("mission_id", missionId, to: &refs)
    appendReceiptRef("work_item_id", workItemId, to: &refs)
    appendReceiptRef("follow_up_work_item_id", followUpWorkItemId, to: &refs)
    appendReceiptRef("follow_up_run_id", followUpRunId, to: &refs)
    appendReceiptRef("answer_body_run_id", answerBodyRunId, to: &refs)
    appendReceiptRef("answer_sha256", answerSha256, to: &refs)
    appendReceiptRef("answer_len", answerLen.map(String.init), to: &refs)
    appendReceiptRef("answer_body", answerBodyOutcome, to: &refs)
    appendReceiptRef("turns", turns.map(String.init), to: &refs)
    appendReceiptRef("executed_tools", executedTools.map(String.init), to: &refs)
    appendReceiptRef("prompt_tokens", promptTokens.map(String.init), to: &refs)
    appendReceiptRef("completion_tokens", completionTokens.map(String.init), to: &refs)
    if let total = tokenTotal(prompt: promptTokens, completion: completionTokens) {
      refs.append(ChatReceiptRef(label: "total_tokens", ref: String(total)))
    }
    return refs
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

  public var title: String {
    switch (op, accepted) {
    case ("resume", true): return "Approved action executed"
    case ("reject", true): return "Approval rejected"
    case ("cancel", true): return "Run cancelled"
    case (_, false): return "Action refused"
    default: return "Control accepted"
    }
  }

  public var statusLabel: String {
    switch (op, accepted) {
    case ("resume", true): return "EXECUTED"
    case ("reject", true): return "REJECTED"
    case ("cancel", true): return "CANCELLED"
    case (_, false): return "REFUSED"
    default: return "ACCEPTED"
    }
  }

  public var detail: String {
    switch (op, accepted) {
    case ("resume", true): return "receipt is refs-only — no body"
    case ("reject", true): return "the pending approval was rejected; the action did NOT execute"
    case ("cancel", true): return "the run was cancelled; no further mutation executes"
    case (_, false): return "the action did NOT execute"
    default: return "control receipt is refs-only — no body"
    }
  }

  public var receiptRefs: [ChatReceiptRef] {
    var refs = [
      ChatReceiptRef(label: "run_id", ref: runId),
      ChatReceiptRef(label: "op", ref: op),
      ChatReceiptRef(label: "status", ref: status),
    ]
    appendReceiptRef("audit_ref", auditRef, to: &refs)
    appendReceiptRef("truth", truthLabel, to: &refs)
    return refs
  }
}

public struct ChatHistoryItem: Identifiable, Codable, Sendable, Equatable {
  public let id: String
  public let role: String
  public let text: String
  public let runId: String?
  public let receiptRefs: [ChatReceiptRef]
  public let createdAtMs: Int64

  public init(
    id: String,
    role: String,
    text: String,
    runId: String? = nil,
    receiptRefs: [ChatReceiptRef] = [],
    createdAtMs: Int64
  ) {
    self.id = id
    self.role = role
    self.text = text
    self.runId = runId
    self.receiptRefs = receiptRefs
    self.createdAtMs = createdAtMs
  }

  private enum CodingKeys: String, CodingKey {
    case id
    case role
    case text
    case runId
    case receiptRefs
    case createdAtMs
  }

  public init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    self.id = try container.decode(String.self, forKey: .id)
    self.role = try container.decode(String.self, forKey: .role)
    self.text = try container.decode(String.self, forKey: .text)
    self.runId = try container.decodeIfPresent(String.self, forKey: .runId)
    self.receiptRefs = try container.decodeIfPresent([ChatReceiptRef].self, forKey: .receiptRefs) ?? []
    self.createdAtMs = try container.decode(Int64.self, forKey: .createdAtMs)
  }
}

public struct ChatContextCard: Identifiable, Sendable, Equatable {
  public let id: String
  public let title: String
  public let detail: String
  public let truthLabel: String
  public let evidenceRef: String
  public let memoryCandidateId: String?
  public let memoryPreview: String?
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
  /// A rejection is being relayed to the hub (no mutation executes).
  case rejecting(ApprovalCard)
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
    case .dispatching, .resuming, .rejecting: return true
    default: return false
    }
  }
}

@MainActor
public final class FridayChatViewModel: ObservableObject {
  @Published public private(set) var phase: ChatPhase = .composing
  @Published public private(set) var history: [ChatHistoryItem]
  @Published public private(set) var contextCards: [ChatContextCard] = []
  @Published public private(set) var selectedContextCardId: String?
  @Published public private(set) var contextMemoryDecisionState: HomeLearningDecisionState?
  @Published public private(set) var contextPassportTransferState: HomeLearningDecisionState?

  /// The package write client is `Sendable`; each dispatch/control call builds a fresh transport.
  private let writeClient: FridayRustWriteClient
  private let missionClient: (any FridayMobileMissionDispatchingWriteClient)?
  private let memoryDecisionClient: (any FridayMissionSpineWriteClient)?
  private let readClient: FridayRustReadClient?
  private let signer: OperatorSigner
  private let newId: () -> String
  private let missionIdPrefix: String
  private let nowMs: () -> Int64
  private let historyStore: any ChatHistoryStoring

  /// - Parameters:
  ///   - writeClient: the real `SealedWSWriteClient` (or a mock in tests/preview). DEFAULT
  ///     read-only / no-grant dispatch; the run-control flag lives on the client.
  ///   - signer: the operator-signing RELAY seam (INV-1). The shipped app default is
  ///     `UnavailableOperatorSigner`; tests may inject `MockOperatorSigner` explicitly, and the
  ///     real desktop signer (PR #671) remains the slice-6 / operator-key gate.
  public init(
    writeClient: FridayRustWriteClient,
    signer: OperatorSigner,
    missionClient: (any FridayMobileMissionDispatchingWriteClient)? = nil,
    memoryDecisionClient: (any FridayMissionSpineWriteClient)? = nil,
    readClient: FridayRustReadClient? = nil,
    historyStore: any ChatHistoryStoring = UserDefaultsChatHistoryStore(),
    newId: @escaping () -> String = { UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "") },
    missionIdPrefix: String = "mission-mobile-",
    nowMs: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
  ) {
    self.writeClient = writeClient
    self.signer = signer
    self.missionClient = missionClient
    self.memoryDecisionClient = memoryDecisionClient ?? (writeClient as? any FridayMissionSpineWriteClient)
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
    await send(task, routePreference: .auto, constraints: constraints)
  }

  public func send(
    _ task: String,
    routePreference: MissionRoutePreference,
    constraints: AgentRunConstraintsWire? = nil
  ) async {
    let trimmed = task.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    appendHistory(role: "you", text: trimmed)
    phase = .dispatching(task: trimmed)
    if let missionClient {
      await sendMission(trimmed, routePreference: routePreference, missionClient: missionClient)
      return
    }
    do {
      let outcome = try await writeClient.dispatchAgentRun(task: trimmed, constraints: constraints)
      switch outcome {
      case .result(let r):
        let answer = await fetchDeliveredAnswerBody(for: r.runId)
        let receipt = ChatAnswerReceipt(
          r,
          answerBody: answer?.body,
          answerBodyRunId: answer?.runId,
          answerBodyOutcome: answer?.outcome)
        appendAnswerHistory(receipt)
        contextCards = Self.contextCards(for: receipt, memoryCandidate: await firstMemoryCandidate())
        phase = .answered(receipt)
      case .paused(let p):
        // INV-2: a mutating run PAUSED — surface the S6 approval card. No mutation has executed.
        appendHistory(
          role: "friday",
          text: "Approval required: \(p.ownerSealedSummary ?? "mutating action")",
          runId: p.runId)
        contextCards = []
        phase = .pendingApproval(ApprovalCard(p))
      }
    } catch {
      phase = .unavailable(reason: Self.dispatchReason(for: error))
    }
  }

  private func sendMission(
    _ task: String,
    routePreference: MissionRoutePreference,
    missionClient: any FridayMobileMissionDispatchingWriteClient
  ) async {
    do {
      let request = Self.buildMissionIntakeRequest(
        intent: task,
        owner: liveAgentRunOwnerPrincipal,
        idFactory: newId,
        missionIdPrefix: missionIdPrefix,
        routePreference: routePreference)
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
      let receipt = ChatAnswerReceipt(
        firstReceipt,
        missionId: result.missionId,
        workItemId: workItemId,
        followUpWorkItemId: followUp?.workItemId,
        followUpRunId: followUp?.runId,
        answerBody: answer?.body,
        answerBodyRunId: answer?.runId,
        answerBodyOutcome: answer?.outcome)
      appendAnswerHistory(receipt)
      contextCards = Self.contextCards(for: receipt, memoryCandidate: await firstMemoryCandidate())
      phase = .answered(receipt)
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

  private func firstMemoryCandidate() async -> HomeMemoryCandidate? {
    guard let readClient else { return nil }
    do {
      let snapshot = try await readClient.fetchWorkbench()
      return HomeProjection(snapshot).memoryCandidates.first
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
      let surfacedReceipt = ChatResumeReceipt(receipt)
      appendHistory(
        role: "friday",
        text: receipt.accepted ? "Approved action executed." : "Action refused.",
        runId: receipt.runId,
        receiptRefs: surfacedReceipt.receiptRefs)
      phase = .resumed(surfacedReceipt)
      contextCards = []
    } catch {
      phase = .unavailable(reason: Self.resumeReason(for: error))
    }
  }

  // MARK: 4. Reject / dismiss (no mutation executes)

  /// Decline the paused mutation WITHOUT approving — no resume is relayed, and the server records
  /// the pending approval as rejected. This is not a local dismiss; a failure is surfaced honestly.
  public func reject() async {
    guard case .pendingApproval(let card) = phase else { return }
    phase = .rejecting(card)
    do {
      let receipt = try await writeClient.rejectApproval(runId: card.runId, approvalId: card.approvalId)
      let surfacedReceipt = ChatResumeReceipt(receipt)
      appendHistory(
        role: "friday",
        text: receipt.accepted ? "Approval rejected." : "Approval rejection refused.",
        runId: receipt.runId,
        receiptRefs: surfacedReceipt.receiptRefs)
      phase = .resumed(surfacedReceipt)
      contextCards = []
    } catch {
      phase = .unavailable(reason: Self.rejectReason(for: error))
    }
  }

  public func clearHistory() {
    history = []
    contextCards = []
    selectedContextCardId = nil
    contextMemoryDecisionState = nil
    contextPassportTransferState = nil
    historyStore.save(history)
  }

  public func selectContextCard(_ id: String) {
    guard contextCards.contains(where: { $0.id == id }) else { return }
    selectedContextCardId = id
  }

  public func decideContextMemory(confirm: Bool) async {
    let card = contextCards.first { $0.id == "memory" }
    guard let memoryId = card?.memoryCandidateId, !memoryId.isEmpty else {
      contextMemoryDecisionState = .error(reason: "No memory candidate is available for this Chat turn.")
      return
    }
    guard let memoryDecisionClient else {
      contextMemoryDecisionState = .error(reason: "Write seam not configured.")
      return
    }

    selectedContextCardId = "memory"
    contextMemoryDecisionState = .sent
    let request = MemoryDecisionRequestWire(
      memoryId: memoryId,
      ownerPrincipal: liveAgentRunOwnerPrincipal,
      decision: confirm ? "confirm" : "reject")
    do {
      let result = try await memoryDecisionClient.submitMemoryDecision(request)
      switch result.status {
      case "confirmed", "rejected":
        contextMemoryDecisionState = .confirmed(
          summary: "\(result.status) · state=\(result.state) · recallable=\(result.recallable)")
        appendHistory(
          role: "friday",
          text: "Memory decision \(result.status).",
          receiptRefs: [
            ChatReceiptRef(label: "memory_id", ref: result.memoryId),
            ChatReceiptRef(label: "status", ref: result.status),
            ChatReceiptRef(label: "state", ref: result.state),
          ])
      default:
        let why = result.blocker ?? "blocked"
        contextMemoryDecisionState = .error(reason: "Memory decision blocked — \(why)")
      }
    } catch {
      contextMemoryDecisionState = .error(reason: Self.memoryReason(for: error))
    }
  }

  public func submitContextPassportHandoff() async {
    guard case .answered(let receipt) = phase else {
      contextPassportTransferState = .error(reason: "No answered Chat turn is available for handoff.")
      return
    }
    guard let missionId = receipt.missionId, !missionId.isEmpty else {
      contextPassportTransferState = .error(reason: "This Chat turn is not bound to a Mission.")
      return
    }
    guard let memoryDecisionClient else {
      contextPassportTransferState = .error(reason: "Write seam not configured.")
      return
    }

    selectedContextCardId = "handoff"
    contextPassportTransferState = .sent
    let workItemId = receipt.followUpWorkItemId ?? receipt.workItemId
    let runRef = receipt.answerBodyRunId ?? receipt.followUpRunId ?? receipt.runId
    let request = ContextPassportTransferRequestWire(
      passportId: "mobile-chat-passport-\(missionId)",
      missionId: missionId,
      workItemId: workItemId,
      destinationLane: "codex",
      destinationTarget: "codex",
      items: [
        ContextPassportItemWire(
          kind: "summary",
          label: "Mobile Chat handoff for mission \(missionId).",
          included: true,
          sensitive: false),
        ContextPassportItemWire(
          kind: "summary",
          label: "Answer run ref \(runRef).",
          included: true,
          sensitive: false),
        ContextPassportItemWire(
          kind: "summary",
          label: "Work item ref \(workItemId ?? "not-attached").",
          included: true,
          sensitive: false),
      ],
      approvedSensitive: false)
    do {
      let result = try await memoryDecisionClient.submitContextPassportTransfer(request)
      switch result.status {
      case "confirmed":
        contextPassportTransferState = .confirmed(
          summary: "passport \(result.passportId) · items=\(result.sharedItemCount)")
        appendHistory(
          role: "friday",
          text: "Context handoff created.",
          receiptRefs: [
            ChatReceiptRef(label: "passport_id", ref: result.passportId),
            ChatReceiptRef(label: "mission_id", ref: result.missionId),
            ChatReceiptRef(label: "link_id", ref: result.linkId ?? "none"),
          ])
      default:
        contextPassportTransferState = .error(reason: "Context passport blocked — \(result.blocker ?? "blocked")")
      }
    } catch {
      contextPassportTransferState = .error(reason: Self.memoryReason(for: error))
    }
  }

  /// Reset to a fresh composer after an answer / receipt / unavailable (start a new turn).
  public func newTurn() {
    switch phase {
    case .answered, .resumed, .unavailable:
      phase = .composing
      contextCards = []
      selectedContextCardId = nil
      contextMemoryDecisionState = nil
      contextPassportTransferState = nil
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

  static func rejectReason(for error: Error) -> String {
    if let e = error as? FridayWriteClientError { return writeReason(e, verb: "reject") }
    return "Reject unavailable — \(error)"
  }

  static func signerReason(for error: Error) -> String {
    if let e = error as? OperatorSignerError { return e.description }
    return "Approval unavailable — \(error)"
  }

  static func memoryReason(for error: Error) -> String {
    if let e = error as? FridayWriteClientError { return writeReason(e, verb: "memory decision") }
    return "Memory decision unavailable — \(error)"
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

  private func appendAnswerHistory(_ receipt: ChatAnswerReceipt) {
    let text: String
    if let body = receipt.answerBody?.trimmingCharacters(in: .whitespacesAndNewlines), !body.isEmpty {
      text = body
    } else {
      text = "Friday answered (\(receipt.status)). Run \(receipt.runId)."
    }
    appendHistory(role: "friday", text: text, runId: receipt.answerBodyRunId ?? receipt.runId, receiptRefs: receipt.receiptRefs)
  }

  private static func contextCards(
    for receipt: ChatAnswerReceipt,
    memoryCandidate: HomeMemoryCandidate?
  ) -> [ChatContextCard] {
    let runRef = receipt.answerBodyRunId ?? receipt.followUpRunId ?? receipt.runId
    return [
      ChatContextCard(
        id: "handoff",
        title: "Handoff",
        detail: "Prepare a context passport from this answer when the passport send gate is available.",
        truthLabel: "local",
        evidenceRef: "swift://mobile/fridayChat/handoff-card/\(runRef)",
        memoryCandidateId: nil,
        memoryPreview: nil),
      ChatContextCard(
        id: "memory",
        title: "Memory",
        detail: memoryCandidate?.preview ?? "Review memory candidates for this turn through the governed memory surface.",
        truthLabel: memoryCandidate == nil ? "local" : "wired",
        evidenceRef: memoryCandidate?.evidenceRef ?? "swift://mobile/fridayChat/memory-card/\(runRef)",
        memoryCandidateId: memoryCandidate?.id,
        memoryPreview: memoryCandidate?.preview),
    ]
  }

  private func appendHistory(role: String, text: String, runId: String? = nil, receiptRefs: [ChatReceiptRef] = []) {
    let item = ChatHistoryItem(
      id: newId(),
      role: role,
      text: text,
      runId: runId,
      receiptRefs: receiptRefs,
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
    missionIdPrefix: String = "mission-mobile-",
    routePreference: MissionRoutePreference = .auto
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
      lane: routePreference.lane,
      targetProviderOrAgent: routePreference.targetProviderOrAgent)
  }

  private static let claudeFollowUpTaskHeader =
    "Write a concise owner-visible summary for this Mission result."

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
}

private func appendReceiptRef(_ label: String, _ value: String?, to refs: inout [ChatReceiptRef]) {
  guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return
  }
  refs.append(ChatReceiptRef(label: label, ref: value))
}

private func tokenTotal(prompt: UInt64?, completion: UInt64?) -> UInt64? {
  guard let prompt, let completion else { return nil }
  let sum = prompt.addingReportingOverflow(completion)
  return sum.overflow ? nil : sum.partialValue
}
