import Darwin
import Foundation

/// Refs-only approval material the desktop can hand to an operator-controlled signer.
/// It contains no key material, tool body, session secret, or signature.
public struct OperatorApprovalSigningRequest: Sendable, Equatable {
  public let runId: String
  public let approvalId: String
  public let actionDigest: String
  public let summary: String?
  public let expiresAtMs: Int64
  public let decision: String

  public init(
    runId: String,
    approvalId: String,
    actionDigest: String,
    summary: String?,
    expiresAtMs: Int64,
    decision: String = "approved"
  ) {
    self.runId = runId
    self.approvalId = approvalId
    self.actionDigest = actionDigest
    self.summary = summary
    self.expiresAtMs = expiresAtMs
    self.decision = decision
  }
}

public protocol OperatorApprovalSigner: Sendable {
  /// Returns the opaque `SignedApproval` JSON bytes the Hub verifies. The caller relays these
  /// bytes verbatim; the app never inspects or mints a signature.
  func signApproval(_ request: OperatorApprovalSigningRequest) async throws -> [UInt8]
}

public enum OperatorApprovalSignerError: Error, Sendable, Equatable, CustomStringConvertible {
  case keyUnprovisioned
  case invalidRequest(String)
  case signerFailed(String)
  case signedApprovalUnavailable(String)

  public var description: String {
    switch self {
    case .keyUnprovisioned:
      return "Operator approval key is not configured on this desktop signer"
    case let .invalidRequest(reason):
      return "Invalid approval request: \(reason)"
    case let .signerFailed(reason):
      return "Operator signer failed: \(reason)"
    case let .signedApprovalUnavailable(reason):
      return "Operator signed approval unavailable: \(reason)"
    }
  }
}

/// Desktop relay for an operator-supplied `SignedApproval` artifact.
///
/// The app is not a signer. It writes a refs-only pending request the operator can sign outside
/// the app, and if a signed artifact path is configured it relays those opaque bytes after checking
/// the public refs match this pause frame. No key path is accepted and no signing command is run.
public struct OperatorApprovalExternalArtifactSigner: OperatorApprovalSigner {
  private let signedApprovalPath: String?
  private let tempDirectory: URL

  public init(
    signedApprovalPath: String? = ProcessInfo.processInfo.environment[
      "FRIDAY_OPERATOR_APPROVE_SIGNED_APPROVAL_PATH"],
    tempDirectory: URL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
  ) {
    self.signedApprovalPath = signedApprovalPath?.trimmingCharacters(in: .whitespacesAndNewlines)
      .nilIfEmpty
    self.tempDirectory = tempDirectory
  }

  public func signApproval(_ request: OperatorApprovalSigningRequest) async throws -> [UInt8] {
    let requestFile = try writePendingRequest(request)
    guard let signedApprovalPath else {
      throw OperatorApprovalSignerError.signedApprovalUnavailable(
        "refs-only request written to \(requestFile.path); sign it outside the app and set FRIDAY_OPERATOR_APPROVE_SIGNED_APPROVAL_PATH")
    }
    let signedApprovalFile = URL(fileURLWithPath: signedApprovalPath)
    let data = try Data(contentsOf: signedApprovalFile)
    try validateSignedApproval(data, matches: request)
    return Array(data)
  }

  private func writePendingRequest(_ request: OperatorApprovalSigningRequest) throws -> URL {
    guard !request.runId.isEmpty else {
      throw OperatorApprovalSignerError.invalidRequest("run_id must not be empty")
    }
    guard !request.approvalId.isEmpty else {
      throw OperatorApprovalSignerError.invalidRequest("approval_id must not be empty")
    }
    guard request.actionDigest.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
      throw OperatorApprovalSignerError.invalidRequest("action_digest must be 64 lowercase hex chars")
    }
    guard request.expiresAtMs > 0 else {
      throw OperatorApprovalSignerError.invalidRequest("expires_at must be positive")
    }

    let file = tempDirectory.appendingPathComponent("friday-approval-\(UUID().uuidString).json")
    let payload = PendingApprovalRequestFile(
      approvalId: request.approvalId,
      actionDigest: request.actionDigest,
      expiresAt: request.expiresAtMs,
      decision: request.decision,
      surface: "desktop",
      summary: request.summary)
    let data = try JSONEncoder().encode(payload)
    guard FileManager.default.createFile(
      atPath: file.path, contents: data,
      attributes: [.posixPermissions: NSNumber(value: Int16(0o600))])
    else {
      throw OperatorApprovalSignerError.signerFailed("could not create temporary request file")
    }
    return file
  }

  private func validateSignedApproval(
    _ data: Data,
    matches request: OperatorApprovalSigningRequest
  ) throws {
    let approval = try JSONDecoder().decode(SignedApprovalFile.self, from: data)
    guard approval.approvalId == request.approvalId else {
      throw OperatorApprovalSignerError.invalidRequest("signed approval_id does not match pause frame")
    }
    guard approval.actionDigest == request.actionDigest else {
      throw OperatorApprovalSignerError.invalidRequest("signed action_digest does not match pause frame")
    }
    guard approval.decision == request.decision else {
      throw OperatorApprovalSignerError.invalidRequest("signed decision does not match requested decision")
    }
    guard approval.expiresAt > 0 else {
      throw OperatorApprovalSignerError.invalidRequest("signed expires_at must be positive")
    }
    guard !approval.signature.isEmpty else {
      throw OperatorApprovalSignerError.invalidRequest("signed approval is missing signature")
    }
  }
}

private struct PendingApprovalRequestFile: Encodable {
  let approvalId: String
  let actionDigest: String
  let expiresAt: Int64
  let decision: String
  let surface: String
  let summary: String?

  enum CodingKeys: String, CodingKey {
    case approvalId = "approval_id"
    case actionDigest = "action_digest"
    case expiresAt = "expires_at"
    case decision, surface, summary
  }
}

private struct SignedApprovalFile: Decodable {
  let approvalId: String
  let actionDigest: String
  let expiresAt: Int64
  let decision: String
  let signature: String

  enum CodingKeys: String, CodingKey {
    case approvalId = "approval_id"
    case actionDigest = "action_digest"
    case expiresAt = "expires_at"
    case decision, signature
  }
}

private extension String {
  var nilIfEmpty: String? {
    isEmpty ? nil : self
  }
}
