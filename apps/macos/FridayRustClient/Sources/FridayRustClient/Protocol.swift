import Foundation

/// **The wire types the Rust read-projection server speaks** — Swift ports of the
/// `friday-protocol` serde structs the sealed-WS read seam uses. Both endpoints are
/// JSON (gate §4.6), so these are `Codable` structs whose JSON shape is byte-compatible
/// with the Rust `serde_json` serialization.
///
/// Sources mirrored (read-seam branch `ui-read-seam-sr0-sr1-20260611`):
/// - `friday-protocol/src/lib.rs`: `Envelope`, `Message` (`#[serde(tag = "kind")]`),
///   `WorkbenchProjectionRequestWire`, `WorkbenchProjectionSnapshotWire`, `ErrorCode`.
/// - `bin/hub_read_projection_server.rs`: the request/response flow + owner-seal.

/// Inclusive supported schema-version range / current version. Mirrors
/// `friday_protocol::CURRENT_SCHEMA_VERSION`. Kept in step with the read-seam branch.
public let fridayCurrentSchemaVersion: UInt16 = 13

// MARK: - ErrorCode

/// Mirrors `friday_protocol::ErrorCode` with `#[serde(rename_all = "SCREAMING_SNAKE_CASE")]`.
public enum FridayErrorCode: String, Codable, Equatable, Sendable {
  case pairingDenied = "PAIRING_DENIED"
  case deviceRevoked = "DEVICE_REVOKED"
  case schemaVersionUnsupported = "SCHEMA_VERSION_UNSUPPORTED"
  case hubOffline = "HUB_OFFLINE"
  case providerUnavailable = "PROVIDER_UNAVAILABLE"
  case rateLimited = "RATE_LIMITED"
  case idempotencyReplay = "IDEMPOTENCY_REPLAY"
  case `internal` = "INTERNAL"
}

// MARK: - WorkbenchProjection wire types

/// Client→read-server request for the Mission Workbench read projection. Mirrors
/// `friday_protocol::WorkbenchProjectionRequestWire`. `auth_proof` is the sealed
/// possession-of-session proof; serde serializes `Vec<u8>` as a JSON array of numbers,
/// so this is `[UInt8]`.
public struct WorkbenchProjectionRequestWire: Codable, Equatable {
  /// Optional Mission id; absent ⇒ the first active Mission. `skip_serializing_if` on
  /// the Rust side OMITS this key when `nil`.
  public var missionId: String?
  /// The TS-token-resolved / device-resolved principal conveyed by the peer. VERIFIED
  /// against the sealed session before release.
  public var forwardedPrincipal: String
  /// The sealed possession-of-session proof, bound to `request_id` + `forwarded_principal`
  /// in its AAD. Opaque bytes; serde array-of-numbers form.
  public var authProof: [UInt8]
  /// The opaque per-request id the `auth_proof` is bound to (the read analog of `run_id`).
  public var requestId: String

  public init(missionId: String?, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.missionId = missionId
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case missionId = "mission_id"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }

  // Custom encode so an absent `missionId` is OMITTED (matches Rust
  // `skip_serializing_if = "Option::is_none"`), and the request bytes are byte-identical
  // to what the Rust test client / TS client send.
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if let missionId { try c.encode(missionId, forKey: .missionId) }
    try c.encode(forwardedPrincipal, forKey: .forwardedPrincipal)
    try c.encode(authProof, forKey: .authProof)
    try c.encode(requestId, forKey: .requestId)
  }
}

/// Read-server→client refs-only Mission Workbench snapshot wire frame. Mirrors
/// `friday_protocol::WorkbenchProjectionSnapshotWire`. The `projectionJson` carries the
/// OWNER-SEALED ciphertext as lowercase hex of `[nonce_len][nonce][ciphertext]` — the
/// client opens it under the session key to recover the refs-only projection JSON.
public struct WorkbenchProjectionSnapshotWire: Codable, Equatable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

// MARK: - Message (tagged enum, `#[serde(tag = "kind")]`)

/// The subset of `friday_protocol::Message` the read seam uses, tagged by `kind` (serde
/// uses the Rust variant name as the tag value). The read client only constructs a
/// `WorkbenchProjectionRequest` and only decodes a `WorkbenchProjectionSnapshot` or an
/// `Error` — every other inbound kind is surfaced as `.unsupported`, never silently dropped.
public enum FridayMessage: Equatable {
  case workbenchProjectionRequest(WorkbenchProjectionRequestWire)
  case workbenchProjectionSnapshot(WorkbenchProjectionSnapshotWire)
  case error(code: FridayErrorCode, message: String)

