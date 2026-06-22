import Foundation
import FridayRustClient

public enum PairingServerConfigError: Error, Sendable, Equatable, CustomStringConvertible {
  case badEndpoint(String)
  case nonLoopbackHost(String)
  case missingPort(String)

  public var description: String {
    switch self {
    case let .badEndpoint(endpoint):
      return "bad pairing endpoint \(endpoint)"
    case let .nonLoopbackHost(host):
      return "pairing endpoint must be loopback, got \(host)"
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
    guard ["127.0.0.1", "localhost", "::1"].contains(host) else {
      throw PairingServerConfigError.nonLoopbackHost(host)
    }
    guard let port = url.port, let p = UInt16(exactly: port) else {
      throw PairingServerConfigError.missingPort(endpoint)
    }
    self.init(host: host == "localhost" ? "127.0.0.1" : host, port: p)
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
