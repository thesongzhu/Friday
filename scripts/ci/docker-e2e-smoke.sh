#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/docker-e2e"
IMAGE_TAG="${FRIDAY_DOCKER_IMAGE_TAG:-friday:ci-e2e}"
CONTAINER_NAME="${FRIDAY_DOCKER_CONTAINER_NAME:-friday-ci-e2e}"
HOST="${FRIDAY_DOCKER_HOST:-127.0.0.1}"
PORT="${FRIDAY_DOCKER_PORT:-3141}"
TOKEN_SECRET="${FRIDAY_TOKEN_SECRET:-ci-docker-e2e-secret}"
SKIP_BUILD="${FRIDAY_DOCKER_SKIP_BUILD:-false}"

HEALTH_URL="http://${HOST}:${PORT}/v1/health"
AUTH_ME_URL="http://${HOST}:${PORT}/v1/auth/me"
SETUP_STATUS_URL="http://${HOST}:${PORT}/v1/setup/status"
LOGIN_URL="http://${HOST}:${PORT}/v1/auth/login"

mkdir -p "${ARTIFACT_DIR}"

cleanup() {
  docker logs "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container.log" 2>&1 || true
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[docker-e2e] root=${ROOT_DIR}"
echo "[docker-e2e] artifacts=${ARTIFACT_DIR}"

if [[ "${SKIP_BUILD}" != "true" ]]; then
  echo "[docker-e2e] building image ${IMAGE_TAG}"
  docker build -f "${ROOT_DIR}/Dockerfile" -t "${IMAGE_TAG}" "${ROOT_DIR}" \
    2>&1 | tee "${ARTIFACT_DIR}/docker-build.log"
else
  echo "[docker-e2e] skipping docker build (FRIDAY_DOCKER_SKIP_BUILD=true)"
fi

echo "[docker-e2e] starting container ${CONTAINER_NAME}"
docker run -d \
  --name "${CONTAINER_NAME}" \
  -e FRIDAY_TOKEN_SECRET="${TOKEN_SECRET}" \
  -e FRIDAY_ALLOW_PASSWORDLESS_LOCAL_LOGIN=true \
  -e FRIDAY_HOST=0.0.0.0 \
  -p "${PORT}:3141" \
  "${IMAGE_TAG}" > "${ARTIFACT_DIR}/container-id.txt"

echo "[docker-e2e] waiting for health endpoint: ${HEALTH_URL}"
for _ in $(seq 1 60); do
  if curl -fsS "${HEALTH_URL}" > "${ARTIFACT_DIR}/health.json"; then
    break
  fi
  sleep 1
done

if [[ ! -s "${ARTIFACT_DIR}/health.json" ]]; then
  echo "[docker-e2e][error] health endpoint never became ready"
  exit 1
fi

curl -sS -o "${ARTIFACT_DIR}/auth-me.json" -w "%{http_code}" "${AUTH_ME_URL}" \
  > "${ARTIFACT_DIR}/auth-me.status"
curl -sS -o "${ARTIFACT_DIR}/setup-status.json" -w "%{http_code}" "${SETUP_STATUS_URL}" \
  > "${ARTIFACT_DIR}/setup-status.status"
curl -sS -X POST "${LOGIN_URL}" \
  -H "content-type: application/json" \
  -d "{}" \
  -o "${ARTIFACT_DIR}/login.json" -w "%{http_code}" > "${ARTIFACT_DIR}/login.status"

node <<'NODE'
const fs = require("node:fs");

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function readStatus(path) {
  return Number(fs.readFileSync(path, "utf8").trim());
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const base = "artifacts/docker-e2e";
const health = readJson(`${base}/health.json`);
assert(health.ok === true, "health response must be ok=true");
assert(typeof health.requestId === "string" && health.requestId.length > 0, "health must include requestId");

const authMeStatus = readStatus(`${base}/auth-me.status`);
const authMe = readJson(`${base}/auth-me.json`);
assert(authMeStatus === 401, `auth/me must be 401, got ${authMeStatus}`);
assert(authMe.ok === false, "auth/me must return ok=false");
assert(authMe.error?.code === "UNAUTHORIZED", "auth/me error code must be UNAUTHORIZED");

const setupStatus = readStatus(`${base}/setup-status.status`);
const setup = readJson(`${base}/setup-status.json`);
assert(setupStatus === 401, `setup/status must be 401, got ${setupStatus}`);
assert(setup.ok === false, "setup/status must return ok=false");
assert(setup.error?.code === "UNAUTHORIZED", "setup/status error code must be UNAUTHORIZED");

const loginStatus = readStatus(`${base}/login.status`);
const login = readJson(`${base}/login.json`);
assert(loginStatus >= 400, `login expected failure path for empty body, got ${loginStatus}`);
assert(login.ok === false, "login(empty body) must return ok=false");
assert(typeof login.error?.code === "string" && login.error.code.length > 0, "login failure must include error code");

console.log("[docker-e2e] assertions passed");
NODE

echo "[docker-e2e] completed"
