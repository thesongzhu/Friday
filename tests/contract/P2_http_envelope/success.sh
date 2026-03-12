#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P2_http_envelope success \
  test/e2e/api/friday-api-health-routes.test.ts \
  "returns 200 with ok status" \
  "returns 200 with ok status"
