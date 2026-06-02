#!/usr/bin/env bash
# Unit 5c — build the Friday native Android shell, install it on the running
# emulator, and screenshot it. Proves the Activity renders values computed by the
# all-Rust core via the generated UniFFI Kotlin bindings.
#
# Toolchain (see goal files 33/34): the iOS-style "stable rustup bin first on PATH"
# fix (brew rust 1.95.0 lacks the mobile std and shadows it), plus the Android NDK
# clang as the C cross-compiler / linker for the bundled-SQLite build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RUSTCORE="$(cd "$HERE/../../rust-core" && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
NDK="$SDK/ndk/30.0.14904198"
PB="$NDK/toolchains/llvm/prebuilt/darwin-x86_64/bin"
TC="$HOME/.rustup/toolchains/stable-aarch64-apple-darwin/bin"
RUST_TARGET="aarch64-linux-android"   # emulator on Apple Silicon is arm64-v8a
ABI="arm64-v8a"
API=24
SHOT="${1:-$HERE/.build/friday-android-emu.png}"

mkdir -p "$HERE/.build"
echo "sdk.dir=$SDK" > "$HERE/local.properties"

echo "== 1. cross-compile the .so via the NDK clang =="
( cd "$RUSTCORE" && env \
    "CC_${RUST_TARGET}=$PB/${RUST_TARGET}${API}-clang" \
    "CXX_${RUST_TARGET}=$PB/${RUST_TARGET}${API}-clang++" \
    "AR_${RUST_TARGET}=$PB/llvm-ar" \
    "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER=$PB/${RUST_TARGET}${API}-clang" \
    "PATH=$TC:$PATH" \
    cargo build -p friday-ffi --target "$RUST_TARGET" )
SO="$RUSTCORE/target/$RUST_TARGET/debug/libfriday_ffi.so"

echo "== 2. generate Kotlin bindings =="
( cd "$RUSTCORE" && PATH="$TC:$PATH" cargo run -q -p friday-ffi --bin uniffi-bindgen -- \
    generate --library "$SO" --language kotlin --out-dir "$HERE/.build/bindings" )

echo "== 3. stage bindings + .so into the app =="
rm -rf "$HERE/app/src/main/kotlin/uniffi" "$HERE/app/src/main/jniLibs" "$HERE/app/src/main/resources"
mkdir -p "$HERE/app/src/main/kotlin" "$HERE/app/src/main/jniLibs/$ABI"
cp -R "$HERE/.build/bindings/uniffi" "$HERE/app/src/main/kotlin/"
cp "$SO" "$HERE/app/src/main/jniLibs/$ABI/libfriday_ffi.so"

echo "== 4. assemble the debug APK =="
( cd "$HERE" && ANDROID_HOME="$SDK" gradle :app:assembleDebug --no-daemon )
APK="$HERE/app/build/outputs/apk/debug/app-debug.apk"

echo "== 5. install + launch + screenshot on the running emulator =="
ADB="$SDK/platform-tools/adb"
"$ADB" install -r "$APK"
"$ADB" shell am start -n com.friday.shell/.MainActivity
sleep 4
"$ADB" exec-out screencap -p > "$SHOT"
echo "screenshot: $SHOT"
