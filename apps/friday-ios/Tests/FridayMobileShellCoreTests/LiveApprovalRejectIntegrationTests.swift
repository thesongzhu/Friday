import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE mobile approval reject integration (MANUAL / env-gated)
//
// Drives the real mobile Swift write client against the live agent-run WRITE server. The paused
// approval is created by the governed S6 diagnostic driver; this test proves the mobile product
// write seam can reject that exact pending approval over owner-authed sealed WS without relaying an
// operator signature or executing the paused mutation.
//
// HONEST CEILING: this is mobile Swift write-client runtime evidence paired with existing
// view-model reject unit coverage. It is not a simulator tap, not END-BAR, not release/adoption,
// and not an operator-signed approve.

private let liveMobileApprovalRejectEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_APPROVAL_REJECT_TEST"] == "1"

@MainActor
@Test(.enabled(if: liveMobileApprovalRejectEnabled))
func liveMobileApprovalRejectUsesOwnerAuthedWriteClientWithoutResume() async throws {
  let env = ProcessInfo.processInfo.environment
  let runId = try requiredMobileApprovalRejectEnv("FRIDAY_MOBILE_APPROVAL_REJECT_RUN_ID", env: env)
  let approvalId = try requiredMobileApprovalRejectEnv("FRIDAY_MOBILE_APPROVAL_REJECT_APPROVAL_ID", env: env)
  let writeConfig = try mobileApprovalRejectWriteConfig(env: env)
  let client = try RealWriteClientFactory.makeLive(
    config: writeConfig,
    agentRunControlViaRust: true)

  let result = try await client.rejectApproval(runId: runId, approvalId: approvalId)

  print(
    "[live-mobile-approval-reject] runId=\(result.runId) op=\(result.op) "
      + "accepted=\(result.accepted) status=\(result.status) "
      + "auditRef=\(result.auditRef ?? "<nil>")")

  #expect(result.runId == runId)
  #expect(result.op == "reject")
  #expect(result.accepted)
  #expect(result.status == "rejected" || result.status == "already_rejected")

  try writeMobileApprovalRejectProofIfRequested(
    result: result,
    approvalId: approvalId,
    writeConfig: writeConfig)

  try await proveFridayChatViewModelRejectDelegatesToLiveWriteClientWithoutResume(
    runId: runId,
    approvalId: approvalId,
    actionDigest: env["FRIDAY_MOBILE_APPROVAL_REJECT_ACTION_DIGEST"],
    liveClient: client)
}

private func requiredMobileApprovalRejectEnv(_ key: String, env: [String: String]) throws -> String {
  guard let value = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    throw FridayWriteClientError.transport("missing required env \(key)")
  }
  return value
}

private func mobileApprovalRejectWriteConfig(env: [String: String]) throws -> AgentRunServerConfig {
  let host = env["FRIDAY_MOBILE_APPROVAL_REJECT_WRITE_HOST"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let rawPort = env["FRIDAY_MOBILE_APPROVAL_REJECT_WRITE_PORT"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard let rawPort, !rawPort.isEmpty else {
    return AgentRunServerConfig(
      host: host.flatMap { $0.isEmpty ? nil : $0 } ?? AgentRunServerConfig.liveLoopback.host,
      port: AgentRunServerConfig.liveLoopback.port)
  }
  guard let port = UInt16(rawPort), port > 0 else {
    throw FridayWriteClientError.transport("invalid FRIDAY_MOBILE_APPROVAL_REJECT_WRITE_PORT=\(rawPort)")
  }
  return AgentRunServerConfig(
    host: host.flatMap { $0.isEmpty ? nil : $0 } ?? AgentRunServerConfig.liveLoopback.host,
    port: port)
}

private func writeMobileApprovalRejectProofIfRequested(
  result: ResumeRelayResult,
  approvalId: String,
  writeConfig: AgentRunServerConfig
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_APPROVAL_REJECT_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }

  let proof: [String: Any] = [
    "truth_label": "ios_mobile_live_approval_reject_write_client_proof_not_sim_tap_not_endbar",
    "status": "pass",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "run_id": result.runId,
    "approval_id": approvalId,
    "reject": [
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
        "action_id": "act",
        "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
        "status": "pass",
        "evidence_ref": "proof://mobile/approval-reject/\(result.runId)",
        "truth_label": "explicit_mobile_approval_reject_runtime_evidence_from_live_swift_write_client",
      ],
    ],
      "caveat": "Mobile Swift write-client reject proof only, paired with view-model unit tests; not a simulator tap, not END-BAR, not GO-LIVE, not operator-signed approve.",
  ]

  let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  let url = URL(fileURLWithPath: rawPath)
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true)
  try data.write(to: url, options: .atomic)
  print("[live-mobile-approval-reject] proofOut=\(url.path)")
}

