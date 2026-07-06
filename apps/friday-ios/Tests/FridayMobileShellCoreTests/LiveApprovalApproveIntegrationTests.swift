import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE mobile approval approve integration (MANUAL / env-gated)
//
// Drives the real mobile Swift write client against a live paused mutating run and relays an
// operator-signed approval artifact verbatim through the iOS approval seam.
//
// HONEST CEILING: this is mobile Swift write-client runtime evidence. It is not a simulator tap,
// not END-BAR, not release/adoption, and it does not read or mint signing material.

private let liveMobileApprovalApproveEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_APPROVAL_APPROVE_TEST"] == "1"

@Test
func mobileApprovalApproveProofMarksRefusedResumeAsFailure() throws {
  let dir = FileManager.default.temporaryDirectory.appendingPathComponent(
    "friday-mobile-approval-approve-refused-\(UUID().uuidString)",
    isDirectory: true)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  defer { try? FileManager.default.removeItem(at: dir) }

  let proofURL = dir.appendingPathComponent("mobile-approval-approve-proof.json")
  setenv("FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT", proofURL.path, 1)
  defer { unsetenv("FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT") }

  try writeMobileApprovalApproveProofIfRequested(
    result: ResumeRelayResult(
      runId: "run-refused",
      op: "resume",
      accepted: false,
      status: "approval_refused",
      auditRef: "run-refused:resume:receipt"),
    approvalId: "approval-refused",
    signedApprovalPath: dir.appendingPathComponent("signed-approval.json").path,
    signedBlobByteCount: 439,
    writeConfig: AgentRunServerConfig(host: "127.0.0.1", port: 48750))

  let data = try Data(contentsOf: proofURL)
  guard let proof = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    Issue.record("proof JSON is not an object")
    return
  }
  #expect(proof["status"] as? String == "fail")
  #expect(proof["failure_reason"] as? String == "approval_refused")
  let resume = proof["resume"] as? [String: Any] ?? [:]
  #expect(resume["accepted"] as? Bool == false)
  let actions = proof["ui_actions"] as? [[String: Any]] ?? []
  #expect(!actions.isEmpty)
  #expect(actions.allSatisfy { ($0["status"] as? String) == "fail" })
}

@MainActor
@Test(.enabled(if: liveMobileApprovalApproveEnabled))
func liveMobileApprovalApproveRelaysOperatorSignedBlobVerbatim() async throws {
  let env = ProcessInfo.processInfo.environment
  let runId = try requiredMobileApprovalApproveEnv("FRIDAY_MOBILE_APPROVAL_APPROVE_RUN_ID", env: env)
  let approvalId = try requiredMobileApprovalApproveEnv("FRIDAY_MOBILE_APPROVAL_APPROVE_APPROVAL_ID", env: env)
  let signedApprovalPath = try requiredMobileApprovalApproveEnv(
    "FRIDAY_MOBILE_APPROVAL_APPROVE_SIGNED_APPROVAL",
    env: env)
  let signedBlob = try Data(contentsOf: URL(fileURLWithPath: signedApprovalPath))
  guard !signedBlob.isEmpty else {
    throw FridayWriteClientError.emptySignedBlob
  }

  let writeConfig = try mobileApprovalApproveWriteConfig(env: env)
  let client = try RealWriteClientFactory.makeLive(
    config: writeConfig,
    agentRunControlViaRust: true)

  let result = try await client.resumeWithApproval(runId: runId, opaqueSignedBlob: Array(signedBlob))

  print(
    "[live-mobile-approval-approve] runId=\(result.runId) op=\(result.op) "
      + "accepted=\(result.accepted) status=\(result.status) "
      + "auditRef=\(result.auditRef ?? "<nil>")")

  #expect(result.runId == runId)
  #expect(result.op == "resume")
  #expect(result.accepted)

  try writeMobileApprovalApproveProofIfRequested(
    result: result,
    approvalId: approvalId,
    signedApprovalPath: signedApprovalPath,
    signedBlobByteCount: signedBlob.count,
    writeConfig: writeConfig)

  try await proveFridayChatViewModelApproveDelegatesSignedBlobToLiveWriteClient(
    runId: runId,
    approvalId: approvalId,
    actionDigest: env["FRIDAY_MOBILE_APPROVAL_APPROVE_ACTION_DIGEST"],
    signedBlob: Array(signedBlob),
    liveReceipt: result)
}

