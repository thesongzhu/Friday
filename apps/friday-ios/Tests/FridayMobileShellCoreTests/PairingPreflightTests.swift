import Foundation
import Testing

@testable import FridayMobileShellCore
@testable import FridayRustClient

private final class InMemoryPairingKeypairBackend: DeviceKeypairBackend, @unchecked Sendable {
  private var secret: [UInt8]?
  private(set) var loadCount = 0
  private(set) var storeCount = 0

  init(seed: [UInt8]? = nil) {
    self.secret = seed
  }

  func loadSecret() throws -> [UInt8]? {
    loadCount += 1
    return secret
  }

  func storeSecret(_ secret: [UInt8]) throws {
    self.secret = secret
    storeCount += 1
  }
}

private final class FakePairingClient: FridayPairingClient, @unchecked Sendable {
  var ack: PairingPairAckWire
  var delayNanoseconds: UInt64
  private(set) var pairedDeviceIds: [String] = []
  private(set) var sawRawSecret = false

  init(ack: PairingPairAckWire, delayNanoseconds: UInt64 = 0) {
    self.ack = ack
    self.delayNanoseconds = delayNanoseconds
  }

  func fetchHubStatus(manifest: FridayPairingManifest) async throws -> PairingHubStatusWire {
    PairingHubStatusWire(
      online: true,
      capabilities: ["pairing"],
      minVersion: manifest.version,
      maxVersion: fridayCurrentSchemaVersion)
  }

  func pairDevice(manifest: FridayPairingManifest, deviceId: String) async throws -> PairingPairAckWire {
    if delayNanoseconds > 0 {
      try await Task.sleep(nanoseconds: delayNanoseconds)
    }
    pairedDeviceIds.append(deviceId)
    sawRawSecret = String(describing: self).contains(manifest.pairingSecret)
    return ack
  }
}