@MainActor
private func proveFridayChatViewModelRejectDelegatesToLiveWriteClientWithoutResume(
  runId: String,
  approvalId: String,
  actionDigest rawActionDigest: String?,
  liveClient: FridayRustWriteClient
) async throws {
  let actionDigest = rawActionDigest?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let client = FridayChatLiveRejectHarnessWriteClient(
    pending: PausedOutcome(
      runId: runId,
      approvalId: approvalId,
      actionDigest: actionDigest.flatMap { $0.isEmpty ? nil : $0 } ?? String(repeating: "0", count: 64),
      ownerSealedSummary: "write_file(mobile-approval-reject-proof.txt)"),
    liveClient: liveClient)
  let vm = FridayChatViewModel(
    writeClient: client,
    signer: MockOperatorSigner(),
    historyStore: LiveApprovalRejectInMemoryHistoryStore())

  await vm.send("reject this already-paused mobile approval")
  guard case .pendingApproval = vm.phase else {
    Issue.record("expected .pendingApproval before reject, got \(String(describing: vm.phase))")
    return
  }

  await vm.reject()

  #expect(client.dispatchedTasks == ["reject this already-paused mobile approval"])
  #expect(client.rejectedRunIds == [runId])
  #expect(client.rejectedApprovalIds == [approvalId])
  #expect(client.resumedRunIds.isEmpty)
  guard case .resumed(let receipt) = vm.phase else {
    Issue.record("expected .resumed reject receipt, got \(String(describing: vm.phase))")
    return
  }
  #expect(receipt.runId == runId)
  #expect(receipt.op == "reject")
  #expect(receipt.accepted)
  #expect(receipt.status == "rejected" || receipt.status == "already_rejected")

  try appendMobileFridayChatRejectEvidenceIfRequested(
    result: ResumeRelayResult(
      runId: receipt.runId,
      op: receipt.op,
      accepted: receipt.accepted,
      status: receipt.status,
      auditRef: receipt.auditRef),
    approvalId: approvalId)
}

private final class FridayChatLiveRejectHarnessWriteClient: FridayRustWriteClient, @unchecked Sendable {
  let pending: PausedOutcome
  let liveClient: FridayRustWriteClient

  private(set) var dispatchedTasks: [String] = []
  private(set) var resumedRunIds: [String] = []
  private(set) var rejectedRunIds: [String] = []
  private(set) var rejectedApprovalIds: [String] = []

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
    throw FridayWriteClientError.transport("test harness must not resume")
  }

  func rejectApproval(runId: String, approvalId: String) async throws -> ResumeRelayResult {
    rejectedRunIds.append(runId)
    rejectedApprovalIds.append(approvalId)
    return try await liveClient.rejectApproval(runId: runId, approvalId: approvalId)
  }

  func cancelRun(runId: String, reason: String?) async throws -> ResumeRelayResult {
    throw FridayWriteClientError.transport("test harness must not cancel")
  }
}

private final class LiveApprovalRejectInMemoryHistoryStore: ChatHistoryStoring, @unchecked Sendable {
  private var items: [ChatHistoryItem] = []

  func load() -> [ChatHistoryItem] {
    items
  }

  func save(_ items: [ChatHistoryItem]) {
    self.items = items
  }
}

private func appendMobileFridayChatRejectEvidenceIfRequested(
  result: ResumeRelayResult,
  approvalId: String
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_APPROVAL_REJECT_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }

  let url = URL(fileURLWithPath: rawPath)
  let original = try Data(contentsOf: url)
  guard var proof = try JSONSerialization.jsonObject(with: original) as? [String: Any] else {
    throw FridayWriteClientError.transport("invalid mobile approval reject proof JSON at \(rawPath)")
  }
  var actions = proof["ui_actions"] as? [[String: Any]] ?? []
  actions.append([
    "surface": "mobile",
    "screen": "fridayChat",
    "action_id": "act",
    "capability_id": "security_approval_bound_principal_gate_cat10_netnew",
    "status": "pass",
    "evidence_ref": "proof://mobile/fridaychat-approval-reject/\(result.runId)",
    "truth_label": "explicit_mobile_fridaychat_reject_runtime_evidence_from_view_model_delegating_to_live_swift_write_client",
  ])
  proof["ui_actions"] = actions
  proof["friday_chat_reject"] = [
    "op": result.op,
    "accepted": result.accepted,
    "status": result.status,
    "run_id": result.runId,
    "approval_id": approvalId,
    "audit_ref": result.auditRef.map { $0 as Any } ?? NSNull(),
  ]
  let updated = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  try updated.write(to: url, options: .atomic)
  print("[live-mobile-fridaychat-approval-reject] appendedProofOut=\(url.path)")
}