private func requiredMobileApprovalApproveEnv(_ key: String, env: [String: String]) throws -> String {
  guard let value = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    throw FridayWriteClientError.transport("missing required env \(key)")
  }
  return value
}

private func mobileApprovalApproveWriteConfig(env: [String: String]) throws -> AgentRunServerConfig {
  let host = env["FRIDAY_MOBILE_APPROVAL_APPROVE_WRITE_HOST"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let rawPort = env["FRIDAY_MOBILE_APPROVAL_APPROVE_WRITE_PORT"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard let rawPort, !rawPort.isEmpty else {
    return AgentRunServerConfig(
      host: host.flatMap { $0.isEmpty ? nil : $0 } ?? AgentRunServerConfig.liveLoopback.host,
      port: AgentRunServerConfig.liveLoopback.port)
  }
  guard let port = UInt16(rawPort), port > 0 else {
    throw FridayWriteClientError.transport("invalid FRIDAY_MOBILE_APPROVAL_APPROVE_WRITE_PORT=\(rawPort)")
  }
  return AgentRunServerConfig(
    host: host.flatMap { $0.isEmpty ? nil : $0 } ?? AgentRunServerConfig.liveLoopback.host,
    port: port)
}

private func writeMobileApprovalApproveProofIfRequested(
  result: ResumeRelayResult,
  approvalId: String,
  signedApprovalPath: String,
  signedBlobByteCount: Int,
  writeConfig: AgentRunServerConfig
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }

  let proofStatus = result.accepted ? "pass" : "fail"
  var proof: [String: Any] = [
    "truth_label": "ios_mobile_live_approval_approve_write_client_proof_signed_artifact_relay_not_sim_tap_not_endbar",
    "status": proofStatus,
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "run_id": result.runId,
    "approval_id": approvalId,
    "signed_approval_artifact": signedApprovalPath,
    "signed_blob_byte_count": signedBlobByteCount,
    "resume": [
      "op": result.op,
      "accepted": result.accepted,
      "status": result.status,
      "audit_ref": result.auditRef.map { $0 as Any } ?? NSNull(),
      "endpoint": [
        "host": writeConfig.host,
        "port": Int(writeConfig.port),
      ],
    ],
    "ui_actions": [
      [
        "surface": "mobile",
        "screen": "approval",
        "action_id": "check",
        "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
        "status": proofStatus,
        "evidence_ref": "proof://mobile/approval-approve/\(result.runId)",
        "truth_label": "explicit_mobile_approval_approve_runtime_evidence_from_live_swift_write_client",
      ],
    ],
    "caveat": "Mobile Swift write-client approve proof only. The signed artifact is supplied externally; the app never reads a signing key or mints a signature. Not a simulator tap, END-BAR, GO-LIVE, release, or adoption.",
  ]
  if !result.accepted {
    proof["failure_reason"] = result.status
  }

  let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  let url = URL(fileURLWithPath: rawPath)
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true)
  try data.write(to: url, options: .atomic)
  print("[live-mobile-approval-approve] proofOut=\(url.path)")
}

