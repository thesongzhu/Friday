import Foundation

public struct CompanionConfig: Sendable {
  public let id: String
  public let socketPath: String
  public let authToken: String
  public let workspaceRoot: String
  public let runtimeKind: String
  public let launchAtLoginEnabled: Bool
  public let controlPageURL: String
  public let overlayHotkey: CompanionHotkey
  public let panicHotkey: CompanionHotkey
  public let heartbeatIntervalMs: Int
  public let notificationDatabasePath: String
  public let notificationLimit: Int
  public let remoteSessionHeartbeat: CompanionRemoteSessionHeartbeat?

  public init(
    id: String,
    socketPath: String,
    authToken: String,
    workspaceRoot: String,
    runtimeKind: String,
    launchAtLoginEnabled: Bool,
    controlPageURL: String,
    overlayHotkey: CompanionHotkey,
    panicHotkey: CompanionHotkey,
    heartbeatIntervalMs: Int,
    notificationDatabasePath: String,
    notificationLimit: Int,
    remoteSessionHeartbeat: CompanionRemoteSessionHeartbeat? = nil
  ) {
    self.id = id
    self.socketPath = socketPath
    self.authToken = authToken
    self.workspaceRoot = workspaceRoot
    self.runtimeKind = runtimeKind
    self.launchAtLoginEnabled = launchAtLoginEnabled
    self.controlPageURL = controlPageURL
    self.overlayHotkey = overlayHotkey
    self.panicHotkey = panicHotkey
    self.heartbeatIntervalMs = heartbeatIntervalMs
    self.notificationDatabasePath = notificationDatabasePath
    self.notificationLimit = notificationLimit
    self.remoteSessionHeartbeat = remoteSessionHeartbeat
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
    let controlPageURL = resolveControlPageURL(env)
    let overlayHotkey = try CompanionHotkey(rawValue: env["FRIDAY_SYSTEM_OVERLAY_HOTKEY"] ?? "cmd+shift+space")
    let panicHotkey = try CompanionHotkey(rawValue: env["FRIDAY_SYSTEM_PANIC_HOTKEY"] ?? "cmd+shift+escape")
    let heartbeatIntervalMs = Int(env["FRIDAY_SYSTEM_COMPANION_HEARTBEAT_MS"] ?? "") ?? 5_000
    let notificationDatabasePath = nonEmpty(env["FRIDAY_SYSTEM_NOTIFICATION_DB_PATH"])
      ?? CompanionUserNotedNotificationReader.defaultDatabasePath(homeDirectory: env["HOME"] ?? NSHomeDirectory())
    let notificationLimit = Int(env["FRIDAY_SYSTEM_NOTIFICATION_LIMIT"] ?? "") ?? 64
    let remoteSessionHeartbeat = resolveRemoteSessionHeartbeat(env)

    return CompanionConfig(
      id: id,
      socketPath: socketPath,
      authToken: authToken,
      workspaceRoot: workspaceRoot,
      runtimeKind: runtimeKind,
      launchAtLoginEnabled: launchAtLoginEnabled,
      controlPageURL: controlPageURL,
      overlayHotkey: overlayHotkey,
      panicHotkey: panicHotkey,
      heartbeatIntervalMs: max(1_000, heartbeatIntervalMs),
      notificationDatabasePath: notificationDatabasePath,
      notificationLimit: max(1, notificationLimit),
      remoteSessionHeartbeat: remoteSessionHeartbeat
    )
  }
}

private func resolveRemoteSessionHeartbeat(_ env: [String: String]) -> CompanionRemoteSessionHeartbeat? {
  guard let sessionId = nonEmpty(env["FRIDAY_SYSTEM_REMOTE_SESSION_ID"]) else {
    return nil
  }
  let hubBaseURL = nonEmpty(env["FRIDAY_SYSTEM_REMOTE_HUB_BASE_URL"])
    ?? nonEmpty(env["FRIDAY_PUBLIC_APP_BASE_URL"])
    ?? defaultPublicAppBaseURL(env)
  return CompanionRemoteSessionHeartbeat(hubBaseURL: hubBaseURL, sessionId: sessionId)
}

private func resolveControlPageURL(_ env: [String: String]) -> String {
  if let explicitURL = nonEmpty(env["FRIDAY_CONTROL_PAGE_URL"]) {
    return explicitURL
  }

  let baseURL = nonEmpty(env["FRIDAY_PUBLIC_APP_BASE_URL"]) ?? defaultPublicAppBaseURL(env)
  return appendPath("command-center", to: baseURL)
}

private func defaultPublicAppBaseURL(_ env: [String: String]) -> String {
  let rawHost = nonEmpty(env["FRIDAY_HOST"]) ?? "127.0.0.1"
  let host = rawHost == "0.0.0.0" ? "localhost" : rawHost
  let hostname = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
  let port = max(1, Int(env["FRIDAY_PORT"] ?? "") ?? 3_141)
  return "http://\(hostname):\(port)"
}

private func appendPath(_ path: String, to baseURL: String) -> String {
  let suffix = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  guard !suffix.isEmpty else {
    return baseURL
  }

  if let url = URL(string: baseURL), var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
    let currentPath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    if currentPath.isEmpty {
      components.path = "/\(suffix)"
    } else if currentPath != suffix && !currentPath.hasSuffix("/\(suffix)") {
      components.path = "/\(currentPath)/\(suffix)"
    }
    return components.url?.absoluteString ?? appendPathString(suffix, to: baseURL)
  }

  return appendPathString(suffix, to: baseURL)
}

private func appendPathString(_ path: String, to baseURL: String) -> String {
  var base = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
  while base.hasSuffix("/") {
    base.removeLast()
  }
  return "\(base)/\(path)"
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
