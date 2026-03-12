#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_NAME="${CONTRACT_ENV:-local}"
ART_DIR="${ROOT_DIR}/artifacts/contract/${ENV_NAME}/P1_cli_runtime/failure"
mkdir -p "${ART_DIR}"

if [ ! -f "${ROOT_DIR}/dist/cli/friday-cli.js" ]; then
  (cd "${ROOT_DIR}" && npm run -s build:api >/dev/null)
fi

PORT=$(node -e 'const s=require("net").createServer(); s.listen(0,"127.0.0.1",()=>{const p=s.address().port; console.log(String(p)); s.close();});')

node -e 'const http=require("http");const port=Number(process.argv[1]);const server=http.createServer((_req,res)=>res.end("occupied"));server.listen(port,"127.0.0.1",()=>console.log("ready"));setInterval(()=>{},1000);' "${PORT}" > "${ART_DIR}/occupier.log" 2>&1 &
OCCUPIER_PID=$!
cleanup() {
  if kill -0 "${OCCUPIER_PID}" >/dev/null 2>&1; then
    kill "${OCCUPIER_PID}" >/dev/null 2>&1 || true
    wait "${OCCUPIER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
sleep 1

set +e
node "${ROOT_DIR}/dist/cli/friday-cli.js" start --host 127.0.0.1 --port "${PORT}" > "${ART_DIR}/test.log" 2>&1
CODE=$?
set -e

if [ "${CODE}" -eq 0 ]; then
  echo "expected non-zero exit for port conflict" >&2
  exit 1
fi

if ! grep -E "EADDRINUSE|address already in use|listen EADDRINUSE" "${ART_DIR}/test.log" >/dev/null 2>&1; then
  echo "expected bind failure marker in log" >&2
  cat "${ART_DIR}/test.log" >&2
  exit 1
fi

cat > "${ART_DIR}/result.json" <<JSON
{"promise_id":"P1_cli_runtime","case":"failure","status":"PASS","exit_code":${CODE},"port":${PORT}}
JSON
