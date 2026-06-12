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

// MARK: - AgentRunRequestWire

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

  public init(
    runId: String,
    task: String,
    forwardedPrincipal: String,
    authProof: [UInt8],
    sessionId: String? = nil,
    constraints: AgentRunConstraintsWire? = nil
  ) {
    self.runId = runId
    self.task = task
    self.forwardedPrincipal = forwardedPrincipal
    self.authProof = authProof
    self.sessionId = sessionId
    self.constraints = constraints
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
