import Foundation

/// **The Swift sealed-WS WRITE / agent-run client + the COURIER pause/resume + the S6 approval
/// relay** — the client side of the GATE-AGENT-REPLACE chat read-WRITE loop.
///
/// This is the Swift mirror of the TS courier
/// (`src/api/mission-spine/friday-rust-hub-agent-run-ws-sealed-client.ts`) and the client half of
/// the Rust agent-run WRITE server (`bin/hub_agent_run_server.rs` + the merged Phase-2 control
/// plane). It reuses #677's SAME crypto substrate (X25519+HKDF+XChaCha20-Poly1305, the sealed-WS
/// handshake/peer-auth/seal-open framing, the `SealedWSTransport` two-phase pipe) but with the
/// WRITE constants + the agent-run dispatch + courier flow:
///
/// 1. **Handshake** — identical cleartext preamble: client pubkey OUT → server pubkey IN →
///    64-byte session nonce IN → WS upgrade → `agree(serverPub)` derives the per-session key.
/// 2. **Dispatch** — an `AgentRunRequest` envelope (owner-authed `auth_proof` over the WRITE
///    constants, bound to `run_id`; DEFAULT read-only / no constraints), sealed under the session
///    key with the WRITE SESSION_AAD.
/// 3. **Settle (the leg-A decouple, #655)** — settle on the FIRST inbound:
///    - `AgentRunResult` (refs-only) ⇒ `.result(...)`,
///    - `AgentRunPaused` (flag-on ONLY) ⇒ `.paused(...)` carrying refs only,
///    - anything else / a close-before-refs ⇒ fail-closed.
///    The owner-sealed body `AskFridayStream` frame is NOT awaited (the body is sourced by the
///    owner-gated DB readback downstream).
/// 4. **Resume (S6 relay)** — `resumeWithApproval(opaqueSignedBlob)` opens a FRESH sealed session
///    and sends `AgentRunResume {run_id, signed_blob}` VERBATIM, then awaits the refs-only
///    `AgentRunControlResult`. INV-1: the client INSPECTS NOTHING in the blob and holds NO signing
///    key — it only RELAYS the operator's externally-produced Ed25519 signature (PR #671). The
///    NONCE inside the blob is the single-use authority (resume is self-authenticating — it carries
///    NO `auth_proof`), so the fresh socket is safe.
///
/// ## DARK + flag-gated
/// `agentRunControlViaRust` is DEFAULT-OFF (mirrors `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` + the TS
/// courier). OFF ⇒ an `AgentRunPaused` is an UNKNOWN inbound (fail-closed), and `resumeWithApproval`
/// refuses WITHOUT opening a socket — byte-identical to the no-control posture. ON ⇒ a paused frame
/// settles the dispatch and the resume relay is live.
///
/// ## The live round-trip is DEFERRED (slice-6 operator gate)
/// As in #677, the live `NWConnection`-backed transport against a RUNNING write server (with the UI
/// peer pubkey enrolled + the operator signer provisioned) is a DEFERRED acceptance criterion. The
/// write-path crypto-parity KATs prove byte-identity OFFLINE; the in-memory emulated write-server
/// proves this client's wiring; the live agent-run + the real operator-signed resume are slice-6.

// MARK: - Write-seam protocol constants

/// The WRITE session AAD binding every sealed envelope on an agent-run session. Mirrors the bin's
/// `SESSION_AAD` (`b"friday:execrun:ws:s-c:agent-run-session:aad:v1"`). DOMAIN-SEPARATED from the
/// read bin's AAD (`friday:ui-read-seam:…`).
public let writeSessionAad = Array("friday:execrun:ws:s-c:agent-run-session:aad:v1".utf8)

/// The BASE auth challenge the peer seals in its dispatch `auth_proof`. Mirrors the bin's
/// `AUTH_CHALLENGE` (`b"friday:execrun:ws:s-c:authed-run:challenge:v1"`).
public let writeAuthChallenge = Array("friday:execrun:ws:s-c:authed-run:challenge:v1".utf8)

// MARK: - Courier outcomes

