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
//
// Optional isolated read/write endpoint overrides:
//   FRIDAY_MOBILE_LIVE_WRITE_PORT=48750 \
//   FRIDAY_MOBILE_LIVE_READ_PORT=59151 \
//   FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_TEST=1 swift test ...

private let liveWriteReadRoundTripEnabled =
  ProcessInfo.processInfo.environment["FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_TEST"] == "1"

@Test(.enabled(if: liveWriteReadRoundTripEnabled))
func liveMobileMissionWriteAppearsInReadProjection() async throws {
  let writeConfig = try liveRoundTripWriteConfig()
  let writeClient = try RealWriteClientFactory.makeLive(config: writeConfig)
  let request = makeMobileRoundTripIntake()

  let result = try await writeClient.submitMissionIntake(request)
  #expect(result.status == "ready")
  #expect(result.createdOrReady)
  #expect(result.missionId == request.missionId)
  #expect(result.workItemId == request.workItemId)

  let readConfig = try liveRoundTripReadConfig()
  let readClient = try RealReadClientFactory.makeLive(config: readConfig, missionId: result.missionId)
  let snapshot = try await pollReadProjection(
    client: readClient,
    missionId: result.missionId,
    workItemId: try #require(result.workItemId))

  print(
    "[live-write-read][mobile] missionId=\(snapshot.missionId) "
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

private func liveRoundTripWriteConfig() throws -> AgentRunServerConfig {
  let host = endpointHost(
    envKey: "FRIDAY_MOBILE_LIVE_WRITE_HOST",
    fallback: AgentRunServerConfig.liveLoopback.host)
  let port = try endpointPort(
    envKey: "FRIDAY_MOBILE_LIVE_WRITE_PORT",
    fallback: AgentRunServerConfig.liveLoopback.port,
    label: "write")
  return AgentRunServerConfig(host: host, port: port)
}

private func liveRoundTripReadConfig() throws -> ReadProjectionServerConfig {
  let host = endpointHost(
    envKey: "FRIDAY_MOBILE_LIVE_READ_HOST",
    fallback: ReadProjectionServerConfig.liveLoopback.host)
  let port = try endpointPort(
    envKey: "FRIDAY_MOBILE_LIVE_READ_PORT",
    fallback: ReadProjectionServerConfig.liveLoopback.port,
    label: "read")
  return ReadProjectionServerConfig(host: host, port: port)
}

private func endpointHost(envKey: String, fallback: String) -> String {
  if let value = ProcessInfo.processInfo.environment[envKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
    !value.isEmpty
  {
    return value
  }
  return fallback
}

private func endpointPort(envKey: String, fallback: UInt16, label: String) throws -> UInt16 {
  guard let raw = ProcessInfo.processInfo.environment[envKey]?.trimmingCharacters(in: .whitespacesAndNewlines),
    !raw.isEmpty
  else {
    return fallback
  }
  guard let port = UInt16(raw), port > 0 else {
    throw FridayReadClientError.transport("invalid live \(label) port override \(raw)")
  }
  return port
}

private func makeMobileRoundTripIntake() -> MissionIntakeRequestWire {
  let identity = liveWriteReadMissionIdentity(defaultSurface: "mobile")
  return MissionIntakeRequestWire(
    fridayConversationId: "fconv_mobile_live_roundtrip_\(identity.id)",
    ownerPrincipal: liveAgentRunOwnerPrincipal,
    surfaceThreadId: "surface-mobile-live-roundtrip-\(identity.id)",
    surfaceKind: "mobile",
    deliveryRoute: "ios://friday-mobile/live-write-read-roundtrip/\(identity.id)",
    visibilityPolicy: "compact",
    missionId: identity.missionId,
    workItemId: "work-mobile-live-roundtrip-\(identity.id)",
    title: "Verify live mobile write appears in read projection",
    intent: "Create a refs-only live mobile round-trip proof item and expose it through the "
      + "Mission Workbench read projection.",
    lane: "deepseek",
    targetProviderOrAgent: "deepseek")
}

private struct LiveWriteReadMissionIdentity {
  let id: String
  let missionId: String
}

private func liveWriteReadMissionIdentity(defaultSurface: String) -> LiveWriteReadMissionIdentity {
  let rawSharedId = ProcessInfo.processInfo.environment["FRIDAY_MISSION_SPINE_UI_PROOF_SHARED_ID"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if let rawSharedId, !rawSharedId.isEmpty {
    let id = rawSharedId.hasPrefix("mission_")
      ? String(rawSharedId.dropFirst("mission_".count))
      : rawSharedId
    return LiveWriteReadMissionIdentity(id: id, missionId: "mission_\(id)")
  }

  let id = UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "")
  return LiveWriteReadMissionIdentity(id: id, missionId: "mission-\(defaultSurface)-live-roundtrip-\(id)")
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
  writeConfig: AgentRunServerConfig,
  readConfig: ReadProjectionServerConfig
) throws {
  guard let rawPath = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_LIVE_WRITE_READ_ROUNDTRIP_PROOF_OUT"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawPath.isEmpty else {
    return
  }
  guard let workItemId = result.workItemId else {
    throw FridayReadClientError.malformedProjection("roundtrip proof missing WorkItem id")
  }

  let proof: [String: Any] = [
    "truth_label": "ios_mobile_live_write_read_roundtrip_proof_not_ui_device_proof",
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
    "caveat": "Mobile live write-read artifact only; not END-BAR, not GO-LIVE, not UI/device proof.",
  ]

  let data = try JSONSerialization.data(withJSONObject: proof, options: [.prettyPrinted, .sortedKeys])
  let url = URL(fileURLWithPath: rawPath)
  try FileManager.default.createDirectory(
    at: url.deletingLastPathComponent(),
    withIntermediateDirectories: true)
  try data.write(to: url, options: .atomic)
  print("[live-write-read][mobile] proofOut=\(url.path)")
}