@MainActor
private func proveFridayChatViewModelApproveDelegatesSignedBlobToLiveWriteClient(
  runId: String,
  approvalId: String,
  actionDigest rawActionDigest: String?,
  signedBlob: [UInt8],
  liveReceipt: ResumeRelayResult
) async throws {
  let actionDigest = rawActionDigest?.trimmingCharacters(in: .whitespacesAndNewlines)
  let client = FridayChatLiveApproveHarnessWriteClient(
    pending: PausedOutcome(
      runId: runId,
      approvalId: approvalId,
      actionDigest: actionDigest.flatMap { $0.isEmpty ? nil : $0 } ?? String(repeating: "0", count: 64),
      ownerSealedSummary: "write_file(mobile-approval-approve-proof.txt)"),
    receipt: liveReceipt)
  let vm = FridayChatViewModel(
    writeClient: client,
    signer: FixedOperatorSigner(blob: signedBlob),
    historyStore: LiveApprovalApproveInMemoryHistoryStore())

  await vm.send("approve this already-paused mobile approval")
  guard case .pendingApproval = vm.phase else {
    Issue.record("expected .pendingApproval before approve, got \(String(describing: vm.phase))")
    return
  }

  await vm.approve()

  #expect(client.dispatchedTasks == ["approve this already-paused mobile approval"])
  #expect(client.resumedRunIds == [runId])
  #expect(client.relayedBlobs == [signedBlob])
  #expect(client.rejectedRunIds.isEmpty)
  guard case .resumed(let receipt) = vm.phase else {
    Issue.record("expected .resumed approve receipt, got \(String(describing: vm.phase))")
    return
  }
  #expect(receipt.runId == runId)
  #expect(receipt.op == "resume")
  #expect(receipt.accepted)

  try appendMobileFridayChatApproveEvidenceIfRequested(
    result: liveReceipt,
    approvalId: approvalId)
}

private struct FixedOperatorSigner: OperatorSigner {
  let blob: [UInt8]

  func signApproval(_ request: ApprovalSigningRequest) async throws -> [UInt8] {
    blob
  }
}

private final class FridayChatLiveApproveHarnessWriteClient: FridayRustWriteClient, @unchecked Sendable {
  let pending: PausedOutcome
  let receipt: ResumeRelayResult

  private(set) var dispatchedTasks: [String] = []
  private(set) var resumedRunIds: [String] = []
  private(set) var relayedBlobs: [[UInt8]] = []
  private(set) var rejectedRunIds: [String] = []

  init(pending: PausedOutcome, receipt: ResumeRelayResult) {
    self.pending = pending
    self.receipt = receipt
  }

  func dispatchAgentRun(task: String, constraints: AgentRunConstraintsWire?) async throws -> AgentRunDispatchOutcome {
    dispatchedTasks.append(task)
    return .paused(pending)
  }

  func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
    resumedRunIds.append(runId)
    relayedBlobs.append(opaqueSignedBlob)
    return receipt
  }

  func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
    rejectedRunIds.append(runId)
    throw FridayWriteClientError.transport("test harness must not reject")
  }

  func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
    throw FridayWriteClientError.transport("test harness must not cancel")
  }
}

private final class LiveApprovalApproveInMemoryHistoryStore: ChatHistoryStoring, @unchecked Sendable {
  private var items: [ChatHistoryItem] = []

  func load() -> [ChatHistoryItem] {
    items
  }

  func save(_ items: [ChatHistoryItem]) {
    self.items = items
  }
}

private func appendMobileFridayChatApproveEvidenceIfRequested(
  result: ResumeRelayResult,
  approvalId: String
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }

  let url = URL(fileURLWithPath: rawPath)
  let original = try Data(contentsOf: url)
  guard var proof = try JSONSerialization.jsonObject(with: original) as? [String: Any] else {
    throw FridayWriteClientError.transport("invalid mobile approval approve proof JSON at \(rawPath)")
  }
  var actions = proof["ui_actions"] as? [[String: Any]] ?? []
  actions.append([
    "surface": "mobile",
    "screen": "fridayChat",
    "action_id": "check",
    "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
    "status": result.accepted ? "pass" : "fail",
    "evidence_ref": "proof://mobile/fridaychat-approval-approve/\(result.runId)",
    "truth_label": "explicit_mobile_fridaychat_approve_runtime_evidence_from_view_model_relaying_signed_blob_verbatim",
  ])
  proof["ui_actions"] = actions
  proof["friday_chat_approve"] = [
    "op": result.op,
    "accepted": result.accepted,
    "status": result.status,
    "run_id": result.runId,
    "approval_id": approvalId,
    "audit_ref": result.auditRef.map { $0 as Any } ?? NSNull(),
  ]
  let updated = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  try updated.write(to: url, options: .atomic)
  print("[live-mobile-fridaychat-approval-approve] appendedProofOut=\(url.path)")
}