/// The discriminated outcome of a sealed `dispatchAgentRun`. Mirrors the TS
/// `FridayRustHubAgentRunSealedDispatchOutcome` (a result OR a paused settle).
public enum AgentRunDispatchOutcome: Equatable, Sendable {
  /// The refs-only `AgentRunResult` — today's ONLY non-paused outcome (status + answer
  /// fingerprint + counts; NEVER a body).
  case result(AgentRunResultWire)
  /// (flag-on ONLY) The loop's gate PAUSED a mutating tool. Carries REFS ONLY — `{runId,
  /// approvalId(=nonce), actionDigest(hex), summary?}` — and NO signing material (INV-1). The
  /// operator signs the `approvalId` out-of-band; the courier later relays `resumeWithApproval`.
  case paused(PausedOutcome)
}

/// The refs-only PAUSED settle. Mirrors the TS `FridayRustHubAgentRunPausedOutcome` field-for-field
/// (`nonce → approvalId`, `action_digest → actionDigest`, `summary → ownerSealedSummary?`). It
/// carries NO signing material; the client authors no approval (INV-1).
public struct PausedOutcome: Equatable, Sendable {
  /// Truth label — `rust_wired` at best (mirrors the TS courier). NEVER upgraded.
  public let truthLabel: String
  /// The run that paused (echoes the request run id).
  public let runId: String
  /// The single-use approval nonce the operator signs over (the wire `nonce` =
  /// `pending_approval_request.approval_id`). A nonce, not a secret.
  public let approvalId: String
  /// Hex SHA-256 of the request's `canonical_action_bytes` (the wire `action_digest`). A
  /// fingerprint binding the EXACT paused action — never a body.
  public let actionDigest: String
  /// A coarse, body-free summary of WHAT paused (the wire `summary`). Never the tool args/body.
  public let ownerSealedSummary: String?

  public init(runId: String, approvalId: String, actionDigest: String, ownerSealedSummary: String?) {
    self.truthLabel = "rust_wired"
    self.runId = runId
    self.approvalId = approvalId
    self.actionDigest = actionDigest
    self.ownerSealedSummary = ownerSealedSummary
  }
}

/// The refs-only result of relaying an operator-signed approval to RESUME a paused run. Mirrors the
/// TS `FridayRustHubAgentRunResumeResult`: the coarse `op`/`accepted`/`status` + an optional soft
/// `auditRef`. `accepted=false` is a SUCCESSFUL relay of a refusal, NOT a transport failure.
public struct ResumeRelayResult: Equatable, Sendable {
  public let truthLabel: String
  public let runId: String
  public let op: String
  public let accepted: Bool
  public let status: String
  public let auditRef: String?

  public init(runId: String, op: String, accepted: Bool, status: String, auditRef: String?) {
    self.truthLabel = "rust_wired"
    self.runId = runId
    self.op = op
    self.accepted = accepted
    self.status = status
    self.auditRef = auditRef
  }
}

// MARK: - Errors

public enum FridayWriteClientError: Error, Equatable {
  case badServerPubkey
  case badSessionNonce
  /// The server answered with a typed `Error` frame.
  case serverError(code: FridayErrorCode, message: String)
  /// The server's response was an unexpected / unknown message kind (e.g. an `AgentRunPaused`
  /// reaching a flag-OFF client, or any non-result/non-control inbound). Fail-closed.
  case unexpectedResponse(kind: String)
  /// A required ref was missing from a result/pause/control frame (the refs-surface contract).
  case missingRef(String)
  /// Run-control is DISABLED (the flag is off) and a resume relay was attempted — fail-closed,
  /// no socket opened (mirrors the TS courier's flag-off refusal).
  case runControlDisabled
  /// The resume relay was given an empty signed blob (an empty blob can carry no signature).
  case emptySignedBlob
  /// A transport-layer failure (the pipe closed / no response — the write server ENDS the session
  /// fail-closed on an auth failure).
  case transport(String)
}

// MARK: - The clean product-facing write client protocol

/// The product-facing WRITE client. A UI depends on THIS, not the transport. It dispatches an
/// agent-run (the chat read-WRITE loop) and relays an operator-signed resume.
public protocol FridayRustWriteClient: Sendable {
  /// Dispatch one agent-run over the sealed-WS WRITE seam. `constraints` DEFAULT read-only /
  /// no-grant (the mutation is operator-gated downstream). Settles refs-only on the first
  /// `AgentRunResult`, or `.paused` when the run-control flag is on AND the server pauses.
  func dispatchAgentRun(task: String, constraints: AgentRunConstraintsWire?) async throws -> AgentRunDispatchOutcome
  /// Relay an operator's OPAQUE Ed25519-signed approval to RESUME a paused run (S6). The client
  /// inspects NOTHING in `opaqueSignedBlob` and holds NO signing key (INV-1) — it relays VERBATIM.
  /// Fail-closed (`.runControlDisabled`) when the run-control flag is off.
  func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult
  /// Reject one pending approval without resuming the mutation. Owner-authed over the sealed
  /// session; fail-closed (`.runControlDisabled`) when run-control is off.
  func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult
  /// Cancel one live run. Owner-authed over the sealed session; fail-closed
  /// (`.runControlDisabled`) when run-control is off.
  func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult
}

