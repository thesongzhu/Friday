// swift-tools-version: 6.1
import PackageDescription

// FridayRustClient — the Swift client for the Rust read-projection server's sealed-WS
// protocol. Models its structure on `apps/macos/FridayCompanion/Package.swift` (a
// library + a test target). The crypto stack is split deliberately (see the file
// headers in Sources/FridayRustClient/Crypto.swift):
//   - X25519 ECDH + HKDF-SHA256 come from Apple CryptoKit (correct + matches Rust).
//   - XChaCha20-Poly1305 (24-byte nonce) comes from swift-sodium's `Sodium`
//     (libsodium binding). Apple CryptoKit's `ChaChaPoly` is the 12-byte IETF
//     variant and would NOT byte-match the Rust/TS side — so libsodium is mandatory.
// swift-sodium is pinned to an exact tag (the TS side pins @noble exact for the same
// reason: a crypto-primitive dep must never float).
let package = Package(
  name: "FridayRustClient",
  platforms: [
    .macOS(.v13),
    .iOS(.v16),
  ],
  products: [
    .library(name: "FridayRustClient", targets: ["FridayRustClient"]),
  ],
  dependencies: [
    // swift-sodium vendors a prebuilt `Clibsodium` binary xcframework, so there is NO
    // `brew install libsodium` system dependency — it is self-contained for CI.
    .package(url: "https://github.com/jedisct1/swift-sodium.git", exact: "0.9.1"),
  ],
  targets: [
    .target(
      name: "FridayRustClient",
      dependencies: [
        .product(name: "Sodium", package: "swift-sodium"),
      ],
      path: "Sources/FridayRustClient"
    ),
    .testTarget(
      name: "FridayRustClientTests",
      dependencies: ["FridayRustClient"],
      path: "Tests/FridayRustClientTests"
    ),
  ]
)
