import Foundation
import Testing
@testable import FridayHubConsoleCore

@MainActor
@Test func operatorProvisioningCommandUsesReadOnlyActionHelper() async throws {
  let command = PairingProvisioningViewModel.operatorProvisioningCommand(repoRoot: "/repo")

  #expect(command.contains("cd /repo"))
  #expect(command.contains("node scripts/ops/friday-t3-provisioning-status.mjs --operator-action"))
  #expect(!command.contains("FRIDAY_T3_OPERATOR_PROVISION_ACK=operator-runs-t3-provisioning")) // pragma: allowlist secret
  #expect(!command.contains("scripts/ops/friday-t3-operator-provision.sh"))
  #expect(!command.contains("<grant-id>"))
  #expect(!command.contains("FRIDAY_T3_ITEMS_JSON"))
  #expect(!command.contains("<<"))
  #expect(!command.contains("operator-approve.key"))
  #expect(!command.contains("operator-signer.key"))
}

@MainActor
@Test func provisioningStepsExplainQrPairackAndOperatorCeremonyWithoutClaimingReady() async throws {
  let secret = "friday-pairing-step-secret" // pragma: allowlist secret
  let payload = pairingManifestJSON(secret: secret, expiresAt: 1_900_000_000_000)
  let vm = PairingProvisioningViewModel()

  #expect(vm.provisioningSteps.map(\.id) == [
    "qr-session", "pairack", "operator-ceremony", "verify-projection",
  ])
  #expect(vm.provisioningSteps.first?.satisfied == false)

  vm.load(qrJSON: payload, nowMs: 1_780_000_000_000)

  #expect(vm.provisioningSteps.first?.status == "ready")
  #expect(vm.provisioningSteps.first?.satisfied == true)
  #expect(vm.provisioningSteps[1].status == "waiting for phone")
  #expect(vm.provisioningSteps[1].detail.contains("does not insert device rows"))
  #expect(vm.provisioningSteps[2].status == "operator CLI only")
  #expect(vm.provisioningSteps[2].detail.contains("no-heredoc operator command"))
  #expect(vm.provisioningSteps[2].satisfied == false)
  #expect(vm.provisioningSteps[3].detail.contains("active trust_grant"))
  #expect(!vm.provisioningSteps.map(\.detail).joined(separator: "\n").contains(secret))
}

@MainActor
@Test func pairingProvisioningAcceptsValidManifestWithoutDisplayingSecret() async throws {
  let secret = "friday-pairing-secret-for-test" // pragma: allowlist secret
  let payload = pairingManifestJSON(secret: secret, expiresAt: 1_900_000_000_000)
  let vm = PairingProvisioningViewModel()

  vm.load(qrJSON: payload, nowMs: 1_780_000_000_000)

  #expect(vm.state.mode == .ready)
  #expect(vm.state.projection?.hubId == "hub-test")
  #expect(vm.qrPayload.contains(secret))
  #expect(!vm.redactedSummary.contains(secret))
  #expect(!vm.state.description.contains(secret))
  #expect(vm.state.manifestPath == nil)
  #expect(vm.canRenderQRCode)
}

@MainActor
@Test func pairingProvisioningRejectsExpiredManifestAndClearsPayload() async throws {
  let secret = "friday-pairing-expired-secret" // pragma: allowlist secret
  let payload = pairingManifestJSON(secret: secret, expiresAt: 1_700_000_000_000)
  let vm = PairingProvisioningViewModel()

  vm.load(qrJSON: payload, nowMs: 1_780_000_000_000)

  #expect(vm.state.mode == .invalid)
  #expect(vm.qrPayload.isEmpty)
  #expect(!vm.redactedSummary.contains(secret))
  #expect(!vm.canRenderQRCode)
}

