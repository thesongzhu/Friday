import XCTest
@testable import FridayRustClient

final class PairingManifestTests: XCTestCase {
  private let fixturePairingSecret = "qr-secret-1234567890" // pragma: allowlist secret

  func testDecodesQrManifestAndRedactsSecretFromDisplaySurfaces() throws {
    let manifest = try decodeManifest()

    XCTAssertEqual(manifest.kind, FridayPairingManifest.supportedKind)
    XCTAssertEqual(manifest.version, 1)
    XCTAssertEqual(manifest.hubId, "hub-local")
    XCTAssertEqual(try manifest.webSocketEndpoint, "ws://127.0.0.1:49152")
    XCTAssertEqual(try manifest.hubPublicKey.count, 32)

    let projection = manifest.redactedProjection
    XCTAssertEqual(projection.transportLabels, ["Local pairing"])
    XCTAssertEqual(projection.capabilitiesHint, ["status_only"])

    let display = "\(manifest)"
    let debug = String(reflecting: manifest)
    XCTAssertFalse(display.contains(fixturePairingSecret))
    XCTAssertFalse(debug.contains(fixturePairingSecret))
    XCTAssertFalse("\(projection)".contains(fixturePairingSecret))
  }

  func testPairingProofMatchesRustHmacSha256Contract() throws {
    let manifest = try decodeManifest()
    let devicePubkey = Array(UInt8(0)..<UInt8(32))

    let proof = try manifest.pairingProof(forDevicePublicKey: devicePubkey)

    XCTAssertEqual(
      Hex.encode(proof),
      "b82be6373123d412b180127398c090c940663a12574035523b71c629549282fc")  // pragma: allowlist secret
  }

  func testAcceptsRustQrLanWebSocketTransportKind() throws {
    let manifest = try decodeManifest(replacing: (#""websocket""#, #""lan_websocket""#))

    XCTAssertEqual(try manifest.webSocketEndpoint, "ws://127.0.0.1:49152")
  }

  func testValidationFailsClosedForBadManifestShapes() throws {
    let manifest = try decodeManifest()
    try manifest.validate(nowMs: 1_780_000_000_000)
    XCTAssertThrowsError(try manifest.validate(nowMs: 1_790_000_000_000)) { error in
      XCTAssertEqual(error as? FridayPairingManifestError, .expired(
        nowMs: 1_790_000_000_000,
        expiresAtMs: 1_780_650_000_000))
    }

    let badKind = try decodeManifest(replacing: ("friday.pairing.qr.v1", "friday.other"))
    XCTAssertThrowsError(try badKind.validate()) { error in
      XCTAssertEqual(error as? FridayPairingManifestError, .unsupportedKind("friday.other"))
    }

    let badKey = try decodeManifest(replacing: (String(repeating: "a", count: 64), "abcd"))
    XCTAssertThrowsError(try badKey.validate()) { error in
      XCTAssertEqual(
        error as? FridayPairingManifestError,
        .badHubPublicKey("hub public key must be 32 bytes"))
    }

    XCTAssertThrowsError(try manifest.pairingProof(forDevicePublicKey: [1, 2, 3])) { error in
      XCTAssertEqual(error as? FridayCryptoError, .badLength("device public key must be 32 bytes"))
    }
  }

  private func decodeManifest(replacing replacement: (String, String)? = nil) throws -> FridayPairingManifest {
    var json = """
      {
        "kind": "friday.pairing.qr.v1",
        "aad": "friday:pairing:ws:j1:qr-pair-session:aad:v1",
        "hub_public_key_hex": "\(String(repeating: "a", count: 64))",
        "v": 1,
        "hub_id": "hub-local",
        "pairing_id": "pair-123",
        "pairing_secret": "\(fixturePairingSecret)",
        "display_name": "Friday on Jarvis Mac",
        "transport_hints": [
          {"kind": "websocket", "endpoint": "ws://127.0.0.1:49152", "label": "Local pairing"}
        ],
        "expires_at": 1780650000000,
        "capabilities_hint": ["status_only"]
      }
      """
    if let replacement {
      json = json.replacingOccurrences(of: replacement.0, with: replacement.1)
    }
    return try JSONDecoder().decode(FridayPairingManifest.self, from: Data(json.utf8))
  }
}
