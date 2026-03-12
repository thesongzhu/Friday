import AppKit
import ApplicationServices
import CoreGraphics
import Dispatch
import Foundation
import FridayCompanionCore

private func nowIso() -> String {
  ISO8601DateFormatter().string(from: Date())
}

private func slugify(_ value: String) -> String {
  value
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
    .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
}

@MainActor
final class CompanionAppController: NSObject, NSApplicationDelegate {
  private let config: CompanionConfig
  private let notificationStore = CompanionNotificationStore(nowIso: nowIso)
  private let notificationReader: CompanionUserNotedNotificationReader
  private let notificationMutator: CompanionUserNotedNotificationMutator
  private let updater: CompanionUpdaterProviding
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private let titleMenuItem = NSMenuItem()
  private let updateMenuItem = NSMenuItem()
  private let overlayMenuItem = NSMenuItem()
  private let safeModeMenuItem = NSMenuItem()
  private var overlayWindow: NSPanel?
  private var globalMonitor: Any?
  private var localMonitor: Any?
  private var heartbeatTimer: Timer?
  private var server: CompanionUnixSocketServer?
  private var overlayVisible = false
  private var panicActive = false
  private var lastHeartbeatAt = nowIso()
  private var lastNotificationRefreshError: String?

  init(config: CompanionConfig) {
    self.config = config
    self.notificationReader = CompanionUserNotedNotificationReader(
      databasePath: config.notificationDatabasePath,
      maxRecords: config.notificationLimit
    )
    self.notificationMutator = CompanionUserNotedNotificationMutator(
      databasePath: config.notificationDatabasePath
    )
    self.updater = makeCompanionUpdater()
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    buildMenuBar()
    buildOverlayWindow()
    installHotkeyMonitors()
    installHeartbeatTimer()
    _ = refreshNotifications()

    do {
      let server = CompanionUnixSocketServer(
        socketPath: config.socketPath,
        authToken: config.authToken
      ) { [weak self] method, params in
        guard let self else {
          return NSNull()
        }
        let semaphore = DispatchSemaphore(value: 0)
        var result: Any = NSNull()
        var capturedError: Error?
        Task { @MainActor in
          do {
            self.lastHeartbeatAt = nowIso()
            result = try self.handle(method: method, params: params)
          } catch {
            capturedError = error
          }
          semaphore.signal()
        }
        semaphore.wait()
        if let capturedError {
          throw capturedError
        }
        return result
      }
      try server.start()
      self.server = server
      refreshMenuState()
    } catch {
      NSLog("[FridayCompanion] failed to start socket server: %@", error.localizedDescription)
      NSApp.terminate(nil)
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    heartbeatTimer?.invalidate()
    heartbeatTimer = nil
    server?.stop()
    server = nil
    if let globalMonitor {
      NSEvent.removeMonitor(globalMonitor)
    }
    if let localMonitor {
      NSEvent.removeMonitor(localMonitor)
    }
  }

  private func buildMenuBar() {
    statusItem.button?.title = "FRIDAY"
    menu.autoenablesItems = false
    titleMenuItem.title = "Friday Companion"
    titleMenuItem.isEnabled = false
    menu.addItem(titleMenuItem)

    updateMenuItem.title = "Check for Updates..."
    updateMenuItem.action = #selector(checkForUpdatesFromMenu)
    updateMenuItem.target = self
    updateMenuItem.keyEquivalent = "u"
    menu.addItem(updateMenuItem)

    overlayMenuItem.title = "Toggle Overlay"
    overlayMenuItem.action = #selector(toggleOverlayFromMenu)
    overlayMenuItem.target = self
    menu.addItem(overlayMenuItem)

    safeModeMenuItem.title = "Enter Safe Mode"
    safeModeMenuItem.action = #selector(toggleSafeModeFromMenu)
    safeModeMenuItem.target = self
    menu.addItem(safeModeMenuItem)

    menu.addItem(NSMenuItem.separator())
    menu.addItem(withTitle: "Quit Friday Companion", action: #selector(quitCompanion), keyEquivalent: "q")
    statusItem.menu = menu
    refreshMenuState()
  }

  private func buildOverlayWindow() {
    let frame = NSRect(x: 0, y: 0, width: 560, height: 240)
    let panel = NSPanel(
      contentRect: frame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = NSColor(calibratedWhite: 0.08, alpha: 0.92)
    panel.hasShadow = true
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isReleasedWhenClosed = false

    let contentView = NSView(frame: frame)
    let titleLabel = NSTextField(labelWithString: "Friday Agent OS")
    titleLabel.font = NSFont.systemFont(ofSize: 28, weight: .semibold)
    titleLabel.textColor = .white
    titleLabel.frame = NSRect(x: 28, y: 148, width: 320, height: 36)

    let detailLabel = NSTextField(labelWithString: "Command overlay ready. Use the web console for full operator control.")
    detailLabel.font = NSFont.systemFont(ofSize: 14, weight: .regular)
    detailLabel.textColor = NSColor(calibratedWhite: 0.82, alpha: 1.0)
    detailLabel.frame = NSRect(x: 28, y: 112, width: 500, height: 20)

    let hotkeyLabel = NSTextField(
      labelWithString: "Overlay: \(config.overlayHotkey.displayString)  •  Panic: \(config.panicHotkey.displayString)"
    )
    hotkeyLabel.font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    hotkeyLabel.textColor = NSColor(calibratedWhite: 0.68, alpha: 1.0)
    hotkeyLabel.frame = NSRect(x: 28, y: 72, width: 500, height: 18)

    contentView.addSubview(titleLabel)
    contentView.addSubview(detailLabel)
    contentView.addSubview(hotkeyLabel)
    panel.contentView = contentView
    overlayWindow = panel
    centerOverlayWindow()
  }

  private func centerOverlayWindow() {
    guard let overlayWindow, let screen = NSScreen.main else {
      return
    }
    let origin = NSPoint(
      x: screen.frame.midX - overlayWindow.frame.width / 2,
      y: screen.frame.midY - overlayWindow.frame.height / 2
    )
    overlayWindow.setFrameOrigin(origin)
  }

  private func installHotkeyMonitors() {
    globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
      self?.handleKeyEvent(event)
    }
    localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown]) { [weak self] event in
      self?.handleKeyEvent(event)
      return event
    }
  }

