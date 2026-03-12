#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P1_cli_runtime success \
  test/e2e/cli/friday-cli-start-runtime.test.ts \
  "run_loop_starts_http_server" \
  "run_loop_starts_http_server"
