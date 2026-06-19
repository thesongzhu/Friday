import Foundation

/// **The WRITE / agent-run wire types** — Swift ports of the `friday-protocol` serde structs the
/// sealed-WS WRITE seam (`bin/hub_agent_run_server.rs` + the merged Phase-2 control plane) speaks.
/// These mirror the merged Rust `friday_protocol::Message` variants
/// (`AgentRunRequest`/`AgentRunResult`/`AgentRunPaused`/`AgentRunResume`/`AgentRunControlResult`)
/// and the per-run `AgentRunConstraintsWire`, and they MIRROR the TS courier
/// (`src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.ts`) field-for-field.
///
/// The WRITE path reuses #677's SAME crypto substrate (X25519+HKDF+XChaCha20-Poly1305, the
/// sealed-WS handshake/peer-auth/seal-open framing) but DIFFERENT constants/flow than the read
/// path: the WRITE session AAD/challenge (`friday:execrun:ws:s-c:…`) and the agent-run dispatch +
/// courier pause/resume + S6 approval relay flow (not a single read projection).

// MARK: - AgentRunConstraintsWire (per-run restrictions — NEVER a grant)

/// Per-run CONSTRAINTS carried on an `AgentRunRequest`. Mirrors
/// `friday_protocol::AgentRunConstraintsWire` and the TS courier `buildConstraintsWire`.
///
/// **SECURITY / TRUTH (the load-bearing parity fact):** the WIRE carries ONLY restrictions —
/// `read_only`, `disabled_tools`, `max_turns`. A constraint can ONLY ever TIGHTEN a run; there is
/// NO wire field that GRANTS a mutating capability. The mutation-permission surface
/// (`mutatingToolGrant` + `mutationGate="operator_signed_ed25519"` + the bound-owner principal)
/// lives ENTIRELY in the TS route-admission predicate (#670 `qualifiesForRustReadOnlyRoute` in
/// `friday-api-runtime.ts`), default-off behind `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST`, and the REAL
/// runtime authority for any mutation is the operator's Ed25519-signed resume blob (PR #671).
/// This Swift client therefore exposes a `mutatingToolGrant` / `mutationGate` knob on the
/// CONSTRAINTS struct ONLY as default-off, NON-SERIALIZED admission hints (so a UI can drive the
/// chat read-WRITE loop with the intended grant) — they NEVER reach the wire. The byte-parity KAT
/// `writeConstraintsWire_emitsOnlyRestrictions` proves the ungated-mutation admission surface on
/// the wire is EXACTLY ZERO (#670 INV-2/INV-7).
public struct AgentRunConstraintsWire: Codable, Equatable, Sendable {
  /// When `true`, the run is constrained read-only (a mutating tool is blocked before execution).
  /// Absent on the wire ⇒ `false`. Emitted ONLY when `true` (Rust `#[serde(default)]`; the TS
  /// courier never emits `read_only: false`).
  public var readOnly: Bool
  /// Tools disabled for THIS run (NEVER a grant — only a restriction). Emitted ONLY when the
  /// normalized (trimmed, de-duped, non-empty) set is non-empty (Rust `skip_serializing_if`).
  public var disabledTools: [String]
  /// A per-run `max_turns` cap tighter than the runtime default. Emitted ONLY when a positive
  /// integer is given; the server takes `min(runtime_default, this)`.
  public var maxTurns: UInt64?

  // MARK: Admission hints — DEFAULT-OFF, NON-SERIALIZED (NEVER reach the wire)

  /// The explicit mutating-tool grant a UI may attach to drive the chat read-WRITE loop. This is
  /// an ADMISSION hint consumed by the TS route predicate (#670), NOT a wire field — it is
  /// `CodingKeys`-excluded so it can NEVER serialize. DEFAULT empty (read-only/no-grant).
  public var mutatingToolGrant: [String]
  /// The mutation gate the UI asserts (`"operator_signed_ed25519"`). An ADMISSION hint, NOT a
  /// wire field — `CodingKeys`-excluded. DEFAULT `nil` (no gate ⇒ no mutating admission).
  public var mutationGate: String?

