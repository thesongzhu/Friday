#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-companion-build] macOS is required." >&2
  exit 78
fi

SWIFT_BIN="$(command -v swift || true)"
if [[ -z "${SWIFT_BIN}" ]]; then
  echo "[friday-companion-build] swift not found in PATH." >&2
  exit 78
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-companion-build] node not found in PATH." >&2
  exit 78
fi

PACKAGE_DIR="${REPO_DIR}/apps/macos/FridayCompanion"
INFO_TEMPLATE="${PACKAGE_DIR}/Info.plist"
ENTITLEMENTS="${PACKAGE_DIR}/FridayCompanion.entitlements"
BUILD_CONFIGURATION="${FRIDAY_SYSTEM_COMPANION_BUILD_CONFIGURATION:-release}"
if [[ -n "${FRIDAY_SYSTEM_COMPANION_DIST_DIR:-}" ]]; then
  DIST_DIR="${FRIDAY_SYSTEM_COMPANION_DIST_DIR}"
else
  BUILD_ROOT_ID="$(printf '%s' "${REPO_DIR}" | cksum | awk '{print $1}')"
  DIST_DIR="${TMPDIR:-/tmp}/friday-companion-build/${BUILD_ROOT_ID}/macos"
fi
APP_NAME="FridayCompanion.app"
APP_DIR="${DIST_DIR}/${APP_NAME}"
APP_BINARY="${APP_DIR}/Contents/MacOS/FridayCompanion"
APP_PLIST="${APP_DIR}/Contents/Info.plist"
APP_VERSION="${FRIDAY_MACOS_APP_VERSION:-$("${NODE_BIN}" -p "require('./package.json').version")}"
APP_BUILD="${FRIDAY_MACOS_APP_BUILD:-${APP_VERSION}}"
BUNDLE_IDENTIFIER="${FRIDAY_MACOS_BUNDLE_IDENTIFIER:-com.friday.FridayCompanion}"
SIGN_MODE="${FRIDAY_MACOS_CODESIGN_MODE:-adhoc}"
SIGN_IDENTITY="${FRIDAY_MACOS_CODESIGN_IDENTITY:-}"
SPARKLE_PUBLIC_KEY="${FRIDAY_MACOS_SPARKLE_PUBLIC_KEY:-}"
SPARKLE_FEED_URL=""
SPARKLE_VERSION="${FRIDAY_MACOS_SPARKLE_VERSION:-2.9.0}"
SPARKLE_CACHE_DIR="${FRIDAY_MACOS_SPARKLE_CACHE_DIR:-${REPO_DIR}/.friday/cache/sparkle/${SPARKLE_VERSION}}"
SPARKLE_FRAMEWORK_DIR=""

if [[ -n "${FRIDAY_MACOS_APPCAST_BASE_URL:-}" ]]; then
  SPARKLE_FEED_URL="${FRIDAY_MACOS_APPCAST_BASE_URL%/}/appcast.xml"
fi

if [[ ! -f "${PACKAGE_DIR}/Package.swift" ]]; then
  echo "[friday-companion-build] missing Swift package at ${PACKAGE_DIR}" >&2
  exit 78
fi

case "${SIGN_MODE}" in
  adhoc|identity|skip) ;;
  *)
    echo "[friday-companion-build] invalid FRIDAY_MACOS_CODESIGN_MODE=${SIGN_MODE}; expected adhoc|identity|skip." >&2
    exit 78
    ;;
esac

ensure_sparkle_cache() {
  local framework_dir="${SPARKLE_CACHE_DIR}/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
  local appcast_tool="${SPARKLE_CACHE_DIR}/bin/generate_appcast"
  local key_tool="${SPARKLE_CACHE_DIR}/bin/generate_keys"

  if [[ -d "${framework_dir}" && -x "${appcast_tool}" && -x "${key_tool}" ]]; then
    SPARKLE_FRAMEWORK_DIR="${framework_dir}"
    return
  fi

  local download_url="https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-for-Swift-Package-Manager.zip"
  local temp_dir
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/friday-sparkle.XXXXXX")"
  trap 'rm -rf "${temp_dir}"' RETURN

  mkdir -p "${SPARKLE_CACHE_DIR}"
  curl -L --fail --silent --show-error "${download_url}" -o "${temp_dir}/Sparkle.zip"
  unzip -q "${temp_dir}/Sparkle.zip" -d "${temp_dir}/unzipped"
  rm -rf "${SPARKLE_CACHE_DIR}"
  mkdir -p "$(dirname "${SPARKLE_CACHE_DIR}")"
  mv "${temp_dir}/unzipped" "${SPARKLE_CACHE_DIR}"
  SPARKLE_FRAMEWORK_DIR="${SPARKLE_CACHE_DIR}/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
}

codesign_identity_path() {
  local target_path="$1"
  shift || true

  /usr/bin/codesign \
    --force \
    --options runtime \
    --timestamp \
    "$@" \
    --sign "${SIGN_IDENTITY}" \
    "${target_path}"
}