// MARK: - The mission-spine WRITE client protocol (Lane-D entry-point-A organic driver)

/// The product-facing mission-spine WRITE client — the two organic-loop drivers over the SAME
/// sealed-WS WRITE seam (:48750) the agent-run client uses, but WITHOUT a per-request `auth_proof`
/// (the sealed single-peer session IS the channel auth; the server binds the write to the
/// authenticated `--owner`).
///
/// `Sendable` so a `@MainActor` view model can store one and `await` a call that hops off the
/// MainActor (the concrete `SealedWSWriteClient` is `@unchecked Sendable`, justified by its
/// all-immutable stored state — same posture as `SealedWSReadClient`). This lets the blocking
/// synchronous transport run OFF the main thread.
public protocol FridayMissionSpineWriteClient: Sendable {
  /// Submit one operator-typed Mission intake over the sealed WRITE session. Births a Mission +
  /// WorkItem(Draft) server-side (no model call); returns the refs-only receipt (which may be
  /// `status:"needs_clarification"` with questions, or `status:"blocked"`).
  func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire
  /// Submit the owner's explicit confirm/reject for ONE pending memory candidate. Returns the
  /// refs-only receipt (`status:"confirmed"`/`"rejected"`/`"blocked"`). `decision` MUST be
  /// `"confirm"` or `"reject"`.
  func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire
  /// Submit the owner's explicit confirm/reject for ONE pending A1 run-outcome learning candidate.
  func submitRunOutcomeLearningDecision(
    _ request: RunOutcomeLearningDecisionRequestWire
  ) async throws -> RunOutcomeLearningDecisionResultWire
}

/// Product-facing bridge for MissionIntakeResult -> mission-bound AgentRunRequest. This is the
/// model-turn leg: it carries the server-produced Mission handle on the sealed WRITE dispatch.
public protocol FridayMissionBoundRunWriteClient: Sendable {
  func dispatchMissionBoundAgentRun(
    task: String,
    missionContext: MissionWorkItemContextWire,
    constraints: AgentRunConstraintsWire?
  ) async throws -> AgentRunDispatchOutcome
}

// MARK: - The sealed-WS write client implementation

/// The sealed-WS WRITE client. Drives the full handshake + dispatch + courier LOGIC over an
/// injected `SealedWSTransport` (reused from #677). Pure byte-exact logic; the network is the
/// injected pipe (the live transport is the deferred slice-6 AC).
///
/// `@unchecked Sendable`: every stored property is an immutable `let` (the keypair, the principal,
/// the injected `@escaping` factory/closures). The closures are not statically `@Sendable` (so the
/// `FridayMissionSpineWriteClient: Sendable` conformance is not auto-satisfied), but the instance
/// carries no mutable shared state across an `await`, so it is safe to send — the SAME asserted
/// posture as `SealedWSReadClient`. This lets a `@MainActor` view model store one and run the
/// blocking synchronous transport OFF the main thread.
public final class SealedWSWriteClient: FridayRustWriteClient, FridayMissionSpineWriteClient, FridayMissionBoundRunWriteClient, @unchecked Sendable {
  private let keypair: FridayCrypto.DeviceKeypair
  private let forwardedPrincipal: String
  private let sessionId: String?
  /// DEFAULT-OFF run-control flag (mirrors `FRIDAY_AGENT_RUN_CONTROL_VIA_RUST` + the TS courier).
  /// Gates ONLY the `AgentRunPaused` inbound branch + `resumeWithApproval`. OFF ⇒ byte-identical to
  /// the no-control posture.
  private let agentRunControlViaRust: Bool
  private let makeTransport: () throws -> SealedWSTransport
  private let now: () -> Int64
  private let newRunId: () -> String

