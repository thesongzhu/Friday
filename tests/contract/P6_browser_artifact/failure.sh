#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P6_browser_artifact failure \
  test/integration/agent/friday-browser-resilience-integration.test.ts \
  "auto-fallbacks web_fetch failure to browser open/snapshot" \
  "auto-fallbacks web_fetch failure"
