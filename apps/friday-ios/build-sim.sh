#!/usr/bin/env bash
# M-PR1 — build the Friday Mobile iOS SHELL for the SIMULATOR, install it, and
# screenshot it. This is the read-only v1 mobile UI shell: Home (Status + top-bar
# 💬 chat-entry + heroPet + cardsQueues) + the full-screen pet-centered Friday Chat
# skeleton + the Command Sheet launcher, all reading a `WorkbenchSnapshot` through
# the `FridayRustReadClient` protocol backed by `MockReadClient`.
#
# M-PR1 has NO Rust/UniFFI seam (the real `FridayRustClient` package is integrated
# in a later PR via the same protocol), so — unlike the old prototype — this script
# does NOT cross-compile a Rust staticlib or generate UniFFI bindings. It compiles
# the UI-free `FridayMobileShellCore` as a Swift module, then compiles the SwiftUI
# app against it for the iOS Simulator SDK.
#
# The UI-FREE core + its truth tests are also runnable on the host with no Xcode:
#   swift test
#
# Device/simulator SCREENSHOT proof is operator-gated (needs Xcode + a booted
# simulator / physical device); this script is a LOCAL proof, not a CI step.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/.build-sim"
APP="$BUILD/FridayShell.app"
SHOT="${1:-$BUILD/friday-ios-sim.png}"
TARGET="arm64-apple-ios17.0-simulator"  # Apple-Silicon host (arm64 sim slice)

CORE="$HERE/Sources/FridayMobileShellCore"
APPSRC="$HERE/Sources/FridayMobileShell"

rm -rf "$BUILD"; mkdir -p "$BUILD" "$APP"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

echo "== 1. compile FridayMobileShellCore as a Swift module (UI-free) =="
xcrun --sdk iphonesimulator swiftc \
    -target "$TARGET" -sdk "$SDK" \
    -emit-module -emit-library -static \
    -module-name FridayMobileShellCore \
    -emit-module-path "$BUILD/FridayMobileShellCore.swiftmodule" \
    -o "$BUILD/libFridayMobileShellCore.a" \
    "$CORE"/*.swift

echo "== 2. compile the SwiftUI app against the core module =="
xcrun --sdk iphonesimulator swiftc \
    -target "$TARGET" -sdk "$SDK" \
    -I "$BUILD" -L "$BUILD" -lFridayMobileShellCore \
    "$APPSRC"/*.swift \
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
