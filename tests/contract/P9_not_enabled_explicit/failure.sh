#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P9_not_enabled_explicit failure \
  test/e2e/api/friday-api-auth-rbac-errors.test.ts \
  "error_envelope_consistent" \
  "error_envelope_consistent"
