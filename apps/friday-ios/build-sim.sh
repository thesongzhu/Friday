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

usage() {
  cat <<'USAGE'
Usage:
  apps/friday-ios/build-sim.sh [screenshot-path]
  apps/friday-ios/build-sim.sh --mode offline-truth [--shot screenshot-path]
  apps/friday-ios/build-sim.sh --mode live-loopback [--shot screenshot-path]

Modes:
  offline-truth  Default. Launches with all FRIDAY_MOBILE_LIVE_* gates OFF and proves the
                 shipped app renders honest-unavailable instead of fabricated ready state.
  live-loopback  Explicit local proof mode. Launches with the existing simulator live gates ON
                 (read/write/pairing/device-keypair) so the app attempts real loopback seams.
                 It still does not flip shipped defaults, mint trust, or hold signing keys.
USAGE
}

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/.build-sim"
APP="$BUILD/FridayShell.app"
MODE="offline-truth"
SHOT="$BUILD/friday-ios-sim.png"
IOS_VERSION="17.0"
TRIPLE="arm64-apple-ios${IOS_VERSION}-simulator"   # Apple-Silicon host (arm64 sim slice)

APPSRC="$HERE/Sources/FridayMobileShell"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --mode requires a value" >&2
        usage >&2
        exit 2
      fi
      MODE="$2"
      shift 2
      ;;
    --shot)
      if [[ $# -lt 2 ]]; then
        echo "ERROR: --shot requires a path" >&2
        usage >&2
        exit 2
      fi
      SHOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "ERROR: unknown option $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      # Backward-compatible positional screenshot path.
      SHOT="$1"
      shift
      ;;
  esac
done

case "$MODE" in
  offline|offline-truth)
    MODE="offline-truth"
    ;;
  live|live-loopback)
    MODE="live-loopback"
    ;;
  *)
    echo "ERROR: unsupported --mode '$MODE'" >&2
    usage >&2
    exit 2
    ;;
esac

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

# Bundle the FridayMobileShellCore resource bundle (the pet engine + v9 assets + mobile
# pet-host.html, declared `.copy("PetResources")`) into the .app. `Bundle.module` (used by
# `MobilePetScheme` to serve the pet over the `friday-pet://` scheme) resolves this bundle next
# to the executable inside the .app — so the 155px v9 Hero Pet renders LOCALLY (zero token, no
# network). Without this, the pet host page 404s its `/source/...` fetches and the canvas is blank.
echo "== 2b. copy the pet resource bundle into the .app =="
PET_BUNDLE="$SPMBIN/FridayMobileShell_FridayMobileShellCore.bundle"
if [ ! -d "$PET_BUNDLE" ]; then
  echo "ERROR: pet resource bundle not found at $PET_BUNDLE (did the .copy(\"PetResources\") build?)" >&2
  exit 1
fi
cp -R "$PET_BUNDLE" "$APP/"

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
LAUNCH_ARGS=()
LAUNCH_ENV=()
case "$MODE" in
  offline-truth)
    echo "launch mode: offline-truth (all mobile live gates OFF)"
    ;;
  live-loopback)
    echo "launch mode: live-loopback (explicit FRIDAY_MOBILE_LIVE_* gates ON)"
    LAUNCH_ARGS=(--live-read --live-write --live-pairing --live-device-keypair)
    LAUNCH_ARGS+=(--simulator-file-device-keypair)
    LAUNCH_ENV=(
      SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ=1
      SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_WRITE=1
      SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_PAIRING=1
      SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_DEVICE_KEYPAIR=1
      SIMCTL_CHILD_FRIDAY_MOBILE_SIMULATOR_FILE_DEVICE_KEYPAIR=1
    )
    if [[ -n "${FRIDAY_MOBILE_LIVE_READ_HOST:-}" ]]; then
      LAUNCH_ENV+=(SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_HOST="$FRIDAY_MOBILE_LIVE_READ_HOST")
    fi
    if [[ -n "${FRIDAY_MOBILE_LIVE_READ_PORT:-}" ]]; then
      LAUNCH_ENV+=(SIMCTL_CHILD_FRIDAY_MOBILE_LIVE_READ_PORT="$FRIDAY_MOBILE_LIVE_READ_PORT")
    fi
    ;;
