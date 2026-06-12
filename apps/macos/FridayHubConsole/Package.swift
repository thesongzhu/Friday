// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "FridayHubConsole",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .executable(name: "FridayHubConsole", targets: ["FridayHubConsole"]),
    .library(name: "FridayHubConsoleCore", targets: ["FridayHubConsoleCore"]),
  ],
  dependencies: [
    // The REAL sealed-WS read client package (PR #677 read + #680 write, crypto-parity
    // PASS). The Console's `FridayRustReadClient` protocol + `SealedWSReadClient` live
    // there; the Core target adapts the package's refs-only `WorkbenchProjectionSnapshot`
    // into the Console's rich display `WorkbenchSnapshot`.
    .package(path: "../FridayRustClient"),
  ],
  targets: [
    // Core: rich display snapshot model + mock + view models + the real-client adapter/factory.
    // Kept UI-free so view-model truth rules (incl. honest-unavailable) are unit-testable via
    // `swift test`. Depends on FridayRustClient for the read-client protocol + SealedWSReadClient.
    .target(
      name: "FridayHubConsoleCore",
      dependencies: [
        .product(name: "FridayRustClient", package: "FridayRustClient"),
      ],
      path: "Sources/FridayHubConsoleCore"
    ),
    // Executable: the SwiftUI shell (three-pane Hub Console + Operations Overview).
    .executableTarget(
      name: "FridayHubConsole",
      dependencies: ["FridayHubConsoleCore"],
      path: "Sources/FridayHubConsole"
    ),
    .testTarget(
      name: "FridayHubConsoleCoreTests",
      dependencies: [
        "FridayHubConsoleCore",
        .product(name: "FridayRustClient", package: "FridayRustClient"),
      ],
      path: "Tests/FridayHubConsoleCoreTests"
    ),
  ]
)
