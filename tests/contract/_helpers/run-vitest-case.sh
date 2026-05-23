#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <promise_id> <case_name> <test_file> <test_name> [expected_literal...]" >&2
  exit 2
fi

PROMISE_ID="$1"
CASE_NAME="$2"
TEST_FILE="$3"
TEST_NAME="$4"
shift 4

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ENV_NAME="${CONTRACT_ENV:-local}"
CONTRACT_VITEST_TIMEOUT_MS="${CONTRACT_VITEST_TIMEOUT_MS:-60000}"
ART_DIR="${ROOT_DIR}/artifacts/contract/${ENV_NAME}/${PROMISE_ID}/${CASE_NAME}"
mkdir -p "${ART_DIR}"

command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { echo "npx is required" >&2; exit 1; }
[ -f "${ROOT_DIR}/${TEST_FILE}" ] || { echo "missing test file: ${TEST_FILE}" >&2; exit 1; }
case "${CONTRACT_VITEST_TIMEOUT_MS}" in
  ''|*[!0-9]*)
    echo "CONTRACT_VITEST_TIMEOUT_MS must be a positive integer, got: ${CONTRACT_VITEST_TIMEOUT_MS}" >&2
    exit 2
    ;;
esac

CMD=(npx vitest run "${TEST_FILE}" -t "${TEST_NAME}" --reporter=verbose --testTimeout "${CONTRACT_VITEST_TIMEOUT_MS}")
printf '%q ' "${CMD[@]}" > "${ART_DIR}/command.sh"
printf '\n' >> "${ART_DIR}/command.sh"

set -o pipefail
"${CMD[@]}" 2>&1 | tee "${ART_DIR}/test.log"

for pattern in "$@"; do
  if ! grep -F -- "${pattern}" "${ART_DIR}/test.log" >/dev/null 2>&1; then
    echo "expected literal not found: ${pattern}" >&2
    exit 1
  fi
done

cat > "${ART_DIR}/result.json" <<JSON
{"promise_id":"${PROMISE_ID}","case":"${CASE_NAME}","status":"PASS","test_file":"${TEST_FILE}","test_name":"${TEST_NAME}"}
JSON
