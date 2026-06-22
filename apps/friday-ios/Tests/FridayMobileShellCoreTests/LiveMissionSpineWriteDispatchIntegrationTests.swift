import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE mission-spine write dispatch integration (MANUAL / env-gated)
//
// Drives the real iOS shared write transport against the live agent-run WRITE server on
// 127.0.0.1:48750 as the enrolled master-derived peer. This sends a single Mission intake and
// expects a refs-only server receipt. A stricter opt-in test also dispatches the returned
// Mission/WorkItem handle as a read-only mission-bound model turn.
//
// HONEST CEILING: these are agent-driven live product-surface proofs. They are not OG9 organic
// origin and not A1 live-done.

private let liveMissionSpineWriteDispatchEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_WRITE_DISPATCH_TEST"] == "1"
private let liveMissionBoundRunEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_MISSION_BOUND_RUN_TEST"] == "1"
private let liveProductAutoFollowUpRunEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_RUN_TEST"] == "1"

@Test(.enabled(if: liveMissionSpineWriteDispatchEnabled))
func liveMobileMissionSpineWriteDispatchReturnsReadyReceipt() async throws {
  let client = try RealWriteClientFactory.makeLive()
  let request = makeLiveMobileIntake()

  let result = try await client.submitMissionIntake(request)

  print(
    "[live-write-dispatch][mobile] status=\(result.status) "
      + "missionId=\(result.missionId) workItemId=\(result.workItemId ?? "<nil>") "
      + "surfaceThreadId=\(result.surfaceThreadId) createdOrReady=\(result.createdOrReady)")

  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == request.workItemId)
  #expect(result.surfaceThreadId == request.surfaceThreadId)
}

@Test(.enabled(if: liveMissionBoundRunEnabled))
func liveMobileMissionSpineWriteDispatchCanStartMissionBoundRun() async throws {
  let client = try RealWriteClientFactory.makeLive()
  let request = makeLiveMobileIntake(
    title: "Verify live mobile auto-route mission-bound Claude run",
    intent: "写一份调研综述，总结 Friday 这个方案的利弊和下一步计划。",
    lane: "auto",
    targetProviderOrAgent: nil)

  let result = try await client.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.workItemId == request.workItemId)

  let outcome = try await client.dispatchMissionBoundAgentRun(
    task: request.intent,
    missionContext: MissionWorkItemContextWire(
      fridayConversationId: result.fridayConversationId,
      missionId: result.missionId,
      workItemId: try #require(result.workItemId)),
    constraints: AgentRunConstraintsWire(readOnly: true))

  guard case .result(let receipt) = outcome else {
    Issue.record("expected mission-bound read-only run to settle with a result")
    return
  }
  print(
    "[live-write-dispatch][mobile-bound] runId=\(receipt.runId) "
      + "status=\(receipt.status) turns=\(receipt.turns ?? 0)")
  #expect(receipt.status == "completed" || receipt.status == "finished" || receipt.status == "ok")
}