  public init(
    readOnly: Bool = false,
    disabledTools: [String] = [],
    maxTurns: UInt64? = nil,
    mutatingToolGrant: [String] = [],
    mutationGate: String? = nil
  ) {
    self.readOnly = readOnly
    self.disabledTools = disabledTools
    self.maxTurns = maxTurns
    self.mutatingToolGrant = mutatingToolGrant
    self.mutationGate = mutationGate
  }

  /// ONLY the three restriction fields are wire keys. `mutatingToolGrant` / `mutationGate` are
  /// DELIBERATELY ABSENT here, so they can never serialize — the wire surface is restrictions-only.
  enum CodingKeys: String, CodingKey {
    case readOnly = "read_only"
    case disabledTools = "disabled_tools"
    case maxTurns = "max_turns"
  }

  /// Normalize a disabled-tool set EXACTLY like the TS courier `buildConstraintsWire` / the Rust
  /// `RunPolicy::new`: trim, drop empties, de-dup (order-preserving) — so a whitespace/duplicate
  /// entry can never bloat or weaken the set.
  static func normalizeToolSet(_ tools: [String]) -> [String] {
    var seen = Set<String>()
    var out: [String] = []
    for t in tools {
      let trimmed = t.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      if seen.insert(trimmed).inserted { out.append(trimmed) }
    }
    return out
  }

  /// `true` when, after normalization, NONE of the three restriction fields would be emitted —
  /// i.e. this constraints block asserts no tightening and the whole `constraints` key is OMITTED
  /// (byte-identity with the pre-A1 request). Mirrors the TS `buildConstraintsWire` returning
  /// `undefined`.
  var isWireEmpty: Bool {
    !readOnly
      && AgentRunConstraintsWire.normalizeToolSet(disabledTools).isEmpty
      && (maxTurns == nil || maxTurns == 0)
  }

  /// Custom encode mirroring the Rust serde discipline + the TS courier EXACTLY: emit `read_only`
  /// ONLY when `true`; `disabled_tools` ONLY when the normalized set is non-empty; `max_turns`
  /// ONLY when a positive integer. Field order matches the Rust struct (read_only, disabled_tools,
  /// max_turns). A hostile/garbled value at worst under-restricts to "no constraint", never a grant.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if readOnly { try c.encode(true, forKey: .readOnly) }
    let normalized = AgentRunConstraintsWire.normalizeToolSet(disabledTools)
    if !normalized.isEmpty { try c.encode(normalized, forKey: .disabledTools) }
    if let maxTurns, maxTurns > 0 { try c.encode(maxTurns, forKey: .maxTurns) }
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.readOnly = (try c.decodeIfPresent(Bool.self, forKey: .readOnly)) ?? false
    self.disabledTools = (try c.decodeIfPresent([String].self, forKey: .disabledTools)) ?? []
    self.maxTurns = try c.decodeIfPresent(UInt64.self, forKey: .maxTurns)
    self.mutatingToolGrant = []
    self.mutationGate = nil
  }
}

/// Client→hub A1 run-outcome learning decision. Mirrors
/// `friday_protocol::RunOutcomeLearningDecisionRequestWire`.
public struct RunOutcomeLearningDecisionRequestWire: Codable, Equatable, Sendable {
  public var candidateId: String
  /// EXACTLY `"confirm"` or `"reject"`.
  public var decision: String
  public var reason: String?

  public init(candidateId: String, decision: String, reason: String? = nil) {
    self.candidateId = candidateId
    self.decision = decision
    self.reason = reason
  }

  enum CodingKeys: String, CodingKey {
    case candidateId = "candidate_id"
    case decision
    case reason
  }
}

/// Hub→client A1 run-outcome learning decision receipt. Refs-only: candidate/run/kind/state/status,
/// never a run body or candidate content.
public struct RunOutcomeLearningDecisionResultWire: Codable, Equatable, Sendable {
  public var candidateId: String
  public var runId: String?
  public var kind: String?
  public var state: String
  public var status: String
  public var blocker: String?

