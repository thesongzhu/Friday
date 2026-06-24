import Foundation
import Testing

@testable import FridayHubConsoleCore
@testable import FridayRustClient

// MARK: - LIVE write -> read-projection round-trip (MANUAL / env-gated)
//
// Narrow opt-in proof for the desktop client gap: a successful live Mission intake WRITE receipt
// must become visible through the live READ projection for that exact Mission/WorkItem. CI defaults
// to skipped; running this requires both live Rust servers and the enrolled master-derived peer.
//
// Run locally:
//   FRIDAY_CONSOLE_LIVE_WRITE_READ_ROUNDTRIP_TEST=1 swift test \
//     --package-path apps/macos/FridayHubConsole \
//     --filter LiveWriteReadProjectionRoundTrip

private let liveWriteReadRoundTripEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_CONSOLE_LIVE_WRITE_READ_ROUNDTRIP_TEST"] == "1"

@Test(.enabled(if: liveWriteReadRoundTripEnabled))
func liveDesktopMissionWriteAppearsInReadProjection() async throws {
  let writeConfig = AgentRunWriteServerConfig.liveLoopback
  let writeClient = try RealWriteClientFactory.makeLiveWrite(config: writeConfig)
  let request = makeDesktopRoundTripIntake()

  let result = try await writeClient.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == request.workItemId)

  let readConfig = ReadProjectionServerConfig.liveLoopback
  let readClient = try RealReadClientFactory.makeLive(config: readConfig, missionId: result.missionId)
  let snapshot = try await pollReadProjection(
    client: readClient,
    missionId: result.missionId,
    workItemId: try #require(result.workItemId))

  print(
    "[live-write-read][desktop] missionId=\(snapshot.missionId) "
      + "workItemIds=\(snapshot.workItemIds) generatedAtMs=\(snapshot.generatedAtMs)")
  #expect(snapshot.missionId == result.missionId)
  #expect(snapshot.workItemIds.contains(request.workItemId))

  try writeRoundTripProofIfRequested(
    request: request,
    result: result,
    snapshot: snapshot,
    writeConfig: writeConfig,
    readConfig: readConfig)
}

private func makeDesktopRoundTripIntake() -> MissionIntakeRequestWire {
  let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
  return MissionIntakeRequestWire(
    fridayConversationId: "fconv_desktop_live_roundtrip_\(id)",
    ownerPrincipal: liveReadProjectionOwnerPrincipal,
    surfaceThreadId: "surface-desktop-live-roundtrip-\(id)",
    surfaceKind: "desktop",
    deliveryRoute: "desktop://hub-console/live-write-read-roundtrip/\(id)",
    visibilityPolicy: "compact",
    missionId: "mission-desktop-live-roundtrip-\(id)",
    workItemId: "work-desktop-live-roundtrip-\(id)",
    title: "Verify live desktop write appears in read projection",
    intent: "Create a refs-only live desktop round-trip proof item and expose it through the "
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

private func writeRoundTripProofIfRequested(
  request: MissionIntakeRequestWire,
  result: MissionIntakeResultWire,
  snapshot: FridayRustClient.WorkbenchSnapshot,
  writeConfig: AgentRunWriteServerConfig,
  readConfig: ReadProjectionServerConfig
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_DESKTOP_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }
  guard let workItemId = result.workItemId else {
    throw FridayReadClientError.malformedProjection("desktop roundtrip proof missing WorkItem id")
  }

  let proof: [String: Any] = [
    "truth_label": "macos_desktop_live_write_read_roundtrip_proof_not_ui_device_proof",
    "status": "pass",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "mission_id": result.missionId,
    "work_item_id": workItemId,
    "surface_kind": request.surfaceKind,
    "delivery_route": request.deliveryRoute,
    "write": [
      "status": result.status,
      "created_or_ready": result.createdOrReady,
      "mission_id": result.missionId,
      "work_item_id": workItemId,
      "endpoint": [
        "host": writeConfig.host,
        "port": Int(writeConfig.port),
      ],
    ],
    "read_projection": [
      "mission_id": snapshot.missionId,
      "work_item_ids": snapshot.workItemIds,
      "contains_written_work_item": snapshot.workItemIds.contains(workItemId),
      "generated_at_ms": snapshot.generatedAtMs,
      "endpoint": [
        "host": readConfig.host,
        "port": Int(readConfig.port),
      ],
    ],
    "caveat": "Desktop live write-read artifact only; not END-BAR, not GO-LIVE, not UI/device proof.",
  ]

  let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  let url = URL(fileURLWithPath: rawPath)
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true)
  try data.write(to: url, options: .atomic)
  print("[live-write-read][desktop] proofOut=\(url.path)")
}
