// swift-tools-version: 6.1
import PackageDescription

// Friday Mobile Shell — the v1 mobile UI shell, now wired to the REAL Rust clients.
//
// The UI-FREE `FridayMobileShellCore` target carries the view models + the integration
// factory + the operator-signing RELAY seam. It depends on the `FridayRustClient` SPM
// package (the sealed-WS read/write clients + crypto, shared with the desktop), so the
// view-model truth rules + the chat read-WRITE / S6 loop are unit-testable on the host via
// `swift test` (no iOS device/simulator needed). The package's `WorkbenchSnapshot` +
// `FridayRustReadClient` / `FridayRustWriteClient` are the ONE authoritative
// snapshot/protocol across desktop + mobile (this shell adapter-bridges them to a small
// `Sendable` display projection — see FridayMobileShellCore/HomeViewModel.swift).
//
// The SwiftUI iOS app itself (Sources/FridayMobileShell/*.swift) is NOT a SwiftPM target:
// it uses iOS-only APIs (NavigationStack toolbar placements, etc.) and cannot be plain-
// `swift build`-ed on a macOS host. It is compiled against the iOS Simulator SDK by
// `build-sim.sh` (swiftc), importing `FridayMobileShellCore` + `FridayRustClient`.
let package = Package(
  name: "FridayMobileShell",
  platforms: [
    .iOS(.v17),
    // macOS only so the UI-FREE core + its tests build/run on a mac host.
    .macOS(.v13),
  ],
  products: [
    .library(name: "FridayMobileShellCore", targets: ["FridayMobileShellCore"])
  ],
  dependencies: [
    // The real sealed-WS Rust client package (read + write + crypto). Local path dep so the
    // mobile shell reconciles to the SAME clients the desktop integration uses.
    .package(path: "../macos/FridayRustClient"),
  ],
  targets: [
    .target(
      name: "FridayMobileShellCore",
      dependencies: [
        .product(name: "FridayRustClient", package: "FridayRustClient"),
      ],
      path: "Sources/FridayMobileShellCore"
    ),
    .testTarget(
      name: "FridayMobileShellCoreTests",
      dependencies: [
        "FridayMobileShellCore",
        .product(name: "FridayRustClient", package: "FridayRustClient"),
      ],
      path: "Tests/FridayMobileShellCoreTests"
    ),
  ]
)