  private func installHeartbeatTimer() {
    heartbeatTimer = Timer.scheduledTimer(withTimeInterval: Double(config.heartbeatIntervalMs) / 1000.0, repeats: true) { [weak self] _ in
      Task { @MainActor in
        self?.lastHeartbeatAt = nowIso()
      }
    }
  }

  private func handleKeyEvent(_ event: NSEvent) {
    if matches(event: event, hotkey: config.overlayHotkey) {
      toggleOverlay()
      return
    }
    if matches(event: event, hotkey: config.panicHotkey) {
      panicActive = true
      setOverlayVisible(false)
      refreshMenuState()
    }
  }

  private func matches(event: NSEvent, hotkey: CompanionHotkey) -> Bool {
    let modifiers = event.modifierFlags.intersection([.command, .shift, .option, .control])
    return event.keyCode == keyCode(for: hotkey.key)
      && modifiers.contains(.command) == hotkey.command
      && modifiers.contains(.shift) == hotkey.shift
      && modifiers.contains(.option) == hotkey.option
      && modifiers.contains(.control) == hotkey.control
  }

  private func keyCode(for key: CompanionHotkey.Key) -> UInt16 {
    switch key {
    case .space:
      return 49
    case .escape:
      return 53
    }
  }

  @objc private func toggleOverlayFromMenu() {
    toggleOverlay()
  }

  @objc private func checkForUpdatesFromMenu() {
    updater.checkForUpdates(nil)
  }

  @objc private func toggleSafeModeFromMenu() {
    panicActive.toggle()
    if panicActive {
      setOverlayVisible(false)
    }
    refreshMenuState()
  }

