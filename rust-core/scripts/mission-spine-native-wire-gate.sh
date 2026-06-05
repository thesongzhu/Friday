#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

swift_out="${SWIFT_BINDGEN_OUT:-/tmp/friday-ffi-bindgen-swift}"
kotlin_out="${KOTLIN_BINDGEN_OUT:-/tmp/friday-ffi-bindgen-kotlin}"

echo "[mission-spine-native] fmt check"
cargo fmt --all -- --check

echo "[mission-spine-native] FFI contract tests"
cargo test -p friday-ffi -- --test-threads=1

echo "[mission-spine-native] build cdylib/staticlib surface"
cargo build -p friday-ffi

echo "[mission-spine-native] generate Swift bindings"
rm -rf "$swift_out"
mkdir -p "$swift_out"
cargo run -p friday-ffi --bin uniffi-bindgen -- \
  generate --library target/debug/libfriday_ffi.dylib --language swift --out-dir "$swift_out"

echo "[mission-spine-native] generate Kotlin bindings"
rm -rf "$kotlin_out"
mkdir -p "$kotlin_out"
cargo run -p friday-ffi --bin uniffi-bindgen -- \
  generate --library target/debug/libfriday_ffi.dylib --language kotlin --out-dir "$kotlin_out"

echo "[mission-spine-native] verify native-visible Mission Spine helpers"
for required in \
  sampleMissionSpineResponses \
  connectionTruthLabel \
  offlineActionTruthLabel \
  offlineActionStateImpliesCompletion \
  missionIntakeAllowsNewWork \
  missionIntakeShouldOpenExisting \
  missionWorkItemStatusImpliesCompletion \
  missionWorkItemStatusIsTerminal \
  missionTimelineLinkGrantsConfirmedMemoryAuthority
do
  rg -q "$required" "$swift_out" "$kotlin_out"
done

echo "[mission-spine-native] NATIVE/WIRE CONTRACT PASSED"
echo "[mission-spine-native] This is bindgen + fixture proof, not real UI/device/live API proof."