esac
env "${LAUNCH_ENV[@]}" xcrun simctl launch --terminate-running-process "$UDID" com.friday.shell "${LAUNCH_ARGS[@]}"
# Give the WKWebView time to load the host page over `friday-pet://`, fetch the bundled engine +
# v9 assets, and start the canvas animation before the screenshot. Per the design CLAUDE.md hard
# rule 5, the pet is verified by the RENDERED image (open $SHOT), not by code/bbox numbers — a
# scheme/fetch bug yields a BLANK card (the host page sets window.__petError), so inspect the shot.
sleep 6
xcrun simctl io "$UDID" screenshot "$SHOT"
SIMULATOR_DEVICE_PUBKEY_JSON=null
LIVE_READ_HOST_OVERRIDE_JSON=null
LIVE_READ_PORT_OVERRIDE_JSON=null
if [[ "$MODE" == "live-loopback" ]]; then
  if [[ -n "${FRIDAY_MOBILE_LIVE_READ_HOST:-}" && "$FRIDAY_MOBILE_LIVE_READ_HOST" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    LIVE_READ_HOST_OVERRIDE_JSON="\"$FRIDAY_MOBILE_LIVE_READ_HOST\""
  fi
  if [[ -n "${FRIDAY_MOBILE_LIVE_READ_PORT:-}" && "$FRIDAY_MOBILE_LIVE_READ_PORT" =~ ^[0-9]+$ ]]; then
    LIVE_READ_PORT_OVERRIDE_JSON="\"$FRIDAY_MOBILE_LIVE_READ_PORT\""
  fi
  DATA_CONTAINER="$(xcrun simctl get_app_container "$UDID" com.friday.shell data 2>/dev/null || true)"
  PUBKEY_FILE="$DATA_CONTAINER/Library/Application Support/FridayShellSimulatorProof/device-pubkey-v1.txt"
  if [[ -n "$DATA_CONTAINER" && -f "$PUBKEY_FILE" ]]; then
    PUBKEY_HEX="$(tr -d '\r\n' < "$PUBKEY_FILE")"
    if [[ "$PUBKEY_HEX" =~ ^[0-9a-fA-F]{64}$ ]]; then
      PUBKEY_HEX_LOWER="$(printf '%s' "$PUBKEY_HEX" | tr '[:upper:]' '[:lower:]')"
      SIMULATOR_DEVICE_PUBKEY_JSON="\"$PUBKEY_HEX_LOWER\""
    fi
  fi
fi
cat > "$SHOT.metadata.json" <<JSON
{
  "truth_label": "friday_ios_simulator_${MODE}_proof",
  "mode": "$MODE",
  "bundle_id": "com.friday.shell",
  "screenshot": "$SHOT",
  "live_read_requested": $([[ "$MODE" == "live-loopback" ]] && echo true || echo false),
  "live_write_requested": $([[ "$MODE" == "live-loopback" ]] && echo true || echo false),
  "live_pairing_requested": $([[ "$MODE" == "live-loopback" ]] && echo true || echo false),
  "device_keypair_requested": $([[ "$MODE" == "live-loopback" ]] && echo true || echo false),
  "simulator_file_device_keypair_requested": $([[ "$MODE" == "live-loopback" ]] && echo true || echo false),
  "live_read_host_override": $LIVE_READ_HOST_OVERRIDE_JSON,
  "live_read_port_override": $LIVE_READ_PORT_OVERRIDE_JSON,
  "simulator_device_pubkey": $SIMULATOR_DEVICE_PUBKEY_JSON,
  "caveat": "offline-truth proves honest-unavailable; live-loopback attempts real local read/write/pairing seams but does not claim END-BAR, GO-LIVE, adoption, trust minting, or operator signing."
}
JSON
echo "screenshot: $SHOT"
echo "metadata: $SHOT.metadata.json"
echo "VERIFY: open the screenshot and confirm the 155px Hero Pet card shows the v9 DOG (not blank)."
if [[ "$MODE" == "offline-truth" ]]; then
  echo "VERIFY: offline-truth mode should honestly show unavailable/disabled state, not a fabricated ready product."
else
  echo "VERIFY: live-loopback mode should show live read/write/pairing requests and any real seam failure AS truth."
fi
