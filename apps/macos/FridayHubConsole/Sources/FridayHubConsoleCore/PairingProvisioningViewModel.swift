import Combine
import Foundation
import FridayRustClient

public enum PairingProvisioningMode: String, Sendable, Equatable {
  case empty
  case starting
  case ready
  case invalid
  case unavailable
}

public enum PairingSessionExposureMode: String, Sendable, Equatable {
  case loopback
  case privateLan = "private_lan"

  public var readyReason: String {
    switch self {
    case .loopback:
      return "Short-lived loopback pairing QR is ready to scan."
    case .privateLan:
      return "Short-lived private-LAN pairing QR is ready to scan."
    }
  }

  public var startingReason: String {
    switch self {
    case .loopback:
      return "Starting a short-lived loopback Hub pairing session."
    case .privateLan:
      return "Starting a short-lived private-LAN Hub pairing session."
    }
  }
}

public struct PairingProvisioningState: Sendable, Equatable, CustomStringConvertible,
  CustomDebugStringConvertible
{
  public let mode: PairingProvisioningMode
  public let reason: String
  public let projection: FridayPairingManifestProjection?
  public let manifestPath: String?

  public var description: String {
    [
      "mode=\(mode.rawValue)",
      projection.map { "hub=\($0.hubId)" },
      projection.map { "pairing=\($0.pairingId)" },
      manifestPath.map { "manifest=\($0)" },
      "reason=\(reason)",
    ]
    .compactMap { $0 }
    .joined(separator: " ")
  }

  public var debugDescription: String { description }

  public static let empty = PairingProvisioningState(
    mode: .empty,
    reason: "Paste or import a Hub pairing QR manifest.",
    projection: nil,
    manifestPath: nil)
}

@MainActor
public final class PairingProvisioningViewModel: ObservableObject {
  @Published public private(set) var state: PairingProvisioningState = .empty
  @Published public private(set) var qrPayload: String = ""

  private let launcher: PairingSessionLaunching?

  public init(launcher: PairingSessionLaunching? = OpsScriptPairingSessionLauncher.liveFromEnvironment()) {
    self.launcher = launcher
  }

  public var canRenderQRCode: Bool {
    state.mode == .ready && !qrPayload.isEmpty
  }

  public var canStartPairingSession: Bool {
    state.mode != .starting
  }

  public var redactedSummary: String {
    state.description
  }

  public static func operatorProvisioningCommand(repoRoot: String = "$FRIDAY_REPO_ROOT") -> String {
    """
    cd \(repoRoot)
    node scripts/ops/friday-t3-provisioning-status.mjs --operator-action
    """
  }

