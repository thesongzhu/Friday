#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-companion-release-env] macOS is required." >&2
  exit 78
fi

RELEASE_MODE="${FRIDAY_MACOS_RELEASE_MODE:-local}"
if [[ "${RELEASE_MODE}" != "local" && "${RELEASE_MODE}" != "notarize" ]]; then
  echo "[friday-companion-release-env] invalid FRIDAY_MACOS_RELEASE_MODE=${RELEASE_MODE}; expected local|notarize." >&2
  exit 78
fi

SWIFT_BIN="$(command -v swift || true)"
NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"

if [[ -z "${SWIFT_BIN}" ]]; then
  echo "[friday-companion-release-env] swift not found in PATH." >&2
  exit 78
fi

if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-companion-release-env] node not found in PATH." >&2
  exit 78
fi

if [[ ! -f "${REPO_DIR}/apps/macos/FridayCompanion/Package.swift" ]]; then
  echo "[friday-companion-release-env] missing Swift package at apps/macos/FridayCompanion." >&2
  exit 78
fi

if [[ "${RELEASE_MODE}" == "notarize" ]]; then
  if ! command -v xcrun >/dev/null 2>&1; then
    echo "[friday-companion-release-env] xcrun is required for notarization." >&2
    exit 78
  fi
  if ! command -v security >/dev/null 2>&1; then
    echo "[friday-companion-release-env] security is required to inspect signing identities." >&2
    exit 78
  fi
  if [[ -z "${FRIDAY_MACOS_CODESIGN_IDENTITY:-}" ]]; then
    echo "[friday-companion-release-env] FRIDAY_MACOS_CODESIGN_IDENTITY is required for notarized release mode." >&2
    exit 78
  fi
  if [[ -z "${FRIDAY_MACOS_NOTARY_PROFILE:-}" ]]; then
    echo "[friday-companion-release-env] FRIDAY_MACOS_NOTARY_PROFILE is required for notarized release mode." >&2
    exit 78
  fi
  IDENTITIES="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  if printf '%s\n' "${IDENTITIES}" | grep -Fq "0 valid identities found"; then
    echo "[friday-companion-release-env] no valid codesigning identities are available in the active keychain." >&2
    exit 78
  fi
  if ! printf '%s\n' "${IDENTITIES}" | grep -Fq -- "${FRIDAY_MACOS_CODESIGN_IDENTITY}"; then
    echo "[friday-companion-release-env] requested codesigning identity was not found: ${FRIDAY_MACOS_CODESIGN_IDENTITY}" >&2
    exit 78
  fi
  NOTARY_ARGS=(notarytool history --keychain-profile "${FRIDAY_MACOS_NOTARY_PROFILE}")
  if [[ -n "${FRIDAY_MACOS_TEAM_ID:-}" ]]; then
    NOTARY_ARGS+=(--team-id "${FRIDAY_MACOS_TEAM_ID}")
  fi
  if ! xcrun "${NOTARY_ARGS[@]}" >/dev/null 2>&1; then
    echo "[friday-companion-release-env] notary profile is unavailable or inaccessible: ${FRIDAY_MACOS_NOTARY_PROFILE}" >&2
    exit 78
  fi
fi

echo "[friday-companion-release-env] environment OK for ${RELEASE_MODE} release mode" >&2