  // MARK: - WRITE / agent-run seam (GATE-AGENT-REPLACE)

  /// trusted-peer→hub: dispatch one production agent-run to the Rust loop over the sealed WS
  /// WRITE session. Mirrors `friday_protocol::Message::AgentRunRequest`. The `auth_proof` is
  /// the sealed possession-of-session proof bound to `(forwarded_principal, run_id)`; `constraints`
  /// can ONLY tighten the run (a restriction, never a grant).
  case agentRunRequest(AgentRunRequestWire)
  /// hub→trusted-peer: REFS-ONLY terminal receipt (status + answer fingerprint + counts — NEVER
  /// the body). Mirrors `friday_protocol::Message::AgentRunResult`.
  case agentRunResult(AgentRunResultWire)
  /// hub→trusted-peer: the loop's gate PAUSED a mutating tool, awaiting an operator approval.
  /// REFS-ONLY (nonce + action_digest + summary). Mirrors `friday_protocol::Message::AgentRunPaused`.
  case agentRunPaused(AgentRunPausedWire)
  /// trusted-peer→hub: relay an operator's OPAQUE Ed25519-signed approval to resume a paused run.
  /// The courier authors NOTHING in `signed_blob` (INV-1). Mirrors `Message::AgentRunResume`.
  case agentRunResume(runId: String, signedBlob: [UInt8])
  /// hub→trusted-peer: the body-free receipt for a control op (resume/cancel/reject). Mirrors
  /// `friday_protocol::Message::AgentRunControlResult`.
  case agentRunControlResult(AgentRunControlResultWire)

  // MARK: - Mission-spine WRITE seam (Lane-D entry-point-A organic driver)

  /// trusted-peer→hub: resolve/create a Mission from one surface input (a Hub-owned preflight
  /// mutation, NOT a provider/model call). Mirrors `friday_protocol::Message::MissionIntakeRequest`
  /// — a NESTED struct variant `{ request: … }` (NOT flattened like the AgentRun* variants).
  case missionIntakeRequest(MissionIntakeRequestWire)
  /// hub→trusted-peer: Mission intake/preflight receipt (refs-only). Mirrors
  /// `friday_protocol::Message::MissionIntakeResult` — NESTED `{ result: … }`.
  case missionIntakeResult(MissionIntakeResultWire)
  /// trusted-peer→hub: apply the OWNER's explicit confirm/reject to ONE pending memory candidate.
  /// Mirrors `friday_protocol::Message::MemoryDecisionRequest` — NESTED `{ request: … }`.
  case memoryDecisionRequest(MemoryDecisionRequestWire)
  /// hub→trusted-peer: memory decision receipt (refs-only). Mirrors
  /// `friday_protocol::Message::MemoryDecisionResult` — NESTED `{ result: … }`.
  case memoryDecisionResult(MemoryDecisionResultWire)

  /// A decoded-but-not-handled message kind. Carries the raw `kind` for truth-labeled surfacing
  /// (e.g. an `AgentRunPaused` reaching the read client, or any frame the client cannot handle).
  case unsupported(kind: String)
}

extension FridayMessage: Codable {
  private enum TagKey: String, CodingKey { case kind }
  private enum SnapshotKey: String, CodingKey { case snapshot }
  private enum RequestKey: String, CodingKey { case request }
  private enum ResultKey: String, CodingKey { case result }
  private enum ErrorKey: String, CodingKey { case code, message }
  /// The flattened keys the WRITE variants carry as SIBLINGS of `kind` (serde's internally-tagged
  /// shape for struct variants with named fields). The read variants nest a single `request`/
  /// `snapshot` field; the write variants flatten — exactly as `friday_protocol::Message`
  /// serializes (`{"kind":"AgentRunRequest","run_id":...,"task":...}`).
  private enum WriteKey: String, CodingKey {
    case kind
    case runId = "run_id"
    case task
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case sessionId = "session_id"
    case constraints
    case missionContext = "mission_context"
    case status
    case answerSha256 = "answer_sha256"
    case answerLen = "answer_len"
    case turns
    case executedTools = "executed_tools"
    case promptTokens = "prompt_tokens"
    case completionTokens = "completion_tokens"
    case nonce
    case actionDigest = "action_digest"
    case summary
    case signedBlob = "signed_blob"
    case op
    case accepted
    case auditRef = "audit_ref"
  }