  public init(
    candidateId: String,
    runId: String? = nil,
    kind: String? = nil,
    state: String,
    status: String,
    blocker: String? = nil
  ) {
    self.candidateId = candidateId
    self.runId = runId
    self.kind = kind
    self.state = state
    self.status = status
    self.blocker = blocker
  }

  enum CodingKeys: String, CodingKey {
    case candidateId = "candidate_id"
    case runId = "run_id"
    case kind, state, status, blocker
  }
}

// MARK: - AgentRunRequestWire

/// First-class Mission handle for a bound agent run. Mirrors
/// `friday_protocol::MissionWorkItemContextWire`; it is a selector, not authority.
public struct MissionWorkItemContextWire: Codable, Equatable, Sendable {
  public var fridayConversationId: String
  public var missionId: String
  public var workItemId: String

  public init(fridayConversationId: String, missionId: String, workItemId: String) {
    self.fridayConversationId = fridayConversationId
    self.missionId = missionId
    self.workItemId = workItemId
  }

  enum CodingKeys: String, CodingKey {
    case fridayConversationId = "friday_conversation_id"
    case missionId = "mission_id"
    case workItemId = "work_item_id"
  }
}

/// trusted-peer→hub WRITE dispatch. Mirrors `friday_protocol::Message::AgentRunRequest`'s fields
/// (flattened as siblings of `kind` on the wire). The `authProof` is the sealed possession proof
/// bound to `(forwardedPrincipal, runId)`; `sessionId`/`constraints` are additive-optional.
public struct AgentRunRequestWire: Equatable, Sendable {
  public var runId: String
  public var task: String
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var sessionId: String?
  public var constraints: AgentRunConstraintsWire?
  public var missionContext: MissionWorkItemContextWire?

  public init(
    runId: String,
    task: String,
    forwardedPrincipal: String,
    authProof: [UInt8],
    sessionId: String? = nil,
    constraints: AgentRunConstraintsWire? = nil,
    missionContext: MissionWorkItemContextWire? = nil
  ) {
    self.runId = runId
    self.task = task
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.sessionId = sessionId
    self.constraints = constraints
    self.missionContext = missionContext
  }
}

// MARK: - AgentRunResultWire (refs-only terminal receipt)

/// hub→trusted-peer REFS-ONLY terminal receipt. Mirrors `friday_protocol::Message::AgentRunResult`:
/// a coarse status + the answer FINGERPRINT (sha256/len) + run COUNTS — NEVER the body.
public struct AgentRunResultWire: Equatable, Sendable {
  public var runId: String
  public var status: String
  public var answerSha256: String?
  public var answerLen: UInt64?
  public var turns: UInt64?
  public var executedTools: UInt64?
  public var promptTokens: UInt64?
  public var completionTokens: UInt64?

  public init(
    runId: String,
    status: String,
    answerSha256: String? = nil,
    answerLen: UInt64? = nil,
    turns: UInt64? = nil,
    executedTools: UInt64? = nil,
    promptTokens: UInt64? = nil,
    completionTokens: UInt64? = nil
  ) {
    self.runId = runId
    self.status = status
    self.answerSha256 = answerSha256
    self.answerLen = answerLen
    self.turns = turns
    self.executedTools = executedTools
    self.promptTokens = promptTokens
    self.completionTokens = completionTokens
  }
}

// MARK: - AgentRunPausedWire (refs-only pause frame)

/// hub→trusted-peer pause frame. Mirrors `friday_protocol::Message::AgentRunPaused`: the single-use
/// approval `nonce` (= `pending_approval_request.approval_id` the operator signs over), the
/// `action_digest` (hex SHA-256 binding the EXACT paused action), and a coarse body-free `summary`.
/// REFS-ONLY: it carries NO signing material, tool args, or body.
public struct AgentRunPausedWire: Equatable, Sendable {
  public var runId: String
  public var nonce: String
  public var actionDigest: String
  public var summary: String

  public init(runId: String, nonce: String, actionDigest: String, summary: String) {
    self.runId = runId
    self.nonce = nonce
    self.actionDigest = actionDigest
    self.summary = summary
  }
}

