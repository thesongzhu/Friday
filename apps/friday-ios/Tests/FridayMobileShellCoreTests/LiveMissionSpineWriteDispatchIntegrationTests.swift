import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE mission-spine write dispatch integration (MANUAL / env-gated)
//
// Drives the real iOS shared write transport against the live agent-run WRITE server on
// 127.0.0.1:48750 as the enrolled master-derived peer. This sends a single Mission intake and
// expects a refs-only server receipt.
//
// HONEST CEILING: this is an agent-driven live product-surface write proof. It is not OG9 organic
// origin, not a provider/model turn, not a completed_with_proof claim, and not A1 live-done.

private let liveMissionSpineWriteDispatchEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_WRITE_DISPATCH_TEST"] == "1"

@Test(.enabled(if: liveMissionSpineWriteDispatchEnabled))
func liveMobileMissionSpineWriteDispatchReturnsReadyReceipt() async throws {
  let keypair = try MasterKeyPeer.deriveKeypair()
  let client = SealedWSWriteClient(
    keypair: keypair,
    forwardedPrincipal: liveAgentRunOwnerPrincipal,
    makeTransport: {
      try LoopbackSealedWSTransport(config: ReadProjectionServerConfig(
        host: AgentRunServerConfig.liveLoopback.host,
        port: AgentRunServerConfig.liveLoopback.port,
        connectTimeout: AgentRunServerConfig.liveLoopback.connectTimeout))
    })
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

private func makeLiveMobileIntake() -> MissionIntakeRequestWire {
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
    title: "Verify live mobile mission-spine write receipt",
    intent: "create a workflow that triggers every morning at 9am, reads the Friday live mobile "
      + "write receipt, and posts a refs-only status summary to the operator console as its "
      + "output destination",
    lane: "deepseek",
    targetProviderOrAgent: "deepseek")
}
