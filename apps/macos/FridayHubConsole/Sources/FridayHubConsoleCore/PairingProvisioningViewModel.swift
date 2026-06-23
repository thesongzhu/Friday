import Combine
import Foundation
import FridayRustClient

public enum PairingProvisioningMode: String, Sendable, Equatable {
  case empty
  case ready
  case invalid
}

public struct PairingProvisioningState: Sendable, Equatable, CustomStringConvertible,
  CustomDebugStringConvertible
{
  public let mode: PairingProvisioningMode
  public let reason: String
  public let projection: FridayPairingManifestProjection?

  public var description: String {
    [
      "mode=\(mode.rawValue)",
      projection.map { "hub=\($0.hubId)" },
      projection.map { "pairing=\($0.pairingId)" },
      "reason=\(reason)",
    ]
    .compactMap { $0 }
    .joined(separator: " ")
  }

  public var debugDescription: String { description }

  public static let empty = PairingProvisioningState(
    mode: .empty,
    reason: "Paste or import a Hub pairing QR manifest.",
    projection: nil)
}

@MainActor
public final class PairingProvisioningViewModel: ObservableObject {
  @Published public private(set) var state: PairingProvisioningState = .empty
  @Published public private(set) var qrPayload: String = ""

  public init() {}

  public var canRenderQRCode: Bool {
    state.mode == .ready && !qrPayload.isEmpty
  }

  public var redactedSummary: String {
    state.description
  }

  public func load(qrJSON: String, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
    let payload = qrJSON.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !payload.isEmpty else {
      clear()
      return
    }

    do {
      let manifest = try JSONDecoder().decode(FridayPairingManifest.self, from: Data(payload.utf8))
      try manifest.validate(nowMs: nowMs)
      qrPayload = payload
      state = PairingProvisioningState(
        mode: .ready,
        reason: "Short-lived pairing QR is ready to scan.",
        projection: manifest.redactedProjection)
    } catch {
      qrPayload = ""
      state = PairingProvisioningState(
        mode: .invalid,
        reason: Self.reason(for: error),
        projection: nil)
    }
  }

  public func load(data: Data, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) {
    load(qrJSON: String(decoding: data, as: UTF8.self), nowMs: nowMs)
  }

  public func clear() {
    qrPayload = ""
    state = .empty
  }

  private static func reason(for error: Error) -> String {
    if let e = error as? FridayPairingManifestError {
      switch e {
      case .expired:
        return "Pairing QR has expired."
      case .unsupportedKind, .badHubPublicKey, .missingWebSocketEndpoint:
        return "Pairing QR cannot be trusted."
      }
    }
    return "Pairing QR is invalid."
  }
}
