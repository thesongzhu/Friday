// swift-tools-version: 6.1
import PackageDescription

// Friday — native iOS app (Unit 5b) integration package.
//
// This package builds the iOS app's UI-FREE CORE — the integration layer + view
// models that wire the SwiftUI shell to the REAL Rust core over the sealed-WS seam:
//   - the real `SealedWSReadClient` (Home read projection),
//   - the real `SealedWSWriteClient` (the Friday Chat read-WRITE loop + S6 approval),
//   - the `OperatorSigner` relay seam (mock now; real = desktop signer PR #671, slice-6).
//
// It models its structure on `apps/macos/FridayHubConsole/Package.swift`: a UI-free
// `FridayiOSCore` LIBRARY (so the view-model truth rules are unit-testable with plain
// `swift test`, no Xcode/simulator/UniFFI bindings needed) + a test target. The SwiftUI
// shell (`Sources/FridayApp.swift`) is built SEPARATELY by `build-sim.sh` (it links the
// UniFFI `friday_ffi` staticlib + the simulator SDK, which `swift build` cannot do on a
// host) — so it is NOT a target here; only the host-buildable, host-testable core is.
//
// The lone product dependency is the local `FridayRustClient` SPM package (the real
// sealed-WS read+write client + Swift↔Rust crypto-parity stack); swift-sodium rides in
// transitively. The package's types WIN (one `WorkbenchSnapshot` / one client protocol).
let package = Package(
  name: "FridayiOS",
  platforms: [
    .iOS(.v16),
    .macOS(.v13), // host build/test of the UI-free core
  ],
  products: [
    .library(name: "FridayiOSCore", targets: ["FridayiOSCore"]),
  ],
  dependencies: [
    .package(name: "FridayRustClient", path: "../macos/FridayRustClient"),
  ],
  targets: [
    // The UI-free integration core: the Home read view model + the Friday Chat
    // read-WRITE view model (the 4-state S6 loop) + the OperatorSigner relay seam.
    // Kept UI-free so every truth rule (refs-only, honest-unavailable, INV-1/2/5) is
    // unit-testable via `swift test` with no simulator.
    .target(
      name: "FridayiOSCore",
      dependencies: [
        .product(name: "FridayRustClient", package: "FridayRustClient"),
      ],
      path: "Sources/FridayiOSCore"
    ),
    .testTarget(
      name: "FridayiOSCoreTests",
      dependencies: ["FridayiOSCore"],
      path: "Tests/FridayiOSCoreTests"
    ),
  ]
)
