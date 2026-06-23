import Foundation
import FridayRustClient
import Testing
@testable import FridayHubConsoleCore

@Test func pairingEndpointConfigAcceptsLoopbackAndPrivateLanOnly() throws {
  #expect(try PairingEndpointConfig(manifest: manifest(endpoint: "ws://127.0.0.1:49152")).host == "127.0.0.1")
  #expect(try PairingEndpointConfig(manifest: manifest(endpoint: "ws://localhost:49152")).host == "127.0.0.1")
  #expect(try PairingEndpointConfig(manifest: manifest(endpoint: "ws://192.168.1.50:49152")).host == "192.168.1.50")
  #expect(try PairingEndpointConfig(manifest: manifest(endpoint: "ws://10.0.0.5:49152")).host == "10.0.0.5")
  #expect(try PairingEndpointConfig(manifest: manifest(endpoint: "ws://172.20.0.5:49152")).host == "172.20.0.5")

  #expect(throws: PairingEndpointConfigError.disallowedHost("8.8.8.8")) {
    try PairingEndpointConfig(manifest: manifest(endpoint: "ws://8.8.8.8:49152"))
  }
  #expect(throws: PairingEndpointConfigError.disallowedHost("example.com")) {
    try PairingEndpointConfig(manifest: manifest(endpoint: "ws://example.com:49152"))
  }
}

@Test func realPairingProofFactoryBuildsASealedPairingClient() throws {
  let client = try RealPairingProofClientFactory.make(
    manifest: manifest(endpoint: "ws://127.0.0.1:49152"),
    keypair: FridayCrypto.DeviceKeypair())
  #expect(client is SealedWSPairingClient)
}

private func manifest(endpoint: String) throws -> FridayPairingManifest {
  let pairingSecret = "friday-pairing-secret-for-test" // pragma: allowlist secret
  let json = """
    {
      "kind": "friday.pairing.qr.v1",
      "aad": "friday:pairing:ws:j1:qr-pair-session:aad:v1",
      "hub_public_key_hex": "\(String(repeating: "a", count: 64))",
      "v": 1,
      "hub_id": "hub-test",
      "pairing_id": "pair-test",
      "pairing_secret": "\(pairingSecret)",
      "display_name": "Friday Test Hub",
      "transport_hints": [
        {"kind":"lan_websocket","endpoint":"\(endpoint)","label":"pairing"}
      ],
      "expires_at": 1900000000000,
      "capabilities_hint": ["pairing", "read_seam_enroll"]
    }
    """
  return try JSONDecoder().decode(FridayPairingManifest.self, from: Data(json.utf8))
}
