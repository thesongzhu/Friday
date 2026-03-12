#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P10_traceability_fields success \
  test/e2e/api/friday-api-auth-rbac-errors.test.ts \
  "request_id_propagated_in_all_responses" \
  "request_id_propagated_in_all_responses"
