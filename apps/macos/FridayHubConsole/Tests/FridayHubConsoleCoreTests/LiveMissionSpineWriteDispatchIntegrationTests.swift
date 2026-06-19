import Foundation
import Testing

@testable import FridayHubConsoleCore
@testable import FridayRustClient

// MARK: - LIVE mission-spine write dispatch integration (MANUAL / env-gated)
//
// Drives the real Console product write path (`RealWriteClientFactory.makeLiveWrite`) against the
// live agent-run WRITE server on 127.0.0.1:48750 as the enrolled master-derived peer. This sends a
// single Mission intake and expects a refs-only server receipt. A stricter opt-in test also
// dispatches the returned Mission/WorkItem handle as a read-only mission-bound model turn.
//
// HONEST CEILING: these are agent-driven live product-surface proofs. They are not OG9 organic
// origin and not A1 live-done.

private let liveMissionSpineWriteDispatchEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_WRITE_DISPATCH_TEST"] == "1"
private let liveMissionBoundRunEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_MISSION_BOUND_RUN_TEST"] == "1"
private let liveStrengthRouteEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_STRENGTH_ROUTE_TEST"] == "1"
private let liveStrengthRouteRunEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_STRENGTH_ROUTE_RUN_TEST"] == "1"
private let liveHybridFollowUpRunEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_HYBRID_FOLLOWUP_RUN_TEST"] == "1"

@Test(.enabled(if: liveMissionSpineWriteDispatchEnabled))
func liveConsoleMissionSpineWriteDispatchReturnsReadyReceipt() async throws {
  let client = try RealWriteClientFactory.makeLiveWrite()
  let request = makeLiveIntake(surface: "desktop", route: "desktop://hub-console/live-write-dispatch")

  let result = try await client.submitMissionIntake(request)

  print(
    "[live-write-dispatch][desktop] status=\(result.status) "
      + "missionId=\(result.missionId) workItemId=\(result.workItemId ?? "<nil>") "
      + "surfaceThreadId=\(result.surfaceThreadId) createdOrReady=\(result.createdOrReady)")

  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == request.workItemId)
  #expect(result.surfaceThreadId == request.surfaceThreadId)
}

@Test(.enabled(if: liveMissionBoundRunEnabled))
func liveConsoleMissionSpineWriteDispatchClarifiesVagueCodexRepairAtIntake() async throws {
  let client = try RealWriteClientFactory.makeLiveWrite()
  let request = makeLiveIntake(
    surface: "desktop",
    route: "desktop://hub-console/live-vague-repair-intake-clarification",
    title: "Verify live desktop vague Codex repair clarifies at intake",
    intent: "Fix a small Rust compile failure in a workspace and describe the focused regression test that should be added.",
    lane: "auto",
    targetProviderOrAgent: nil)

  let result = try await client.submitMissionIntake(request)
  print(
    "[live-write-dispatch][desktop-vague-repair] status=\(result.status) "
      + "missionId=\(result.missionId) workItemId=\(result.workItemId ?? "<nil>") "
      + "questions=\(result.clarificationQuestions.count)")
  #expect(result.status == "needs_clarification")
  #expect(!result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == nil)
  #expect(result.surfaceThreadId == request.surfaceThreadId)
  #expect(!result.clarificationQuestions.isEmpty)
}

@Test(.enabled(if: liveMissionBoundRunEnabled))
func liveConsoleMissionSpineWriteDispatchCanCompleteClearCodexRun() async throws {
  let client = try RealWriteClientFactory.makeLiveWrite()
  let request = makeLiveIntake(
    surface: "desktop",
    route: "desktop://hub-console/live-clear-codex-bound-run",
    title: "Verify live desktop clear Codex mission-bound run",
    intent: "Answer exactly FRIDAY_DESKTOP_CODEX_CLEAR_OK.",
    lane: "codex",
    targetProviderOrAgent: "codex")

  let result = try await client.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.workItemId == request.workItemId)

  let outcome = try await client.dispatchMissionBoundAgentRun(
    task: request.intent,
    missionContext: MissionWorkItemContextWire(
      fridayConversationId: result.fridayConversationId,
      missionId: result.missionId,
      workItemId: try #require(result.workItemId)),
    constraints: AgentRunConstraintsWire(readOnly: true))

  guard case .result(let receipt) = outcome else {
    Issue.record("expected clear Codex mission-bound read-only run to settle with a result")
    return
  }
  print(
    "[live-write-dispatch][desktop-clear-codex] runId=\(receipt.runId) "
      + "status=\(receipt.status) turns=\(receipt.turns ?? 0) "
      + "answerLen=\(receipt.answerLen ?? 0)")
  #expect(receipt.status == "completed" || receipt.status == "finished" || receipt.status == "ok")
  #expect((receipt.turns ?? 0) > 0)
  #expect(receipt.executedTools == 0)
  #expect(receipt.answerSha256 != nil)
  #expect((receipt.answerLen ?? 0) > 0)
}

