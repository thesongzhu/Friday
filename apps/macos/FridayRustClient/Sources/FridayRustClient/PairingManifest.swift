import CryptoKit
import Foundation

public enum FridayPairingManifestError: Error, Equatable {
  case unsupportedKind(String)
  case badHubPublicKey(String)
  case missingWebSocketEndpoint
  case expired(nowMs: Int64, expiresAtMs: Int64)
}

public struct FridayPairingTransportHint: Codable, Equatable, Sendable {
  public let kind: String
  public let endpoint: String
  public let label: String

  public init(kind: String, endpoint: String, label: String) {
    self.kind = kind
    self.endpoint = endpoint
    self.label = label
  }
}

/// Decodes the QR manifest emitted by `hub_pairing_server --qr-json-out`.
///
/// The manifest is scan material: it intentionally contains the short-lived `pairing_secret`.
/// Keep it in memory only, do not log it, and use `redactedProjection` for UI display.
public struct FridayPairingManifest: Codable, Equatable, Sendable, CustomStringConvertible,
  CustomDebugStringConvertible
{
  public static let supportedKind = "friday.pairing.qr.v1"

  public let kind: String
  public let aad: String
  public let hubPublicKeyHex: String
  public let version: UInt16
  public let hubId: String
  public let pairingId: String
  public let pairingSecret: String
  public let displayName: String
  public let transportHints: [FridayPairingTransportHint]
  public let expiresAt: Int64
  public let capabilitiesHint: [String]

  enum CodingKeys: String, CodingKey {
    case kind, aad
    case hubPublicKeyHex = "hub_public_key_hex"
    case version = "v"
    case hubId = "hub_id"
    case pairingId = "pairing_id"
    case pairingSecret = "pairing_secret"  // pragma: allowlist secret
    case displayName = "display_name"
    case transportHints = "transport_hints"
    case expiresAt = "expires_at"
    case capabilitiesHint = "capabilities_hint"
  }

  public var description: String { redactedProjection.description }
  public var debugDescription: String { redactedProjection.description }

  public var hubPublicKey: [UInt8] {
    get throws {
      let key = try Hex.decode(hubPublicKeyHex)
      guard key.count == FridayCrypto.x25519PublicKeyLen else {
        throw FridayPairingManifestError.badHubPublicKey("hub public key must be 32 bytes")
      }
      return key
    }
  }

  public var webSocketEndpoint: String {
    get throws {
      guard let endpoint = transportHints.first(where: { $0.kind == "websocket" })?.endpoint,
        !endpoint.isEmpty
      else {
        throw FridayPairingManifestError.missingWebSocketEndpoint
      }
      return endpoint
    }
  }

  public var redactedProjection: FridayPairingManifestProjection {
    FridayPairingManifestProjection(
      kind: kind,
      aad: aad,
      hubPublicKeyHex: hubPublicKeyHex,
      version: version,
      hubId: hubId,
      pairingId: pairingId,
      displayName: displayName,
      transportLabels: transportHints.map(\.label),
      endpoints: transportHints.map(\.endpoint),
      expiresAt: expiresAt,
      capabilitiesHint: capabilitiesHint)
  }

  public func validate(nowMs: Int64? = nil) throws {
    guard kind == Self.supportedKind else {
      throw FridayPairingManifestError.unsupportedKind(kind)
    }
    _ = try hubPublicKey
    _ = try webSocketEndpoint
    if let nowMs, expiresAt <= nowMs {
      throw FridayPairingManifestError.expired(nowMs: nowMs, expiresAtMs: expiresAt)
    }
  }

  public func pairingProof(forDevicePublicKey devicePublicKey: [UInt8]) throws -> [UInt8] {
    guard devicePublicKey.count == FridayCrypto.x25519PublicKeyLen else {
      throw FridayCryptoError.badLength("device public key must be 32 bytes")
    }
    let key = SymmetricKey(data: Data(pairingSecret.utf8))
    let mac = HMAC<SHA256>.authenticationCode(for: Data(devicePublicKey), using: key)
    return Array(mac)
  }
}

public struct FridayPairingManifestProjection: Equatable, Sendable, CustomStringConvertible {
  public let kind: String
  public let aad: String
  public let hubPublicKeyHex: String
  public let version: UInt16
  public let hubId: String
  public let pairingId: String
  public let displayName: String
  public let transportLabels: [String]
  public let endpoints: [String]
  public let expiresAt: Int64
  public let capabilitiesHint: [String]

  public var description: String {
    "FridayPairingManifestProjection(kind: \(kind), hubId: \(hubId), pairingId: \(pairingId), displayName: \(displayName), expiresAt: \(expiresAt))"
  }
}
