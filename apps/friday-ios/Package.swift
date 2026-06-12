// swift-tools-version: 6.1
import PackageDescription

// Friday Mobile Shell — M-PR1 iOS SwiftUI app shell (the v1 mobile UI).
//
// Only the UI-FREE `FridayMobileShellCore` target is a SwiftPM target: the snapshot
// truth model + read-only client protocol + mock + view models. Keeping it UI-free
// means the M-PR1 truth rules are unit-testable on the host via `swift test`
// (no iOS device/simulator needed), exactly mirroring the desktop sibling #676.
//
// The SwiftUI iOS app itself (Sources/FridayMobileShell/*.swift) is NOT a SwiftPM
// target: it uses iOS-only APIs (NavigationStack toolbar placements, etc.) and
// cannot be plain-`swift build`-ed on a macOS host. It is compiled against the
// iOS Simulator SDK by `build-sim.sh` (swiftc), importing `FridayMobileShellCore`.
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
  targets: [
    .target(
      name: "FridayMobileShellCore",
      path: "Sources/FridayMobileShellCore"
    ),
    .testTarget(
      name: "FridayMobileShellCoreTests",
      dependencies: ["FridayMobileShellCore"],
      path: "Tests/FridayMobileShellCoreTests"
    ),
  ]
)