// MARK: - AgentRunControlResultWire (refs-only control receipt)

/// hub→trusted-peer control-op receipt (resume/cancel/reject). Mirrors
/// `friday_protocol::Message::AgentRunControlResult`: a coarse `op`/`accepted`/`status` + an
/// optional soft `audit_ref` — NEVER a body. `accepted=false` is a fail-closed refusal.
public struct AgentRunControlResultWire: Equatable, Sendable {
  public var runId: String
  public var op: String
  public var accepted: Bool
  public var status: String
  public var auditRef: String?

  public init(runId: String, op: String, accepted: Bool, status: String, auditRef: String? = nil) {
    self.runId = runId
    self.op = op
    self.accepted = accepted
    self.status = status
    self.auditRef = auditRef
  }
}

// MARK: - Mission-spine WRITE wire types (MissionIntake + MemoryDecision)
//
// The Lane-D entry-point-A spine-WRITE shapes — Swift ports of the `friday-protocol` serde structs
// the live agent-run WRITE server (`bin/hub_agent_run_server.rs`) handles under
// `FRIDAY_MISSION_INTAKE=1` / `FRIDAY_MEMORY_CONFIRM=1` (BOTH ON in the live launch script). These
// drive the FIRST organic loop through the Rust spine: an operator-typed `MissionIntakeRequest`
// BIRTHS a Mission + WorkItem(Draft), and a `MemoryDecisionRequest{decision:"confirm"}` makes a
// pending memory candidate durable/recallable.
//
// TWO load-bearing facts that differ from the AgentRun* variants above:
//  1. WIRE SHAPE — the `FridayMessage` variants for these NEST the payload under a single named
//     field (`{"kind":"MissionIntakeRequest","request":{…}}`), the SAME internally-tagged shape as
//     the read `WorkbenchProjection*` variants — NOT the flattened `WriteKey` shape the AgentRun*
//     variants use. The Rust test `memory_decision_wire_round_trips_and_uses_the_request_result_wrapper`
//     asserts `"request":{` / `"result":{` and documents that a prior FLAT shape "503'd every call."
//  2. AUTH — these carry NO per-request `auth_proof`. The SEALED SESSION itself is the channel auth
//     (an allowlisted single peer holding the session key; the server binds the write to the
//     Rust-derived AUTHENTICATED owner `--owner admin-001`, FIX-Q3b). Unlike `dispatchAgentRun`,
//     the submit methods build NO `buildAuthProof` for these messages.

/// Client→hub Mission intake/preflight request. Mirrors `friday_protocol::MissionIntakeRequestWire`.
/// Resolves/creates a Mission from one surface input (a Hub-owned preflight mutation, NOT a
/// provider/model call). The server FAIL-CLOSES (writes ZERO rows) when `ownerPrincipal` != the
/// authenticated `--owner` (FIX-Q3b), so `ownerPrincipal` MUST equal the configured owner.
public struct MissionIntakeRequestWire: Codable, Equatable, Sendable {
  public var fridayConversationId: String
  /// MUST equal the authenticated `--owner` (live: `admin-001`) — a mismatch is a typed Error that
  /// persists nothing (NOT a silent write). Wire it from config, never raw UI input.
  public var ownerPrincipal: String
  public var surfaceThreadId: String
  /// One of the server's `surface_kind_from_wire` tokens (e.g. `desktop`, `mobile`, …); an unknown
  /// value blocks the intake.
  public var surfaceKind: String
  /// Non-empty free-form route hint (server only requires it non-empty).
  public var deliveryRoute: String
  /// One of `compact` / `rich_proof` / `status_only` / `hidden_trace_only`.
  public var visibilityPolicy: String
  /// The client SUPPLIES the Mission id (the server births the row from it).
  public var missionId: String
  /// The client SUPPLIES the WorkItem id (the server births the Draft from it).
  public var workItemId: String
  public var title: String
  public var intent: String
  /// One of `friday_hub`/`codex`/`claude`/`deepseek`/`workflow`/`channel`/`human`/`future_api`.
  public var lane: String
  /// Optional — omitted from the wire when nil (serde `skip_serializing_if`).
  public var targetProviderOrAgent: String?
  /// Optional — omitted when nil.
  public var capabilityId: String?
  /// Optional — omitted when nil. When present MUST be a Friday-owned body ref
  /// (`friday://body/…` / `friday://surface-event-body/…` / `blob://…`) or the intake blocks.
  public var bodyRef: String?
  /// ALWAYS emitted (serde `#[serde(default)]` WITHOUT skip — the server itself always serializes it).
  public var includesSensitiveContext: Bool

