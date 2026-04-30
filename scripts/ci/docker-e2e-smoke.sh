#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd -- "${BASH_SOURCE[0]%/*}/../.." && pwd)"
ARTIFACT_DIR="${ROOT_DIR}/artifacts/docker-e2e"
IMAGE_TAG="${FRIDAY_DOCKER_IMAGE_TAG:-friday:ci-e2e}"
CONTAINER_NAME="${FRIDAY_DOCKER_CONTAINER_NAME:-friday-ci-e2e}"
HOST="${FRIDAY_DOCKER_HOST:-127.0.0.1}"
PORT="${FRIDAY_DOCKER_PORT:-3141}"
if [[ -z "${FRIDAY_DOCKER_PORT:-}" ]]; then
  PORT="$((39000 + RANDOM % 2000))"
fi
TOKEN_SECRET="${FRIDAY_TOKEN_SECRET:-ci-docker-e2e-secret-32-characters-min}"
LOCAL_PASSPHRASE="${FRIDAY_TEST_LOCAL_PASSPHRASE:-${FRIDAY_LOCAL_PASSPHRASE:-friday-docker-e2e-passphrase-123}}"
SKIP_BUILD="${FRIDAY_DOCKER_SKIP_BUILD:-false}"
LAYER="${FRIDAY_DOCKER_SMOKE_LAYER:-all}"

HEALTH_URL="http://${HOST}:${PORT}/v1/health"
AUTH_ME_URL="http://${HOST}:${PORT}/v1/auth/me"
AUTH_BOOTSTRAP_STATUS_URL="http://${HOST}:${PORT}/v1/auth/bootstrap/status"
AUTH_BOOTSTRAP_URL="http://${HOST}:${PORT}/v1/auth/bootstrap/local-passphrase"
SETUP_STATUS_URL="http://${HOST}:${PORT}/v1/setup/status"
LOGIN_URL="http://${HOST}:${PORT}/v1/auth/login"
PLUGINS_URL="http://${HOST}:${PORT}/v1/plugins"

if ! command -v docker >/dev/null 2>&1; then
  echo "[docker-e2e][blocker] docker is not installed or not on PATH" >&2
  exit 78
fi

mkdir -p "${ARTIFACT_DIR}"
rm -f \
  "${ARTIFACT_DIR}/auth-bootstrap-status.json" \
  "${ARTIFACT_DIR}/auth-bootstrap-status.status" \
  "${ARTIFACT_DIR}/auth-bootstrap-local-passphrase.json" \
  "${ARTIFACT_DIR}/auth-bootstrap-local-passphrase.status" \
  "${ARTIFACT_DIR}/container-auth-flow.json" \
  "${ARTIFACT_DIR}/login.json" \
  "${ARTIFACT_DIR}/login.status"

case "${LAYER}" in
  runtime|bootstrap|plugins|all)
    ;;
  *)
    echo "[docker-e2e][error] unsupported FRIDAY_DOCKER_SMOKE_LAYER=${LAYER}"
    exit 2
    ;;
esac

cleanup() {
  docker logs "${CONTAINER_NAME}" > "${ARTIFACT_DIR}/container.log" 2>&1 || true
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "[docker-e2e] root=${ROOT_DIR}"
echo "[docker-e2e] artifacts=${ARTIFACT_DIR}"
echo "[docker-e2e] layer=${LAYER}"

if [[ "${SKIP_BUILD}" != "true" ]]; then
  echo "[docker-e2e] building image ${IMAGE_TAG}"
  docker build -f "${ROOT_DIR}/docker/Dockerfile" -t "${IMAGE_TAG}" "${ROOT_DIR}" \
    2>&1 | tee "${ARTIFACT_DIR}/docker-build.log"
else
  echo "[docker-e2e] skipping docker build (FRIDAY_DOCKER_SKIP_BUILD=true)"
fi

echo "[docker-e2e] starting container ${CONTAINER_NAME}"
docker run -d \
  --name "${CONTAINER_NAME}" \
  -e FRIDAY_TOKEN_SECRET="${TOKEN_SECRET}" \
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

echo "[docker-e2e] bootstrapping local passphrase from inside container"
docker exec -i \
  -e LOCAL_PASSPHRASE="${LOCAL_PASSPHRASE}" \
  "${CONTAINER_NAME}" \
  node <<'NODE' > "${ARTIFACT_DIR}/container-auth-flow.json"
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function requestJson(path, options) {
  const res = await fetch(`http://127.0.0.1:3141${path}`, options);
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await res.json()
    : { text: await res.text() };
  return { status: res.status, body };
}

async function bootstrapLocalPassphrase() {
  const initialized = await requestJson("/v1/auth/bootstrap/local-passphrase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: process.env.LOCAL_PASSPHRASE }),
  });
  assert(initialized.status === 200, `local passphrase bootstrap must be 200, got ${initialized.status}`);
  assert(initialized.body.ok !== false, "local passphrase bootstrap must not return ok=false");
  return initialized;
}

