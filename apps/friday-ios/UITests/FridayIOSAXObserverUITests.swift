import XCTest

final class FridayIOSAXObserverUITests: XCTestCase {
  func testDumpFridayAccessibilityTree() throws {
    let app = XCUIApplication(bundleIdentifier: "com.friday.shell")
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10), "Friday iOS shell did not become foreground for AX observation")

    let tree = app.debugDescription
    XCTAssertFalse(tree.isEmpty, "Friday iOS shell AX tree was empty")

    print("FRIDAY_AX_DESC_BEGIN")
    print(tree)
    print("FRIDAY_AX_DESC_END")
  }
}
