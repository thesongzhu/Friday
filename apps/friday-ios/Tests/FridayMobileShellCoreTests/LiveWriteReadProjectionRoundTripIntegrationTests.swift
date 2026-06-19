import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

// MARK: - LIVE write -> read-projection round-trip (MANUAL / env-gated)
//
// Narrow opt-in proof for the mobile client gap: a successful live Mission intake WRITE receipt
// must become visible through the live READ projection for that exact Mission/WorkItem. CI defaults
// to skipped; running this requires both live Rust servers and the enrolled master-derived peer.
//
// Run locally:
//   FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_TEST=1 swift test \
//     --package-path apps/friday-ios \
//     --filter LiveWriteReadProjectionRoundTrip

private let liveWriteReadRoundTripEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_TEST"] == "1"

@Test(.enabled(if: liveWriteReadRoundTripEnabled))
func liveMobileMissionWriteAppearsInReadProjection() async throws {
  let writeClient = try RealWriteClientFactory.makeLive()
  let request = makeMobileRoundTripIntake()

  let result = try await writeClient.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == request.workItemId)

  let readClient = try RealReadClientFactory.makeLive(missionId: result.missionId)
  let snapshot = try await pollReadProjection(
    client: readClient,
    missionId: result.missionId,
    workItemId: try #require(result.workItemId))

  print(
    "[live-write-read][mobile] missionId=\(snapshot.missionId) "
      + "workItemIds=\(snapshot.workItemIds) generatedAtMs=\(snapshot.generatedAtMs)")
  #expect(snapshot.missionId == result.missionId)
  #expect(snapshot.workItemIds.contains(request.workItemId))
}

private func makeMobileRoundTripIntake() -> MissionIntakeRequestWire {
  let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
  return MissionIntakeRequestWire(
    fridayConversationId: "fconv_mobile_live_roundtrip_\(id)",
    ownerPrincipal: liveAgentRunOwnerPrincipal,
    surfaceThreadId: "surface-mobile-live-roundtrip-\(id)",
    surfaceKind: "mobile",
    deliveryRoute: "ios://friday-mobile/live-write-read-roundtrip/\(id)",
    visibilityPolicy: "compact",
    missionId: "mission-mobile-live-roundtrip-\(id)",
    workItemId: "work-mobile-live-roundtrip-\(id)",
    title: "Verify live mobile write appears in read projection",
    intent: "Create a refs-only live mobile round-trip proof item and expose it through the "
      + "Mission Workbench read projection.",
    lane: "deepseek",
    targetProviderOrAgent: "deepseek")
}

private func pollReadProjection(
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