  /// - Parameters:
  ///   - keypair: this client's X25519 keypair. Its public key MUST be enrolled in the server's
  ///     SecureStore peer-allowlist (S-F) or the server refuses the handshake.
  ///   - forwardedPrincipal: the owner principal; MUST be on the server's owner-allowlist.
  ///   - sessionId: optional session id for a sessioned (multi-turn chat) run; `nil` ⇒ sessionless
  ///     (byte-identical to the pre-A2a wire).
  ///   - agentRunControlViaRust: DEFAULT-OFF run-control flag.
  ///   - makeTransport: factory for a fresh transport per dispatch/resume (one session each).
  ///   - now: epoch-millis clock (injectable for tests).
  ///   - newRunId: fresh per-run id factory.
  public init(
    keypair: FridayCrypto.DeviceKeypair,
    forwardedPrincipal: String,
    sessionId: String? = nil,
    agentRunControlViaRust: Bool = false,
    makeTransport: @escaping () throws -> SealedWSTransport,
    now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
    newRunId: @escaping () -> String = { "run-\(UUID().uuidString)" }
  ) {
    self.keypair = keypair
    self.forwardedPrincipal = forwardedPrincipal
    self.sessionId = sessionId
    self.agentRunControlViaRust = agentRunControlViaRust
    self.makeTransport = makeTransport
    self.now = now
    self.newRunId = newRunId
  }

  // MARK: dispatchAgentRun

  public func dispatchAgentRun(
    task: String,
    constraints: AgentRunConstraintsWire? = nil
  ) async throws -> AgentRunDispatchOutcome {
    try await dispatchAgentRun(task: task, constraints: constraints, missionContext: nil)
  }

  public func dispatchMissionBoundAgentRun(
    task: String,
    missionContext: MissionWorkItemContextWire,
    constraints: AgentRunConstraintsWire? = nil
  ) async throws -> AgentRunDispatchOutcome {
    try await dispatchAgentRun(task: task, constraints: constraints, missionContext: missionContext)
  }

