#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "[friday-companion] workspace not found: ${REPO_DIR}" >&2
  exit 78
fi

cd "${REPO_DIR}"

if [[ -f "${REPO_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${REPO_DIR}/.env"
  set +a
fi

BUILD_MODE="${FRIDAY_BUILD_ON_START:-auto}"
if [[ "${BUILD_MODE}" != "auto" && "${BUILD_MODE}" != "always" && "${BUILD_MODE}" != "never" ]]; then
  echo "[friday-companion] invalid FRIDAY_BUILD_ON_START=${BUILD_MODE}; expected auto|always|never." >&2
  exit 78
fi

COMPANION_MODE="${FRIDAY_SYSTEM_NATIVE_COMPANION_MODE:-auto}"
if [[ "${COMPANION_MODE}" != "auto" && "${COMPANION_MODE}" != "swift" && "${COMPANION_MODE}" != "node" ]]; then
  echo "[friday-companion] invalid FRIDAY_SYSTEM_NATIVE_COMPANION_MODE=${COMPANION_MODE}; expected auto|swift|node." >&2
  exit 78
fi

SWIFT_BIN="$(command -v swift || true)"
SWIFT_PACKAGE_DIR="${REPO_DIR}/apps/macos/FridayCompanion"
SWIFT_ENTRY="${SWIFT_PACKAGE_DIR}/.build/release/FridayCompanion"
APP_DIR="${FRIDAY_SYSTEM_COMPANION_APP_DIR:-${REPO_DIR}/dist/macos/FridayCompanion.app}"
APP_BINARY="${FRIDAY_SYSTEM_COMPANION_APP_BINARY:-${APP_DIR}/Contents/MacOS/FridayCompanion}"
USE_NATIVE="false"
NODE_BIN="${FRIDAY_NODE_BIN:-}"

if [[ "${COMPANION_MODE}" != "node" && "$(uname -s)" == "Darwin" && -x "${SWIFT_BIN}" && -f "${SWIFT_PACKAGE_DIR}/Package.swift" ]]; then
  USE_NATIVE="true"
fi

if [[ "${COMPANION_MODE}" == "swift" && "${USE_NATIVE}" != "true" ]]; then
  echo "[friday-companion] Swift companion requested but Swift package prerequisites are missing." >&2
  exit 78
fi

resolve_companion_auth_token() {
  local token_file="${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE:-${REPO_DIR}/.friday/run/system-companion.auth.token}"
  mkdir -p "$(dirname "${token_file}")"

  if [[ -n "${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN:-}" ]]; then
    printf "%s" "${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN}" > "${token_file}"
  elif [[ -f "${token_file}" ]]; then
    FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN="$(tr -d '\n' < "${token_file}")"
  else
    local generated=""
    if command -v openssl >/dev/null 2>&1; then
      generated="$(openssl rand -hex 32)"
    else
      if [[ -z "${NODE_BIN}" ]]; then
        NODE_BIN="$(command -v node || true)"
      fi
      if [[ -n "${NODE_BIN}" && -x "${NODE_BIN}" ]]; then
        generated="$("${NODE_BIN}" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
      else
        generated="$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')"
      fi
    fi
    FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN="${generated}"
    printf "%s" "${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN}" > "${token_file}"
  fi

  export FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN
  export FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE="${token_file}"
}

resolve_companion_auth_token

if [[ "${USE_NATIVE}" == "true" ]]; then
  if [[ -x "${APP_BINARY}" ]]; then
    echo "[friday-companion] starting packaged native companion (${APP_BINARY})" >&2
    export FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND="swift_app"
    export FRIDAY_WORKSPACE_ROOT="${REPO_DIR}"
    export FRIDAY_SYSTEM_COMPANION_SOCKET_PATH="${FRIDAY_SYSTEM_COMPANION_SOCKET_PATH:-${REPO_DIR}/.friday/run/system-companion.sock}"
    exec "${APP_BINARY}"
  fi

  SWIFT_BUILD_REASON=""
  if [[ ! -x "${SWIFT_ENTRY}" ]]; then
    SWIFT_BUILD_REASON="${SWIFT_ENTRY} missing"
  elif [[ "${BUILD_MODE}" == "always" ]]; then
    SWIFT_BUILD_REASON="FRIDAY_BUILD_ON_START=always"
  elif [[ "${BUILD_MODE}" == "auto" ]]; then
    newer_swift_src="$(find "${SWIFT_PACKAGE_DIR}/Sources" "${SWIFT_PACKAGE_DIR}/Package.swift" -type f -newer "${SWIFT_ENTRY}" -print -quit 2>/dev/null || true)"
    if [[ -n "${newer_swift_src}" ]]; then
      SWIFT_BUILD_REASON="native source newer than binary (${newer_swift_src})"
    fi
  fi

  if [[ -n "${SWIFT_BUILD_REASON}" ]]; then
    echo "[friday-companion] running swift build -c release (${SWIFT_BUILD_REASON})" >&2
    "${SWIFT_BIN}" build -c release --package-path "${SWIFT_PACKAGE_DIR}" >&2
  fi

  echo "[friday-companion] starting Swift build companion (${SWIFT_ENTRY})" >&2
  export FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND="swift_binary"
  export FRIDAY_WORKSPACE_ROOT="${REPO_DIR}"
  export FRIDAY_SYSTEM_COMPANION_SOCKET_PATH="${FRIDAY_SYSTEM_COMPANION_SOCKET_PATH:-${REPO_DIR}/.friday/run/system-companion.sock}"
  exec "${SWIFT_ENTRY}"
fi

if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "[friday-companion] node binary not found. Set FRIDAY_NODE_BIN or ensure node is on PATH." >&2
  exit 78
fi

DIST_ENTRY="dist/system/companion/friday-system-companion-daemon.js"
BUILD_REASON=""

if [[ ! -f "${DIST_ENTRY}" ]]; then
  BUILD_REASON="${DIST_ENTRY} missing"
elif [[ "${BUILD_MODE}" == "always" ]]; then
  BUILD_REASON="FRIDAY_BUILD_ON_START=always"
elif [[ "${BUILD_MODE}" == "auto" ]]; then
  newer_src="$(find src -type f -newer "${DIST_ENTRY}" -print -quit 2>/dev/null || true)"
  if [[ -n "${newer_src}" ]]; then
    BUILD_REASON="source newer than dist (${newer_src})"
  elif [[ package.json -nt "${DIST_ENTRY}" || tsconfig.json -nt "${DIST_ENTRY}" ]]; then
    BUILD_REASON="build metadata newer than dist"
  fi
fi

if [[ -n "${BUILD_REASON}" ]]; then
  echo "[friday-companion] running npm run build:api (${BUILD_REASON})" >&2
  npm run build:api >&2
fi

export FRIDAY_WORKSPACE_ROOT="${REPO_DIR}"
export FRIDAY_SYSTEM_COMPANION_SOCKET_PATH="${FRIDAY_SYSTEM_COMPANION_SOCKET_PATH:-${REPO_DIR}/.friday/run/system-companion.sock}"
export FRIDAY_SYSTEM_COMPANION_RUNTIME_KIND="node_daemon"

exec "${NODE_BIN}" "${DIST_ENTRY}"
