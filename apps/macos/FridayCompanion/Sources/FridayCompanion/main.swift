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

private struct GuideBounds {
  let x: CGFloat
  let y: CGFloat
  let width: CGFloat
  let height: CGFloat
}

private struct GuideAvatar {
  let kind: String
  let imageUrl: String?
  let localPath: String?
  let initials: String
  let sizePx: CGFloat
}

private struct GuideOverlayCommand {
  let id: String
  let mode: String
  let message: String
  let targetBounds: GuideBounds?
  let avatar: GuideAvatar
  let stepLabel: String?
  let tone: String
}

private final class GuideOverlayRootView: NSView {
  override func hitTest(_ point: NSPoint) -> NSView? {
    guard let hit = super.hitTest(point), hit !== self else {
      return nil
    }
    var current: NSView? = hit
    while let view = current {
      if view.identifier?.rawValue == "guide-control" {
        return hit
      }
      current = view.superview
    }
    return nil
  }
}

private final class GuideFocusView: NSView {
  override var isFlipped: Bool { false }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    let rect = bounds.insetBy(dx: 4, dy: 4)
    let path = NSBezierPath(roundedRect: rect, xRadius: 12, yRadius: 12)
    NSColor(calibratedRed: 0.11, green: 0.45, blue: 1.0, alpha: 0.18).setFill()
    path.fill()
    NSColor(calibratedRed: 0.11, green: 0.45, blue: 1.0, alpha: 0.95).setStroke()
    path.lineWidth = 3
    path.stroke()
  }
}

private final class GuideAvatarView: NSView {
  private let avatar: GuideAvatar

