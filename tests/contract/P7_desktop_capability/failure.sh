#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P7_desktop_capability failure \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "desktop disabled failure path: model receives explicit enablement hint and tool_end logs error code" \
  "desktop disabled failure path"
