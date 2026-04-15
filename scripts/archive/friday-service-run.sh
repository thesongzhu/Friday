#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

if [[ ! -d "${REPO_DIR}" ]]; then
  echo "[friday-service] workspace not found: ${REPO_DIR}" >&2
  exit 78
fi

cd "${REPO_DIR}"

# Optional: load env vars from repo .env for channel/provider credentials.
if [[ -f "${REPO_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${REPO_DIR}/.env"
  set +a
fi

NODE_BIN="${FRIDAY_NODE_BIN:-}"
if [[ -z "${NODE_BIN}" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "[friday-service] node binary not found. Set FRIDAY_NODE_BIN or ensure node is on PATH." >&2
  exit 78
fi

BUILD_MODE="${FRIDAY_BUILD_ON_START:-auto}"
if [[ "${BUILD_MODE}" != "auto" && "${BUILD_MODE}" != "always" && "${BUILD_MODE}" != "never" ]]; then
  echo "[friday-service] invalid FRIDAY_BUILD_ON_START=${BUILD_MODE}; expected auto|always|never." >&2
  exit 78
fi

DIST_ENTRY="dist/cli/friday-cli.js"
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
  echo "[friday-service] running npm run build:api (${BUILD_REASON})" >&2
  npm run build:api >&2
fi

ARGS=(start)
if [[ -n "${FRIDAY_HOST:-}" ]]; then
  ARGS+=(--host "${FRIDAY_HOST}")
fi
if [[ -n "${FRIDAY_PORT:-}" ]]; then
  ARGS+=(--port "${FRIDAY_PORT}")
fi

resolve_companion_auth_token() {
  local token_file="${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE:-${REPO_DIR}/.friday/run/system-companion.auth.token}"
  mkdir -p "$(dirname "${token_file}")"

  if [[ -n "${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN:-}" ]]; then
    printf "%s" "${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN}" > "${token_file}"
  elif [[ -f "${token_file}" ]]; then
    FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN="$(tr -d '\n' < "${token_file}")"
  else
    FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN="$("${NODE_BIN}" -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))")"
    printf "%s" "${FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN}" > "${token_file}"
  fi

  export FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN
  export FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN_FILE="${token_file}"
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  export FRIDAY_SYSTEM_NATIVE_COMPANION_MODE="${FRIDAY_SYSTEM_NATIVE_COMPANION_MODE:-auto}"
  export FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN="${FRIDAY_ALLOW_LOCAL_BYPASS_LOGIN:-true}"
  if [[ "${FRIDAY_SYSTEM_COMPANION_TRANSPORT:-unix_socket}" == "unix_socket" && "${FRIDAY_SYSTEM_NATIVE_COMPANION_MODE}" != "node" ]]; then
    export FRIDAY_SYSTEM_COMPANION_SERVER_MODE="${FRIDAY_SYSTEM_COMPANION_SERVER_MODE:-external}"
    resolve_companion_auth_token
  fi
fi

exec "${NODE_BIN}" dist/cli/friday-cli.js "${ARGS[@]}"
