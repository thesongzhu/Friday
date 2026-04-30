#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-sparkle-keys] macOS is required." >&2
  exit 78
fi

SPARKLE_VERSION="${FRIDAY_MACOS_SPARKLE_VERSION:-2.9.0}"
SPARKLE_CACHE_DIR="${FRIDAY_MACOS_SPARKLE_CACHE_DIR:-${REPO_DIR}/.friday/cache/sparkle/${SPARKLE_VERSION}}"
SPARKLE_GENERATE_KEYS="${SPARKLE_CACHE_DIR}/bin/generate_keys"
OUTPUT_DIR="${FRIDAY_MACOS_SPARKLE_KEY_DIR:-${HOME}/.friday-keys}"
PRIVATE_KEY_PATH="${OUTPUT_DIR}/sparkle-private-key.txt"
PUBLIC_KEY_PATH="${OUTPUT_DIR}/sparkle-public-key.txt"
SPARKLE_ACCOUNT="${FRIDAY_MACOS_SPARKLE_ACCOUNT:-ed25519}"

ensure_sparkle_cache() {
  if [[ -x "${SPARKLE_GENERATE_KEYS}" ]]; then
    return
  fi

  local download_url="https://github.com/sparkle-project/Sparkle/releases/download/${SPARKLE_VERSION}/Sparkle-for-Swift-Package-Manager.zip"
  local temp_dir=""
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/friday-sparkle-fetch.XXXXXX")"
  trap 'rm -rf "${temp_dir:-}"' RETURN

  mkdir -p "$(dirname "${SPARKLE_CACHE_DIR}")"
  curl -L --fail --silent --show-error "${download_url}" -o "${temp_dir}/Sparkle.zip"
  unzip -q "${temp_dir}/Sparkle.zip" -d "${temp_dir}/unzipped"
  rm -rf "${SPARKLE_CACHE_DIR}"
  mv "${temp_dir}/unzipped" "${SPARKLE_CACHE_DIR}"
}

ensure_sparkle_cache
mkdir -p "${OUTPUT_DIR}"

if [[ -f "${PRIVATE_KEY_PATH}" && -f "${PUBLIC_KEY_PATH}" && "${FRIDAY_MACOS_SPARKLE_FORCE_REGENERATE:-false}" != "true" ]]; then
  echo "${PRIVATE_KEY_PATH}"
  echo "${PUBLIC_KEY_PATH}"
  exit 0
fi

if ! PUBLIC_KEY="$("${SPARKLE_GENERATE_KEYS}" --account "${SPARKLE_ACCOUNT}" -p 2>/dev/null)"; then
  PUBLIC_KEY="$("${SPARKLE_GENERATE_KEYS}" --account "${SPARKLE_ACCOUNT}")"
fi
"${SPARKLE_GENERATE_KEYS}" --account "${SPARKLE_ACCOUNT}" -x "${PRIVATE_KEY_PATH}" >/dev/null

if [[ -z "${PUBLIC_KEY}" || ! -f "${PRIVATE_KEY_PATH}" ]]; then
  echo "[friday-sparkle-keys] failed to export Sparkle keys." >&2
  exit 78
fi

printf '%s\n' "${PUBLIC_KEY}" > "${PUBLIC_KEY_PATH}"
chmod 600 "${PRIVATE_KEY_PATH}"

echo "${PRIVATE_KEY_PATH}"
echo "${PUBLIC_KEY_PATH}"
