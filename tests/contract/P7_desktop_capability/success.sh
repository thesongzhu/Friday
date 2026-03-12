#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P7_desktop_capability success \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "desktop enabled route closure: desktop tool executes session_info and returns user-visible response" \
  "desktop enabled route closure"
