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

  public var description: String {
    switch self {
    case .keyUnprovisioned:
      return "Operator approval key is not configured on this desktop signer"
    case let .invalidRequest(reason):
      return "Invalid approval request: \(reason)"
    case let .signerFailed(reason):
      return "Operator signer failed: \(reason)"
    }
  }
}

/// Desktop bridge to `friday-operator-approve sign`. It reads no key bytes itself; the external
/// operator CLI owns key custody and emits only public signed-approval JSON on stdout.
public struct OperatorApprovalCLISigner: OperatorApprovalSigner {
  private let executablePath: String
  private let keyPath: String?
  private let tempDirectory: URL

  public init(
    executablePath: String? = ProcessInfo.processInfo.environment["FRIDAY_OPERATOR_APPROVE_BIN"],
    keyPath: String? = ProcessInfo.processInfo.environment["FRIDAY_OPERATOR_APPROVE_KEY_PATH"],
    tempDirectory: URL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
  ) {
    self.executablePath = executablePath?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
      ?? "friday-operator-approve"
    self.keyPath = keyPath?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    self.tempDirectory = tempDirectory
  }

  public func signApproval(_ request: OperatorApprovalSigningRequest) async throws -> [UInt8] {
    guard let keyPath else { throw OperatorApprovalSignerError.keyUnprovisioned }
    let requestFile = try writePendingRequest(request)
    defer { try? FileManager.default.removeItem(at: requestFile) }
    return try await runSigner(keyPath: keyPath, requestFile: requestFile)
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

  private func runSigner(keyPath: String, requestFile: URL) async throws -> [UInt8] {
    try await withCheckedThrowingContinuation { continuation in
      let process = Process()
      let stdout = Pipe()
      let stderr = Pipe()
      process.standardOutput = stdout
      process.standardError = stderr

      if executablePath.contains("/") {
        process.executableURL = URL(fileURLWithPath: executablePath)
        process.arguments = ["sign", "--key", keyPath, "--request", requestFile.path]
      } else {
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [executablePath, "sign", "--key", keyPath, "--request", requestFile.path]
      }

      process.terminationHandler = { completed in
        let out = stdout.fileHandleForReading.readDataToEndOfFile()
        let err = stderr.fileHandleForReading.readDataToEndOfFile()
        if completed.terminationStatus == 0, !out.isEmpty {
          continuation.resume(returning: Array(out))
        } else {
          let stderrText = String(data: err, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
          continuation.resume(
            throwing: OperatorApprovalSignerError.signerFailed(
              stderrText?.nilIfEmpty ?? "exit \(completed.terminationStatus)"))
        }
      }

      do {
        try process.run()
      } catch {
        continuation.resume(throwing: OperatorApprovalSignerError.signerFailed(error.localizedDescription))
      }
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

private extension String {
  var nilIfEmpty: String? {
    isEmpty ? nil : self
  }
}
