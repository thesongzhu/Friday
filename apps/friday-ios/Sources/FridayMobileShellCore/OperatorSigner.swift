import Foundation

/// **The operator-signing RELAY seam (INV-1).**
///
/// The phone is a PURE COURIER for S6 approvals: it NEVER mints, derives, holds, or even
/// inspects a signing key. When a mutating agent-run PAUSES, the app surfaces the refs-only
/// approval card; on approval it asks an EXTERNAL signer to produce the operator's Ed25519
/// signature over the paused action, then relays that OPAQUE blob VERBATIM via
/// `SealedWSWriteClient.resumeWithApproval`.
///
/// ## Where the real signature comes from (the slice-6 / operator-key gate)
/// The REAL signer is the desktop operator-signer helper (PR #671,
/// `rust-core/crates/friday-operator-signer`). It reads the operator's PRIVATE Ed25519 seed
/// from an ISOLATED, KEK-wrapped SecureStore — a store the Hub (and the phone) can never
/// open — and produces a `SignedApproval` blob byte-identical to what the Hub recomputes at
/// verify time (`canonical_approval_signature_bytes`). That blob is what rides
/// `AgentRunResume.signed_blob`.
///
/// On the phone, `OperatorSigner` is therefore an INJECTED protocol whose ONLY concrete
/// implementation shipped today is a clearly-labeled TEST/DEV mock (`MockOperatorSigner`).
/// The REAL on-device integration — relaying to the desktop signer (or a future Secure
/// Enclave-backed operator path) over the local trust channel — is a DEFERRED acceptance
/// criterion gated on slice-6 + the operator key. The protocol shape is fixed NOW so the
/// chat loop is real and the only thing that swaps at slice-6 is the signer impl.
///
/// INV-1 is structural: the protocol can ONLY return an opaque `[UInt8]` blob. It exposes NO
/// key material, NO "sign these bytes with this key" primitive — the app has nothing to mint
/// a signature WITH. The app cannot become a signer by accident.
public protocol OperatorSigner: Sendable {
  /// Obtain the operator's OPAQUE Ed25519-signed approval blob for a paused action.
  ///
  /// - The signer is handed ONLY the refs the pause frame carried (`approvalId` = the
  ///   single-use nonce, `actionDigest` = the hex SHA-256 binding the EXACT action). It is
  ///   handed NO body, NO key, NO session material.
  /// - The returned blob is OPAQUE to the app: the app relays it verbatim and inspects
  ///   nothing (INV-1). A real signer's blob is the operator's `SignedApproval` bytes.
  /// - Throwing is an honest "could not obtain a signature" (e.g. the desktop signer is
  ///   unreachable, the operator declined at the signer, or no key is provisioned). A throw
  ///   means NO resume is relayed — the mutation stays paused (INV-2 holds: no approval ⇒ no
  ///   mutation).
  func signApproval(_ request: ApprovalSigningRequest) async throws -> [UInt8]
}

/// The REFS-ONLY request handed to the operator signer. It carries ONLY what the pause frame
/// surfaced — never a body, key, or session secret. Mirrors the fields the desktop signer's
/// `PendingRequest` binds (`approval_id`, `action_digest`).
public struct ApprovalSigningRequest: Sendable, Equatable {
  /// The run that paused (echoes the pause frame's `runId`).
  public let runId: String
  /// The single-use approval nonce the operator signs over (the pause frame's `nonce`, =
  /// `pending_approval_request.approval_id`). A nonce, not a secret.
  public let approvalId: String
  /// Hex SHA-256 of the paused action's canonical bytes (the pause frame's `action_digest`).
  /// A fingerprint binding the EXACT action — never a body.
  public let actionDigest: String
  /// The coarse, body-free summary of WHAT paused (the pause frame's `summary`), shown to the
  /// operator so they sign over an action they can SEE. Optional (the wire may omit it).
  public let summary: String?

  public init(runId: String, approvalId: String, actionDigest: String, summary: String?) {
    self.runId = runId
    self.approvalId = approvalId
    self.actionDigest = actionDigest
    self.summary = summary
  }
}

/// Errors an `OperatorSigner` may surface. Each maps to an honest "approval unavailable"
/// state — none lets the app pretend an approval happened.
public enum OperatorSignerError: Error, Sendable, Equatable, CustomStringConvertible {
  /// No operator signer is reachable (the desktop signer is offline / not paired).
  case signerUnavailable
  /// The operator declined to sign at the signer (a deliberate refusal — the mutation stays
  /// paused; this is NOT a failure).
  case declined
  /// The signer is reachable but holds no provisioned operator key (slice-6 / operator-key
  /// gate not yet satisfied).
  case keyUnprovisioned

  public var description: String {
    switch self {
    case .signerUnavailable: return "Operator signer unavailable — connect the desktop signer to approve"
    case .declined: return "Operator declined the approval"
    case .keyUnprovisioned: return "Approval key is not set up on the trusted signer"
    }
  }
}

// MARK: - MockOperatorSigner (TEST / DEV ONLY — clearly labeled)

/// **A TEST/DEV-ONLY mock signer. NOT a real operator signature; NOT a key.**
///
/// It does NOT hold or mint an Ed25519 key — it returns a DETERMINISTIC, clearly-marked
/// placeholder blob so the chat read-WRITE loop is exercisable end-to-end OFFLINE (dispatch →
/// pause → approval card → resume) WITHOUT the operator key. The blob is NOT a valid
/// signature: a real Rust write server would reject it at Ed25519 verify time. That is the
/// point — the real, accepted resume is the slice-6 / operator-key gate, and swapping this
/// mock for the desktop signer (PR #671) is the ONLY change that makes a live mutation pass.
///
/// The placeholder blob is prefixed with `MOCK-OPERATOR-SIGNED-BLOB:` so it can NEVER be
/// mistaken for a real signature in a log or on the wire, and is bound to the request refs so
/// a test can assert the EXACT bytes relayed (proving the verbatim INV-1 relay).
public struct MockOperatorSigner: OperatorSigner {
  /// A label proving this is a mock surface, never upgraded.
  public static let truthLabel = "mock_operator_signer_not_a_real_signature"

  /// When set, every `signApproval` throws this instead of returning a blob — lets a test
  /// drive the "operator declined / signer unavailable" path (no resume relayed).
  private let throwing: OperatorSignerError?

  public init(throwing: OperatorSignerError? = nil) {
    self.throwing = throwing
  }

  public func signApproval(_ request: ApprovalSigningRequest) async throws -> [UInt8] {
    if let throwing { throw throwing }
    // A deterministic, clearly-NON-real placeholder bound to the request refs. Real signers
    // produce the operator's `SignedApproval` bytes here; this proves the LOOP, not the crypto.
    let marker = "MOCK-OPERATOR-SIGNED-BLOB:\(request.runId):\(request.approvalId):\(request.actionDigest)"
    return Array(marker.utf8)
  }
}
