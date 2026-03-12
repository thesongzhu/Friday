import Foundation

public struct CompanionConfig: Sendable {
  public let id: String
  public let socketPath: String
  public let authToken: String
  public let workspaceRoot: String
  public let runtimeKind: String
  public let launchAtLoginEnabled: Bool
  public let overlayHotkey: CompanionHotkey
  public let panicHotkey: CompanionHotkey
  public let heartbeatIntervalMs: Int
  public let notificationDatabasePath: String
  public let notificationLimit: Int

  public init(
    id: String,
    socketPath: String,
    authToken: String,
    workspaceRoot: String,
    runtimeKind: String,
    launchAtLoginEnabled: Bool,
    overlayHotkey: CompanionHotkey,
    panicHotkey: CompanionHotkey,
    heartbeatIntervalMs: Int,
    notificationDatabasePath: String,
    notificationLimit: Int
  ) {
    self.id = id
    self.socketPath = socketPath
    self.authToken = authToken
    self.workspaceRoot = workspaceRoot
    self.runtimeKind = runtimeKind
    self.launchAtLoginEnabled = launchAtLoginEnabled
    self.overlayHotkey = overlayHotkey
    self.panicHotkey = panicHotkey
    self.heartbeatIntervalMs = heartbeatIntervalMs
    self.notificationDatabasePath = notificationDatabasePath
    self.notificationLimit = notificationLimit
  }

  public static func fromEnvironment(_ env: [String: String] = ProcessInfo.processInfo.environment) throws -> CompanionConfig {
    let id = nonEmpty(env["FRIDAY_SYSTEM_COMPANION_ID"]) ?? "friday-system-companion"
    let authToken = nonEmpty(env["FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN"])
      ?? readNonEmptyFile(path: env["FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE"])
      ?? ""
    guard !authToken.isEmpty else {
      throw CompanionConfigError.missingAuthToken
    }

    let workspaceRoot = nonEmpty(env["FRIDAY_WORKSPACE_ROOT"]) ?? FileManager.default.currentDirectoryPath
    let socketPath = nonEmpty(env["FRIDAY_SYSTEM_COMPANION_SOCKET_PATH"]) ?? "\(workspaceRoot)/.friday/run/system-companion.sock"
    let runtimeKind = resolveRuntimeKind(env["FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND"])
    let launchAtLoginEnabled = env["FRIDAY_SYSTEM_LAUNCH_AT_LOGIN"] != "false"
    let overlayHotkey = try CompanionHotkey(rawValue: env["FRIDAY_SYSTEM_OVERLAY_HOTKEY"] ?? "cmd+shift+space")
    let panicHotkey = try CompanionHotkey(rawValue: env["FRIDAY_SYSTEM_PANIC_HOTKEY"] ?? "cmd+shift+escape")
    let heartbeatIntervalMs = Int(env["FRIDAY_SYSTEM_COMPANION_HEARTBEAT_MS"] ?? "") ?? 5_000
    let notificationDatabasePath = nonEmpty(env["FRIDAY_SYSTEM_NOTIFICATION_DB_PATH"])
      ?? CompanionUserNotedNotificationReader.defaultDatabasePath(homeDirectory: env["HOME"] ?? NSHomeDirectory())
    let notificationLimit = Int(env["FRIDAY_SYSTEM_NOTIFICATION_LIMIT"] ?? "") ?? 64

    return CompanionConfig(
      id: id,
      socketPath: socketPath,
      authToken: authToken,
      workspaceRoot: workspaceRoot,
      runtimeKind: runtimeKind,
      launchAtLoginEnabled: launchAtLoginEnabled,
      overlayHotkey: overlayHotkey,
      panicHotkey: panicHotkey,
      heartbeatIntervalMs: max(1_000, heartbeatIntervalMs),
      notificationDatabasePath: notificationDatabasePath,
      notificationLimit: max(1, notificationLimit)
    )
  }
}

private func nonEmpty(_ value: String?) -> String? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  return trimmed
}

private func readNonEmptyFile(path: String?) -> String? {
  guard let path = nonEmpty(path) else {
    return nil
  }
  let contents = try? String(contentsOfFile: path, encoding: .utf8)
  return nonEmpty(contents)
}

private func resolveRuntimeKind(_ value: String?) -> String {
  switch nonEmpty(value) {
  case let kind? where ["embedded", "node_daemon", "swift_binary", "swift_app"].contains(kind):
    return kind
  default:
    return "swift_binary"
  }
}

public enum CompanionConfigError: Error, CustomStringConvertible {
  case missingAuthToken

  public var description: String {
    switch self {
    case .missingAuthToken:
      return "FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN is required"
    }
  }
}
