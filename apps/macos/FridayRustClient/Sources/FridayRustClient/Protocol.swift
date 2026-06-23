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

// MARK: - Pairing wire types

/// phone→hub QR pairing request. Mirrors `friday_protocol::Message::Pair`.
///
/// This carries the device's public key plus `HMAC(qr_secret, device_pubkey)` proof; it never
/// carries the raw QR secret. `Vec<u8>` fields serialize as JSON arrays of byte numbers.
public struct PairingPairWire: Equatable, Sendable {
  public var deviceId: String
  public var devicePubkey: [UInt8]
  public var pairingProof: [UInt8]

  public init(deviceId: String, devicePubkey: [UInt8], pairingProof: [UInt8]) {
    self.deviceId = deviceId
    self.devicePubkey = devicePubkey
    self.pairingProof = pairingProof
  }
}

/// hub→phone QR pairing acknowledgement. Mirrors `friday_protocol::Message::PairAck`.
public struct PairingPairAckWire: Equatable, Sendable {
  public var accepted: Bool
  public var errorCode: FridayErrorCode?

  public init(accepted: Bool, errorCode: FridayErrorCode? = nil) {
    self.accepted = accepted
    self.errorCode = errorCode
  }
}

/// hub→phone status frame available on the pairing channel. Mirrors
/// `friday_protocol::Message::HubStatus`; it is refs/capabilities only, never a model call.
public struct PairingHubStatusWire: Equatable, Sendable {
  public var online: Bool
  public var capabilities: [String]
  public var minVersion: UInt16
  public var maxVersion: UInt16

