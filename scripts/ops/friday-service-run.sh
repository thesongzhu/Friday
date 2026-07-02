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

if [[ -f "${REPO_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "${REPO_DIR}/.env"
  set +a
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
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
  newer_src="$(find src ui/src packages -type f -newer "${DIST_ENTRY}" -print -quit 2>/dev/null || true)"
  if [[ -n "${newer_src}" ]]; then
    BUILD_REASON="source newer than dist (${newer_src})"
  elif [[ package.json -nt "${DIST_ENTRY}" || tsconfig.json -nt "${DIST_ENTRY}" ]]; then
    BUILD_REASON="build metadata newer than dist"
  fi
fi

if [[ -n "${BUILD_REASON}" ]]; then
  if [[ "${BUILD_MODE}" == "never" ]]; then
    echo "[friday-service] ${BUILD_REASON}; FRIDAY_BUILD_ON_START=never prevents rebuild." >&2
    exit 78
  fi
  echo "[friday-service] running npm run build (${BUILD_REASON})" >&2
  npm run build >&2
fi

export FRIDAY_SYSTEM_ENABLED="${FRIDAY_SYSTEM_ENABLED:-true}"
export FRIDAY_CANONICAL_GATE="${FRIDAY_CANONICAL_GATE:-true}"

exec "${NODE_BIN}" "${DIST_ENTRY}" start
