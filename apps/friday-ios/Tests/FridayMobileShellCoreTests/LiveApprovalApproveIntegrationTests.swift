import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE mobile approval approve/resume integration (MANUAL / env-gated)
//
// Drives the real mobile Swift write client against the live agent-run WRITE server using
// operator-signed approval artifacts produced out-of-band. The app/test never reads an operator
// key and never mints a signature: direct resume relays file bytes, and the FridayChat view-model
// path receives those same opaque bytes through an injected signer.
//
// HONEST CEILING: this is mobile Swift write-client + view-model runtime evidence, not a simulator
// tap, not END-BAR, not release/adoption, and not operator key custody.

private let liveMobileApprovalApproveEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_APPROVAL_APPROVE_TEST"] == "1"

@MainActor
@Test(.enabled(if: liveMobileApprovalApproveEnabled))
func liveMobileApprovalApproveRelaysOperatorSignedArtifactsWithoutMinting() async throws {
  let env = ProcessInfo.processInfo.environment
  let writeConfig = try mobileApprovalApproveWriteConfig(env: env)
  let liveClient = try RealWriteClientFactory.makeLive(
    config: writeConfig,
    agentRunControlViaRust: true)

  let directRunId = try requiredMobileApprovalApproveEnv("FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_RUN_ID", env: env)
  let directSignedApproval = try readSignedApprovalBytes(
    fromEnv: "FRIDAY_MOBILE_APPROVAL_APPROVE_DIRECT_SIGNED_APPROVAL",
    env: env)
  let directResult = try await liveClient.resumeWithApproval(
    runId: directRunId,
    opaqueSignedBlob: directSignedApproval)
  try assertApprovedResume(result: directResult, expectedRunId: directRunId, label: "direct")
  try writeMobileApprovalApproveProofIfRequested(
    result: directResult,
    writeConfig: writeConfig)

  let chatRunId = try requiredMobileApprovalApproveEnv("FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_RUN_ID", env: env)
  let chatApprovalId = try requiredMobileApprovalApproveEnv("FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_APPROVAL_ID", env: env)
  let chatActionDigest = try requiredMobileApprovalApproveEnv("FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_ACTION_DIGEST", env: env)
  let chatSignedApproval = try readSignedApprovalBytes(
    fromEnv: "FRIDAY_MOBILE_APPROVAL_APPROVE_CHAT_SIGNED_APPROVAL",
    env: env)
  try await proveFridayChatViewModelApproveDelegatesSignedBlobToLiveWriteClient(
    runId: chatRunId,
    approvalId: chatApprovalId,
    actionDigest: chatActionDigest,
    signedApproval: chatSignedApproval,
    liveClient: liveClient)
}

private func assertApprovedResume(result: ResumeRelayResult, expectedRunId: String, label: String) throws {
  print(
    "[live-mobile-approval-approve][\(label)] runId=\(result.runId) op=\(result.op) "
      + "accepted=\(result.accepted) status=\(result.status) "
      + "auditRef=\(result.auditRef ?? "<nil>")")
  #expect(result.runId == expectedRunId)
  #expect(result.op == "resume")
  #expect(result.accepted)
  #expect(result.status == "mutation_completed" || result.status == "completed" || result.status == "resumed")
  #expect(result.auditRef != nil)
}

@MainActor
private func proveFridayChatViewModelApproveDelegatesSignedBlobToLiveWriteClient(
  runId: String,
  approvalId: String,
  actionDigest: String,
  signedApproval: [UInt8],
  liveClient: FridayRustWriteClient
) async throws {
  let client = FridayChatLiveApproveHarnessWriteClient(
    pending: PausedOutcome(
      runId: runId,
      approvalId: approvalId,
      actionDigest: actionDigest,
      ownerSealedSummary: "write_file(mobile-approval-approve-chat-proof.txt)"),
    liveClient: liveClient)
  let signer = FileBackedOperatorSigner(signedApproval: signedApproval)
  let vm = FridayChatViewModel(
    writeClient: client,
    signer: signer,
    historyStore: LiveApprovalApproveInMemoryHistoryStore())

  await vm.send("approve this already-paused mobile approval")
  guard case .pendingApproval(let card) = vm.phase else {
    Issue.record("expected .pendingApproval before approve, got \(String(describing: vm.phase))")
    return
  }
  #expect(card.runId == runId)
  #expect(card.approvalId == approvalId)

  await vm.approve()

  #expect(client.dispatchedTasks == ["approve this already-paused mobile approval"])
  #expect(client.resumedRunIds == [runId])
  #expect(client.relabeledBlob == signedApproval)
  #expect(client.rejectedRunIds.isEmpty)
  guard case .resumed(let receipt) = vm.phase else {
    Issue.record("expected .resumed approve receipt, got \(String(describing: vm.phase))")
    return
  }
  let result = ResumeRelayResult(
    runId: receipt.runId,
    op: receipt.op,
    accepted: receipt.accepted,
    status: receipt.status,
    auditRef: receipt.auditRef)
  try assertApprovedResume(result: result, expectedRunId: runId, label: "fridayChat")
  try appendMobileFridayChatApproveEvidenceIfRequested(result: result, approvalId: approvalId)
}

