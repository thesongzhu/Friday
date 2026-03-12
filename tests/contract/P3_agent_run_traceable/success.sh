#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P3_agent_run_traceable success \
  test/e2e/mock/friday-mock-multi-turn.e2e.test.ts \
  "two-turn conversation: run 2 sends history from run 1 to LLM" \
  "two-turn conversation"
