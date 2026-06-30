import XCTest

final class FridayIOSAXObserverUITests: XCTestCase {
  private struct InteractionRequest: Decodable {
    let scenario: String?
    let text: String?
    let url: String?
    let appLaunchArgs: [String]?
    let appLaunchEnv: [String: String]?
    let masterKeyFile: String?
  }

  func testDumpFridayAccessibilityTree() throws {
    let app = XCUIApplication(bundleIdentifier: "com.friday.shell")
    let request = try interactionRequest()
    if request?.appLaunchArgs?.isEmpty != false,
      ProcessInfo.processInfo.environment["FRIDAY_IOS_AX_ATTACH_RUNNING_APP"] == "1" {
      app.activate()
    } else {
      configureAppLaunch(app, request: request)
      app.launch()
    }
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "Friday iOS shell did not become foreground for AX observation")

    try performRequestedInteraction(in: app, request: request)

    let tree = app.debugDescription
    XCTAssertFalse(tree.isEmpty, "Friday iOS shell AX tree was empty")

    print("FRIDAY_AX_DESC_BEGIN")
    print(tree)
    print("FRIDAY_AX_DESC_END")
  }

  private func configureAppLaunch(_ app: XCUIApplication, request: InteractionRequest?) {
    let env = ProcessInfo.processInfo.environment
    if let appLaunchArgs = request?.appLaunchArgs {
      app.launchArguments = appLaunchArgs
    } else if let rawArgs = env["FRIDAY_IOS_AX_APP_LAUNCH_ARGS_JSON"],
      let data = rawArgs.data(using: .utf8),
      let decoded = try? JSONDecoder().decode([String].self, from: data) {
      app.launchArguments = decoded
    } else if let rawArgs = env["FRIDAY_IOS_AX_APP_LAUNCH_ARGS"] {
      app.launchArguments = rawArgs
        .split(separator: "\u{1f}")
        .map(String.init)
        .filter { !$0.isEmpty }
    }

    if let appLaunchEnv = request?.appLaunchEnv {
      app.launchEnvironment = appLaunchEnv
    } else if let rawEnv = env["FRIDAY_IOS_AX_APP_ENV_JSON"],
      let data = rawEnv.data(using: .utf8),
      let decoded = try? JSONDecoder().decode([String: String].self, from: data) {
      app.launchEnvironment = decoded
    }

    if let masterKey = env["FRIDAY_MASTER_KEY"], !masterKey.isEmpty {
      app.launchEnvironment["FRIDAY_MASTER_KEY"] = masterKey
    } else if let masterKeyFile = request?.masterKeyFile,
      let masterKey = try? String(contentsOfFile: masterKeyFile, encoding: .utf8)
        .trimmingCharacters(in: .whitespacesAndNewlines),
      !masterKey.isEmpty {
      app.launchEnvironment["FRIDAY_MASTER_KEY"] = masterKey
    }
    let hasInitialDestination = app.launchArguments.contains { $0.hasPrefix("--initial-destination") }
    print(
      "FRIDAY_AX_LAUNCH_CONFIG scenario=\(request?.scenario ?? "<nil>") "
        + "args=\(app.launchArguments.count) initialDestination=\(hasInitialDestination) "
        + "envKeys=\(app.launchEnvironment.keys.sorted().joined(separator: ","))")
  }

  private func performRequestedInteraction(in app: XCUIApplication, request: InteractionRequest?) throws {
    let env = ProcessInfo.processInfo.environment
    let scenario = request == nil
      ? (env["FRIDAY_IOS_AX_INTERACTION_SCENARIO"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
      : (request?.scenario?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
    guard !scenario.isEmpty else { return }

    let text = request?.text ?? env["FRIDAY_IOS_AX_INTERACTION_TEXT"] ?? "Friday UI live interaction proof"
    let url = request?.url ?? env["FRIDAY_IOS_AX_INTERACTION_URL"] ?? "https://example.com/friday-ui-proof"

    switch scenario {
    case "missions-dispatch":
      try type(text, into: app, identifier: "friday.missions.dispatch-input")
      try tap(app, identifier: "friday.missions.dispatch-button")
      try waitFor(app, identifier: "friday.missions.open-chat-loop", timeout: 30)
    case "share-submit":
      try type(url, into: app, identifier: "friday.share.url")
      try type(text, into: app, identifier: "friday.share.text")
      try tap(app, identifier: "friday.share.submit")
      try waitFor(app, identifier: "friday.share.open-chat-loop", timeout: 30)
    case "new-session-launch":
      try type(text, into: app, identifier: "friday.new-session.intent-input")
      try tap(app, identifier: "friday.new-session.launch-button")
      try waitFor(app, identifier: "friday.new-session.open-chat-loop", timeout: 30)
    case "voice-open-chat":
      let permission = firstExistingElement(in: app, identifier: "friday.voice.permission", timeout: 3)
      if permission.exists {
        permission.tap()
      }
      try waitFor(app, identifier: "friday.voice.open-chat-loop", timeout: 10)
    case "settings-push-permission":
      try tap(app, identifier: "friday.settings.push-permission")
      try waitFor(app, identifier: "friday.settings.push-notifications-card", timeout: 10)
    case "pairing-retry":
      try type(text, into: app, identifier: "friday.home.pairing-qr-input")
      try tap(app, identifier: "friday.home.pair-button")
      try waitFor(app, identifier: "friday.home.pairing-retry-button", timeout: 10)
    case "pairing-cancel":
      try type(text, into: app, identifier: "friday.home.pairing-qr-input")
      try tap(app, identifier: "friday.home.pair-button")
      try waitFor(app, identifier: "friday.home.pairing-cancel-button", timeout: 10)
    case "session-sidecar-open":
      try tap(app, identifier: "friday.session.sidecar-open")
      try waitFor(app, identifier: "friday.session.sidecar-close", timeout: 10)
    default:
      XCTFail("Unsupported Friday iOS AX interaction scenario: \(scenario)")
    }
  }

  private func interactionRequest() throws -> InteractionRequest? {
    let env = ProcessInfo.processInfo.environment
    let path = env["FRIDAY_IOS_AX_INTERACTION_FILE"] ?? "/tmp/friday-ios-ax-interaction-current.json"
    guard FileManager.default.fileExists(atPath: path) else { return nil }
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return try JSONDecoder().decode(InteractionRequest.self, from: data)
  }

  private func type(_ text: String, into app: XCUIApplication, identifier: String) throws {
    let field = firstExistingElement(in: app, identifier: identifier, timeout: 10)
    XCTAssertTrue(field.exists, "Missing field \(identifier)")
    field.tap()
    field.typeText(text)
  }

  private func tap(_ app: XCUIApplication, identifier: String) throws {
    let element = firstExistingElement(in: app, identifier: identifier, timeout: 10)
    XCTAssertTrue(element.exists, "Missing tappable element \(identifier)")
    XCTAssertTrue(element.isEnabled, "Tappable element \(identifier) is disabled")
    element.tap()
  }

  private func waitFor(_ app: XCUIApplication, identifier: String, timeout: TimeInterval) throws {
    let element = firstExistingElement(in: app, identifier: identifier, timeout: timeout)
    XCTAssertTrue(element.exists, "Timed out waiting for \(identifier)")
  }

  private func firstExistingElement(in app: XCUIApplication, identifier: String, timeout: TimeInterval) -> XCUIElement {
    let candidates = [
      app.buttons.matching(identifier: identifier).firstMatch,
      app.textFields.matching(identifier: identifier).firstMatch,
      app.textViews.matching(identifier: identifier).firstMatch,
      app.staticTexts.matching(identifier: identifier).firstMatch,
      app.otherElements.matching(identifier: identifier).firstMatch,
    ]
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if let found = candidates.first(where: { $0.exists }) {
        return found
      }
      RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return candidates[0]
  }
}