async function main() {
  const result = {};
  result.bootstrapStatus = await requestJson("/v1/auth/bootstrap/status");
  assert(result.bootstrapStatus.status === 200, `bootstrap status must be 200, got ${result.bootstrapStatus.status}`);
  assert(result.bootstrapStatus.body.ok !== false, "bootstrap status must not return ok=false");

  const bootstrapData = result.bootstrapStatus.body.data ?? result.bootstrapStatus.body;
  if (bootstrapData?.bootstrapRequired === true) {
    result.bootstrapLocalPassphrase = await bootstrapLocalPassphrase();
  }

  result.login = await requestJson("/v1/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPassphrase: process.env.LOCAL_PASSPHRASE }),
  });
  if (result.login.status === 401 && result.login.body?.error?.code === "NO_PASSWORD_CONFIGURED") {
    result.bootstrapLocalPassphrase = await bootstrapLocalPassphrase();
    result.login = await requestJson("/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localPassphrase: process.env.LOCAL_PASSPHRASE }),
    });
  }
  assert(result.login.status === 200, `localPassphrase login must succeed, got ${result.login.status}`);
  assert(result.login.body.ok === true, "localPassphrase login must return ok=true");
  assert(typeof result.login.body.data?.accessToken === "string" && result.login.body.data.accessToken.length > 0, "login must return accessToken");

  process.stdout.write(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

node <<'NODE'
const fs = require("node:fs");

const base = "artifacts/docker-e2e";
const flow = JSON.parse(fs.readFileSync(`${base}/container-auth-flow.json`, "utf8"));

function writeResult(name, result) {
  fs.writeFileSync(`${base}/${name}.json`, JSON.stringify(result.body, null, 2));
  fs.writeFileSync(`${base}/${name}.status`, String(result.status));
}

writeResult("auth-bootstrap-status", flow.bootstrapStatus);
if (flow.bootstrapLocalPassphrase) {
  writeResult("auth-bootstrap-local-passphrase", flow.bootstrapLocalPassphrase);
}
writeResult("login", flow.login);
NODE

FRIDAY_DOCKER_SMOKE_LAYER="${LAYER}" \
SETUP_STATUS_URL="${SETUP_STATUS_URL}" \
PLUGINS_URL="${PLUGINS_URL}" \
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

function hasLayer(layer) {
  return layer === "all" || layer === process.env.FRIDAY_DOCKER_SMOKE_LAYER;
}

const base = "artifacts/docker-e2e";

async function requestJson(url, options, outName) {
  const res = await fetch(url, options);
  const body = await res.json();
  fs.writeFileSync(`${base}/${outName}.json`, JSON.stringify(body, null, 2));
  fs.writeFileSync(`${base}/${outName}.status`, String(res.status));
  return { status: res.status, body };
}

const health = readJson(`${base}/health.json`);
assert(health.ok === true, "health response must be ok=true");
assert(typeof health.requestId === "string" && health.requestId.length > 0, "health must include requestId");

const authMeStatus = readStatus(`${base}/auth-me.status`);
const authMe = readJson(`${base}/auth-me.json`);
assert(authMeStatus === 401, `auth/me must be 401, got ${authMeStatus}`);
assert(authMe.ok === false, "auth/me must return ok=false");
assert(authMe.error?.code === "UNAUTHORIZED", "auth/me error code must be UNAUTHORIZED");

async function main() {
  const bootstrap = {
    status: readStatus(`${base}/auth-bootstrap-status.status`),
    body: readJson(`${base}/auth-bootstrap-status.json`),
  };
  assert(bootstrap.status === 200, `bootstrap status must be 200, got ${bootstrap.status}`);
  assert(bootstrap.body.ok !== false, "bootstrap status must not return ok=false");

  const loginResult = {
    status: readStatus(`${base}/login.status`),
    body: readJson(`${base}/login.json`),
  };
  assert(loginResult.status === 200, `localPassphrase login must succeed, got ${loginResult.status}`);
  assert(loginResult.body.ok === true, "localPassphrase login must return ok=true");
  assert(typeof loginResult.body.data?.accessToken === "string" && loginResult.body.data.accessToken.length > 0, "login must return accessToken");

  if (hasLayer("runtime")) {
    console.log("[docker-e2e] runtime assertions passed");
  }

  if (hasLayer("bootstrap")) {
    const setupStatus = readStatus(`${base}/setup-status.status`);
    const setup = readJson(`${base}/setup-status.json`);
    assert(setupStatus === 401, `setup/status must be 401 before auth, got ${setupStatus}`);
    assert(setup.ok === false, "setup/status must return ok=false before auth");
    assert(setup.error?.code === "UNAUTHORIZED", "setup/status error code must be UNAUTHORIZED before auth");
  }

  if (hasLayer("bootstrap") || hasLayer("plugins")) {
    const token = loginResult.body.data.accessToken;
    const authHeaders = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    async function fetchJson(url, outName) {
      const res = await fetch(url, { headers: authHeaders });
      const body = await res.json();
      fs.writeFileSync(`${base}/${outName}.json`, JSON.stringify(body, null, 2));
      fs.writeFileSync(`${base}/${outName}.status`, String(res.status));
      return { status: res.status, body };
    }

    if (hasLayer("bootstrap")) {
      const authedSetup = await fetchJson(process.env.SETUP_STATUS_URL, "setup-status-authed");
      assert(authedSetup.status === 200, `setup/status must be 200 after auth, got ${authedSetup.status}`);
      assert(authedSetup.body.ok === true, "setup/status after auth must return ok=true");
    }

    if (hasLayer("plugins")) {
      const plugins = await fetchJson(process.env.PLUGINS_URL, "plugins");
      assert(plugins.status === 200, `plugins must be 200 after auth, got ${plugins.status}`);
      assert(plugins.body.ok === true, "plugins after auth must return ok=true");
      assert(Array.isArray(plugins.body.data?.items), "plugins response must include data.items array");
    }
  }

  console.log("[docker-e2e] assertions passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

echo "[docker-e2e] completed"