@MainActor
@Test func pairingProvisioningRejectsMalformedManifest() async throws {
  let vm = PairingProvisioningViewModel()

  vm.load(qrJSON: #"{"kind":"not-friday","pairing_secret":"do-not-display"}"#) // pragma: allowlist secret

  #expect(vm.state.mode == .invalid)
  #expect(vm.state.projection == nil)
  #expect(vm.qrPayload.isEmpty)
  #expect(!vm.redactedSummary.contains("do-not-display"))
}

@MainActor
@Test func pairingProvisioningStartsLauncherAndLoadsQrManifestWithoutDisplayingSecret() async throws {
  let secret = "friday-pairing-launched-secret" // pragma: allowlist secret
  let launcher = FakePairingLauncher(result: PairingSessionLaunchResult(
    manifestJSON: pairingManifestJSON(secret: secret, expiresAt: 1_900_000_000_000),
    manifestPath: "/tmp/friday-pairing.json"))
  let vm = PairingProvisioningViewModel(launcher: launcher)

  await vm.startPairingSession(nowMs: 1_780_000_000_000)

  #expect(launcher.startCount == 1)
  #expect(launcher.exposureModes == [.loopback])
  #expect(vm.state.mode == .ready)
  #expect(vm.qrPayload.contains(secret))
  #expect(!vm.redactedSummary.contains(secret))
  #expect(vm.state.manifestPath == "/tmp/friday-pairing.json")
  #expect(vm.redactedSummary.contains("/tmp/friday-pairing.json"))
  #expect(vm.canRenderQRCode)
  try writeDesktopPairingActionEvidenceIfRequested(
    manifestPath: vm.state.manifestPath ?? "",
    hubId: vm.state.projection?.hubId ?? "",
    pairingId: vm.state.projection?.pairingId ?? "")
}

@MainActor
@Test func pairingProvisioningCanRequestPrivateLanLauncherExplicitly() async throws {
  let secret = "friday-pairing-lan-secret" // pragma: allowlist secret
  let launcher = FakePairingLauncher(result: PairingSessionLaunchResult(
    manifestJSON: pairingManifestJSON(
      secret: secret,
      expiresAt: 1_900_000_000_000,
      endpoint: "ws://192.168.1.44:48752"),
    manifestPath: "/tmp/friday-pairing-lan.json"))
  let vm = PairingProvisioningViewModel(launcher: launcher)

  await vm.startPairingSession(exposureMode: .privateLan, nowMs: 1_780_000_000_000)

  #expect(launcher.exposureModes == [.privateLan])
  #expect(vm.state.mode == .ready)
  #expect(vm.state.reason.contains("private-LAN"))
  #expect(vm.state.projection?.transportLabels.contains("pairing") == true)
  #expect(vm.canRenderQRCode)
}

@MainActor
@Test func pairingProvisioningLauncherFailureIsHonestUnavailableAndClearsPayload() async throws {
  let launcher = FakePairingLauncher(error: .manifestTimedOut)
  let vm = PairingProvisioningViewModel(launcher: launcher)

  await vm.startPairingSession(nowMs: 1_780_000_000_000)

  #expect(vm.state.mode == .unavailable)
  #expect(vm.qrPayload.isEmpty)
  #expect(!vm.canRenderQRCode)
  #expect(vm.state.reason.contains("did not produce"))
}

@MainActor
@Test func opsScriptPairingLauncherReadsManifestProducedByScript() async throws {
  let temp = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: temp) }
  let script = temp.appendingPathComponent("friday-start-pairing-session.sh")
  let secret = "friday-pairing-script-secret" // pragma: allowlist secret
  let body = pairingManifestJSON(secret: secret, expiresAt: 1_900_000_000_000)
  try """
    #!/bin/sh
    set -eu
    mkdir -p "$(dirname "$FRIDAY_PAIRING_QR_JSON_OUT")"
    cat > "$FRIDAY_PAIRING_QR_JSON_OUT" <<'JSON'
    \(body)
    JSON
    """.write(to: script, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes(
    [.posixPermissions: NSNumber(value: Int16(0o700))],
    ofItemAtPath: script.path)

  let launcher = OpsScriptPairingSessionLauncher(
    scriptPath: script.path,
    outputDirectory: temp.appendingPathComponent("out", isDirectory: true),
    environment: [:],
    timeoutSeconds: 2)
  let result = try await launcher.startPairingSession()

  #expect(result.manifestJSON.contains(secret))
  #expect(FileManager.default.fileExists(atPath: result.manifestPath))
}

