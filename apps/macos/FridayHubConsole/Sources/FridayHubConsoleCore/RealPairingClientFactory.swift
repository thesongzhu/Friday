import Foundation
import FridayRustClient

public enum PairingEndpointConfigError: Error, Sendable, Equatable, CustomStringConvertible {
  case badEndpoint(String)
  case disallowedHost(String)
  case missingPort(String)

  public var description: String {
    switch self {
    case let .badEndpoint(endpoint):
      return "bad pairing endpoint \(endpoint)"
    case let .disallowedHost(host):
      return "pairing endpoint must be loopback or private LAN, got \(host)"
    case let .missingPort(endpoint):
      return "pairing endpoint missing port \(endpoint)"
    }
  }
}

public struct PairingEndpointConfig: Sendable, Equatable {
  public let host: String
  public let port: UInt16
  public let connectTimeout: TimeInterval
  public let receiveTimeout: TimeInterval

  public init(
    host: String,
    port: UInt16,
    connectTimeout: TimeInterval = 4,
    receiveTimeout: TimeInterval = 8
  ) {
    self.host = host
    self.port = port
    self.connectTimeout = connectTimeout
    self.receiveTimeout = receiveTimeout
  }

  public init(manifest: FridayPairingManifest) throws {
    let endpoint = try manifest.webSocketEndpoint
    guard let url = URL(string: endpoint), let scheme = url.scheme?.lowercased(),
      scheme == "ws" || scheme == "wss"
    else {
      throw PairingEndpointConfigError.badEndpoint(endpoint)
    }
    let host = url.host ?? ""
    guard Self.isAllowedPairingHost(host) else {
      throw PairingEndpointConfigError.disallowedHost(host)
    }
    guard let port = url.port, let p = UInt16(exactly: port) else {
      throw PairingEndpointConfigError.missingPort(endpoint)
    }
    self.init(host: host == "localhost" ? "127.0.0.1" : host, port: p)
  }

  var transportConfig: ReadProjectionServerConfig {
    ReadProjectionServerConfig(
      host: host,
      port: port,
      connectTimeout: connectTimeout,
      receiveTimeout: receiveTimeout)
  }

  static func isAllowedPairingHost(_ host: String) -> Bool {
    let h = host.lowercased()
    if ["127.0.0.1", "localhost", "::1"].contains(h) { return true }
    let parts = h.split(separator: ".").compactMap { UInt8(String($0)) }
    guard parts.count == 4 else { return false }
    if parts[0] == 10 { return true }
    if parts[0] == 172 && (UInt8(16)...UInt8(31)).contains(parts[1]) { return true }
    if parts[0] == 192 && parts[1] == 168 { return true }
    if parts[0] == 169 && parts[1] == 254 { return true }
    return false
  }
}

public enum RealPairingProofClientFactory {
  public static func make(
    manifest: FridayPairingManifest,
    keypair: FridayCrypto.DeviceKeypair
  ) throws -> FridayPairingClient {
    let config = try PairingEndpointConfig(manifest: manifest)
    return SealedWSPairingClient(
      keypair: keypair,
      makeTransport: {
        try LoopbackSealedWSTransport(config: config.transportConfig)
      })
  }
}