@Test
func pairingPreflightValidQrPreparesDeviceWithoutSurfacingSecret() throws {
  let backend = InMemoryPairingKeypairBackend()
  let pairingSecret = "qr-secret-1234567890" // pragma: allowlist secret

  let preflight = MobilePairingPreflight.evaluate(
    qrPayload: try pairingManifest(pairingSecret: pairingSecret, expiresAt: 1_900_000_000_000),
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(preflight.mode == .ready)
  #expect(preflight.proofReady)
  #expect(preflight.devicePublicKeyHex?.count == 64)
  #expect(preflight.projection?.hubId == "hub-local-1")
  #expect(preflight.projection?.pairingId == "pair-123")
  #expect(!String(describing: preflight).contains(pairingSecret))
  #expect(!String(describing: preflight.projection).contains(pairingSecret))
  #expect(backend.loadCount == 1)
  #expect(backend.storeCount == 1)
}

@Test
func pairingPreflightExpiredQrDoesNotTouchDeviceKeyStore() throws {
  let backend = InMemoryPairingKeypairBackend()

  let preflight = MobilePairingPreflight.evaluate(
    qrPayload: try pairingManifest(expiresAt: 1_700_000_000_000),
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(preflight.mode == .expired)
  #expect(!preflight.proofReady)
  #expect(preflight.devicePublicKeyHex == nil)
  #expect(backend.loadCount == 0)
  #expect(backend.storeCount == 0)
}

@Test
func pairingPreflightInvalidQrDoesNotTouchDeviceKeyStore() {
  let backend = InMemoryPairingKeypairBackend()

  let preflight = MobilePairingPreflight.evaluate(
    qrPayload: #"{"kind":"not.friday"}"#,
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(preflight.mode == .invalid)
  #expect(!preflight.proofReady)
  #expect(preflight.projection == nil)
  #expect(backend.loadCount == 0)
  #expect(backend.storeCount == 0)
}

@Test
func pairingPreflightCorruptDeviceKeyFailsClosedWithRedactedManifest() throws {
  let backend = InMemoryPairingKeypairBackend(seed: [UInt8](repeating: 0x42, count: 16))

  let preflight = MobilePairingPreflight.evaluate(
    qrPayload: try pairingManifest(expiresAt: 1_900_000_000_000),
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(preflight.mode == .deviceKeyUnavailable)
  #expect(!preflight.proofReady)
  #expect(preflight.projection?.pairingId == "pair-123")
  #expect(preflight.devicePublicKeyHex == nil)
  #expect(backend.loadCount == 1)
  #expect(backend.storeCount == 0)
}

@MainActor
@Test
func homeViewModelCarriesPairingPreflightStateAndCanClearIt() async throws {
  let backend = InMemoryPairingKeypairBackend()
  let vm = HomeViewModel(client: HonestlyUnavailableReadClient())

  vm.preflightPairingQR(
    try pairingManifest(expiresAt: 1_900_000_000_000),
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(vm.pairingPreflight.mode == .ready)
  #expect(vm.pairingPreflight.projection?.displayName == "Friday Local Hub")
  try writeFirstLaunchActionEvidenceIfRequested(
    fileSuffix: "scan",
    actionId: "firstlaunch_scan",
    evidenceRef: "swift://mobile/firstlaunch/scan/pair-123",
    proof: [
      "preflight_mode": String(describing: vm.pairingPreflight.mode),
      "proof_ready": vm.pairingPreflight.proofReady,
      "pairing_id": vm.pairingPreflight.projection?.pairingId ?? "",
      "hub_id": vm.pairingPreflight.projection?.hubId ?? "",
    ])

  vm.clearPairingPreflight()

  #expect(vm.pairingPreflight == .empty)
  #expect(vm.pairingAttempt == .idle)
}

@MainActor
@Test
func homeViewModelPairScannedQrDrivesPairAckAcceptedWithoutLeakingSecret() async throws {
  let backend = InMemoryPairingKeypairBackend()
  let fake = FakePairingClient(ack: PairingPairAckWire(accepted: true))
  let vm = HomeViewModel(
    client: HonestlyUnavailableReadClient(),
    makePairingClient: { _ in fake })
  let secret = "qr-secret-accepted-12345" // pragma: allowlist secret

  await vm.pairScannedQR(
    try pairingManifest(pairingSecret: secret, expiresAt: 1_900_000_000_000),
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(vm.pairingPreflight.mode == .ready)
  #expect(vm.pairingAttempt.mode == .accepted)
  #expect(vm.pairingAttempt.pairingId == "pair-123")
  #expect(fake.pairedDeviceIds.count == 1)
  #expect(fake.pairedDeviceIds.first?.hasPrefix("ios-") == true)
  #expect(vm.pairingAttempt.deviceId == fake.pairedDeviceIds.first)
  #expect(!String(describing: vm.pairingPreflight).contains(secret))
  #expect(!String(describing: vm.pairingAttempt).contains(secret))
  #expect(!fake.sawRawSecret)
  try writeFirstLaunchActionEvidenceIfRequested(
    fileSuffix: "pairnow",
    actionId: "firstlaunch_pairnow",
    evidenceRef: "swift://mobile/firstlaunch/pairnow/\(vm.pairingAttempt.deviceId ?? "unknown")",
    proof: [
      "attempt": "accepted",
      "device_id": vm.pairingAttempt.deviceId ?? "",
      "pairing_id": vm.pairingAttempt.pairingId ?? "",
      "hub_id": vm.pairingAttempt.hubId ?? "",
      "raw_secret_leaked": fake.sawRawSecret,
    ])
}

@MainActor
@Test
func homeViewModelPairScannedQrCarriesDeniedPairAckAsTruth() async throws {
  let backend = InMemoryPairingKeypairBackend()
  let fake = FakePairingClient(ack: PairingPairAckWire(accepted: false, errorCode: .pairingDenied))
  let vm = HomeViewModel(
    client: HonestlyUnavailableReadClient(),
    makePairingClient: { _ in fake })

  await vm.pairScannedQR(
    try pairingManifest(expiresAt: 1_900_000_000_000),
    deviceId: "phone-1",
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(vm.pairingPreflight.mode == .ready)
  #expect(vm.pairingAttempt.mode == .denied)
  #expect(vm.pairingAttempt.errorCode == "PAIRING_DENIED")
  #expect(vm.pairingAttempt.deviceId == "phone-1")
  #expect(fake.pairedDeviceIds == ["phone-1"])
}

@MainActor
@Test
func homeViewModelPairScannedQrFailsClosedWhenPairingChannelNotConfigured() async throws {
  let backend = InMemoryPairingKeypairBackend()
  let vm = HomeViewModel(client: HonestlyUnavailableReadClient())

  await vm.pairScannedQR(
    try pairingManifest(expiresAt: 1_900_000_000_000),
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(vm.pairingPreflight.mode == .ready)
  #expect(vm.pairingAttempt.mode == .unavailable)
  #expect(vm.pairingAttempt.reason == "Pairing channel is not configured for this launch.")
  #expect(vm.pairingAttempt.deviceId?.hasPrefix("ios-") == true)
}

@MainActor
@Test
func homeViewModelRetryAfterUnavailableRunsPairingFlowAgain() async throws {
  let backend = InMemoryPairingKeypairBackend()
  var fake: FakePairingClient?
  let vm = HomeViewModel(
    client: HonestlyUnavailableReadClient(),
    makePairingClient: { _ in fake })
  let payload = try pairingManifest(expiresAt: 1_900_000_000_000)

  await vm.pairScannedQR(
    payload,
    deviceId: "phone-retry",
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(vm.pairingAttempt.mode == .unavailable)
  #expect(vm.pairingAttempt.deviceId == "phone-retry")

  let retryClient = FakePairingClient(ack: PairingPairAckWire(accepted: true))
  fake = retryClient
  await vm.pairScannedQR(
    payload,
    deviceId: "phone-retry",
    nowMs: 1_780_640_000_000,
    backend: backend)

  #expect(vm.pairingAttempt.mode == .accepted)
  #expect(vm.pairingAttempt.deviceId == "phone-retry")
  #expect(retryClient.pairedDeviceIds == ["phone-retry"])
  try writeFirstLaunchActionEvidenceIfRequested(
    fileSuffix: "retry",
    actionId: "firstlaunch_retry",
    evidenceRef: "swift://mobile/firstlaunch/retry/phone-retry",
    proof: [
      "first_attempt": "unavailable",
      "retry_attempt": "accepted",
      "device_id": "phone-retry",
      "pairing_id": vm.pairingAttempt.pairingId ?? "",
    ])
}

@MainActor
@Test
func homeViewModelCancelPairingAttemptPreventsLatePairAckFromWinning() async throws {
  let backend = InMemoryPairingKeypairBackend()
  let fake = FakePairingClient(
    ack: PairingPairAckWire(accepted: true),
    delayNanoseconds: 200_000_000)
  let vm = HomeViewModel(
    client: HonestlyUnavailableReadClient(),
    makePairingClient: { _ in fake })
  let payload = try pairingManifest(expiresAt: 1_900_000_000_000)

  let task = Task {
    await vm.pairScannedQR(
      payload,
      deviceId: "phone-cancel",
      nowMs: 1_780_640_000_000,
      backend: backend)
  }
  while vm.pairingAttempt.mode != .sending {
    try await Task.sleep(nanoseconds: 1_000_000)
  }

  vm.cancelPairingAttempt()
  task.cancel()
  await task.value

  #expect(vm.pairingAttempt.mode == .cancelled)
  #expect(vm.pairingAttempt.deviceId == "phone-cancel")
  #expect(fake.pairedDeviceIds.isEmpty)
  try writeFirstLaunchActionEvidenceIfRequested(
    fileSuffix: "cancel",
    actionId: "firstlaunch_cancel",
    evidenceRef: "swift://mobile/firstlaunch/cancel/phone-cancel",
    proof: [
      "attempt": "cancelled",
      "late_pairack_won": false,
      "device_id": "phone-cancel",
      "pairing_id": vm.pairingAttempt.pairingId ?? "",
    ])
}

@Test
func pairingServerConfigAllowsLoopbackAndPrivateLanOnly() throws {
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://127.0.0.1:49152")).host == "127.0.0.1")
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://localhost:49152")).host == "127.0.0.1")
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://10.0.0.8:49152")).host == "10.0.0.8")
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://172.16.2.8:49152")).host == "172.16.2.8")
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://172.31.2.8:49152")).host == "172.31.2.8")
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://192.168.1.8:49152")).host == "192.168.1.8")
  #expect(try PairingServerConfig(manifest: manifest(endpoint: "ws://169.254.1.8:49152")).host == "169.254.1.8")

  #expect(throws: PairingServerConfigError.self) {
    try PairingServerConfig(manifest: manifest(endpoint: "ws://8.8.8.8:49152"))
  }
  #expect(throws: PairingServerConfigError.self) {
    try PairingServerConfig(manifest: manifest(endpoint: "ws://172.32.2.8:49152"))
  }
  #expect(throws: PairingServerConfigError.self) {
    try PairingServerConfig(manifest: manifest(endpoint: "ws://friday.example.com:49152"))
  }
  #expect(throws: PairingServerConfigError.missingPort("ws://127.0.0.1")) {
    try PairingServerConfig(manifest: manifest(endpoint: "ws://127.0.0.1"))
  }
  #expect(throws: PairingServerConfigError.missingPort("ws://127.0.0.1:0")) {
    try PairingServerConfig(manifest: manifest(endpoint: "ws://127.0.0.1:0"))
  }
}

private func writeFirstLaunchActionEvidenceIfRequested(
  fileSuffix: String,
  actionId: String,
  evidenceRef: String,
  proof: [String: Any]
) throws {
  guard let rawDir = ProcessInfo.processInfo.environment[
    "FRIDAY_MOBILE_FIRSTLAUNCH_ACTION_EVIDENCE_DIR"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawDir.isEmpty else {
    return
  }

  let payload: [String: Any] = [
    "truth": "mobile_firstlaunch_pairing_action_swift_viewmodel_runtime_not_live_hub_not_endbar",
    "status": "ready",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "proof": proof,
    "actions": [
      [
        "surface": "mobile",
        "screen": "firstLaunch",
        "action_id": actionId,
        "capability_id": "trust_center_pairing_connected_devices",
        "status": "pass",
        "evidence_ref": evidenceRef,
        "source": "ios_home_viewmodel_firstlaunch_pairing_action_runtime",
        "truth_label": "swift_viewmodel_pairing_action_runtime_not_live_hub_not_sim_tap",
      ],
    ],
    "caveat": "Partial runtime evidence only: Swift product ViewModel and Home wiring cover firstLaunch Retry/Cancel semantics. This is not a real simulator tap, not a live Hub PairAck proof, not END-BAR, and not adoption.",
  ]

  let dir = URL(fileURLWithPath: rawDir)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let out = dir.appendingPathComponent("mobile-firstlaunch-\(fileSuffix)-action-evidence.json")
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: out, options: .atomic)
  print("[mobile-firstlaunch-action-evidence] proofOut=\(out.path)")
}

private func pairingManifest(
  pairingSecret: String = "qr-secret-1234567890", // pragma: allowlist secret
  expiresAt: Int64
) throws -> String {
  try manifestJSON(endpoint: "ws://127.0.0.1:49152", pairingSecret: pairingSecret, expiresAt: expiresAt)
}

private func manifest(
  endpoint: String,
  pairingSecret: String = "qr-secret-1234567890", // pragma: allowlist secret
  expiresAt: Int64 = 1_900_000_000_000
) throws -> FridayPairingManifest {
  try JSONDecoder().decode(FridayPairingManifest.self, from: Data(manifestJSON(
    endpoint: endpoint,
    pairingSecret: pairingSecret,
    expiresAt: expiresAt).utf8))
}

private func manifestJSON(
  endpoint: String,
  pairingSecret: String,
  expiresAt: Int64
) throws -> String {
  let hub = try FridayCrypto.DeviceKeypair(secretBytes: try Hex.decode(TestKeys.serverSecret))
  return """
    {
      "kind": "friday.pairing.qr.v1",
      "aad": "friday:pairing:ws:j1:qr-pair-session:aad:v1",
      "hub_public_key_hex": "\(Hex.encode(hub.publicKey))",
      "v": 1,
      "hub_id": "hub-local-1",
      "pairing_id": "pair-123",
      "pairing_secret": "\(pairingSecret)",
      "display_name": "Friday Local Hub",
      "transport_hints": [
        {"kind": "websocket", "endpoint": "\(endpoint)", "label": "Local pairing"}
      ],
      "expires_at": \(expiresAt),
      "capabilities_hint": ["pairing", "read_seam_enroll"]
    }
    """
}
