#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export CONTRACT_ENV=docker

if ! command -v docker >/dev/null 2>&1; then
  echo "[contract-docker] docker command not found; install Docker Desktop/Engine or run in CI" >&2
  exit 127
fi

mkdir -p "${ROOT_DIR}/artifacts/logs" "${ROOT_DIR}/artifacts/contract/docker"

(
  cd "${ROOT_DIR}"
  bash scripts/ci/docker-e2e-smoke.sh
) 2>&1 | tee "${ROOT_DIR}/artifacts/logs/contract-docker-run.log"

rm -rf "${ROOT_DIR}/artifacts/contract/docker/local-docker-e2e"
mkdir -p "${ROOT_DIR}/artifacts/contract/docker/local-docker-e2e"
cp -R "${ROOT_DIR}/artifacts/docker-e2e/." "${ROOT_DIR}/artifacts/contract/docker/local-docker-e2e/"

if [ ! -s "${ROOT_DIR}/artifacts/contract/docker/local-docker-e2e/health.json" ]; then
  echo "[contract-docker] missing copied health.json artifact" >&2
  exit 1
fi

if [ ! -s "${ROOT_DIR}/artifacts/contract/docker/local-docker-e2e/container-auth-flow.json" ]; then
  echo "[contract-docker] missing copied container-auth-flow.json artifact" >&2
  exit 1
fi

LOGIN_STATUS="$(tr -d '[:space:]' < "${ROOT_DIR}/artifacts/contract/docker/local-docker-e2e/login.status")"
if [ "${LOGIN_STATUS}" != "200" ]; then
  echo "[contract-docker] expected copied login.status=200, got ${LOGIN_STATUS}" >&2
  exit 1
fi

cat > "${ROOT_DIR}/artifacts/contract/docker/result.json" <<JSON
{"env":"docker","status":"PASS","script":"scripts/ci/docker-e2e-smoke.sh","artifacts":"artifacts/contract/docker/local-docker-e2e"}
JSON
