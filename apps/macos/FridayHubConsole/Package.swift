// swift-tools-version: 6.1
import PackageDescription

let package = Package(
  name: "FridayHubConsole",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .executable(name: "FridayHubConsole", targets: ["FridayHubConsole"]),
    .executable(name: "FridayPairingProof", targets: ["FridayPairingProof"]),
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
    // `PetResources/` is the design-handoff pet engine + v9 assets, copied VERBATIM and
    // declared as a `.copy` resource so the folder layout (`/source/pet/...`) is preserved 1:1
    // in the bundle — the `PetSchemeHandler` serves it to the Companion WKWebView over the
    // local `friday-pet://` scheme (zero token, no network, assets unmodified).
    .executableTarget(
      name: "FridayHubConsole",
      dependencies: ["FridayHubConsoleCore"],
      path: "Sources/FridayHubConsole",
      resources: [
        .copy("PetResources"),
      ]
    ),
    .executableTarget(
      name: "FridayPairingProof",
      dependencies: ["FridayHubConsoleCore"],
      path: "Sources/FridayPairingProof"
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