  public init(
    fridayConversationId: String, ownerPrincipal: String, surfaceThreadId: String,
    surfaceKind: String, deliveryRoute: String, visibilityPolicy: String,
    missionId: String, workItemId: String, title: String, intent: String, lane: String,
    targetProviderOrAgent: String? = nil, capabilityId: String? = nil,
    bodyRef: String? = nil, includesSensitiveContext: Bool = false
  ) {
    self.fridayConversationId = fridayConversationId
    self.ownerPrincipal = ownerPrincipal
    self.surfaceThreadId = surfaceThreadId
    self.surfaceKind = surfaceKind
    self.deliveryRoute = deliveryRoute
    self.visibilityPolicy = visibilityPolicy
    self.missionId = missionId
    self.workItemId = workItemId
    self.title = title
    self.intent = intent
    self.lane = lane
    self.targetProviderOrAgent = targetProviderOrAgent
    self.capabilityId = capabilityId
    self.bodyRef = bodyRef
    self.includesSensitiveContext = includesSensitiveContext
  }

  enum CodingKeys: String, CodingKey {
    case fridayConversationId = "friday_conversation_id"
    case ownerPrincipal = "owner_principal"
    case surfaceThreadId = "surface_thread_id"
    case surfaceKind = "surface_kind"
    case deliveryRoute = "delivery_route"
    case visibilityPolicy = "visibility_policy"
    case missionId = "mission_id"
    case workItemId = "work_item_id"
    case title, intent, lane
    case targetProviderOrAgent = "target_provider_or_agent"
    case capabilityId = "capability_id"
    case bodyRef = "body_ref"
    case includesSensitiveContext = "includes_sensitive_context"
  }

  /// Custom encode mirroring the Rust serde discipline: the 3 optionals are OMITTED when nil
  /// (`skip_serializing_if`); `includes_sensitive_context` is ALWAYS emitted (the server's own
  /// serialization always emits it — `#[serde(default)]` without skip).
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(fridayConversationId, forKey: .fridayConversationId)
    try c.encode(ownerPrincipal, forKey: .ownerPrincipal)
    try c.encode(surfaceThreadId, forKey: .surfaceThreadId)
    try c.encode(surfaceKind, forKey: .surfaceKind)
    try c.encode(deliveryRoute, forKey: .deliveryRoute)
    try c.encode(visibilityPolicy, forKey: .visibilityPolicy)
    try c.encode(missionId, forKey: .missionId)
    try c.encode(workItemId, forKey: .workItemId)
    try c.encode(title, forKey: .title)
    try c.encode(intent, forKey: .intent)
    try c.encode(lane, forKey: .lane)
    if let v = targetProviderOrAgent { try c.encode(v, forKey: .targetProviderOrAgent) }
    if let v = capabilityId { try c.encode(v, forKey: .capabilityId) }
    if let v = bodyRef { try c.encode(v, forKey: .bodyRef) }
    try c.encode(includesSensitiveContext, forKey: .includesSensitiveContext)
  }

  /// Decode tolerant of the optionals being absent and of `includes_sensitive_context` being
  /// omitted (serde `default` tolerance) — `?? false`.
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    fridayConversationId = try c.decode(String.self, forKey: .fridayConversationId)
    ownerPrincipal = try c.decode(String.self, forKey: .ownerPrincipal)
    surfaceThreadId = try c.decode(String.self, forKey: .surfaceThreadId)
    surfaceKind = try c.decode(String.self, forKey: .surfaceKind)
    deliveryRoute = try c.decode(String.self, forKey: .deliveryRoute)
    visibilityPolicy = try c.decode(String.self, forKey: .visibilityPolicy)
    missionId = try c.decode(String.self, forKey: .missionId)
    workItemId = try c.decode(String.self, forKey: .workItemId)
    title = try c.decode(String.self, forKey: .title)
    intent = try c.decode(String.self, forKey: .intent)
    lane = try c.decode(String.self, forKey: .lane)
    targetProviderOrAgent = try c.decodeIfPresent(String.self, forKey: .targetProviderOrAgent)
    capabilityId = try c.decodeIfPresent(String.self, forKey: .capabilityId)
    bodyRef = try c.decodeIfPresent(String.self, forKey: .bodyRef)
    includesSensitiveContext =
      (try c.decodeIfPresent(Bool.self, forKey: .includesSensitiveContext)) ?? false
  }
}

