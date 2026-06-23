import Foundation
import FridayRustClient

public enum PairingServerConfigError: Error, Sendable, Equatable, CustomStringConvertible {
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

public struct PairingServerConfig: Sendable, Equatable {
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
      throw PairingServerConfigError.badEndpoint(endpoint)
    }
    let host = url.host ?? ""
    guard Self.isAllowedPairingHost(host) else {
      throw PairingServerConfigError.disallowedHost(host)
    }
    guard let port = url.port, let p = UInt16(exactly: port), p > 0 else {
      throw PairingServerConfigError.missingPort(endpoint)
    }
    self.init(host: host == "localhost" ? "127.0.0.1" : host, port: p)
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

public final class ManifestRoutedPairingClient: FridayPairingClient, @unchecked Sendable {
  private let deviceKeypair: DeviceKeypair

  public init(deviceKeypair: DeviceKeypair) {
    self.deviceKeypair = deviceKeypair
  }

  public func fetchHubStatus(manifest: FridayPairingManifest) async throws -> PairingHubStatusWire {
    try await client(for: manifest).fetchHubStatus(manifest: manifest)
  }

  public func pairDevice(manifest: FridayPairingManifest, deviceId: String) async throws -> PairingPairAckWire {
    try await client(for: manifest).pairDevice(manifest: manifest, deviceId: deviceId)
  }

  private func client(for manifest: FridayPairingManifest) throws -> SealedWSPairingClient {
    let config = try PairingServerConfig(manifest: manifest)
    return SealedWSPairingClient(
      keypair: deviceKeypair.keypair,
      makeTransport: {
        try LoopbackSealedWSTransport(config: ReadProjectionServerConfig(
          host: config.host,
          port: config.port,
          connectTimeout: config.connectTimeout,
          receiveTimeout: config.receiveTimeout))
      })
  }
}

public enum RealPairingClientFactory {
  public static func makeLive(deviceKeypair: DeviceKeypair) -> FridayPairingClient {
    ManifestRoutedPairingClient(deviceKeypair: deviceKeypair)
  }
}
