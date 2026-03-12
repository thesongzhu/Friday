#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "${BASH_SOURCE[0]}")/../_helpers" && pwd)/run-vitest-case.sh" \
  P6_browser_artifact success \
  test/e2e/mock/friday-openclaw-parity-closure.e2e.test.ts \
  "C/G route closure: browser screenshot produces user-visible artifact path and on-disk file" \
  "browser screenshot produces user-visible artifact"