/// Hub→client Mission intake/preflight receipt. Mirrors `friday_protocol::MissionIntakeResultWire`.
/// `status` is `"ready"` / `"blocked"` / `"needs_clarification"`. With `FRIDAY_MISSION_INTAKE_CLARIFY=1`
/// LIVE, an UNDER-SPECIFIED intent returns `status:"needs_clarification"` + a non-empty
/// `clarificationQuestions` + `createdOrReady:false` (no rows written) — the Swift result MUST carry
/// these. Refs-only: it carries ids/status/blockers, never a body.
public struct MissionIntakeResultWire: Codable, Equatable, Sendable {
  public var fridayConversationId: String
  public var missionId: String
  /// Omitted from the wire when nil (serde `skip_serializing_if`).
  public var workItemId: String?
  public var surfaceThreadId: String
  public var status: String
  /// Always present (default `[]`).
  public var blockers: [String]
  public var duplicateMissionId: String?
  public var duplicateWorkItemId: String?
  public var createdOrReady: Bool
  /// Non-empty ONLY when `status == "needs_clarification"`; omitted (skip-if-empty) otherwise.
  public var clarificationQuestions: [String]

  public init(
    fridayConversationId: String, missionId: String, workItemId: String? = nil,
    surfaceThreadId: String, status: String, blockers: [String] = [],
    duplicateMissionId: String? = nil, duplicateWorkItemId: String? = nil,
    createdOrReady: Bool, clarificationQuestions: [String] = []
  ) {
    self.fridayConversationId = fridayConversationId
    self.missionId = missionId
    self.workItemId = workItemId
    self.surfaceThreadId = surfaceThreadId
    self.status = status
    self.blockers = blockers
    self.duplicateMissionId = duplicateMissionId
    self.duplicateWorkItemId = duplicateWorkItemId
    self.createdOrReady = createdOrReady
    self.clarificationQuestions = clarificationQuestions
  }

  enum CodingKeys: String, CodingKey {
    case fridayConversationId = "friday_conversation_id"
    case missionId = "mission_id"
    case workItemId = "work_item_id"
    case surfaceThreadId = "surface_thread_id"
    case status, blockers
    case duplicateMissionId = "duplicate_mission_id"
    case duplicateWorkItemId = "duplicate_work_item_id"
    case createdOrReady = "created_or_ready"
    case clarificationQuestions = "clarification_questions"
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    fridayConversationId = try c.decode(String.self, forKey: .fridayConversationId)
    missionId = try c.decode(String.self, forKey: .missionId)
    workItemId = try c.decodeIfPresent(String.self, forKey: .workItemId)
    surfaceThreadId = try c.decode(String.self, forKey: .surfaceThreadId)
    status = try c.decode(String.self, forKey: .status)
    blockers = (try c.decodeIfPresent([String].self, forKey: .blockers)) ?? []
    duplicateMissionId = try c.decodeIfPresent(String.self, forKey: .duplicateMissionId)
    duplicateWorkItemId = try c.decodeIfPresent(String.self, forKey: .duplicateWorkItemId)
    createdOrReady = try c.decode(Bool.self, forKey: .createdOrReady)
    clarificationQuestions =
      (try c.decodeIfPresent([String].self, forKey: .clarificationQuestions)) ?? []
  }