  @objc private func quitCompanion() {
    NSApp.terminate(nil)
  }

  private func toggleOverlay() {
    panicActive = false
    setOverlayVisible(!overlayVisible)
    refreshMenuState()
  }

  private func setOverlayVisible(_ visible: Bool) {
    overlayVisible = visible
    guard let overlayWindow else {
      return
    }
    centerOverlayWindow()
    if visible {
      overlayWindow.orderFrontRegardless()
    } else {
      overlayWindow.orderOut(nil)
    }
  }

  private func refreshMenuState() {
    statusItem.button?.title = panicActive ? "FRIDAY SAFE" : "FRIDAY"
    titleMenuItem.title = panicActive ? "Friday Companion (safe mode)" : "Friday Companion"
    updateMenuItem.isEnabled = updater.isAvailable
    overlayMenuItem.title = overlayVisible ? "Hide Overlay" : "Show Overlay"
    safeModeMenuItem.title = panicActive ? "Exit Safe Mode" : "Enter Safe Mode"
  }

  private func handle(method: String, params: [String: Any]) throws -> Any {
    switch method {
    case "companion.ping":
      return ["ok": true, "serverTime": nowIso()]
    case "companion.getStatus":
      return statusPayload()
    case "companion.captureSnapshot":
      return snapshotPayload()
    case "companion.launchApp":
      let appIdentifier = (params["appIdentifier"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !appIdentifier.isEmpty else { return NSNull() }
      return launchApp(appIdentifier)
    case "companion.focusTarget":
      return focusTarget(params: params) ?? NSNull()
    case "companion.openUrl":
      let url = (params["url"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !url.isEmpty else { return NSNull() }
      return openURL(url)
    case "companion.openProject":
      let projectPath = (params["projectPath"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      guard !projectPath.isEmpty else { return NSNull() }
      return openProject(projectPath)
    case "companion.arrangeWindows":
      return arrangeWindows(layout: params["layout"] as? String) ?? NSNull()
    case "companion.listNotifications":
      return refreshNotifications().map(mapNotification)
    case "companion.actOnNotification":
      _ = refreshNotifications()
      guard
        let notificationId = params["notificationId"] as? String,
        let action = params["action"] as? String,
        let notification = notificationStore.act(on: notificationId, action: action)
      else {
        return NSNull()
      }
      applyNotificationAction(action, notification: notification)
      _ = refreshNotifications()
      return [
        "notification": mapNotification(notification),
        "action": action,
        "actedAt": nowIso(),
      ]
    case "companion.setOverlayVisible":
      let visible = params["visible"] as? Bool ?? false
      panicActive = false
      setOverlayVisible(visible)
      refreshMenuState()
      return [
        "visible": visible,
        "changedAt": nowIso(),
      ]
    default:
      throw NSError(domain: "FridayCompanion", code: 404, userInfo: [
        NSLocalizedDescriptionKey: "Unknown companion method: \(method)",
      ])
    }
  }

  private func statusPayload() -> [String: Any] {
    let permissions = [
      permissionPayload(
        id: "accessibility",
        permission: "accessibility",
        granted: AXIsProcessTrusted()
      ),
      permissionPayload(
        id: "screen_capture",
        permission: "screen_capture",
        granted: CGPreflightScreenCaptureAccess()
      ),
      [
        "id": "notifications",
        "permission": "notifications",
        "status": "granted",
      ],
    ]

    return [
      "id": config.id,
      "platform": "darwin",
      "runtimeKind": config.runtimeKind,
      "connected": true,
      "transport": [
        "mode": "unix_socket",
        "protocol": "jsonrpc-2.0",
        "authenticated": true,
        "socketPath": config.socketPath,
      ],
      "launchAtLoginEnabled": config.launchAtLoginEnabled,
      "panicHotkey": config.panicHotkey.displayString,
      "safeMode": panicActive,
      "overlayVisible": overlayVisible,
      "lastHeartbeatAt": lastHeartbeatAt,
      "capabilities": [
        "launchAtLogin": config.launchAtLoginEnabled,
        "menuBar": true,
        "overlay": true,
        "globalHotkey": true,
        "sparkleAutoUpdate": updater.isAvailable,
        "windowInventory": true,
        "notificationIntake": true,
        "screenCapture": true,
      ],
      "permissions": permissions,
    ]
  }

  private func permissionPayload(id: String, permission: String, granted: Bool) -> [String: Any] {
    [
      "id": id,
      "permission": permission,
      "status": granted ? "granted" : "not_determined",
      "grantInstructions": granted ? NSNull() : "System Settings → Privacy & Security → \(permission.replacingOccurrences(of: "_", with: " ").capitalized)",
    ]
  }

  private func snapshotPayload() -> [String: Any] {
    let apps = runningApplications()
    let windows = runningWindows(apps: apps)
    let frontmostAppId = apps.first(where: { ($0["frontmost"] as? Bool) == true })?["id"]
    let frontmostWindowId = windows.first(where: { ($0["focused"] as? Bool) == true })?["id"]
    return [
      "apps": apps,
      "windows": windows,
      "notifications": refreshNotifications().map(mapNotification),
      "frontmostAppId": frontmostAppId ?? NSNull(),
      "frontmostWindowId": frontmostWindowId ?? NSNull(),
    ]
  }

  private func runningApplications() -> [[String: Any]] {
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
    return NSWorkspace.shared.runningApplications
      .filter { !$0.isTerminated && $0.activationPolicy != .prohibited }
      .map { app in
        let name = app.localizedName ?? app.bundleIdentifier ?? "Application \(app.processIdentifier)"
        return [
          "id": appIdentifier(name: name, bundleId: app.bundleIdentifier, pid: app.processIdentifier),
          "name": name,
          "bundleId": app.bundleIdentifier ?? name,
          "pid": Int(app.processIdentifier),
          "running": true,
          "frontmost": app.processIdentifier == frontmostPid,
        ]
      }
      .sorted { lhs, rhs in
        (lhs["frontmost"] as? Bool ?? false) && !(rhs["frontmost"] as? Bool ?? false)
      }
  }

  private func runningWindows(apps: [[String: Any]]) -> [[String: Any]] {
    guard
      let rawWindowInfo = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else {
      return []
    }
    let appIdsByPid = Dictionary(uniqueKeysWithValues: apps.compactMap { app -> (pid_t, String)? in
      guard
        let pid = app["pid"] as? Int,
        let id = app["id"] as? String
      else {
        return nil
      }
      return (pid_t(pid), id)
    })
    let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier

    return rawWindowInfo.compactMap { window in
      guard
        let ownerPID = window[kCGWindowOwnerPID as String] as? Int,
        let appId = appIdsByPid[pid_t(ownerPID)],
        let windowNumber = window[kCGWindowNumber as String] as? Int
      else {
        return nil
      }
      let title = (window[kCGWindowName as String] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
      let boundsDict = window[kCGWindowBounds as String] as? [String: CGFloat]
      let bounds: [String: Any] = [
        "x": Double(boundsDict?["X"] ?? 0),
        "y": Double(boundsDict?["Y"] ?? 0),
        "width": Double(boundsDict?["Width"] ?? 0),
        "height": Double(boundsDict?["Height"] ?? 0),
      ]
      return [
        "id": "window:\(ownerPID):\(windowNumber)",
        "appId": appId,
        "title": (title?.isEmpty == false ? title! : "Window \(windowNumber)"),
        "focused": pid_t(ownerPID) == frontmostPid,
        "bounds": bounds,
      ]
    }
  }

  private func launchApp(_ appIdentifier: String) -> [String: Any] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = [appIdentifier.contains(".") ? "-b" : "-a", appIdentifier]
    try? process.run()
    return [
      "appIdentifier": appIdentifier,
      "launchedAt": nowIso(),
    ]
  }

  private func openURL(_ rawURL: String) -> [String: Any] {
    if let url = URL(string: rawURL) {
      NSWorkspace.shared.open(url)
    }
    return [
      "url": rawURL,
      "openedAt": nowIso(),
    ]
  }

  private func openProject(_ projectPath: String) -> [String: Any] {
    NSWorkspace.shared.open(URL(fileURLWithPath: projectPath))
    return [
      "projectPath": projectPath,
      "openedAt": nowIso(),
    ]
  }

  private func focusTarget(params: [String: Any]) -> [String: Any]? {
    let appIdentifier = params["appIdentifier"] as? String
    let runningApps = NSWorkspace.shared.runningApplications
    guard let match = runningApps.first(where: { app in
      let name = app.localizedName ?? ""
      return app.bundleIdentifier == appIdentifier || name == appIdentifier
    }) else {
      return nil
    }
    panicActive = false
    match.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
    return [
      "appIdentifier": appIdentifier ?? match.localizedName ?? match.bundleIdentifier ?? "unknown",
      "windowId": params["windowId"] ?? NSNull(),
      "focused": true,
      "focusedAt": nowIso(),
    ]
  }

  private func arrangeWindows(layout: String?) -> [String: Any]? {
    guard AXIsProcessTrusted() else {
      return nil
    }
    let apps = runningApplications()
    let windows = runningWindows(apps: apps)
    let orderedWindows = windows.sorted { lhs, rhs in
      (lhs["focused"] as? Bool ?? false) && !(rhs["focused"] as? Bool ?? false)
    }
    let targetCount: Int
    switch layout {
    case "single_focus":
      targetCount = 1
    case "dual_pane":
      targetCount = 2
    default:
      targetCount = 3
    }
    let targets = Array(orderedWindows.prefix(targetCount))
    guard !targets.isEmpty, let screen = NSScreen.main else {
      return nil
    }
    let arrangedBounds = computeArrangementBounds(count: targets.count, screenFrame: screen.visibleFrame)
    for (index, target) in targets.enumerated() {
      guard
        let appId = target["appId"] as? String,
        let pid = pidForAppId(appId, apps: apps)
      else {
        continue
      }
      moveFirstWindow(for: pid, to: arrangedBounds[index])
    }
    return [
      "arrangedWindowIds": targets.compactMap { $0["id"] as? String },
      "layout": layout ?? inferredLayout(for: targets.count),
      "arrangedAt": nowIso(),
    ]
  }

  private func inferredLayout(for count: Int) -> String {
    switch count {
    case 1:
      return "single_focus"
    case 2:
      return "dual_pane"
    default:
      return "triad"
    }
  }

  private func computeArrangementBounds(count: Int, screenFrame: NSRect) -> [CGRect] {
    let margin: CGFloat = 24
    let x = screenFrame.origin.x + margin
    let y = screenFrame.origin.y + margin
    let width = max(640, screenFrame.width - margin * 2)
    let height = max(480, screenFrame.height - margin * 2)

    if count <= 1 {
      return [CGRect(x: x, y: y, width: width, height: height)]
    }
    if count == 2 {
      let halfWidth = floor((width - margin) / 2)
      return [
        CGRect(x: x, y: y, width: halfWidth, height: height),
        CGRect(x: x + halfWidth + margin, y: y, width: width - halfWidth - margin, height: height),
      ]
    }
    let leftWidth = floor(width * 0.58)
    let rightWidth = width - leftWidth - margin
    let rightHeight = floor((height - margin) / 2)
    return [
      CGRect(x: x, y: y, width: leftWidth, height: height),
      CGRect(x: x + leftWidth + margin, y: y, width: rightWidth, height: rightHeight),
      CGRect(x: x + leftWidth + margin, y: y + rightHeight + margin, width: rightWidth, height: height - rightHeight - margin),
    ]
  }

  private func moveFirstWindow(for pid: pid_t, to frame: CGRect) {
    let appElement = AXUIElementCreateApplication(pid)
    var windowsRef: CFTypeRef?
    let copyResult = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)
    guard copyResult == .success, let windows = windowsRef as? [AXUIElement], let window = windows.first else {
      return
    }
    var position = CGPoint(x: frame.origin.x, y: frame.origin.y)
    var size = CGSize(width: frame.size.width, height: frame.size.height)
    if let positionValue = AXValueCreate(.cgPoint, &position) {
      AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, positionValue)
    }
    if let sizeValue = AXValueCreate(.cgSize, &size) {
      AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sizeValue)
    }
  }

  private func pidForAppId(_ appId: String, apps: [[String: Any]]) -> pid_t? {
    apps.first(where: { ($0["id"] as? String) == appId })
      .flatMap { $0["pid"] as? Int }
      .map(pid_t.init)
  }

  private func appIdentifier(name: String, bundleId: String?, pid: pid_t) -> String {
    if let bundleId, !bundleId.isEmpty {
      return "app:\(bundleId)"
    }
    return "app:\(slugify(name)):\(pid)"
  }

  private func mapNotification(_ notification: CompanionNotification) -> [String: Any] {
    [
      "id": notification.id,
      "sourceApp": notification.sourceApp ?? NSNull(),
      "title": notification.title,
      "body": notification.body ?? NSNull(),
      "deepLinkUrl": notification.deepLinkUrl ?? NSNull(),
      "receivedAt": notification.receivedAt,
      "read": notification.read,
    ]
  }

  private func applyNotificationAction(_ action: String, notification: CompanionNotification) {
    switch action {
    case "open":
      openNotification(notification)
    case "dismiss":
      dismissNotification(notification)
    case "mark_read":
      markNotificationRead(notification)
    default:
      break
    }
  }

  private func openNotification(_ notification: CompanionNotification) {
    if let deepLinkUrl = notification.deepLinkUrl {
      _ = openURL(deepLinkUrl)
      return
    }
    if let sourceApp = notification.sourceApp {
      _ = launchApp(sourceApp)
    }
  }

  private func dismissNotification(_ notification: CompanionNotification) {
    do {
      let dismissed = try notificationMutator.dismissNotification(
        sourceApp: notification.sourceApp,
        systemUuidHex: notification.systemUuidHex
      )
      if !dismissed {
        NSLog("[FridayCompanion] notification dismiss fell back to companion-local state for %@", notification.id)
      }
    } catch {
      NSLog("[FridayCompanion] failed to dismiss notification %@: %@", notification.id, error.localizedDescription)
    }
  }

  private func markNotificationRead(_ notification: CompanionNotification) {
    do {
      let marked = try notificationMutator.markNotificationRead(
        sourceApp: notification.sourceApp,
        systemUuidHex: notification.systemUuidHex
      )
      if !marked {
        openNotification(notification)
      }
    } catch {
      NSLog("[FridayCompanion] failed to mark notification as read %@: %@", notification.id, error.localizedDescription)
      openNotification(notification)
    }
  }

  private func refreshNotifications() -> [CompanionNotification] {
    do {
      let notifications = try notificationReader.readNotifications()
      let visible = notificationStore.replaceSnapshot(notifications)
      if lastNotificationRefreshError != nil {
        NSLog("[FridayCompanion] notification intake recovered")
      }
      lastNotificationRefreshError = nil
      return visible
    } catch {
      let message = error.localizedDescription
      if lastNotificationRefreshError != message {
        NSLog("[FridayCompanion] failed to refresh notifications: %@", message)
      }
      lastNotificationRefreshError = message
      return notificationStore.listVisible()
    }
  }
}

let config: CompanionConfig
do {
  config = try CompanionConfig.fromEnvironment()
} catch {
  fputs("[FridayCompanion] \(error)\n", stderr)
  exit(1)
}

let app = NSApplication.shared
let delegate = CompanionAppController(config: config)
app.delegate = delegate
app.run()