  public func startPairingSession(
    exposureMode: PairingSessionExposureMode = .loopback,
    nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)
  ) async {
    guard let launcher else {
      qrPayload = ""
      state = PairingProvisioningState(
        mode: .unavailable,
        reason: "Pairing launcher is not configured for this build.",
        projection: nil,
        manifestPath: nil)
      return
    }
    qrPayload = ""
    state = PairingProvisioningState(
      mode: .starting,
      reason: exposureMode.startingReason,
      projection: nil,
      manifestPath: nil)
    do {
      let result = try await launcher.startPairingSession(exposureMode: exposureMode)
      load(
        qrJSON: result.manifestJSON,
        nowMs: nowMs,
        manifestPath: result.manifestPath,
        readyReason: exposureMode.readyReason)
    } catch {
      qrPayload = ""
      state = PairingProvisioningState(
        mode: .unavailable,
        reason: Self.reason(forLaunchError: error),
        projection: nil,
        manifestPath: nil)
    }
  }

  public func load(
    qrJSON: String,
    nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
    manifestPath: String? = nil,
    readyReason: String = PairingSessionExposureMode.loopback.readyReason
  ) {
    let payload = qrJSON.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !payload.isEmpty else {
      clear()
      return
    }

    do {
      let manifest = try JSONDecoder().decode(FridayPairingManifest.self, from: Data(payload.utf8))
      try manifest.validate(nowMs: nowMs)
      qrPayload = payload
      let trimmedManifestPath = manifestPath?.trimmingCharacters(in: .whitespacesAndNewlines)
      state = PairingProvisioningState(
        mode: .ready,
        reason: readyReason,
        projection: manifest.redactedProjection,
        manifestPath: trimmedManifestPath?.isEmpty == false ? trimmedManifestPath : nil)
    } catch {
      qrPayload = ""
      state = PairingProvisioningState(
        mode: .invalid,
        reason: Self.reason(for: error),
        projection: nil,
        manifestPath: nil)
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

  private static func reason(forLaunchError error: Error) -> String {
    if let e = error as? PairingSessionLauncherError {
      return e.description
    }
    return "Pairing launcher failed."
  }
}

public struct PairingSessionLaunchResult: Sendable, Equatable {
  public let manifestJSON: String
  public let manifestPath: String

  public init(manifestJSON: String, manifestPath: String) {
    self.manifestJSON = manifestJSON
    self.manifestPath = manifestPath
  }
}

@MainActor
public protocol PairingSessionLaunching: AnyObject {
  func startPairingSession(exposureMode: PairingSessionExposureMode) async throws -> PairingSessionLaunchResult
}

public enum PairingSessionLauncherError: Error, Equatable, CustomStringConvertible {
  case scriptUnavailable
  case processStartFailed
  case processExited(String)
  case manifestTimedOut
  case invalidManifest

  public var description: String {
    switch self {
    case .scriptUnavailable:
      return "Pairing launcher script is unavailable."
    case .processStartFailed:
      return "Pairing launcher could not start."
    case .processExited(let reason):
      return reason.isEmpty ? "Pairing launcher exited before producing a QR manifest." : reason
    case .manifestTimedOut:
      return "Pairing launcher did not produce a QR manifest in time."
    case .invalidManifest:
      return "Pairing launcher produced an invalid QR manifest."
    }
  }
}

@MainActor
public final class OpsScriptPairingSessionLauncher: PairingSessionLaunching {
  private let scriptPath: String
  private let outputDirectory: URL
  private let environment: [String: String]
  private let timeoutSeconds: TimeInterval
  private var activeProcesses: [Process] = []

  public init(
    scriptPath: String,
    outputDirectory: URL = FileManager.default.temporaryDirectory
      .appendingPathComponent("friday-pairing-ui", isDirectory: true),
    environment: [String: String] = ProcessInfo.processInfo.environment,
    timeoutSeconds: TimeInterval = 5
  ) {
    self.scriptPath = scriptPath
    self.outputDirectory = outputDirectory
    self.environment = environment
    self.timeoutSeconds = timeoutSeconds
  }

  deinit {
    for process in activeProcesses where process.isRunning {
      process.terminate()
    }
  }

  public static func liveFromEnvironment(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    fileManager: FileManager = .default
  ) -> OpsScriptPairingSessionLauncher? {
    if let script = environment["FRIDAY_PAIRING_LAUNCH_SCRIPT"], fileManager.fileExists(atPath: script) {
      return OpsScriptPairingSessionLauncher(scriptPath: script, environment: environment)
    }
    if let root = environment["FRIDAY_REPO_ROOT"] {
      let script = URL(fileURLWithPath: root)
        .appendingPathComponent("scripts/ops/friday-start-pairing-session.sh")
        .path
      if fileManager.fileExists(atPath: script) {
        return OpsScriptPairingSessionLauncher(scriptPath: script, environment: environment)
      }
    }
    if let script = findScriptFromCurrentDirectory(fileManager: fileManager) {
      return OpsScriptPairingSessionLauncher(scriptPath: script, environment: environment)
    }
    return nil
  }

  public func startPairingSession(
    exposureMode: PairingSessionExposureMode = .loopback
  ) async throws -> PairingSessionLaunchResult {
    guard FileManager.default.fileExists(atPath: scriptPath) else {
      throw PairingSessionLauncherError.scriptUnavailable
    }
    try FileManager.default.createDirectory(
      at: outputDirectory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: NSNumber(value: Int16(0o700))])

    let manifestURL = outputDirectory
      .appendingPathComponent("pairing-\(UUID().uuidString).json")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/bash")
    process.arguments = [scriptPath]
    var env = environment
    env["FRIDAY_PAIRING_QR_JSON_OUT"] = manifestURL.path
    env["FRIDAY_PAIRING_OUT_DIR"] = outputDirectory.path
    if exposureMode == .privateLan {
      env["FRIDAY_PAIRING_HOST"] = "auto-lan"
    }
    process.environment = env

    do {
      try process.run()
    } catch {
      throw PairingSessionLauncherError.processStartFailed
    }

    let deadline = Date().addingTimeInterval(timeoutSeconds)
    while Date() < deadline {
      if FileManager.default.fileExists(atPath: manifestURL.path) {
        let data = try Data(contentsOf: manifestURL)
        guard let manifestJSON = String(data: data, encoding: .utf8) else {
          process.terminate()
          throw PairingSessionLauncherError.invalidManifest
        }
        do {
          let manifest = try JSONDecoder().decode(FridayPairingManifest.self, from: data)
          try manifest.validate(nowMs: Int64(Date().timeIntervalSince1970 * 1000))
        } catch {
          process.terminate()
          throw PairingSessionLauncherError.invalidManifest
        }
        activeProcesses.append(process)
        return PairingSessionLaunchResult(
          manifestJSON: manifestJSON,
          manifestPath: manifestURL.path)
      }
      if !process.isRunning {
        throw PairingSessionLauncherError.processExited("")
      }
      try await Task.sleep(nanoseconds: 100_000_000)
    }
    process.terminate()
    throw PairingSessionLauncherError.manifestTimedOut
  }

  private static func findScriptFromCurrentDirectory(fileManager: FileManager) -> String? {
    var cursor = URL(fileURLWithPath: fileManager.currentDirectoryPath, isDirectory: true)
    while true {
      let script = cursor
        .appendingPathComponent("scripts/ops/friday-start-pairing-session.sh")
        .path
      if fileManager.fileExists(atPath: script) {
        return script
      }
      let parent = cursor.deletingLastPathComponent()
      if parent.path == cursor.path {
        return nil
      }
      cursor = parent
    }
  }
}