@MainActor
@Test func opsScriptPairingLauncherPassesAutoLanOnlyForPrivateLanMode() async throws {
  let temp = try temporaryDirectory()
  defer { try? FileManager.default.removeItem(at: temp) }
  let script = temp.appendingPathComponent("friday-start-pairing-session.sh")
  let secret = "friday-pairing-script-lan-secret" // pragma: allowlist secret
  let body = pairingManifestJSON(
    secret: secret,
    expiresAt: 1_900_000_000_000,
    endpoint: "ws://192.168.1.44:48752")
  try """
    #!/bin/sh
    set -eu
    test "${FRIDAY_PAIRING_HOST:-}" = "auto-lan"
    mkdir -p "$(dirname "$FRIDAY_PAIRING_QR_JSON_OUT")"
    cat > "$FRIDAY_PAIRING_QR_JSON_OUT" <<'JSON'
    \(body)
    JSON
    """.write(to: script, atomically: true, encoding: .utf8)
  try FileManager.default.setAttributes(
    [.posixPermissions: NSNumber(value: Int16(0o700))],
    ofItemAtPath: script.path)

  let launcher = OpsScriptPairingSessionLauncher(
    scriptPath: script.path,
    outputDirectory: temp.appendingPathComponent("out", isDirectory: true),
    environment: [:],
    timeoutSeconds: 2)
  let result = try await launcher.startPairingSession(exposureMode: .privateLan)

  #expect(result.manifestJSON.contains(secret))
  #expect(FileManager.default.fileExists(atPath: result.manifestPath))
}

private final class FakePairingLauncher: PairingSessionLaunching {
  private let result: PairingSessionLaunchResult?
  private let error: PairingSessionLauncherError?
  private(set) var startCount = 0
  private(set) var exposureModes: [PairingSessionExposureMode] = []

  init(result: PairingSessionLaunchResult? = nil, error: PairingSessionLauncherError? = nil) {
    self.result = result
    self.error = error
  }

  func startPairingSession(exposureMode: PairingSessionExposureMode) async throws -> PairingSessionLaunchResult {
    startCount += 1
    exposureModes.append(exposureMode)
    if let error {
      throw error
    }
    return result!
  }
}

private func temporaryDirectory() throws -> URL {
  let url = FileManager.default.temporaryDirectory
    .appendingPathComponent("friday-pairing-tests-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}

private func pairingManifestJSON(
  secret: String,
  expiresAt: Int64,
  endpoint: String = "ws://127.0.0.1:48752"
) -> String {
  """
  {
    "kind": "friday.pairing.qr.v1",
    "aad": "friday:pairing:ws:j1:qr-pair-session:aad:v1",
    "hub_public_key_hex": "\(String(repeating: "a", count: 64))",
    "v": 1,
    "hub_id": "hub-test",
    "pairing_id": "pair-test",
    "pairing_secret": "\(secret)",
    "display_name": "Friday Test Hub",
    "transport_hints": [
      {"kind":"websocket","endpoint":"\(endpoint)","label":"pairing"}
    ],
    "expires_at": \(expiresAt),
    "capabilities_hint": ["read", "write"]
  }
  """
}

private func writeDesktopPairingActionEvidenceIfRequested(
  manifestPath: String,
  hubId: String,
  pairingId: String
) throws {
  guard let rawDir = ProcessInfo.processInfo.environment[
    "FRIDAY_DESKTOP_PAIRING_ACTION_EVIDENCE_DIR"
  ]?.trimmingCharacters(in: .whitespacesAndNewlines), !rawDir.isEmpty else {
    return
  }

  let payload: [String: Any] = [
    "truth": "desktop_pairing_manifest_swift_viewmodel_runtime_not_live_hub_not_endbar",
    "status": "ready",
    "generated_at_utc": ISO8601DateFormatter().string(from: Date()),
    "proof": [
      "manifest_path": manifestPath,
      "hub_id": hubId,
      "pairing_id": pairingId,
    ],
    "actions": [
      [
        "surface": "desktop",
        "screen": "pairingProvisioning",
        "action_id": "desktop/pairing/manifest",
        "capability_id": "desktop_pairing_manifest_readiness",
        "status": "pass",
        "evidence_ref": "swift://desktop/pairing/manifest/\(pairingId)",
        "source": "macos_pairing_provisioning_viewmodel_runtime",
        "truth_label": "swift_viewmodel_pairing_manifest_runtime_not_live_hub_not_gui_tap",
      ],
    ],
    "caveat": "Partial runtime evidence only: macOS PairingProvisioning ViewModel loads a redacted pairing manifest from the launcher. This is not live PairAck, not trust-grant minting, not a GUI tap, not END-BAR, and not adoption.",
  ]

  let dir = URL(fileURLWithPath: rawDir)
  try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let out = dir.appendingPathComponent("desktop-pairing-action-evidence.json")
  let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
  try data.write(to: out, options: .atomic)
  print("[desktop-pairing-action-evidence] proofOut=\(out.path)")
}
