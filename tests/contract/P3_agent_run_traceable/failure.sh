#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P3_agent_run_traceable failure \
  test/e2e/mock/friday-mock-error-resilience.e2e.test.ts \
  "all providers return 500 — agent run fails gracefully" \
  "all providers return 500"