  init(frame: NSRect, avatar: GuideAvatar) {
    self.avatar = avatar
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) {
    return nil
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)
    let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 2, dy: 2))
    NSColor(calibratedWhite: 0.76, alpha: 1.0).setFill()
    circle.fill()

    if let image = loadAvatarImage() {
      NSGraphicsContext.saveGraphicsState()
      circle.addClip()
      image.draw(in: bounds)
      NSGraphicsContext.restoreGraphicsState()
      return
    }

    let text = avatar.initials.isEmpty ? "F" : avatar.initials
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: min(bounds.width, bounds.height) * 0.44, weight: .semibold),
      .foregroundColor: NSColor.white,
    ]
    let size = text.size(withAttributes: attributes)
    text.draw(
      at: NSPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2),
      withAttributes: attributes
    )
  }

  private func loadAvatarImage() -> NSImage? {
    if avatar.kind == "local_image", let path = avatar.localPath {
      return NSImage(contentsOfFile: path)
    }
    if avatar.kind == "profile_image", let value = avatar.imageUrl, value.hasPrefix("file://"), let url = URL(string: value) {
      return NSImage(contentsOf: url)
    }
    return nil
  }
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
  private let controlPageMenuItem = NSMenuItem()
  private let updateMenuItem = NSMenuItem()
  private let overlayMenuItem = NSMenuItem()
  private let safeModeMenuItem = NSMenuItem()
  private var overlayWindow: NSPanel?
  private var globalMonitor: Any?
  private var localMonitor: Any?
  private var heartbeatTimer: Timer?
  private var server: CompanionUnixSocketServer?
  private var overlayVisible = false
  private var guideOverlayCommand: GuideOverlayCommand?
  private var panicActive = false
  private var lastHeartbeatAt = nowIso()
  private var lastRemoteHeartbeatAt: String?
  private var lastRemoteHeartbeatStatus: String = "disabled"
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
    self.lastRemoteHeartbeatStatus = config.remoteSessionHeartbeat == nil ? "disabled" : "pending"
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

    controlPageMenuItem.title = "Open Operator Console"
    controlPageMenuItem.action = #selector(openControlPageFromMenu)
    controlPageMenuItem.target = self
    controlPageMenuItem.keyEquivalent = "o"
    menu.addItem(controlPageMenuItem)

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
    let screenFrame = NSScreen.main?.frame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let panel = NSPanel(
      contentRect: screenFrame,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.level = .statusBar
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    panel.titleVisibility = .hidden
    panel.titlebarAppearsTransparent = true
    panel.isReleasedWhenClosed = false
    panel.ignoresMouseEvents = false

    panel.contentView = GuideOverlayRootView(frame: NSRect(x: 0, y: 0, width: screenFrame.width, height: screenFrame.height))
    overlayWindow = panel
    centerOverlayWindow()
  }

  private func centerOverlayWindow() {
    guard let overlayWindow, let screen = NSScreen.main else {
      return
    }
    overlayWindow.setFrame(screen.frame, display: true)
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
    recordLocalHeartbeat()
    Task { @MainActor in
      await sendRemoteSessionHeartbeatIfConfigured()
    }
    heartbeatTimer = Timer.scheduledTimer(withTimeInterval: Double(config.heartbeatIntervalMs) / 1000.0, repeats: true) { [weak self] _ in
      Task { @MainActor in
        self?.recordLocalHeartbeat()
        await self?.sendRemoteSessionHeartbeatIfConfigured()
      }
    }
  }

  private func recordLocalHeartbeat() {
    lastHeartbeatAt = nowIso()
  }

  private func sendRemoteSessionHeartbeatIfConfigured() async {
    guard let remoteHeartbeat = config.remoteSessionHeartbeat else {
      lastRemoteHeartbeatStatus = "disabled"
      return
    }
    do {
      let request = try remoteHeartbeat.makeRequest(idempotencyKey: "\(config.id)-\(UUID().uuidString)")
      let (data, response) = try await URLSession.shared.data(for: request)
      guard let http = response as? HTTPURLResponse else {
        lastRemoteHeartbeatStatus = "failed_non_http"
        return
      }
      if (200...299).contains(http.statusCode) {
        lastRemoteHeartbeatStatus = remoteSessionHeartbeatStatus(from: data)
        if lastRemoteHeartbeatStatus == "ok" {
          lastRemoteHeartbeatAt = nowIso()
        }
      } else {
        lastRemoteHeartbeatStatus = "failed_\(http.statusCode)"
      }
    } catch {
      lastRemoteHeartbeatStatus = "failed"
    }
  }

  private func remoteSessionHeartbeatStatus(from data: Data) -> String {
    guard
      let object = try? JSONSerialization.jsonObject(with: data),
      let payload = object as? [String: Any],
      let session = payload["session"] as? [String: Any]
    else {
      return "missing_session"
    }
    return session["status"] as? String == "active" ? "ok" : "inactive_session"
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

  @objc private func openControlPageFromMenu() {
    _ = openURL(config.controlPageURL)
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
      renderGuideOverlay(guideOverlayCommand ?? defaultGuideOverlayCommand())
      overlayWindow.orderFrontRegardless()
    } else {
      guideOverlayCommand = nil
      overlayWindow.contentView?.subviews.forEach { $0.removeFromSuperview() }
      overlayWindow.orderOut(nil)
    }
  }

  private func defaultGuideOverlayCommand() -> GuideOverlayCommand {
    GuideOverlayCommand(
      id: "manual-overlay",
      mode: "speech_bubble",
      message: "Guide Mode is ready. Ask Friday for help and I will point to the next step.",
      targetBounds: nil,
      avatar: GuideAvatar(kind: "default_f", imageUrl: nil, localPath: nil, initials: "F", sizePx: 56),
      stepLabel: nil,
      tone: "calm"
    )
  }

  private func showGuideOverlay(command: GuideOverlayCommand) -> [String: Any] {
    guideOverlayCommand = command
    panicActive = false
    setOverlayVisible(true)
    refreshMenuState()
    return [
      "visible": true,
      "changedAt": nowIso(),
    ]
  }

  private func clearGuideOverlay() -> [String: Any] {
    guideOverlayCommand = nil
    setOverlayVisible(false)
    refreshMenuState()
    return [
      "visible": false,
      "changedAt": nowIso(),
    ]
  }

  private func renderGuideOverlay(_ command: GuideOverlayCommand) {
    guard let root = overlayWindow?.contentView, let screen = NSScreen.main else {
      return
    }
    root.subviews.forEach { $0.removeFromSuperview() }

    if let target = command.targetBounds {
      let focusFrame = convertGuideBounds(target, screen: screen).insetBy(dx: -8, dy: -8)
      let focusView = GuideFocusView(frame: focusFrame)
      focusView.wantsLayer = true
      focusView.layer?.shadowColor = NSColor(calibratedRed: 0.11, green: 0.45, blue: 1.0, alpha: 0.65).cgColor
      focusView.layer?.shadowRadius = 18
      focusView.layer?.shadowOpacity = 1
      focusView.layer?.shadowOffset = .zero
      root.addSubview(focusView)
    }

    let avatarSize = max(40, min(96, command.avatar.sizePx))
    let bubbleSize = computeBubbleSize(message: command.message, stepLabel: command.stepLabel)
    let bubbleOrigin = resolveBubbleOrigin(
      targetBounds: command.targetBounds,
      bubbleSize: bubbleSize,
      avatarSize: avatarSize,
      screen: screen
    )
    let avatarFrame = NSRect(
      x: bubbleOrigin.x,
      y: bubbleOrigin.y + bubbleSize.height - avatarSize,
      width: avatarSize,
      height: avatarSize
    )
    let bubbleFrame = NSRect(
      x: bubbleOrigin.x + avatarSize + 12,
      y: bubbleOrigin.y,
      width: bubbleSize.width,
      height: bubbleSize.height
    )

    let avatarView = GuideAvatarView(frame: avatarFrame, avatar: command.avatar)
    avatarView.wantsLayer = true
    avatarView.layer?.shadowColor = NSColor.black.withAlphaComponent(0.18).cgColor
    avatarView.layer?.shadowOpacity = 1
    avatarView.layer?.shadowRadius = 12
    avatarView.layer?.shadowOffset = NSSize(width: 0, height: -2)
    root.addSubview(avatarView)

    let bubble = NSView(frame: bubbleFrame)
    bubble.wantsLayer = true
    bubble.layer?.backgroundColor = NSColor(calibratedWhite: 1.0, alpha: 0.96).cgColor
    bubble.layer?.cornerRadius = 18
    bubble.layer?.shadowColor = NSColor.black.withAlphaComponent(0.16).cgColor
    bubble.layer?.shadowOpacity = 1
    bubble.layer?.shadowRadius = 18
    bubble.layer?.shadowOffset = NSSize(width: 0, height: -4)

    let stepText = command.stepLabel ?? labelForGuideMode(command.mode)
    let stepLabel = NSTextField(labelWithString: stepText.uppercased())
    stepLabel.font = NSFont.systemFont(ofSize: 11, weight: .semibold)
    stepLabel.textColor = NSColor(calibratedRed: 0.11, green: 0.35, blue: 0.84, alpha: 1)
    stepLabel.frame = NSRect(x: 18, y: bubbleFrame.height - 34, width: bubbleFrame.width - 58, height: 16)

    let closeButton = NSButton(title: "Close", target: self, action: #selector(closeGuideOverlayFromButton))
    closeButton.identifier = NSUserInterfaceItemIdentifier("guide-control")
    closeButton.isBordered = false
    closeButton.font = NSFont.systemFont(ofSize: 12, weight: .medium)
    closeButton.contentTintColor = NSColor(calibratedWhite: 0.32, alpha: 1)
    closeButton.frame = NSRect(x: bubbleFrame.width - 62, y: bubbleFrame.height - 36, width: 50, height: 22)

    let messageLabel = NSTextField(wrappingLabelWithString: command.message)
    messageLabel.font = NSFont.systemFont(ofSize: 15, weight: .regular)
    messageLabel.textColor = NSColor(calibratedWhite: 0.12, alpha: 1)
    messageLabel.frame = NSRect(x: 18, y: 18, width: bubbleFrame.width - 36, height: bubbleFrame.height - 58)

    bubble.addSubview(stepLabel)
    bubble.addSubview(closeButton)
    bubble.addSubview(messageLabel)
    root.addSubview(bubble)
  }

  @objc private func closeGuideOverlayFromButton() {
    _ = clearGuideOverlay()
  }

  private func labelForGuideMode(_ mode: String) -> String {
    switch mode {
    case "focus_frame":
      return "Next step"
    case "scroll_hint":
      return "Scroll needed"
    case "page_transition":
      return "New page"
    case "blocked":
      return "Need help"
    case "confirm_step":
      return "Confirm"
    default:
      return "Guide Mode"
    }
  }

  private func computeBubbleSize(message: String, stepLabel: String?) -> NSSize {
    let width: CGFloat = min(420, max(300, CGFloat(message.count) * 4.8))
    let lineCount = max(1, Int(ceil(Double(message.count) / 42.0)))
    let height = CGFloat(76 + lineCount * 24 + (stepLabel == nil ? 0 : 4))
    return NSSize(width: width, height: min(220, max(124, height)))
  }

  private func resolveBubbleOrigin(
    targetBounds: GuideBounds?,
    bubbleSize: NSSize,
    avatarSize: CGFloat,
    screen: NSScreen
  ) -> NSPoint {
    let rootFrame = NSRect(x: 0, y: 0, width: screen.frame.width, height: screen.frame.height)
    let totalWidth = bubbleSize.width + avatarSize + 12
    let totalHeight = max(bubbleSize.height, avatarSize)
    let margin: CGFloat = 28

    if let targetBounds {
      let target = convertGuideBounds(targetBounds, screen: screen)
      var x = target.maxX + 18
      if x + totalWidth > rootFrame.maxX - margin {
        x = target.minX - totalWidth - 18
      }
      var y = target.midY - totalHeight / 2
      y = min(max(y, rootFrame.minY + margin), rootFrame.maxY - totalHeight - margin)
      x = min(max(x, rootFrame.minX + margin), rootFrame.maxX - totalWidth - margin)
      return NSPoint(x: x, y: y)
    }

    return NSPoint(
      x: rootFrame.maxX - totalWidth - 44,
      y: rootFrame.maxY - totalHeight - 96
    )
  }

  private func convertGuideBounds(_ bounds: GuideBounds, screen: NSScreen) -> NSRect {
    NSRect(
      x: bounds.x,
      y: screen.frame.height - bounds.y - bounds.height,
      width: bounds.width,
      height: bounds.height
    )
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
    case "companion.showGuideOverlay":
      guard let command = parseGuideOverlayCommand(params["command"]) else {
        throw NSError(domain: "FridayCompanion", code: 400, userInfo: [
          NSLocalizedDescriptionKey: "Invalid guide overlay command",
        ])
      }
      return showGuideOverlay(command: command)
    case "companion.clearGuideOverlay":
      return clearGuideOverlay()
    default:
      throw NSError(domain: "FridayCompanion", code: 404, userInfo: [
        NSLocalizedDescriptionKey: "Unknown companion method: \(method)",
      ])
    }
  }

  private func parseGuideOverlayCommand(_ raw: Any?) -> GuideOverlayCommand? {
    guard let dict = raw as? [String: Any] else {
      return nil
    }
    let avatarDict = dict["avatar"] as? [String: Any] ?? [:]
    let stepDict = dict["step"] as? [String: Any]
    return GuideOverlayCommand(
      id: dict["id"] as? String ?? "guide-overlay",
      mode: dict["mode"] as? String ?? "speech_bubble",
      message: dict["message"] as? String ?? "Please follow this highlighted step.",
      targetBounds: parseGuideBounds(dict["targetBounds"]),
      avatar: GuideAvatar(
        kind: avatarDict["kind"] as? String ?? "default_f",
        imageUrl: avatarDict["imageUrl"] as? String,
        localPath: avatarDict["localPath"] as? String,
        initials: avatarDict["initials"] as? String ?? "F",
        sizePx: numberValue(avatarDict["sizePx"]) ?? 56
      ),
      stepLabel: stepDict?["label"] as? String,
      tone: dict["tone"] as? String ?? "calm"
    )
  }

  private func parseGuideBounds(_ raw: Any?) -> GuideBounds? {
    guard let dict = raw as? [String: Any],
      let x = numberValue(dict["x"]),
      let y = numberValue(dict["y"]),
      let width = numberValue(dict["width"]),
      let height = numberValue(dict["height"])
    else {
      return nil
    }
    return GuideBounds(x: x, y: y, width: max(1, width), height: max(1, height))
  }

  private func numberValue(_ raw: Any?) -> CGFloat? {
    if let value = raw as? CGFloat {
      return value
    }
    if let value = raw as? Double {
      return CGFloat(value)
    }
    if let value = raw as? Int {
      return CGFloat(value)
    }
    if let value = raw as? NSNumber {
      return CGFloat(truncating: value)
    }
    if let value = raw as? String, let parsed = Double(value) {
      return CGFloat(parsed)
    }
    return nil
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
      "remoteSessionHeartbeat": [
        "enabled": config.remoteSessionHeartbeat != nil,
        "status": lastRemoteHeartbeatStatus,
        "lastHeartbeatAt": lastRemoteHeartbeatAt ?? (NSNull() as Any),
      ],
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
