#!/usr/bin/env bash
set -euo pipefail

bool_json() {
  if [ -n "${1:-}" ]; then
    printf 'true'
  else
    printf 'false'
  fi
}

jq -n \
  --argjson openai "$(bool_json "${OPENAI_API_KEY:-}")" \
  --argjson anthropic "$(bool_json "${ANTHROPIC_API_KEY:-}")" \
  --argjson fridayAnthropic "$(bool_json "${FRIDAY_ANTHROPIC_API_KEY:-}")" \
  --argjson fridayMaster "$(bool_json "${FRIDAY_MASTER_KEY:-}")" \
  --argjson pathVisible "$(bool_json "${PATH:-}")" \
  --argjson homeVisible "$(bool_json "${HOME:-}")" \
  --argjson tmpdirVisible "$(bool_json "${TMPDIR:-}")" \
  '{
    visibleEnv: {
      OPENAI_API_KEY: $openai,
      ANTHROPIC_API_KEY: $anthropic,
      FRIDAY_ANTHROPIC_API_KEY: $fridayAnthropic,
      FRIDAY_MASTER_KEY: $fridayMaster,
      PATH: $pathVisible,
      HOME: $homeVisible,
      TMPDIR: $tmpdirVisible
    }
  }'