@Test(.enabled(if: liveStrengthRouteEnabled))
func liveConsoleMissionSpineWriteDispatchRecordsHybridStrengthRouteDecision() async throws {
  let writeClient = try RealWriteClientFactory.makeLiveWrite()
  let request = makeLiveIntake(
    surface: "desktop",
    route: "desktop://hub-console/live-strength-route-hybrid",
    title: "Verify live desktop hybrid auto route decision",
    intent: "In the FridayHubConsole package, update LiveMissionSpineWriteDispatchIntegrationTests.swift "
      + "with a regression test for hybrid auto routing, then summarize the tradeoffs between "
      + "Codex workspace execution and Claude synthesis follow-up.",
    lane: "auto",
    targetProviderOrAgent: nil)

  let result = try await writeClient.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == request.workItemId)

  let readClient = try RealReadClientFactory.makeLive(missionId: result.missionId)
  let snapshot = try await pollLiveProjection(
    client: readClient,
    missionId: result.missionId,
    workItemId: try #require(result.workItemId))

  let alternatives = snapshot.rawRouteDecisionAlternatives
  print(
    "[live-strength-route][desktop-hybrid] missionId=\(result.missionId) "
      + "workItemId=\(request.workItemId) routeSummary=\(snapshot.routeDecisionSummary ?? "<nil>") "
      + "alternatives=\(alternatives)")

  #expect(snapshot.routeDecisionSummary?.contains("Codex first") == true)
  #expect(alternatives.contains { $0.contains("combination: Codex first") })
  #expect(alternatives.contains { $0.contains("claude: writing") })
}

@Test(.enabled(if: liveStrengthRouteRunEnabled))
func liveConsoleMissionSpineWriteDispatchCanCompleteHybridCodexFirstRun() async throws {
  let client = try RealWriteClientFactory.makeLiveWrite()
  let request = makeLiveIntake(
    surface: "desktop",
    route: "desktop://hub-console/live-strength-route-codex-first",
    title: "Verify live desktop hybrid auto route Codex first run",
    intent: "In the FridayHubConsole test target, identify the live hybrid route test file path, "
      + "then summarize that Claude synthesis follow-up remains deferred. Answer exactly "
      + "FRIDAY_HYBRID_CODEX_FIRST_OK.",
    lane: "auto",
    targetProviderOrAgent: nil)

  let result = try await client.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.workItemId == request.workItemId)

  let snapshot = try await pollLiveProjection(
    client: RealReadClientFactory.makeLive(missionId: result.missionId),
    missionId: result.missionId,
    workItemId: try #require(result.workItemId))
  #expect(snapshot.routeDecisionSummary?.contains("Codex first") == true)
  #expect(snapshot.rawRouteDecisionAlternatives.contains { $0.contains("combination: Codex first") })

  let outcome = try await client.dispatchMissionBoundAgentRun(
    task: request.intent,
    missionContext: MissionWorkItemContextWire(
      fridayConversationId: result.fridayConversationId,
      missionId: result.missionId,
      workItemId: try #require(result.workItemId)),
    constraints: AgentRunConstraintsWire(readOnly: true))

  guard case .result(let receipt) = outcome else {
    Issue.record("expected hybrid Codex-first mission-bound run to settle with a result")
    return
  }
  print(
    "[live-strength-route][desktop-hybrid-codex-first] missionId=\(result.missionId) "
      + "workItemId=\(request.workItemId) runId=\(receipt.runId) status=\(receipt.status) "
      + "turns=\(receipt.turns ?? 0) answerLen=\(receipt.answerLen ?? 0)")
  #expect(receipt.status == "completed" || receipt.status == "finished" || receipt.status == "ok")
  #expect((receipt.turns ?? 0) > 0)
  #expect(receipt.executedTools == 0)
  #expect(receipt.answerSha256 != nil)
  #expect((receipt.answerLen ?? 0) > 0)
}

@Test(.enabled(if: liveHybridFollowUpRunEnabled))
func liveConsoleMissionSpineWriteDispatchCanCompleteHybridCodexThenClaudeFollowUp() async throws {
  let client = try RealWriteClientFactory.makeLiveWrite(config: hybridFollowUpWriteConfig())
  let request = makeLiveIntake(
    surface: "desktop",
    route: "desktop://hub-console/live-strength-route-hybrid-followup",
    title: "Verify live desktop hybrid route Codex then Claude follow-up",
    intent: "In the FridayHubConsole test target, identify the live hybrid route test file path, "
      + "then summarize that Claude synthesis follow-up should run after the Codex first leg. "
      + "Answer exactly FRIDAY_HYBRID_CODEX_FIRST_FOR_CLAUDE_OK.",
    lane: "auto",
    targetProviderOrAgent: nil)

  let result = try await client.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.workItemId == request.workItemId)

  let sourceWorkItemId = try #require(result.workItemId)
  let firstSnapshot = try await pollLiveProjection(
    client: RealReadClientFactory.makeLive(missionId: result.missionId),
    missionId: result.missionId,
    workItemId: sourceWorkItemId)
  #expect(firstSnapshot.routeDecisionSummary?.contains("Codex first") == true)
  #expect(firstSnapshot.rawRouteDecisionAlternatives.contains { $0.contains("combination: Codex first") })

  let firstOutcome = try await client.dispatchMissionBoundAgentRun(
    task: request.intent,
    missionContext: MissionWorkItemContextWire(
      fridayConversationId: result.fridayConversationId,
      missionId: result.missionId,
      workItemId: sourceWorkItemId),
    constraints: AgentRunConstraintsWire(readOnly: true))

  guard case .result(let firstReceipt) = firstOutcome else {
    Issue.record("expected hybrid Codex-first mission-bound run to settle with a result")
    return
  }
  #expect(firstReceipt.status == "completed" || firstReceipt.status == "finished" || firstReceipt.status == "ok")
  #expect((firstReceipt.turns ?? 0) > 0)
  #expect(firstReceipt.answerSha256 != nil)
  #expect((firstReceipt.answerLen ?? 0) > 0)

  let followUpWorkItemId = "\(sourceWorkItemId)-claude-followup"
  _ = try await pollLiveProjection(
    client: RealReadClientFactory.makeLive(missionId: result.missionId),
    missionId: result.missionId,
    workItemId: followUpWorkItemId)

  let followUpOutcome = try await client.dispatchMissionBoundAgentRun(
    task: "Read the completed Codex first-leg evidence already linked to this mission, summarize "
      + "the follow-up in one sentence, and answer exactly FRIDAY_HYBRID_CLAUDE_FOLLOWUP_OK.",
    missionContext: MissionWorkItemContextWire(
      fridayConversationId: result.fridayConversationId,
      missionId: result.missionId,
      workItemId: followUpWorkItemId),
    constraints: AgentRunConstraintsWire(readOnly: true))

  guard case .result(let followUpReceipt) = followUpOutcome else {
    Issue.record("expected hybrid Claude follow-up mission-bound run to settle with a result")
    return
  }
  print(
    "[live-strength-route][desktop-hybrid-followup] missionId=\(result.missionId) "
      + "sourceWorkItemId=\(sourceWorkItemId) followUpWorkItemId=\(followUpWorkItemId) "
      + "firstRunId=\(firstReceipt.runId) followUpRunId=\(followUpReceipt.runId) "
      + "followUpStatus=\(followUpReceipt.status) followUpTurns=\(followUpReceipt.turns ?? 0) "
      + "followUpAnswerLen=\(followUpReceipt.answerLen ?? 0)")
  #expect(
    followUpReceipt.status == "completed" || followUpReceipt.status == "finished"
      || followUpReceipt.status == "ok")
  #expect((followUpReceipt.turns ?? 0) > 0)
  #expect(followUpReceipt.answerSha256 != nil)
  #expect((followUpReceipt.answerLen ?? 0) > 0)
}