  public init(from decoder: Decoder) throws {
    let tag = try decoder.container(keyedBy: TagKey.self)
    let kind = try tag.decode(String.self, forKey: .kind)
    switch kind {
    case "WorkbenchProjectionSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .workbenchProjectionSnapshot(try c.decode(WorkbenchProjectionSnapshotWire.self, forKey: .snapshot))
    case "WorkbenchProjectionRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .workbenchProjectionRequest(try c.decode(WorkbenchProjectionRequestWire.self, forKey: .request))
    case "Error":
      let c = try decoder.container(keyedBy: ErrorKey.self)
      self = .error(code: try c.decode(FridayErrorCode.self, forKey: .code),
                    message: try c.decode(String.self, forKey: .message))
    case "AgentRunRequest":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunRequest(AgentRunRequestWire(
        runId: try c.decode(String.self, forKey: .runId),
        task: try c.decode(String.self, forKey: .task),
        forwardedPrincipal: try c.decode(String.self, forKey: .forwardedPrincipal),
        authProof: try c.decode([UInt8].self, forKey: .authProof),
        sessionId: try c.decodeIfPresent(String.self, forKey: .sessionId),
        constraints: try c.decodeIfPresent(AgentRunConstraintsWire.self, forKey: .constraints),
        missionContext: try c.decodeIfPresent(MissionWorkItemContextWire.self, forKey: .missionContext)
      ))
    case "AgentRunResult":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunResult(AgentRunResultWire(
        runId: try c.decode(String.self, forKey: .runId),
        status: try c.decode(String.self, forKey: .status),
        answerSha256: try c.decodeIfPresent(String.self, forKey: .answerSha256),
        answerLen: try c.decodeIfPresent(UInt64.self, forKey: .answerLen),
        turns: try c.decodeIfPresent(UInt64.self, forKey: .turns),
        executedTools: try c.decodeIfPresent(UInt64.self, forKey: .executedTools),
        promptTokens: try c.decodeIfPresent(UInt64.self, forKey: .promptTokens),
        completionTokens: try c.decodeIfPresent(UInt64.self, forKey: .completionTokens)
      ))
    case "AgentRunPaused":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunPaused(AgentRunPausedWire(
        runId: try c.decode(String.self, forKey: .runId),
        nonce: try c.decode(String.self, forKey: .nonce),
        actionDigest: try c.decode(String.self, forKey: .actionDigest),
        summary: try c.decode(String.self, forKey: .summary)
      ))
    case "AgentRunResume":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunResume(
        runId: try c.decode(String.self, forKey: .runId),
        signedBlob: try c.decode([UInt8].self, forKey: .signedBlob))
    case "AgentRunControlResult":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunControlResult(AgentRunControlResultWire(
        runId: try c.decode(String.self, forKey: .runId),
        op: try c.decode(String.self, forKey: .op),
        accepted: try c.decode(Bool.self, forKey: .accepted),
        status: try c.decode(String.self, forKey: .status),
        auditRef: try c.decodeIfPresent(String.self, forKey: .auditRef)
      ))
    // Mission-spine WRITE variants — NESTED `{ request }` / `{ result }` (NOT the flattened
    // WriteKey path). Same shape as the read WorkbenchProjection* variants.
    case "MissionIntakeRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .missionIntakeRequest(try c.decode(MissionIntakeRequestWire.self, forKey: .request))
    case "MissionIntakeResult":
      let c = try decoder.container(keyedBy: ResultKey.self)
      self = .missionIntakeResult(try c.decode(MissionIntakeResultWire.self, forKey: .result))
    case "MemoryDecisionRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .memoryDecisionRequest(try c.decode(MemoryDecisionRequestWire.self, forKey: .request))
    case "MemoryDecisionResult":
      let c = try decoder.container(keyedBy: ResultKey.self)
      self = .memoryDecisionResult(try c.decode(MemoryDecisionResultWire.self, forKey: .result))
    default:
      self = .unsupported(kind: kind)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var tag = encoder.container(keyedBy: TagKey.self)
    switch self {
    case .workbenchProjectionRequest(let req):
      try tag.encode("WorkbenchProjectionRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .workbenchProjectionSnapshot(let snap):
      try tag.encode("WorkbenchProjectionSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .error(let code, let message):
      try tag.encode("Error", forKey: .kind)
      var c = encoder.container(keyedBy: ErrorKey.self)
      try c.encode(code, forKey: .code)
      try c.encode(message, forKey: .message)
    case .agentRunRequest(let req):
      var c = encoder.container(keyedBy: WriteKey.self)
      // Field order MIRRORS the Rust serde struct-variant order: kind, run_id, task,
      // forwarded_principal, auth_proof, [session_id], [constraints], [mission_context].
      // Optional fields are
      // OMITTED when nil/empty (serde `skip_serializing_if`), keeping a sessionless/
      // constraint-free request byte-identical to the pre-A1/A2a wire.
      try c.encode("AgentRunRequest", forKey: .kind)
      try c.encode(req.runId, forKey: .runId)
      try c.encode(req.task, forKey: .task)
      try c.encode(req.forwardedPrincipal, forKey: .forwardedPrincipal)
      try c.encode(req.authProof, forKey: .authProof)
      if let sessionId = req.sessionId { try c.encode(sessionId, forKey: .sessionId) }
      if let constraints = req.constraints, !constraints.isWireEmpty {
        try c.encode(constraints, forKey: .constraints)
      }
      if let missionContext = req.missionContext {
        try c.encode(missionContext, forKey: .missionContext)
      }
    case .agentRunResult(let r):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("AgentRunResult", forKey: .kind)
      try c.encode(r.runId, forKey: .runId)
      try c.encode(r.status, forKey: .status)
      if let v = r.answerSha256 { try c.encode(v, forKey: .answerSha256) }
      if let v = r.answerLen { try c.encode(v, forKey: .answerLen) }
      if let v = r.turns { try c.encode(v, forKey: .turns) }
      if let v = r.executedTools { try c.encode(v, forKey: .executedTools) }
      if let v = r.promptTokens { try c.encode(v, forKey: .promptTokens) }
      if let v = r.completionTokens { try c.encode(v, forKey: .completionTokens) }
    case .agentRunPaused(let p):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("AgentRunPaused", forKey: .kind)
      try c.encode(p.runId, forKey: .runId)
      try c.encode(p.nonce, forKey: .nonce)
      try c.encode(p.actionDigest, forKey: .actionDigest)
      try c.encode(p.summary, forKey: .summary)
    case .agentRunResume(let runId, let signedBlob):
      var c = encoder.container(keyedBy: WriteKey.self)
      // Field order MIRRORS the Rust serde struct-variant order: kind, run_id, signed_blob.
      // `signed_blob` is serde `Vec<u8>` ⇒ a JSON ARRAY of byte numbers (NOT base64/hex), the
      // SAME encoding as `auth_proof`. The blob rides VERBATIM (INV-1: a pure relay).
      try c.encode("AgentRunResume", forKey: .kind)
      try c.encode(runId, forKey: .runId)
      try c.encode(signedBlob, forKey: .signedBlob)
    case .agentRunControlResult(let r):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("AgentRunControlResult", forKey: .kind)
      try c.encode(r.runId, forKey: .runId)
      try c.encode(r.op, forKey: .op)
      try c.encode(r.accepted, forKey: .accepted)
      try c.encode(r.status, forKey: .status)
      if let v = r.auditRef { try c.encode(v, forKey: .auditRef) }
    // Mission-spine WRITE variants — NEST the payload under a single `request`/`result` field
    // (the internally-tagged struct-variant shape the Rust serde + the read variants use).
    case .missionIntakeRequest(let r):
      try tag.encode("MissionIntakeRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(r, forKey: .request)
    case .missionIntakeResult(let r):
      try tag.encode("MissionIntakeResult", forKey: .kind)
      var c = encoder.container(keyedBy: ResultKey.self)
      try c.encode(r, forKey: .result)
    case .memoryDecisionRequest(let r):
      try tag.encode("MemoryDecisionRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(r, forKey: .request)
    case .memoryDecisionResult(let r):
      try tag.encode("MemoryDecisionResult", forKey: .kind)
      var c = encoder.container(keyedBy: ResultKey.self)
      try c.encode(r, forKey: .result)
    case .unsupported(let kind):
      try tag.encode(kind, forKey: .kind)
    }
  }
}

// MARK: - Envelope

/// The versioned envelope. Mirrors `friday_protocol::Envelope`. JSON-serialized, then
/// SEALED under the session key by the transport before it leaves the client.
public struct FridayEnvelope: Codable, Equatable {
  public var schemaVersion: UInt16
  public var msgId: String
  public var correlationId: String?
  public var sentAt: Int64
  public var message: FridayMessage

  enum CodingKeys: String, CodingKey {
    case schemaVersion = "schema_version"
    case msgId = "msg_id"
    case correlationId = "correlation_id"
    case sentAt = "sent_at"
    case message
  }

  /// Build an envelope stamped with the current schema version. Mirrors `Envelope::new`.
  public init(msgId: String, sentAt: Int64, message: FridayMessage) {
    self.schemaVersion = fridayCurrentSchemaVersion
    self.msgId = msgId
    self.correlationId = nil
    self.sentAt = sentAt
    self.message = message
  }

  public func withCorrelation(_ correlationId: String) -> FridayEnvelope {
    var copy = self
    copy.correlationId = correlationId
    return copy
  }

  // Omit `correlation_id` when nil (Rust `skip_serializing_if = "Option::is_none"`).
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(schemaVersion, forKey: .schemaVersion)
    try c.encode(msgId, forKey: .msgId)
    if let correlationId { try c.encode(correlationId, forKey: .correlationId) }
    try c.encode(sentAt, forKey: .sentAt)
    try c.encode(message, forKey: .message)
  }

  /// Serialize to JSON. Mirrors `Envelope::encode`. Uses sorted keys for deterministic
  /// output (the wire is order-agnostic, but determinism eases debugging/diffing).
  public func encodeJSON() throws -> Data {
    let enc = JSONEncoder()
    enc.outputFormatting = [.withoutEscapingSlashes]
    return try enc.encode(self)
  }

  /// Parse from JSON. Mirrors `Envelope::decode` (unknown fields tolerated).
  public static func decodeJSON(_ data: Data) throws -> FridayEnvelope {
    try JSONDecoder().decode(FridayEnvelope.self, from: data)
  }
}

// MARK: - WorkbenchSnapshot (refs-only typed projection)

/// The refs-only typed Mission Workbench snapshot the read client returns — a Swift
/// mirror of the Rust `project_workbench` JSON (`friday-hub/src/workbench_projection.rs`).
/// The projection is refs-only by construction (the Rust forbidden-output guard ran inside
/// `project_workbench` before sealing), so this carries `*Id`/`*Ref`/labels/counts only,
/// NEVER an inline body. The full decoded JSON is retained in `raw` so a UI can read fields
/// this typed view does not surface, without re-fetching.
public struct WorkbenchSnapshot: Equatable {
  /// The canonical Mission id this projection is for (`missionId`).
  public let missionId: String
  /// The canonical Friday conversation id (`fridayConversationId`).
  public let fridayConversationId: String
  /// The runtime feed status truth label — e.g. `live_rust_hub_projection`. Rides as-is,
  /// never upgraded.
  public let runtimeFeedStatus: String
  /// The status labels the projection may surface (`stale`/`offline`/`error`).
  public let statusLabels: [String]
  /// The route-decision advisor summary (refs-only).
  public let routeDecisionSummary: String?
  /// The work-item id refs in this projection (counts/ids only — never a body).
  public let workItemIds: [String]
  /// The Hub epoch-millis at which the snapshot was generated (lets a UI flag staleness).
  public let generatedAtMs: Int64
  /// The full decoded refs-only projection JSON (kept for fields not surfaced above).
  public let raw: [String: Any]

  public static func == (lhs: WorkbenchSnapshot, rhs: WorkbenchSnapshot) -> Bool {
    lhs.missionId == rhs.missionId
      && lhs.fridayConversationId == rhs.fridayConversationId
      && lhs.runtimeFeedStatus == rhs.runtimeFeedStatus
      && lhs.statusLabels == rhs.statusLabels
      && lhs.routeDecisionSummary == rhs.routeDecisionSummary
      && lhs.workItemIds == rhs.workItemIds
      && lhs.generatedAtMs == rhs.generatedAtMs
  }

  /// Parse the refs-only projection JSON (the opened owner-sealed body) into the typed
  /// snapshot. Throws `FridayReadClientError.malformedProjection` on a non-object or a
  /// missing required ref.
  public init(projectionJSON: Data, generatedAtMs: Int64) throws {
    guard let obj = try JSONSerialization.jsonObject(with: projectionJSON) as? [String: Any] else {
      throw FridayReadClientError.malformedProjection("projection JSON is not an object")
    }
    guard let missionId = obj["missionId"] as? String else {
      throw FridayReadClientError.malformedProjection("projection missing missionId")
    }
    self.missionId = missionId
    self.fridayConversationId = (obj["fridayConversationId"] as? String) ?? ""
    self.runtimeFeedStatus = (obj["runtimeFeedStatus"] as? String) ?? ""
    self.statusLabels = (obj["statusLabels"] as? [String]) ?? []
    if let route = obj["routeDecision"] as? [String: Any] {
      self.routeDecisionSummary = route["advisorSummary"] as? String
    } else {
      self.routeDecisionSummary = nil
    }
    if let items = obj["workItems"] as? [[String: Any]] {
      self.workItemIds = items.compactMap { ($0["workItemId"] as? String) ?? ($0["id"] as? String) }
    } else {
      self.workItemIds = []
    }
    self.generatedAtMs = generatedAtMs
    self.raw = obj
  }
}
