import Testing
@testable import FridayHubConsoleCore

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

private func pairingManifestJSON(secret: String, expiresAt: Int64) -> String {
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
      {"kind":"websocket","endpoint":"ws://127.0.0.1:48752","label":"loopback"}
    ],
    "expires_at": \(expiresAt),
    "capabilities_hint": ["read", "write"]
  }
  """
}