private final class FridayChatLiveApproveHarnessWriteClient: FridayRustWriteClient, @unchecked Sendable {
  let pending: PausedOutcome
  let liveClient: FridayRustWriteClient

  private(set) var dispatchedTasks: [String] = []
  private(set) var resumedRunIds: [String] = []
  private(set) var relabeledBlob: [UInt8] = []
  private(set) var rejectedRunIds: [String] = []

  init(pending: PausedOutcome, liveClient: FridayRustWriteClient) {
    self.pending = pending
    self.liveClient = liveClient
  }

  func dispatchAgentRun(task: String, constraints: AgentRunConstraintsWire?) async throws -> AgentRunDispatchOutcome {
    dispatchedTasks.append(task)
    return .paused(pending)
  }

  func resumeWithApproval(runId: String, opaqueSignedBlob: [UInt8]) async throws -> ResumeRelayResult {
    resumedRunIds.append(runId)
    relabeledBlob = opaqueSignedBlob
    return try await liveClient.resumeWithApproval(runId: runId, opaqueSignedBlob: opaqueSignedBlob)
  }

  func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
    rejectedRunIds.append(runId)
    throw FridayWriteClientError.transport("test harness must not reject")
  }

  func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
    throw FridayWriteClientError.transport("test harness must not cancel")
  }
}

private struct FileBackedOperatorSigner: OperatorSigner {
  let signedApproval: [UInt8]

  func signApproval(_ request: ApprovalSigningRequest) async throws -> [UInt8] {
    signedApproval
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

private func requiredMobileApprovalApproveEnv(_ key: String, env: [String: String]) throws -> String {
  guard let value = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    throw FridayWriteClientError.transport("missing required env \(key)")
  }
  return value
}

private func readSignedApprovalBytes(fromEnv key: String, env: [String: String]) throws -> [UInt8] {
  let path = try requiredMobileApprovalApproveEnv(key, env: env)
  let data = try Data(contentsOf: URL(fileURLWithPath: path))
  guard !data.isEmpty else {
    throw FridayWriteClientError.emptySignedBlob
  }
  return Array(data)
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
  writeConfig: AgentRunServerConfig
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_APPROVAL_APPROVE_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }

  let proof: [String: Any] = [
    "truth_label": "ios_mobile_live_approval_approve_operator_signed_resume_proof_not_sim_tap_not_endbar",
    "status": "pass",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "direct_resume": [
      "op": result.op,
      "accepted": result.accepted,
      "status": result.status,
      "run_id": result.runId,
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
        "status": "pass",
        "evidence_ref": "proof://mobile/approval-approve/\(result.runId)",
        "truth_label": "explicit_mobile_approval_approve_runtime_evidence_from_operator_signed_live_swift_write_client",
      ],
    ],
    "caveat": "Mobile Swift write-client approve proof only; not a simulator tap, not END-BAR, not GO-LIVE, not operator key custody.",
  ]

  let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  let url = URL(fileURLWithPath: rawPath)
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true)
  try data.write(to: url, options: .atomic)
  print("[live-mobile-approval-approve] proofOut=\(url.path)")
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
    "status": "pass",
    "evidence_ref": "proof://mobile/fridaychat-approval-approve/\(result.runId)",
    "truth_label": "explicit_mobile_fridaychat_approve_runtime_evidence_from_view_model_delegating_operator_signed_blob_to_live_swift_write_client",
  ])
  proof["ui_actions"] = actions
  proof["friday_chat_resume"] = [
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