  public init(online: Bool, capabilities: [String], minVersion: UInt16, maxVersion: UInt16) {
    self.online = online
    self.capabilities = capabilities
    self.minVersion = minVersion
    self.maxVersion = maxVersion
  }
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

public struct RunReadbackRequestWire: Codable, Equatable, Sendable {
  public var runId: String
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(runId: String, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.runId = runId
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case runId = "run_id"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct RunReadbackSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct ProvidersDoctorRequestWire: Codable, Equatable, Sendable {
  public var probe: String?
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(probe: String?, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.probe = probe
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case probe
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    if let probe { try c.encode(probe, forKey: .probe) }
    try c.encode(forwardedPrincipal, forKey: .forwardedPrincipal)
    try c.encode(authProof, forKey: .authProof)
    try c.encode(requestId, forKey: .requestId)
  }
}

public struct ProvidersDoctorSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct CapabilityDoctorRequestWire: Codable, Equatable, Sendable {
  public var validateKeys: Bool
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(validateKeys: Bool, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.validateKeys = validateKeys
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case validateKeys = "validate_keys"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct CapabilityDoctorSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct SessionListRequestWire: Codable, Equatable, Sendable {
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct SessionListSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct SessionOpenRequestWire: Codable, Equatable, Sendable {
  public var agentSessionId: String
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(agentSessionId: String, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.agentSessionId = agentSessionId
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case agentSessionId = "agent_session_id"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct SessionOpenSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct SessionLinkStateRequestWire: Codable, Equatable, Sendable {
  public var agentSessionId: String
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(agentSessionId: String, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.agentSessionId = agentSessionId
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case agentSessionId = "agent_session_id"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct SessionLinkStateSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct RunFileViewRequestWire: Codable, Equatable, Sendable {
  public var runId: String
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(runId: String, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.runId = runId
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case runId = "run_id"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct RunFileViewSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

  enum CodingKeys: String, CodingKey {
    case requestId = "request_id"
    case projectionJson = "projection_json"
    case generatedAtMs = "generated_at_ms"
  }
}

public struct ActivityNeedsMeRequestWire: Codable, Equatable, Sendable {
  public var runId: String
  public var forwardedPrincipal: String
  public var authProof: [UInt8]
  public var requestId: String

  public init(runId: String, forwardedPrincipal: String, authProof: [UInt8], requestId: String) {
    self.runId = runId
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.requestId = requestId
  }

  enum CodingKeys: String, CodingKey {
    case runId = "run_id"
    case forwardedPrincipal = "forwarded_principal"
    case authProof = "auth_proof"
    case requestId = "request_id"
  }
}

public struct ActivityNeedsMeSnapshotWire: Codable, Equatable, Sendable {
  public var requestId: String
  public var projectionJson: String
  public var generatedAtMs: Int64

  public init(requestId: String, projectionJson: String, generatedAtMs: Int64) {
    self.requestId = requestId
    self.projectionJson = projectionJson
    self.generatedAtMs = generatedAtMs
  }

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
  // MARK: - Pairing seam (T3 zero-config QR provisioning)

  /// phone→hub: complete QR pairing handshake. Flattened serde struct-variant shape.
  case pair(PairingPairWire)
  /// hub→phone: accept/deny pairing. Flattened serde struct-variant shape.
  case pairAck(PairingPairAckWire)
  /// hub→phone: status/capability frame on the pairing channel. No model/provider call.
  case hubStatus(PairingHubStatusWire)

  case workbenchProjectionRequest(WorkbenchProjectionRequestWire)
  case workbenchProjectionSnapshot(WorkbenchProjectionSnapshotWire)
  case error(code: FridayErrorCode, message: String)
  case runReadbackRequest(RunReadbackRequestWire)
  case runReadbackSnapshot(RunReadbackSnapshotWire)
  case providersDoctorRequest(ProvidersDoctorRequestWire)
  case providersDoctorSnapshot(ProvidersDoctorSnapshotWire)
  case capabilityDoctorRequest(CapabilityDoctorRequestWire)
  case capabilityDoctorSnapshot(CapabilityDoctorSnapshotWire)
  case sessionListRequest(SessionListRequestWire)
  case sessionListSnapshot(SessionListSnapshotWire)
  case sessionOpenRequest(SessionOpenRequestWire)
  case sessionOpenSnapshot(SessionOpenSnapshotWire)
  case sessionLinkStateRequest(SessionLinkStateRequestWire)
  case sessionLinkStateSnapshot(SessionLinkStateSnapshotWire)
  case runFileViewRequest(RunFileViewRequestWire)
  case runFileViewSnapshot(RunFileViewSnapshotWire)
  case activityNeedsMeRequest(ActivityNeedsMeRequestWire)
  case activityNeedsMeSnapshot(ActivityNeedsMeSnapshotWire)

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
  /// trusted-peer→hub: owner-authed terminal stop for one live run. Mirrors
  /// `Message::AgentRunCancel`.
  case agentRunCancel(runId: String, forwardedPrincipal: String, authProof: [UInt8], reason: String?)
  /// trusted-peer→hub: owner-authed refusal of one pending approval. Mirrors
  /// `Message::AgentRunReject`.
  case agentRunReject(runId: String, approvalId: String, forwardedPrincipal: String, authProof: [UInt8])
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
  /// trusted-peer→hub: confirm/reject ONE pending A1 run-outcome learning candidate.
  /// Mirrors `friday_protocol::Message::RunOutcomeLearningDecisionRequest`.
  case runOutcomeLearningDecisionRequest(RunOutcomeLearningDecisionRequestWire)
  /// hub→trusted-peer: A1 run-outcome learning decision receipt (refs-only). Mirrors
  /// `friday_protocol::Message::RunOutcomeLearningDecisionResult`.
  case runOutcomeLearningDecisionResult(RunOutcomeLearningDecisionResultWire)
  /// client→read-server: owner-gated run answer body readback. Kept separate from
  /// RunReadback so refs-only projections stay refs-only.
  case runAnswerBodyRequest(RunAnswerBodyRequestWire)
  /// read-server→client: owner-sealed answer-body snapshot.
  case runAnswerBodySnapshot(RunAnswerBodySnapshotWire)

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
    case approvalId = "approval_id"
    case op
    case accepted
    case auditRef = "audit_ref"
    case reason
    case deviceId = "device_id"
    case devicePubkey = "device_pubkey"
    case pairingProof = "pairing_proof"
    case errorCode = "error_code"
    case online
    case capabilities
    case minVersion = "min_version"
    case maxVersion = "max_version"
  }

  public init(from decoder: Decoder) throws {
    let tag = try decoder.container(keyedBy: TagKey.self)
    let kind = try tag.decode(String.self, forKey: .kind)
    switch kind {
    case "Pair":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .pair(
        PairingPairWire(
          deviceId: try c.decode(String.self, forKey: .deviceId),
          devicePubkey: try c.decode([UInt8].self, forKey: .devicePubkey),
          pairingProof: try c.decode([UInt8].self, forKey: .pairingProof)
        )
      )
    case "PairAck":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .pairAck(
        PairingPairAckWire(
          accepted: try c.decode(Bool.self, forKey: .accepted),
          errorCode: try c.decodeIfPresent(FridayErrorCode.self, forKey: .errorCode)
        )
      )
    case "HubStatus":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .hubStatus(
        PairingHubStatusWire(
          online: try c.decode(Bool.self, forKey: .online),
          capabilities: try c.decode([String].self, forKey: .capabilities),
          minVersion: try c.decode(UInt16.self, forKey: .minVersion),
          maxVersion: try c.decode(UInt16.self, forKey: .maxVersion)
        )
      )
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
    case "RunReadbackRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .runReadbackRequest(try c.decode(RunReadbackRequestWire.self, forKey: .request))
    case "RunReadbackSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .runReadbackSnapshot(try c.decode(RunReadbackSnapshotWire.self, forKey: .snapshot))
    case "ProvidersDoctorRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .providersDoctorRequest(try c.decode(ProvidersDoctorRequestWire.self, forKey: .request))
    case "ProvidersDoctorSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .providersDoctorSnapshot(try c.decode(ProvidersDoctorSnapshotWire.self, forKey: .snapshot))
    case "CapabilityDoctorRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .capabilityDoctorRequest(try c.decode(CapabilityDoctorRequestWire.self, forKey: .request))
    case "CapabilityDoctorSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .capabilityDoctorSnapshot(try c.decode(CapabilityDoctorSnapshotWire.self, forKey: .snapshot))
    case "SessionListRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .sessionListRequest(try c.decode(SessionListRequestWire.self, forKey: .request))
    case "SessionListSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .sessionListSnapshot(try c.decode(SessionListSnapshotWire.self, forKey: .snapshot))
    case "SessionOpenRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .sessionOpenRequest(try c.decode(SessionOpenRequestWire.self, forKey: .request))
    case "SessionOpenSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .sessionOpenSnapshot(try c.decode(SessionOpenSnapshotWire.self, forKey: .snapshot))
    case "SessionLinkStateRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .sessionLinkStateRequest(try c.decode(SessionLinkStateRequestWire.self, forKey: .request))
    case "SessionLinkStateSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .sessionLinkStateSnapshot(try c.decode(SessionLinkStateSnapshotWire.self, forKey: .snapshot))
    case "RunFileViewRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .runFileViewRequest(try c.decode(RunFileViewRequestWire.self, forKey: .request))
    case "RunFileViewSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .runFileViewSnapshot(try c.decode(RunFileViewSnapshotWire.self, forKey: .snapshot))
    case "ActivityNeedsMeRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .activityNeedsMeRequest(try c.decode(ActivityNeedsMeRequestWire.self, forKey: .request))
    case "ActivityNeedsMeSnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .activityNeedsMeSnapshot(try c.decode(ActivityNeedsMeSnapshotWire.self, forKey: .snapshot))
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
    case "AgentRunCancel":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunCancel(
        runId: try c.decode(String.self, forKey: .runId),
        forwardedPrincipal: try c.decode(String.self, forKey: .forwardedPrincipal),
        authProof: try c.decode([UInt8].self, forKey: .authProof),
        reason: try c.decodeIfPresent(String.self, forKey: .reason))
    case "AgentRunReject":
      let c = try decoder.container(keyedBy: WriteKey.self)
      self = .agentRunReject(
        runId: try c.decode(String.self, forKey: .runId),
        approvalId: try c.decode(String.self, forKey: .approvalId),
        forwardedPrincipal: try c.decode(String.self, forKey: .forwardedPrincipal),
        authProof: try c.decode([UInt8].self, forKey: .authProof))
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
    case "RunOutcomeLearningDecisionRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .runOutcomeLearningDecisionRequest(
        try c.decode(RunOutcomeLearningDecisionRequestWire.self, forKey: .request))
    case "RunOutcomeLearningDecisionResult":
      let c = try decoder.container(keyedBy: ResultKey.self)
      self = .runOutcomeLearningDecisionResult(
        try c.decode(RunOutcomeLearningDecisionResultWire.self, forKey: .result))
    case "RunAnswerBodyRequest":
      let c = try decoder.container(keyedBy: RequestKey.self)
      self = .runAnswerBodyRequest(try c.decode(RunAnswerBodyRequestWire.self, forKey: .request))
    case "RunAnswerBodySnapshot":
      let c = try decoder.container(keyedBy: SnapshotKey.self)
      self = .runAnswerBodySnapshot(try c.decode(RunAnswerBodySnapshotWire.self, forKey: .snapshot))
    default:
      self = .unsupported(kind: kind)
    }
  }

  public func encode(to encoder: Encoder) throws {
    var tag = encoder.container(keyedBy: TagKey.self)
    switch self {
    case .pair(let p):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("Pair", forKey: .kind)
      try c.encode(p.deviceId, forKey: .deviceId)
      try c.encode(p.devicePubkey, forKey: .devicePubkey)
      try c.encode(p.pairingProof, forKey: .pairingProof)
    case .pairAck(let a):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("PairAck", forKey: .kind)
      try c.encode(a.accepted, forKey: .accepted)
      if let errorCode = a.errorCode {
        try c.encode(errorCode, forKey: .errorCode)
      }
    case .hubStatus(let s):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("HubStatus", forKey: .kind)
      try c.encode(s.online, forKey: .online)
      try c.encode(s.capabilities, forKey: .capabilities)
      try c.encode(s.minVersion, forKey: .minVersion)
      try c.encode(s.maxVersion, forKey: .maxVersion)
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
    case .runReadbackRequest(let req):
      try tag.encode("RunReadbackRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .runReadbackSnapshot(let snap):
      try tag.encode("RunReadbackSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .providersDoctorRequest(let req):
      try tag.encode("ProvidersDoctorRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .providersDoctorSnapshot(let snap):
      try tag.encode("ProvidersDoctorSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .capabilityDoctorRequest(let req):
      try tag.encode("CapabilityDoctorRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .capabilityDoctorSnapshot(let snap):
      try tag.encode("CapabilityDoctorSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .sessionListRequest(let req):
      try tag.encode("SessionListRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .sessionListSnapshot(let snap):
      try tag.encode("SessionListSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .sessionOpenRequest(let req):
      try tag.encode("SessionOpenRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .sessionOpenSnapshot(let snap):
      try tag.encode("SessionOpenSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .sessionLinkStateRequest(let req):
      try tag.encode("SessionLinkStateRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .sessionLinkStateSnapshot(let snap):
      try tag.encode("SessionLinkStateSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .runFileViewRequest(let req):
      try tag.encode("RunFileViewRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .runFileViewSnapshot(let snap):
      try tag.encode("RunFileViewSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
    case .activityNeedsMeRequest(let req):
      try tag.encode("ActivityNeedsMeRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(req, forKey: .request)
    case .activityNeedsMeSnapshot(let snap):
      try tag.encode("ActivityNeedsMeSnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(snap, forKey: .snapshot)
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
    case .agentRunCancel(let runId, let forwardedPrincipal, let authProof, let reason):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("AgentRunCancel", forKey: .kind)
      try c.encode(runId, forKey: .runId)
      try c.encode(forwardedPrincipal, forKey: .forwardedPrincipal)
      try c.encode(authProof, forKey: .authProof)
      if let reason { try c.encode(reason, forKey: .reason) }
    case .agentRunReject(let runId, let approvalId, let forwardedPrincipal, let authProof):
      var c = encoder.container(keyedBy: WriteKey.self)
      try c.encode("AgentRunReject", forKey: .kind)
      try c.encode(runId, forKey: .runId)
      try c.encode(approvalId, forKey: .approvalId)
      try c.encode(forwardedPrincipal, forKey: .forwardedPrincipal)
      try c.encode(authProof, forKey: .authProof)
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
    case .runOutcomeLearningDecisionRequest(let r):
      try tag.encode("RunOutcomeLearningDecisionRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(r, forKey: .request)
    case .runOutcomeLearningDecisionResult(let r):
      try tag.encode("RunOutcomeLearningDecisionResult", forKey: .kind)
      var c = encoder.container(keyedBy: ResultKey.self)
      try c.encode(r, forKey: .result)
    case .runAnswerBodyRequest(let r):
      try tag.encode("RunAnswerBodyRequest", forKey: .kind)
      var c = encoder.container(keyedBy: RequestKey.self)
      try c.encode(r, forKey: .request)
    case .runAnswerBodySnapshot(let r):
      try tag.encode("RunAnswerBodySnapshot", forKey: .kind)
      var c = encoder.container(keyedBy: SnapshotKey.self)
      try c.encode(r, forKey: .snapshot)
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

// MARK: - Generic owner-gated read projection

public struct ReadProjectionSnapshot: Equatable {
  public let generatedAtMs: Int64
  public let raw: [String: Any]

  public static func == (lhs: ReadProjectionSnapshot, rhs: ReadProjectionSnapshot) -> Bool {
    lhs.generatedAtMs == rhs.generatedAtMs
      && NSDictionary(dictionary: lhs.raw).isEqual(to: rhs.raw)
  }

  public init(projectionJSON: Data, generatedAtMs: Int64) throws {
    guard let obj = try JSONSerialization.jsonObject(with: projectionJSON) as? [String: Any] else {
      throw FridayReadClientError.malformedProjection("projection JSON is not an object")
    }
    self.generatedAtMs = generatedAtMs
    self.raw = obj
  }
}

// MARK: - Owner-gated answer body projection

public struct RunAnswerBody: Equatable, Sendable {
  public let runId: String
  public let outcome: String
  public let status: String?
  public let answer: String?
  public let answerSha256: String?
  public let answerLen: UInt64?
  public let denyReason: String?
  public let truthLabel: String
  public let generatedAtMs: Int64

  public var deliveredAnswer: String? {
    outcome == "delivered" ? answer : nil
  }

  public init(answerJSON: Data, generatedAtMs: Int64) throws {
    guard let obj = try JSONSerialization.jsonObject(with: answerJSON) as? [String: Any] else {
      throw FridayReadClientError.malformedProjection("answer JSON is not an object")
    }
    guard let runId = obj["run_id"] as? String else {
      throw FridayReadClientError.malformedProjection("answer JSON missing run_id")
    }
    guard let outcome = obj["outcome"] as? String else {
      throw FridayReadClientError.malformedProjection("answer JSON missing outcome")
    }
    self.runId = runId
    self.outcome = outcome
    self.status = obj["status"] as? String
    self.answer = obj["answer"] as? String
    self.answerSha256 = obj["answer_sha256"] as? String
    if let n = obj["answer_len"] as? UInt64 {
      self.answerLen = n
    } else if let n = obj["answer_len"] as? Int {
      self.answerLen = UInt64(n)
    } else {
      self.answerLen = nil
    }
    self.denyReason = obj["deny_reason"] as? String
    self.truthLabel = (obj["truth_label"] as? String) ?? "unknown"
    self.generatedAtMs = generatedAtMs
  }
}
