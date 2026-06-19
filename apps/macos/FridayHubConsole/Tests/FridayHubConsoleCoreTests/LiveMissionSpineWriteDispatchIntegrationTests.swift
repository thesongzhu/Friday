import Foundation
import Testing

@testable import FridayHubConsoleCore
@testable import FridayRustClient

// MARK: - LIVE mission-spine write dispatch integration (MANUAL / env-gated)
//
// Drives the real Console product write path (`RealWriteClientFactory.makeLiveWrite`) against the
// live agent-run WRITE server on 127.0.0.1:48750 as the enrolled master-derived peer. This sends a
// single Mission intake and expects a refs-only server receipt.
//
// HONEST CEILING: this is an agent-driven live product-surface write proof. It is not OG9 organic
// origin, not a provider/model turn, not a completed_with_proof claim, and not A1 live-done.

private let liveMissionSpineWriteDispatchEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_WRITE_DISPATCH_TEST"] == "1"

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

private func makeLiveIntake(surface: String, route: String) -> MissionIntakeRequestWire {
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
    title: "Verify live \(surface) mission-spine write receipt",
    intent: "create a workflow that triggers every morning at 9am, reads the Friday live "
      + "\(surface) write receipt, and posts a refs-only status summary to the operator console "
      + "as its output destination",
    lane: "deepseek",
    targetProviderOrAgent: "deepseek")
}
