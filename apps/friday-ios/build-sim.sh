#!/usr/bin/env bash
# Build the Friday Mobile iOS SHELL for the SIMULATOR, install it, and screenshot it.
# This is the v1 mobile UI shell wired to the REAL Rust clients: Home (Status + top-bar 💬
# chat-entry + heroPet) reading the refs-only Mission Workbench projection over the package's
# `SealedWSReadClient`, + the full-screen pet-centered Friday Chat read-WRITE / S6 surface over
# `SealedWSWriteClient` + the `OperatorSigner` relay, + the Command Sheet launcher.
#
# The shell now depends on the `FridayRustClient` SPM package, which depends on swift-sodium
# (libsodium via the vendored `Clibsodium.xcframework`). So — unlike the prior mock-only shell —
# this script cannot hand-compile the core with a single bare `swiftc`. Instead it:
#   1. cross-compiles the WHOLE SPM dependency graph (Sodium + FridayRustClient +
#      FridayMobileShellCore) for the iOS Simulator triple via `swift build --triple …`
#      (this resolves swift-sodium and links the xcframework's ios-simulator libsodium slice), then
#   2. compiles the iOS-only SwiftUI app sources against those sim-built modules with `swiftc`,
#      linking the modules' object files + `libsodium.a`.
#
# The UI-FREE core + its truth tests are also runnable on the host with no Xcode:
#   swift build && swift test     # the REAL gate (19 XCTest cases: chat-S6 loop + home read)
#
# Device/simulator SCREENSHOT proof is operator-gated (needs Xcode + a booted simulator /
# physical device); this script is a LOCAL proof, not a CI step.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/.build-sim"
APP="$BUILD/FridayShell.app"
SHOT="${1:-$BUILD/friday-ios-sim.png}"
IOS_VERSION="17.0"
TRIPLE="arm64-apple-ios${IOS_VERSION}-simulator"   # Apple-Silicon host (arm64 sim slice)

APPSRC="$HERE/Sources/FridayMobileShell"

rm -rf "$BUILD"; mkdir -p "$BUILD" "$APP"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

echo "== 1. cross-compile the SPM dependency graph (Sodium + FridayRustClient + core) for the sim =="
# Builds all module .swiftmodule + per-module .o object files + the ios-simulator libsodium.a.
swift build --package-path "$HERE" \
    --triple "$TRIPLE" --sdk "$SDK" -c release
SPMBIN="$(swift build --package-path "$HERE" --triple "$TRIPLE" --sdk "$SDK" -c release --show-bin-path)"
MODULES="$SPMBIN/Modules"

# Collect the Swift modules' object files + the sim libsodium static archive to link into the app.
CORE_OBJS=(
    "$SPMBIN"/FridayMobileShellCore.build/*.o
    "$SPMBIN"/FridayRustClient.build/*.o
    "$SPMBIN"/Sodium.build/*.o
)
LIBSODIUM="$SPMBIN/libsodium.a"

# The `Sodium` Swift module transitively imports the C `Clibsodium` module; its module map +
# headers for the ios-simulator slice live in the vendored xcframework. Feed that module map so
# the app `swiftc` can resolve `Clibsodium` (otherwise: "missing required module 'Clibsodium'").
CLIBSODIUM_HEADERS="$HERE/.build/checkouts/swift-sodium/Clibsodium.xcframework/ios-arm64_i386_x86_64-simulator/Headers"

echo "== 2. compile the iOS-only SwiftUI app against the sim-built modules =="
xcrun --sdk iphonesimulator swiftc \
    -target "$TRIPLE" -sdk "$SDK" \
    -I "$MODULES" \
    -I "$CLIBSODIUM_HEADERS" \
    -Xcc -fmodule-map-file="$CLIBSODIUM_HEADERS/module.modulemap" \
    "$APPSRC"/*.swift \
    "${CORE_OBJS[@]}" \
    "$LIBSODIUM" \
    -o "$APP/FridayShell"
cp "$HERE/Info.plist" "$APP/Info.plist"

echo "== 3. pick a simulator =="
UDID="$(xcrun simctl list devices available | grep -Eo '\(([0-9A-F-]{36})\) \(Booted\)' | grep -Eo '[0-9A-F-]{36}' | head -1 || true)"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available | grep -E 'iPhone' | grep -Eo '[0-9A-F-]{36}' | head -1)"
  echo "booting $UDID"; xcrun simctl boot "$UDID" || true
fi
echo "using simulator $UDID"
open -a Simulator || true

echo "== 4. install + launch + screenshot =="
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.friday.shell
sleep 4
xcrun simctl io "$UDID" screenshot "$SHOT"
echo "screenshot: $SHOT"
