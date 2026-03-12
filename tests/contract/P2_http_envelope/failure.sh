#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P2_http_envelope failure \
  test/e2e/api/friday-api-auth-rbac-errors.test.ts \
  "missing_token_returns_401" \
  "missing_token_returns_401"
