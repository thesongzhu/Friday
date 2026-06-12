#!/usr/bin/env bash
# Unit 5b — build the Friday native iOS shell for the SIMULATOR, install it, and
# screenshot it. Proves the SwiftUI app renders values computed by the all-Rust
# core via the generated UniFFI Swift bindings, AND now links the REAL sealed-WS
# Rust client (the `FridayiOSCore` SPM package → `FridayRustClient` + swift-sodium)
# so the Home read surface + the Friday Chat read-WRITE S6 loop are the on-device
# integration, not a mock.
#
# Toolchain reconciliation (see goal file 33): the stable rustup toolchain has the
# iOS std but brew rust 1.95.0 shadows it, so we put the toolchain's own bin dir
# FIRST on PATH (rust-toolchain.toml is left untouched for CI reproducibility).
#
# NOTE (deferred local AC): the iOS-sim *link + screenshot* (steps 5b/6–7 below)
# remain a LOCAL proof gated on a booted simulator + the rustup iOS toolchain — the
# same deferred tier as the live `NWConnection` transport. The host `swift build`
# (the `FridayiOSCore` package) + `swift test` (the view-model truth rules:
# send→answer, mutating→paused→approval, approve→resume verbatim relay, INV-1/2/5,
# honest-unavailable) are the CI-grade proof. The shell's iOS-sim compile is verified
# by typechecking `Sources/FridayApp.swift` against the ios-sim-cross-compiled core
# (see the PR body); it is NOT a CI step (needs Xcode + the iOS toolchain + bindings).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUSTCORE="$(cd "$HERE/../../rust-core" && pwd)"
TC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
BUILD="$HERE/.build"
APP="$BUILD/FridayShell.app"
SIM_TARGET="aarch64-apple-ios-sim"
SWIFT_TARGET="arm64-apple-ios17.0-simulator"
SHOT="${1:-$BUILD/friday-ios-sim.png}"

# Keep the SPM build dir OUTSIDE $BUILD (which is wiped below) so the package's
# resolved deps (swift-sodium) survive across runs.
SPM_BUILD="$HERE/.spm-build"

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

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

echo "== 4. cross-compile the FridayiOSCore SPM package for the simulator =="
# Build the REAL integration core (FridayiOSCore → FridayRustClient → swift-sodium)
# for the ios-sim destination. SwiftPM resolves + cross-compiles the Sodium
# xcframework + FridayRustClient (we let SwiftPM own libsodium rather than hand-feed
# it to swiftc). The module-search dir + the per-product static archives are then fed
# to the app's swiftc link.
( cd "$HERE" && swift build \
    --scratch-path "$SPM_BUILD" \
    --sdk "$SDK" \
    -Xswiftc -target -Xswiftc "$SWIFT_TARGET" \
    -Xcc -target -Xcc "$SWIFT_TARGET" )
# SwiftPM compiles the Swift library targets to per-target `.o` OBJECT files (a `.library`
# product is not archived to a standalone `.a`), and emits the `.swiftmodule` files under the
# canonical Modules dir (reached via the `debug` symlink). Only the C `Clibsodium` target ships
# a real `libsodium.a` (vendored in the xcframework's ios-sim slice). So we link the Swift
# targets' object files directly + the libsodium archive.
CORE_DEBUG="$SPM_BUILD/debug" # symlink → arm64-apple-macosx/debug (objects + Modules live here)
CORE_MODULES="$CORE_DEBUG/Modules"
SODIUM_SLICE="$SPM_BUILD/checkouts/swift-sodium/Clibsodium.xcframework/ios-arm64_i386_x86_64-simulator"
SODIUM_HDR="$SODIUM_SLICE/Headers"
# The compiled object files of the three Swift targets (ios-sim arm64).
CORE_OBJS=()
for t in FridayiOSCore FridayRustClient Sodium; do
  while IFS= read -r o; do CORE_OBJS+=("$o"); done < <(find "$CORE_DEBUG/$t.build" -name '*.o' 2>/dev/null)
done

echo "== 5. compile + link SwiftUI app for the simulator =="
# Apple-Silicon host only (arm64 sim slice). The Rust core is linked as the
# STATIC archive by full path (cargo also emits a .dylib used only for bindgen;
# `-l` would prefer that .dylib, so we pass the .a explicitly) — the resulting
# executable is self-contained, with no dependency on a build-tree dylib path.
# The FridayiOSCore + FridayRustClient + Sodium object files + the vendored
# libsodium.a are linked the same way (by full path), so the app embeds the real
# sealed-WS client.
mkdir -p "$APP"
xcrun --sdk iphonesimulator swiftc \
    -target "$SWIFT_TARGET" \
    -sdk "$SDK" \
    -I "$BUILD/headers" \
    -I "$CORE_MODULES" \
    -I "$SODIUM_HDR" \
    -lc++ -framework Security -framework SystemConfiguration \
    "$HERE/Sources/FridayApp.swift" "$BUILD/bindings/friday_ffi.swift" \
    "${CORE_OBJS[@]}" \
    -Xlinker "$LIBDIR/libfriday_ffi.a" \
    -Xlinker "$SODIUM_SLICE/libsodium.a" \
    -o "$APP/FridayShell"
cp "$HERE/Info.plist" "$APP/Info.plist"

echo "== 6. pick a simulator =="
UDID="$(xcrun simctl list devices available | grep -Eo '\(([0-9A-F-]{36})\) \(Booted\)' | grep -Eo '[0-9A-F-]{36}' | head -1 || true)"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices available | grep -E 'iPhone' | grep -Eo '[0-9A-F-]{36}' | head -1)"
  echo "booting $UDID"; xcrun simctl boot "$UDID" || true
fi
echo "using simulator $UDID"
open -a Simulator || true

echo "== 7. install + launch + screenshot =="
xcrun simctl install "$UDID" "$APP"
xcrun simctl launch "$UDID" com.friday.shell
sleep 4
xcrun simctl io "$UDID" screenshot "$SHOT"
echo "screenshot: $SHOT"