sign_embedded_identity_items() {
  local frameworks_dir="${APP_DIR}/Contents/Frameworks"
  if [[ ! -d "${frameworks_dir}" ]]; then
    return
  fi

  local signable
  while IFS= read -r signable; do
    [[ -z "${signable}" ]] && continue
    echo "[friday-companion-build] signing embedded helper ${signable}" >&2
    codesign_identity_path "${signable}"
  done < <(
    find "${frameworks_dir}" -type f -name "Autoupdate" | LC_ALL=C sort -r
  )

  while IFS= read -r signable; do
    [[ -z "${signable}" ]] && continue
    echo "[friday-companion-build] signing embedded bundle ${signable}" >&2
    codesign_identity_path "${signable}"
  done < <(
    find "${frameworks_dir}" -type d \( -name "*.xpc" -o -name "*.appex" -o -name "*.app" -o -name "*.framework" \) \
      | LC_ALL=C sort -r
  )
}

echo "[friday-companion-build] building Swift companion (${BUILD_CONFIGURATION})" >&2
"${SWIFT_BIN}" build \
  -c "${BUILD_CONFIGURATION}" \
  --package-path "${PACKAGE_DIR}" \
  -Xlinker -rpath \
  -Xlinker @executable_path/../Frameworks \
  >&2

SWIFT_BINARY="${PACKAGE_DIR}/.build/${BUILD_CONFIGURATION}/FridayCompanion"
if [[ ! -x "${SWIFT_BINARY}" ]]; then
  echo "[friday-companion-build] missing built binary: ${SWIFT_BINARY}" >&2
  exit 78
fi

rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
cp "${SWIFT_BINARY}" "${APP_BINARY}"

sed \
  -e "s#__APP_VERSION__#${APP_VERSION}#g" \
  -e "s#__APP_BUILD__#${APP_BUILD}#g" \
  -e "s#__BUNDLE_IDENTIFIER__#${BUNDLE_IDENTIFIER}#g" \
  "${INFO_TEMPLATE}" > "${APP_PLIST}"

printf 'APPL????' > "${APP_DIR}/Contents/PkgInfo"

if [[ -n "${SPARKLE_FEED_URL}" || -n "${SPARKLE_PUBLIC_KEY}" ]]; then
  ensure_sparkle_cache
fi

if [[ -n "${SPARKLE_FRAMEWORK_DIR}" && -d "${SPARKLE_FRAMEWORK_DIR}" ]]; then
  mkdir -p "${APP_DIR}/Contents/Frameworks"
  cp -R "${SPARKLE_FRAMEWORK_DIR}" "${APP_DIR}/Contents/Frameworks/"
  chmod -R a+rX "${APP_DIR}/Contents/Frameworks/Sparkle.framework"
fi

if [[ -n "${SPARKLE_FEED_URL}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :SUFeedURL string ${SPARKLE_FEED_URL}" "${APP_PLIST}" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Set :SUFeedURL ${SPARKLE_FEED_URL}" "${APP_PLIST}"
fi

if [[ -n "${SPARKLE_PUBLIC_KEY}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string ${SPARKLE_PUBLIC_KEY}" "${APP_PLIST}" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Set :SUPublicEDKey ${SPARKLE_PUBLIC_KEY}" "${APP_PLIST}"
fi

if [[ -n "${SPARKLE_FEED_URL}" && -n "${SPARKLE_PUBLIC_KEY}" ]]; then
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool true" "${APP_PLIST}" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Set :SUEnableAutomaticChecks true" "${APP_PLIST}"
fi

if [[ -x /usr/bin/xattr ]]; then
  /usr/bin/xattr -cr "${APP_DIR}"
  while IFS= read -r -d '' bundle_path; do
    /usr/bin/xattr -d com.apple.FinderInfo "${bundle_path}" >/dev/null 2>&1 || true
    /usr/bin/xattr -d 'com.apple.fileprovider.fpfs#P' "${bundle_path}" >/dev/null 2>&1 || true
  done < <(find "${APP_DIR}" -print0)
fi

case "${SIGN_MODE}" in
  skip)
    echo "[friday-companion-build] leaving app unsigned at ${APP_DIR}" >&2
    ;;
  adhoc)
    echo "[friday-companion-build] applying ad-hoc signature" >&2
    /usr/bin/codesign --force --deep --sign - "${APP_DIR}"
    ;;
  identity)
    if [[ -z "${SIGN_IDENTITY}" ]]; then
      echo "[friday-companion-build] FRIDAY_MACOS_CODESIGN_IDENTITY is required when SIGN_MODE=identity." >&2
      exit 78
    fi
    echo "[friday-companion-build] signing with identity ${SIGN_IDENTITY}" >&2
    sign_embedded_identity_items
    codesign_identity_path "${APP_DIR}" --entitlements "${ENTITLEMENTS}"
    ;;
esac

echo "${APP_DIR}"