private func hybridFollowUpWriteConfig() -> AgentRunWriteServerConfig {
  guard
    let rawPort = ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_HYBRID_FOLLOWUP_WRITE_PORT"],
    let port = UInt16(rawPort)
  else {
    return .liveLoopback
  }
  return AgentRunWriteServerConfig(host: "127.0.0.1", port: port)
}

private func makeLiveIntake(
  surface: String,
  route: String,
  title: String? = nil,
  intent: String? = nil,
  lane: String = "deepseek",
  targetProviderOrAgent: String? = "deepseek"
) -> MissionIntakeRequestWire {
  let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
  return MissionIntakeRequestWire(
    fridayConversationId: "fconv_\(surface)_live_write_\(id)",
    ownerPrincipal: liveReadProjectionOwnerPrincipal,
    surfaceThreadId: "surface-\(surface)-live-write-\(id)",
    surfaceKind: surface,
    deliveryRoute: "\(route)/\(id)",
    visibilityPolicy: "compact",
    missionId: "mission-\(surface)-live-write-\(id)",
    workItemId: "work-\(surface)-live-write-\(id)",
    title: title ?? "Verify live \(surface) mission-spine write receipt",
    intent: intent ?? "create a workflow that triggers every morning at 9am, reads the Friday live "
      + "\(surface) write receipt, and posts a refs-only status summary to the operator console "
      + "as its output destination",
    lane: lane,
    targetProviderOrAgent: targetProviderOrAgent)
}

private func pollLiveProjection(
  client: FridayRustReadClient,
  missionId: String,
  workItemId: String
) async throws -> FridayRustClient.WorkbenchSnapshot {
  let deadline = Date().addingTimeInterval(20)
  var lastError: Error?

  repeat {
    do {
      let snapshot = try await client.fetchWorkbench()
      if snapshot.missionId == missionId && snapshot.workItemIds.contains(workItemId) {
        return snapshot
      }
      lastError = FridayReadClientError.malformedProjection(
        "projection missionId=\(snapshot.missionId) workItemIds=\(snapshot.workItemIds)")
    } catch {
      lastError = error
    }

    try await Task.sleep(for: .seconds(1))
  } while Date() < deadline

  throw try #require(lastError)
}

private extension FridayRustClient.WorkbenchSnapshot {
  var rawRouteDecisionAlternatives: [String] {
    guard let routeDecision = raw["routeDecision"] as? [String: Any] else {
      return []
    }
    return routeDecision["alternatives"] as? [String] ?? []
  }
}