@Test(.enabled(if: liveProductAutoFollowUpRunEnabled))
@MainActor
func liveMobileChatSendAutoDispatchesHybridClaudeFollowUp() async throws {
  let id = "liveauto\(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: ""))"
  let writeClient = try RealWriteClientFactory.makeLive(config: mobileProductAutoFollowUpWriteConfig())
  let readClient = try RealReadClientFactory.makeLive(missionId: "mission-mobile-\(id)")
  let vm = FridayChatViewModel(
    writeClient: writeClient,
    signer: MockOperatorSigner(),
    missionClient: writeClient,
    readClient: readClient,
    newId: { id })

  await vm.send(
    "In the Friday mobile shell test target, identify the mobile live mission-spine test file path, "
      + "then summarize that the iOS Chat product path should automatically run the generated Claude "
      + "follow-up after the Codex first leg. Answer exactly FRIDAY_MOBILE_PRODUCT_AUTO_FOLLOWUP_OK.")

  guard case .answered(let receipt) = vm.phase else {
    Issue.record("expected mobile product auto follow-up to answer, got \(String(describing: vm.phase))")
    return
  }

  print(
    "[live-mobile-product-auto-followup] id=\(id) firstRunId=\(receipt.runId) "
      + "missionId=\(receipt.missionId ?? "<nil>") workItemId=\(receipt.workItemId ?? "<nil>") "
      + "followUpWorkItemId=\(receipt.followUpWorkItemId ?? "<nil>") "
      + "followUpRunId=\(receipt.followUpRunId ?? "<nil>")")
  #expect(receipt.missionId == "mission-mobile-\(id)")
  #expect(receipt.workItemId == "work-mobile-\(id)")
  #expect(receipt.followUpWorkItemId == "work-mobile-\(id)-claude-followup")
  #expect(receipt.followUpRunId != nil)
  #expect(receipt.answerBodyRunId == receipt.followUpRunId)
  #expect(receipt.answerBodyOutcome == "delivered")
  #expect(receipt.answerBody?.contains("FRIDAY_MOBILE_PRODUCT_AUTO_FOLLOWUP_OK") == true)

  let learningRows = try await pollLiveRunOutcomeLearningCandidates(
    client: readClient,
    runIds: Set([receipt.runId, try #require(receipt.followUpRunId)]))
  let projectedRunIds = Set(learningRows.compactMap { $0["runId"] as? String })
  #expect(projectedRunIds.contains(receipt.runId))
  #expect(projectedRunIds.contains(try #require(receipt.followUpRunId)))
  #expect(learningRows.allSatisfy { ($0["state"] as? String) == "pending" })
  #expect(learningRows.allSatisfy {
    (($0["evidenceRef"] as? String)?.hasPrefix("proof://run-outcome-learning-candidate/")) == true
  })
}

private func pollLiveRunOutcomeLearningCandidates(
  client: FridayRustReadClient,
  runIds: Set<String>
) async throws -> [[String: Any]] {
  let deadline = Date().addingTimeInterval(20)
  var lastRows: [[String: Any]] = []

  repeat {
    let snapshot = try await client.fetchWorkbench()
    let rows = snapshot.raw["runOutcomeLearningCandidates"] as? [[String: Any]] ?? []
    let matched = rows.filter { row in
      guard let runId = row["runId"] as? String else { return false }
      return runIds.contains(runId)
    }
    let matchedRunIds = Set(matched.compactMap { $0["runId"] as? String })
    if runIds.isSubset(of: matchedRunIds) {
      return matched
    }
    lastRows = rows
    try await Task.sleep(for: .seconds(1))
  } while Date() < deadline

  Issue.record("expected live run-outcome learning candidates for \(runIds), got \(lastRows)")
  return []
}

private func mobileProductAutoFollowUpWriteConfig() -> AgentRunServerConfig {
  guard
    let rawPort = ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_PRODUCT_AUTO_FOLLOWUP_WRITE_PORT"],
    let port = UInt16(rawPort)
  else {
    return .liveLoopback
  }
  return AgentRunServerConfig(host: "127.0.0.1", port: port)
}

private func makeLiveMobileIntake(
  title: String = "Verify live mobile mission-spine write receipt",
  intent: String = "create a workflow that triggers every morning at 9am, reads the Friday live mobile "
    + "write receipt, and posts a refs-only status summary to the operator console as its "
    + "output destination",
  lane: String = "deepseek",
  targetProviderOrAgent: String? = "deepseek"
) -> MissionIntakeRequestWire {
  let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
  return MissionIntakeRequestWire(
    fridayConversationId: "fconv_mobile_live_write_\(id)",
    ownerPrincipal: liveAgentRunOwnerPrincipal,
    surfaceThreadId: "surface-mobile-live-write-\(id)",
    surfaceKind: "mobile",
    deliveryRoute: "ios://friday-mobile/live-write-dispatch/\(id)",
    visibilityPolicy: "compact",
    missionId: "mission-mobile-live-write-\(id)",
    workItemId: "work-mobile-live-write-\(id)",
    title: title,
    intent: intent,
    lane: lane,
    targetProviderOrAgent: targetProviderOrAgent)
}
