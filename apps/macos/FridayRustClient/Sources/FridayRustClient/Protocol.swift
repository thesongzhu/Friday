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
  /// A decoded-but-not-handled message kind (the read server can only answer with the
  /// above three). Carries the raw `kind` for truth-labeled surfacing.
  case unsupported(kind: String)
}

extension FridayMessage: Codable {
  private enum TagKey: String, CodingKey { case kind }
  private enum SnapshotKey: String, CodingKey { case snapshot }
  private enum RequestKey: String, CodingKey { case request }
  private enum ErrorKey: String, CodingKey { case code, message }

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
