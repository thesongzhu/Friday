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
  targets: [
    // Core: snapshot truth model + read-only client protocol + mock + view models.
    // Kept UI-free so view-model truth rules are unit-testable via `swift test`.
    .target(
      name: "FridayHubConsoleCore",
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
      dependencies: ["FridayHubConsoleCore"],
      path: "Tests/FridayHubConsoleCoreTests"
    ),
  ]
)
