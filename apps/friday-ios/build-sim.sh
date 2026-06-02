#!/usr/bin/env bash
# Unit 5b — build the Friday native iOS shell for the SIMULATOR, install it, and
# screenshot it. Proves the SwiftUI app renders values computed by the all-Rust
# core via the generated UniFFI Swift bindings.
#
# Toolchain reconciliation (see goal file 33): the stable rustup toolchain has the
# iOS std but brew rust 1.95.0 shadows it, so we put the toolchain's own bin dir
# FIRST on PATH (rust-toolchain.toml is left untouched for CI reproducibility).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUSTCORE="$(cd "$HERE/../../rust-core" && pwd)"
TC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
BUILD="$HERE/.build"
APP="$BUILD/FridayShell.app"
SIM_TARGET="aarch64-apple-ios-sim"
SHOT="${1:-$BUILD/friday-ios-sim.png}"

rm -rf "$BUILD"; mkdir -p "$BUILD" "$BUILD/headers"

echo "== 1. build sim staticlib =="
( cd "$RUSTCORE" && PATH="$TC:$PATH" cargo build -p friday-ffi --target "$SIM_TARGET" )
LIBDIR="$RUSTCORE/target/$SIM_TARGET/debug"

echo "== 2. generate Swift bindings =="
( cd "$RUSTCORE" && PATH="$TC:$PATH" cargo run -q -p friday-ffi --bin uniffi-bindgen -- \
    generate --library "$LIBDIR/libfriday_ffi.dylib" --language swift --out-dir "$BUILD/bindings" )

echo "== 3. assemble module headers =="
cp "$BUILD/bindings/friday_ffiFFI.h" "$BUILD/headers/"
# clang discovers a module via a file named `module.modulemap` on the -I path.
cp "$BUILD/bindings/friday_ffiFFI.modulemap" "$BUILD/headers/module.modulemap"

echo "== 4. compile SwiftUI app for the simulator =="
# Apple-Silicon host only (arm64 sim slice). The Rust core is linked as the
# STATIC archive by full path (cargo also emits a .dylib used only for bindgen;
# `-l` would prefer that .dylib, so we pass the .a explicitly) — the resulting
# executable is self-contained, with no dependency on a build-tree dylib path.
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
mkdir -p "$APP"
xcrun --sdk iphonesimulator swiftc \
    -target arm64-apple-ios17.0-simulator \
    -sdk "$SDK" \
    -I "$BUILD/headers" \
    -lc++ -framework Security -framework SystemConfiguration \
    "$HERE/Sources/FridayApp.swift" "$BUILD/bindings/friday_ffi.swift" \
    -Xlinker "$LIBDIR/libfriday_ffi.a" \
    -o "$APP/FridayShell"
cp "$HERE/Info.plist" "$APP/Info.plist"

echo "== 5. pick a simulator =="
UDID="$(xcrun simctl list devices available | grep -Eo '\(([0-9A-F-]{36})\) \(Booted\)' | grep -Eo '[0-9A-F-]{36}' | head -1 || true)"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available | grep -E 'iPhone' | grep -Eo '[0-9A-F-]{36}' | head -1)"
  echo "booting $UDID"; xcrun simctl boot "$UDID" || true
fi
echo "using simulator $UDID"
open -a Simulator || true

echo "== 6. install + launch + screenshot =="
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.friday.shell
sleep 4
xcrun simctl io "$UDID" screenshot "$SHOT"
echo "screenshot: $SHOT"
