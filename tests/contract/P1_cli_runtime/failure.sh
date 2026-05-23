#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_NAME="${CONTRACT_ENV:-local}"
ART_DIR="${ROOT_DIR}/artifacts/contract/${ENV_NAME}/P1_cli_runtime/failure"
mkdir -p "${ART_DIR}"

if [ ! -f "${ROOT_DIR}/dist/cli/friday-cli.js" ]; then
  (cd "${ROOT_DIR}" && npm run -s build:api >/dev/null)
fi

READY_FILE="${ART_DIR}/occupier.ready"
rm -f "${READY_FILE}"

node - "${READY_FILE}" > "${ART_DIR}/occupier.log" 2>&1 <<'NODE' &
const fs = require("node:fs");
const http = require("node:http");
const readyFile = process.argv[2];
const server = http.createServer((_req, res) => res.end("occupied"));

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("unexpected listen address");
  }
  fs.writeFileSync(readyFile, `${String(address.port)}\n`);
  console.log(`ready ${String(address.port)}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
setInterval(() => {}, 1000);
NODE
OCCUPIER_PID=$!
cleanup() {
  if kill -0 "${OCCUPIER_PID}" >/dev/null 2>&1; then
    kill "${OCCUPIER_PID}" >/dev/null 2>&1 || true
    wait "${OCCUPIER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
for _ in $(seq 1 100); do
  if [ -s "${READY_FILE}" ]; then
    break
  fi
  if ! kill -0 "${OCCUPIER_PID}" >/dev/null 2>&1; then
    echo "occupier process exited before readiness" >&2
    cat "${ART_DIR}/occupier.log" >&2 || true
    exit 1
  fi
  sleep 0.1
done

if [ ! -s "${READY_FILE}" ]; then
  echo "occupier did not report a bound port" >&2
  cat "${ART_DIR}/occupier.log" >&2 || true
  exit 1
fi
PORT="$(tr -d '[:space:]' < "${READY_FILE}")"

set +e
node "${ROOT_DIR}/dist/cli/friday-cli.js" start --host 127.0.0.1 --port "${PORT}" > "${ART_DIR}/test.log" 2>&1
CODE=$?
set -e

if [ "${CODE}" -eq 0 ]; then
  echo "expected non-zero exit for port conflict" >&2
  exit 1
fi

if ! grep -F -e "EADDRINUSE" -e "address already in use" -e "listen EADDRINUSE" -e "already in use" "${ART_DIR}/test.log" >/dev/null 2>&1; then
  echo "expected bind failure marker in log" >&2
  cat "${ART_DIR}/test.log" >&2
  exit 1
fi

cat > "${ART_DIR}/result.json" <<JSON
{"promise_id":"P1_cli_runtime","case":"failure","status":"PASS","exit_code":${CODE},"port":${PORT}}
JSON