  /// Mirror the serde skip discipline: `work_item_id`/`duplicate_*` omitted when nil;
  /// `clarification_questions` omitted when empty; the rest always emitted.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(fridayConversationId, forKey: .fridayConversationId)
    try c.encode(missionId, forKey: .missionId)
    if let v = workItemId { try c.encode(v, forKey: .workItemId) }
    try c.encode(surfaceThreadId, forKey: .surfaceThreadId)
    try c.encode(status, forKey: .status)
    try c.encode(blockers, forKey: .blockers)
    if let v = duplicateMissionId { try c.encode(v, forKey: .duplicateMissionId) }
    if let v = duplicateWorkItemId { try c.encode(v, forKey: .duplicateWorkItemId) }
    try c.encode(createdOrReady, forKey: .createdOrReady)
    if !clarificationQuestions.isEmpty {
      try c.encode(clarificationQuestions, forKey: .clarificationQuestions)
    }
  }
}

/// Client→hub memory-decision request. Mirrors `friday_protocol::MemoryDecisionRequestWire`. The
/// owner's OWN action over the sealed session (NOT an agent mutating-tool action) — it does NOT
/// route the approval/trust gate. All 3 fields are always emitted. `decision` MUST be exactly
/// `"confirm"` or `"reject"` (the server parses fail-closed — any other token is an Error). The
/// server scopes from the AUTHENTICATED owner's composite namespace and IGNORES this body
/// `ownerPrincipal` for scope (set it to the configured owner anyway, for consistency).
public struct MemoryDecisionRequestWire: Codable, Equatable, Sendable {
  public var memoryId: String
  public var ownerPrincipal: String
  /// EXACTLY `"confirm"` or `"reject"`.
  public var decision: String

  public init(memoryId: String, ownerPrincipal: String, decision: String) {
    self.memoryId = memoryId
    self.ownerPrincipal = ownerPrincipal
    self.decision = decision
  }

  enum CodingKeys: String, CodingKey {
    case memoryId = "memory_id"
    case ownerPrincipal = "owner_principal"
    case decision
  }
}

/// Hub→client memory-decision receipt. Mirrors `friday_protocol::MemoryDecisionResultWire`.
/// Refs-only: candidate id + resulting lifecycle state + coarse status + recallable flag — NEVER
/// the candidate content. `status` is `"confirmed"` / `"rejected"` (applied) or `"blocked"`
/// (scope mismatch / unknown candidate / terminal / invalid decision); `blocker` is set only when
/// `status == "blocked"`.
public struct MemoryDecisionResultWire: Codable, Equatable, Sendable {
  public var memoryId: String
  /// `"candidate"` / `"confirmed"` / `"rejected"` / `"unknown"`.
  public var state: String
  /// `"confirmed"` / `"rejected"` / `"blocked"`.
  public var status: String
  /// Set ONLY when `status == "blocked"` (omitted otherwise — serde `skip_serializing_if`).
  public var blocker: String?
  public var recallable: Bool

  public init(memoryId: String, state: String, status: String, blocker: String? = nil, recallable: Bool) {
    self.memoryId = memoryId
    self.state = state
    self.status = status
    self.blocker = blocker
    self.recallable = recallable
  }

  enum CodingKeys: String, CodingKey {
    case memoryId = "memory_id"
    case state, status, blocker, recallable
  }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    memoryId = try c.decode(String.self, forKey: .memoryId)
    state = try c.decode(String.self, forKey: .state)
    status = try c.decode(String.self, forKey: .status)
    blocker = try c.decodeIfPresent(String.self, forKey: .blocker)
    recallable = try c.decode(Bool.self, forKey: .recallable)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(memoryId, forKey: .memoryId)
    try c.encode(state, forKey: .state)
    try c.encode(status, forKey: .status)
    if let v = blocker { try c.encode(v, forKey: .blocker) }
    try c.encode(recallable, forKey: .recallable)
  }
}
