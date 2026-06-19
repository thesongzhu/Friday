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
