// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "FridayCompanion",
  platforms: [
    .macOS(.v13),
  ],
  products: [
    .executable(name: "FridayCompanion", targets: ["FridayCompanion"]),
    .library(name: "FridayCompanionCore", targets: ["FridayCompanionCore"]),
  ],
  targets: [
    .target(
      name: "FridayCompanionCore",
      path: "Sources/FridayCompanionCore"
    ),
    .executableTarget(
      name: "FridayCompanion",
      dependencies: ["FridayCompanionCore"],
      path: "Sources/FridayCompanion"
    ),
    .testTarget(
      name: "FridayCompanionCoreTests",
      dependencies: ["FridayCompanionCore"],
      path: "Tests/FridayCompanionCoreTests"
    ),
  ]
)