  private func dispatchAgentRun(
    task: String,
    constraints: AgentRunConstraintsWire?,
    missionContext: MissionWorkItemContextWire?
  ) async throws -> AgentRunDispatchOutcome {
    let transport = try makeTransport()
    let (sessionKey, sessionNonce) = try handshake(transport)

    // DISPATCH — an AgentRunRequest, owner-authed (auth_proof over the WRITE constants bound to
    // run_id), sealed under the session key with the WRITE SESSION_AAD.
    let runId = newRunId()
    let authProof = try FridayCrypto.buildAuthProof(
      sessionKey: sessionKey,
      sessionNonce: sessionNonce,
      sessionAad: writeSessionAad,
      authChallenge: writeAuthChallenge,
      forwardedPrincipal: forwardedPrincipal,
      boundContext: Array(runId.utf8)
    )
    let request = AgentRunRequestWire(
      runId: runId,
      task: task,
      forwardedPrincipal: forwardedPrincipal,
      authProof: authProof,
      sessionId: normalizedSessionId(),
      constraints: constraints,
      missionContext: missionContext
    )
    let reqEnvelope = FridayEnvelope(
      msgId: "agent-run-\(runId)",
      sentAt: now(),
      message: .agentRunRequest(request)
    ).withCorrelation("agent-run-\(runId)")
    try transport.sendMessage(try sealEnvelope(reqEnvelope, sessionKey: sessionKey))

    // SETTLE on the FIRST inbound (leg-A decouple, #655) — never await the owner-sealed body frame.
    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      // A write server that fails auth ENDS the session (no result). Fail-closed.
      throw FridayWriteClientError.transport("no result (session ended fail-closed): \(error)")
    }
    let respEnvelope = try openEnvelope(respBody, sessionKey: sessionKey)
    return try routeDispatchInbound(respEnvelope.message)
  }

  /// Route the FIRST inbound dispatch envelope to its outcome. `AgentRunResult` ⇒ `.result`;
  /// `AgentRunPaused` ⇒ `.paused` ONLY when the run-control flag is ON (flag OFF ⇒ unknown →
  /// fail-closed, byte-identical to the no-control posture); a typed `Error` is surfaced; anything
  /// else is fail-closed. EXPOSED `internal` so the kind-dispatch (incl. flag-off → fail-closed) is
  /// unit-testable without a socket.
  func routeDispatchInbound(_ message: FridayMessage) throws -> AgentRunDispatchOutcome {
    switch message {
    case .agentRunResult(let r):
      // The refs-surface contract: run_id + status are required (mirrors the TS `handleResult`).
      guard !r.runId.isEmpty, !r.status.isEmpty else {
        throw FridayWriteClientError.missingRef("AgentRunResult missing run_id/status")
      }
      return .result(r)
    case .agentRunPaused(let p):
      guard agentRunControlViaRust else {
        // FLAG-OFF: a paused frame is an UNKNOWN inbound ⇒ fail-closed (byte-identical to today).
        throw FridayWriteClientError.unexpectedResponse(kind: "AgentRunPaused")
      }
      // A pause frame MISSING a required ref fails closed (the refs-surface contract).
      guard !p.runId.isEmpty, !p.nonce.isEmpty, !p.actionDigest.isEmpty else {
        throw FridayWriteClientError.missingRef("AgentRunPaused missing run_id/nonce/action_digest")
      }
      return .paused(PausedOutcome(
        runId: p.runId,
        approvalId: p.nonce,
        actionDigest: p.actionDigest,
        ownerSealedSummary: p.summary.isEmpty ? nil : p.summary
      ))
    case .error(let code, let message):
      throw FridayWriteClientError.serverError(code: code, message: message)
    case .agentRunRequest, .agentRunResume, .agentRunCancel, .agentRunReject, .agentRunControlResult,
         .pair, .pairAck, .hubStatus,
         .workbenchProjectionRequest, .workbenchProjectionSnapshot,
         .runReadbackRequest, .runReadbackSnapshot,
         .runAnswerBodyRequest, .runAnswerBodySnapshot,
         .providersDoctorRequest, .providersDoctorSnapshot,
         .sessionListRequest, .sessionListSnapshot,
         .sessionOpenRequest, .sessionOpenSnapshot,
         .sessionLinkStateRequest, .sessionLinkStateSnapshot,
         .runFileViewRequest, .runFileViewSnapshot,
         .activityNeedsMeRequest, .activityNeedsMeSnapshot,
         .missionIntakeRequest, .missionIntakeResult,
         .memoryDecisionRequest, .memoryDecisionResult,
         .runOutcomeLearningDecisionRequest, .runOutcomeLearningDecisionResult:
      throw FridayWriteClientError.unexpectedResponse(kind: dispatchKind(message))
    case .unsupported(let kind):
      throw FridayWriteClientError.unexpectedResponse(kind: kind)
    }
  }

  // MARK: Mission-spine WRITE drivers (NO auth_proof — the sealed session IS the channel auth)

  /// Submit one Mission intake over the sealed WRITE session. SIMPLER than `dispatchAgentRun`: it
  /// performs ONLY the handshake (the allowlisted peer pubkey is the admission) and sends the
  /// `MissionIntakeRequest` sealed under the WRITE SESSION_AAD — it builds NO `auth_proof` (this
  /// wire shape carries none; the server binds the write to the authenticated `--owner`). Settles
  /// on the FIRST inbound: a `MissionIntakeResult` ⇒ returned; a typed `Error` ⇒ thrown; anything
  /// else ⇒ fail-closed. The session nonce is unused (no possession proof to bind).
  public func submitMissionIntake(_ request: MissionIntakeRequestWire) async throws -> MissionIntakeResultWire {
    let transport = try makeTransport()
    let (sessionKey, _) = try handshake(transport)
    let msgId = "mission-intake-\(request.missionId)"
    let env = FridayEnvelope(msgId: msgId, sentAt: now(), message: .missionIntakeRequest(request))
      .withCorrelation(msgId)
    try transport.sendMessage(try sealEnvelope(env, sessionKey: sessionKey))
    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayWriteClientError.transport("no intake result (session ended fail-closed): \(error)")
    }
    let resp = try openEnvelope(respBody, sessionKey: sessionKey)
    switch resp.message {
    case .missionIntakeResult(let r):
      return r
    case .error(let code, let message):
      throw FridayWriteClientError.serverError(code: code, message: message)
    default:
      throw FridayWriteClientError.unexpectedResponse(kind: dispatchKind(resp.message))
    }
  }

  /// Submit the owner's confirm/reject for ONE pending memory candidate over the sealed WRITE
  /// session. Like `submitMissionIntake`: handshake-only auth (NO `auth_proof`), seal the
  /// `MemoryDecisionRequest` under the WRITE SESSION_AAD, settle on the first
  /// `MemoryDecisionResult` (a `status:"blocked"` result is a VALID receipt the caller surfaces
  /// honestly — NOT a thrown error), a typed `Error` is thrown, anything else fails closed.
  public func submitMemoryDecision(_ request: MemoryDecisionRequestWire) async throws -> MemoryDecisionResultWire {
    let transport = try makeTransport()
    let (sessionKey, _) = try handshake(transport)
    let msgId = "memory-decision-\(request.memoryId)"
    let env = FridayEnvelope(msgId: msgId, sentAt: now(), message: .memoryDecisionRequest(request))
      .withCorrelation(msgId)
    try transport.sendMessage(try sealEnvelope(env, sessionKey: sessionKey))
    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayWriteClientError.transport("no memory-decision result (session ended fail-closed): \(error)")
    }
    let resp = try openEnvelope(respBody, sessionKey: sessionKey)
    switch resp.message {
    case .memoryDecisionResult(let r):
      return r
    case .error(let code, let message):
      throw FridayWriteClientError.serverError(code: code, message: message)
    default:
      throw FridayWriteClientError.unexpectedResponse(kind: dispatchKind(resp.message))
    }
  }

  /// Submit the owner's confirm/reject for ONE pending A1 run-outcome learning candidate over the
  /// sealed WRITE session. This is refs-only governance over an existing candidate row; a
  /// `status:"blocked"` result is returned to the caller as truth, not thrown.
  public func submitRunOutcomeLearningDecision(
    _ request: RunOutcomeLearningDecisionRequestWire
  ) async throws -> RunOutcomeLearningDecisionResultWire {
    let transport = try makeTransport()
    let (sessionKey, _) = try handshake(transport)
    let msgId = "run-outcome-learning-decision-\(request.candidateId)"
    let env = FridayEnvelope(msgId: msgId, sentAt: now(), message: .runOutcomeLearningDecisionRequest(request))
      .withCorrelation(msgId)
    try transport.sendMessage(try sealEnvelope(env, sessionKey: sessionKey))
    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayWriteClientError.transport(
        "no run-outcome-learning-decision result (session ended fail-closed): \(error)")
    }
    let resp = try openEnvelope(respBody, sessionKey: sessionKey)
    switch resp.message {
    case .runOutcomeLearningDecisionResult(let r):
      return r
    case .error(let code, let message):
      throw FridayWriteClientError.serverError(code: code, message: message)
    default:
      throw FridayWriteClientError.unexpectedResponse(kind: dispatchKind(resp.message))
    }
  }

  // MARK: resumeWithApproval (the S6 relay — INV-1 pure courier)

  public func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
    // FLAG-GATED: with the run-control flag OFF the courier relays NOTHING — fail closed WITHOUT
    // opening a socket (mirrors the TS courier; the default-off posture stays byte-identical).
    guard agentRunControlViaRust else { throw FridayWriteClientError.runControlDisabled }
    guard !runId.isEmpty else { throw FridayWriteClientError.missingRef("resume requires a run id") }
    // INV-1 (pure courier): the blob is OPAQUE — the client inspects/derives/authors NOTHING in it.
    // We require only that SOME bytes are present (an empty blob can carry no signature).
    guard !opaqueSignedBlob.isEmpty else { throw FridayWriteClientError.emptySignedBlob }

    // Open a FRESH sealed session bound to the SAME credentials + the SAME run_id. Safe because the
    // NONCE inside the blob is the single-use authority, not the socket. The merged AgentRunResume
    // is SELF-authenticating via the blob — it carries NO auth_proof — so this leg builds no
    // possession proof.
    let transport = try makeTransport()
    let (sessionKey, _) = try handshake(transport)

    // RELAY the AgentRunResume VERBATIM (INV-1): the blob rides the `signed_blob` field unchanged.
    let resumeEnvelope = FridayEnvelope(
      msgId: "agent-run-resume-\(runId)",
      sentAt: now(),
      message: .agentRunResume(runId: runId, signedBlob: opaqueSignedBlob)
    ).withCorrelation("agent-run-resume-\(runId)")
    try transport.sendMessage(try sealEnvelope(resumeEnvelope, sessionKey: sessionKey))

    // Await the refs-only AgentRunControlResult.
    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayWriteClientError.transport("resume: connection closed before a control result: \(error)")
    }
    let respEnvelope = try openEnvelope(respBody, sessionKey: sessionKey)
    return try parseControlResult(respEnvelope.message)
  }

  public func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
    guard !approvalId.isEmpty else { throw FridayWriteClientError.missingRef("reject requires an approval id") }
    return try await sendOwnerAuthedControl(
      runId: runId,
      msgId: "agent-run-reject-\(runId)-\(approvalId)",
      message: { authProof in
        .agentRunReject(
          runId: runId,
          approvalId: approvalId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof)
      },
      closedMessage: "reject: connection closed before a control result")
  }

  public func cancelRun(runId: String, reason: String? = nil) async throws -> ResumeRelayResult {
    try await sendOwnerAuthedControl(
      runId: runId,
      msgId: "agent-run-cancel-\(runId)",
      message: { authProof in
        .agentRunCancel(
          runId: runId,
          forwardedPrincipal: forwardedPrincipal,
          authProof: authProof,
          reason: reason)
      },
      closedMessage: "cancel: connection closed before a control result")
  }

  private func sendOwnerAuthedControl(
    runId: String,
    msgId: String,
    message: ([UInt8]) -> FridayMessage,
    closedMessage: String
  ) async throws -> ResumeRelayResult {
    guard agentRunControlViaRust else { throw FridayWriteClientError.runControlDisabled }
    guard !runId.isEmpty else { throw FridayWriteClientError.missingRef("control requires a run id") }

    let transport = try makeTransport()
    let (sessionKey, sessionNonce) = try handshake(transport)
    let authProof = try FridayCrypto.buildAuthProof(
      sessionKey: sessionKey,
      sessionNonce: sessionNonce,
      sessionAad: writeSessionAad,
      authChallenge: writeAuthChallenge,
      forwardedPrincipal: forwardedPrincipal,
      boundContext: Array(runId.utf8)
    )
    let env = FridayEnvelope(
      msgId: msgId,
      sentAt: now(),
      message: message(authProof)
    ).withCorrelation(msgId)
    try transport.sendMessage(try sealEnvelope(env, sessionKey: sessionKey))

    let respBody: [UInt8]
    do {
      respBody = try transport.recvMessage()
    } catch {
      throw FridayWriteClientError.transport("\(closedMessage): \(error)")
    }
    let respEnvelope = try openEnvelope(respBody, sessionKey: sessionKey)
    return try parseControlResult(respEnvelope.message)
  }

  /// Parse the refs-only `AgentRunControlResult` for a resume relay. A frame missing a required ref
  /// fails closed. A server REFUSAL (`accepted=false`) is a VALID parse — it is a refusal outcome,
  /// not a parse failure (the caller inspects `accepted`). EXPOSED `internal` for unit testing.
  func parseControlResult(_ message: FridayMessage) throws -> ResumeRelayResult {
    switch message {
    case .agentRunControlResult(let r):
      guard !r.runId.isEmpty, !r.op.isEmpty, !r.status.isEmpty else {
        throw FridayWriteClientError.missingRef("AgentRunControlResult missing run_id/op/status")
      }
      return ResumeRelayResult(
        runId: r.runId, op: r.op, accepted: r.accepted, status: r.status, auditRef: r.auditRef)
    case .error(let code, let message):
      throw FridayWriteClientError.serverError(code: code, message: message)
    case .unsupported(let kind):
      throw FridayWriteClientError.unexpectedResponse(kind: kind)
    default:
      throw FridayWriteClientError.unexpectedResponse(kind: dispatchKind(message))
    }
  }

  // MARK: Handshake + envelope seal/open (write session)

  /// The cleartext preamble + WS upgrade + session-key agreement, shared by dispatch + resume.
  /// Identical to the read client's handshake (the WRITE path reuses the SAME framing) — only the
  /// SESSION_AAD differs (applied in seal/open).
  private func handshake(_ transport: SealedWSTransport) throws -> (sessionKey: [UInt8], sessionNonce: [UInt8]) {
    try transport.writeFrame(keypair.publicKey)
    let serverPub = try transport.readFrame()
    guard serverPub.count == FridayCrypto.x25519PublicKeyLen else {
      throw FridayWriteClientError.badServerPubkey
    }
    let sessionNonce = try transport.readFrame()
    guard sessionNonce.count == 64 else {
      throw FridayWriteClientError.badSessionNonce
    }
    try transport.upgrade()
    let sessionKey: [UInt8]
    do {
      sessionKey = try keypair.agree(peerPublicKey: serverPub)
    } catch {
      throw FridayWriteClientError.transport("session-key agreement failed: \(error)")
    }
    return (sessionKey, sessionNonce)
  }

  /// Serialize + seal an envelope into a WS Binary body under the WRITE SESSION_AAD.
  func sealEnvelope(_ env: FridayEnvelope, sessionKey: [UInt8]) throws -> [UInt8] {
    let json = try env.encodeJSON()
    let sealed = try FridayCrypto.seal(key: sessionKey, plaintext: [UInt8](json), aad: writeSessionAad)
    return FridayCrypto.encodeSealed(sealed)
  }

  /// Open + deserialize a WS Binary body into an envelope under the WRITE SESSION_AAD.
  func openEnvelope(_ body: [UInt8], sessionKey: [UInt8]) throws -> FridayEnvelope {
    let sealed = try FridayCrypto.decodeSealed(body)
    let pt: [UInt8]
    do {
      pt = try FridayCrypto.open(key: sessionKey, sealed: sealed, aad: writeSessionAad)
    } catch {
      throw FridayWriteClientError.transport("envelope failed to open (fail-closed): \(error)")
    }
    return try FridayEnvelope.decodeJSON(Data(pt))
  }

  /// A blank/whitespace session id is treated as ABSENT (omitted from the wire), so a degenerate
  /// value can never divert the sessionless path — mirrors the TS courier + the Rust server's
  /// `str::trim().filter(!is_empty)` discipline.
  private func normalizedSessionId() -> String? {
    guard let sessionId else { return nil }
    let trimmed = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

/// A coarse `kind` label for an unexpected inbound (truth-labeled surfacing; never a body).
private func dispatchKind(_ message: FridayMessage) -> String {
  switch message {
  case .workbenchProjectionRequest: return "WorkbenchProjectionRequest"
  case .workbenchProjectionSnapshot: return "WorkbenchProjectionSnapshot"
  case .runReadbackRequest: return "RunReadbackRequest"
  case .runReadbackSnapshot: return "RunReadbackSnapshot"
  case .runAnswerBodyRequest: return "RunAnswerBodyRequest"
  case .runAnswerBodySnapshot: return "RunAnswerBodySnapshot"
  case .providersDoctorRequest: return "ProvidersDoctorRequest"
  case .providersDoctorSnapshot: return "ProvidersDoctorSnapshot"
  case .sessionListRequest: return "SessionListRequest"
  case .sessionListSnapshot: return "SessionListSnapshot"
  case .sessionOpenRequest: return "SessionOpenRequest"
  case .sessionOpenSnapshot: return "SessionOpenSnapshot"
  case .sessionLinkStateRequest: return "SessionLinkStateRequest"
  case .sessionLinkStateSnapshot: return "SessionLinkStateSnapshot"
  case .pair: return "Pair"
  case .pairAck: return "PairAck"
  case .hubStatus: return "HubStatus"
  case .runFileViewRequest: return "RunFileViewRequest"
  case .runFileViewSnapshot: return "RunFileViewSnapshot"
  case .activityNeedsMeRequest: return "ActivityNeedsMeRequest"
  case .activityNeedsMeSnapshot: return "ActivityNeedsMeSnapshot"
  case .error: return "Error"
  case .agentRunRequest: return "AgentRunRequest"
  case .agentRunResult: return "AgentRunResult"
  case .agentRunPaused: return "AgentRunPaused"
  case .agentRunResume: return "AgentRunResume"
  case .agentRunCancel: return "AgentRunCancel"
  case .agentRunReject: return "AgentRunReject"
  case .agentRunControlResult: return "AgentRunControlResult"
  case .missionIntakeRequest: return "MissionIntakeRequest"
  case .missionIntakeResult: return "MissionIntakeResult"
  case .memoryDecisionRequest: return "MemoryDecisionRequest"
  case .memoryDecisionResult: return "MemoryDecisionResult"
  case .runOutcomeLearningDecisionRequest: return "RunOutcomeLearningDecisionRequest"
  case .runOutcomeLearningDecisionResult: return "RunOutcomeLearningDecisionResult"
  case .unsupported(let kind): return kind
  }
}
