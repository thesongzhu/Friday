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
