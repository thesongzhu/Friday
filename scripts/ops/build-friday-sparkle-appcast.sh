#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-sparkle-appcast] macOS is required." >&2
  exit 78
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-sparkle-appcast] node not found in PATH." >&2
  exit 78
fi

if [[ -z "${FRIDAY_MACOS_SPARKLE_PRIVATE_KEY:-}" ]]; then
  echo "[friday-sparkle-appcast] FRIDAY_MACOS_SPARKLE_PRIVATE_KEY is required." >&2
  exit 78
fi

if [[ -z "${FRIDAY_MACOS_APPCAST_BASE_URL:-}" ]]; then
  echo "[friday-sparkle-appcast] FRIDAY_MACOS_APPCAST_BASE_URL is required." >&2
  exit 78
fi

SPARKLE_VERSION="${FRIDAY_MACOS_SPARKLE_VERSION:-2.9.0}"
SPARKLE_CACHE_DIR="${FRIDAY_MACOS_SPARKLE_CACHE_DIR:-${REPO_DIR}/.friday/cache/sparkle/${SPARKLE_VERSION}}"
SPARKLE_BIN_DIR="${SPARKLE_CACHE_DIR}/bin"
SPARKLE_GENERATE_APPCAST="${SPARKLE_BIN_DIR}/generate_appcast"
OUTPUT_DIR="${FRIDAY_MACOS_RELEASE_OUTPUT_DIR:-${REPO_DIR}/dist/releases/macos}"
CHANNELS_DIR="${REPO_DIR}/dist/releases/channels"
CHANNELS_DIR="${FRIDAY_RELEASE_CHANNELS_DIR:-${CHANNELS_DIR}}"
APPCAST_PATH="${OUTPUT_DIR}/appcast.xml"
APPCAST_URL="${FRIDAY_MACOS_APPCAST_BASE_URL%/}/appcast.xml"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friday-sparkle-appcast.XXXXXX")"
cleanup() {
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

ensure_sparkle_cache() {
  if [[ -x "${SPARKLE_GENERATE_APPCAST}" ]]; then
    return
  fi

  local download_url="https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-for-Swift-Package-Manager.zip"
  local fetch_dir
  fetch_dir="$(mktemp -d "${TMPDIR:-/tmp}/friday-sparkle-fetch.XXXXXX")"
  trap 'rm -rf "${TMP_DIR}" "${fetch_dir}"' EXIT

  mkdir -p "$(dirname "${SPARKLE_CACHE_DIR}")"
  curl -L --fail --silent --show-error "${download_url}" -o "${fetch_dir}/Sparkle.zip"
  unzip -q "${fetch_dir}/Sparkle.zip" -d "${fetch_dir}/unzipped"
  rm -rf "${SPARKLE_CACHE_DIR}"
  mv "${fetch_dir}/unzipped" "${SPARKLE_CACHE_DIR}"
}

resolve_private_key_file() {
  if [[ -f "${FRIDAY_MACOS_SPARKLE_PRIVATE_KEY}" ]]; then
    printf '%s\n' "${FRIDAY_MACOS_SPARKLE_PRIVATE_KEY}"
    return
  fi

  local key_file="${TMP_DIR}/sparkle-private-key.txt"
  printf '%s' "${FRIDAY_MACOS_SPARKLE_PRIVATE_KEY}" > "${key_file}"
  chmod 600 "${key_file}"
  printf '%s\n' "${key_file}"
}

ensure_sparkle_cache

ZIP_PATH="${FRIDAY_SYSTEM_COMPANION_ZIP_RELEASE_PATH:-}"
if [[ -z "${ZIP_PATH}" ]]; then
  ZIP_PATH="$(find "${OUTPUT_DIR}" -maxdepth 1 -type f -name 'FridayCompanion-*-macos-*.zip' | sort | tail -n 1)"
fi

if [[ -z "${ZIP_PATH}" || ! -f "${ZIP_PATH}" ]]; then
  echo "[friday-sparkle-appcast] macOS zip artifact not found. Run the release workflow first." >&2
  exit 78
fi

VERSION="$("${NODE_BIN}" -p "require('${REPO_DIR}/package.json').version")"
DOWNLOAD_PREFIX="${FRIDAY_RELEASE_DOWNLOAD_BASE_URL:-https://github.com/thesongzhu/Friday/releases/download/v${VERSION}/}"
PRIVATE_KEY_FILE="$(resolve_private_key_file)"

cp "${ZIP_PATH}" "${TMP_DIR}/$(basename "${ZIP_PATH}")"
"${SPARKLE_GENERATE_APPCAST}" \
  --ed-key-file "${PRIVATE_KEY_FILE}" \
  --download-url-prefix "${DOWNLOAD_PREFIX}" \
  --link "${APPCAST_URL}" \
  "${TMP_DIR}" >/dev/null

mkdir -p "${OUTPUT_DIR}"
cp "${TMP_DIR}/appcast.xml" "${APPCAST_PATH}"

FRIDAY_ARTIFACT_REPO_ROOT="${REPO_DIR}" \
FRIDAY_ARTIFACT_PATH="${APPCAST_PATH}" \
FRIDAY_ARTIFACT_METADATA_PATH="${APPCAST_PATH}.artifact.json" \
FRIDAY_ARTIFACT_ID="macos-sparkle-appcast" \
FRIDAY_ARTIFACT_PLATFORM="macos" \
FRIDAY_ARTIFACT_KIND="sparkle_appcast" \
FRIDAY_ARTIFACT_ARCH="all" \
FRIDAY_ARTIFACT_DISPLAY_NAME="Friday Sparkle appcast" \
FRIDAY_ARTIFACT_AVAILABILITY="available" \
FRIDAY_ARTIFACT_INSTALL_SUMMARY="Serve this appcast URL to enable Sparkle auto-update checks for the packaged macOS companion." \
FRIDAY_ARTIFACT_SIGNING_STATUS="sparkle_eddsa" \
FRIDAY_ARTIFACT_NOTARIZATION_STATUS="not_applicable" \
FRIDAY_ARTIFACT_RUNTIME_KIND="swift_app" \
FRIDAY_ARTIFACT_DOWNLOAD_BASE_URL="${FRIDAY_MACOS_APPCAST_BASE_URL%/}" \
FRIDAY_ARTIFACT_NOTES='["Generated from the signed macOS zip artifact.","Sparkle feed URL must remain stable across releases."]' \
  "${NODE_BIN}" "${REPO_DIR}/scripts/ops/write-friday-artifact-metadata.mjs" >/dev/null

FRIDAY_CHANNEL_METADATA_PATH="${CHANNELS_DIR}/sparkle.json" \
FRIDAY_CHANNEL_KIND="sparkle" \
FRIDAY_CHANNEL_AVAILABILITY="generated" \
FRIDAY_CHANNEL_DETAILS_JSON="$("${NODE_BIN}" --input-type=module -e "console.log(JSON.stringify({appcastUrl: process.argv[1], appcastPath: process.argv[2]}))" "${APPCAST_URL}" "${APPCAST_PATH}")" \
  "${NODE_BIN}" "${REPO_DIR}/scripts/ops/write-friday-channel-metadata.mjs" >/dev/null

echo "${APPCAST_PATH}"
