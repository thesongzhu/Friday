#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

failures=0
warnings=0

print_ok() {
  echo "[enablement-check][ok] $1"
}

print_warn() {
  echo "[enablement-check][warn] $1"
  warnings=$((warnings + 1))
}

print_fail() {
  echo "[enablement-check][fail] $1"
  failures=$((failures + 1))
}

load_env_file() {
  if [[ -f "${ENV_FILE}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${ENV_FILE}"
    set +a
    print_ok "loaded ${ENV_FILE}"
  else
    print_warn ".env file not found at ${ENV_FILE}; checking current process env only"
  fi
}

check_token_secret() {
  if [[ -z "${FRIDAY_TOKEN_SECRET:-}" ]]; then
    print_fail "FRIDAY_TOKEN_SECRET is not set."
    return
  fi
  if (( ${#FRIDAY_TOKEN_SECRET} < 32 )); then
    print_fail "FRIDAY_TOKEN_SECRET is too short (<32 chars)."
    return
  fi
  print_ok "FRIDAY_TOKEN_SECRET is configured"
}

check_channel_secret_policy() {
  if [[ "${FRIDAY_CHANNEL_SECRET_POLICY:-strict}" != "strict" ]]; then
    print_fail "FRIDAY_CHANNEL_SECRET_POLICY is not strict."
    return
  fi
  print_ok "FRIDAY_CHANNEL_SECRET_POLICY=strict"
}

check_channels_json() {
  if [[ -z "${FRIDAY_CHANNELS_JSON:-}" ]]; then
    print_warn "FRIDAY_CHANNELS_JSON is not set; runtime may fall back to legacy config."
    return
  fi

  if ! node -e '
    const raw = process.env.FRIDAY_CHANNELS_JSON;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { process.exit(1); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.instances)) process.exit(2);
    const secretFields = new Set([
      "token", "botToken", "appSecret", "accessToken", "channelSecret",
      "channelAccessToken", "signingSecret", "appToken", "password",
      "webhookVerifyToken",
    ]);
    for (const inst of parsed.instances) {
      if (!inst || typeof inst !== "object") continue;
      for (const [k, v] of Object.entries(inst)) {
        if (!secretFields.has(k)) continue;
        if (typeof v !== "string") continue;
        const value = v.trim();
        if (!(value.startsWith("$") || value.startsWith("secret://channel/"))) {
          process.exit(3);
        }
      }
    }
  '; then
    print_fail "FRIDAY_CHANNELS_JSON is invalid or contains plaintext secrets."
    return
  fi

  print_ok "FRIDAY_CHANNELS_JSON is valid and secret refs are non-plaintext"
}

check_desktop() {
  if [[ "${FRIDAY_DESKTOP_ENABLED:-false}" != "true" ]]; then
    print_fail "FRIDAY_DESKTOP_ENABLED is not true."
    return
  fi
  print_ok "FRIDAY_DESKTOP_ENABLED=true"
}

check_mcp() {
  if [[ -z "${FRIDAY_MCP_SERVERS:-}" ]]; then
    print_warn "FRIDAY_MCP_SERVERS is not set; mcp tool will not be registered."
    return
  fi

  if ! node -e '
    const raw = process.env.FRIDAY_MCP_SERVERS;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { process.exit(1); }
    if (!Array.isArray(parsed) || parsed.length === 0) process.exit(2);
    for (const item of parsed) {
      if (!item || typeof item !== "object") process.exit(3);
      if (typeof item.id !== "string" || item.id.trim() === "") process.exit(4);
      if (typeof item.command !== "string" || item.command.trim() === "") process.exit(5);
    }
  '; then
    print_fail "FRIDAY_MCP_SERVERS is invalid."
    return
  fi

  print_ok "FRIDAY_MCP_SERVERS configured"
}

check_browser_presentation_mode() {
  local mode="${FRIDAY_BROWSER_PRESENTATION_MODE:-}"
  if [[ -z "${mode}" ]]; then
    if [[ "${FRIDAY_BROWSER_USE_HOST_CHROME:-false}" == "true" ]]; then
      print_warn "Legacy browser config uses host Chrome mode; prefer FRIDAY_BROWSER_PRESENTATION_MODE=host_chrome_visible or auto."
      return
    fi
    if [[ "${FRIDAY_BROWSER_HEADLESS:-}" == "false" ]]; then
      print_warn "Legacy browser config uses FRIDAY_BROWSER_HEADLESS=false; prefer FRIDAY_BROWSER_PRESENTATION_MODE=host_chrome_visible or auto."
      return
    fi
    print_warn "FRIDAY_BROWSER_PRESENTATION_MODE is unset; default auto mode is recommended for local interactive runs."
    return
  fi

  case "${mode}" in
    auto)
      print_ok "FRIDAY_BROWSER_PRESENTATION_MODE=auto (interactive local runs prefer visible desktop Chrome)"
      ;;
    host_chrome_visible)
      print_warn "FRIDAY_BROWSER_PRESENTATION_MODE=host_chrome_visible may fallback to headless if host Chrome CDP is unavailable."
      ;;
    headless)
      print_warn "FRIDAY_BROWSER_PRESENTATION_MODE=headless keeps browser actions in the background."
      ;;
    *)
      print_fail "FRIDAY_BROWSER_PRESENTATION_MODE must be one of: auto, headless, host_chrome_visible."
      ;;
  esac
}

main() {
  load_env_file
  check_token_secret
  check_channel_secret_policy
  check_channels_json
  check_desktop
  check_mcp
  check_browser_presentation_mode

  if (( failures > 0 )); then
    echo "[enablement-check] FAILED with ${failures} failure(s), ${warnings} warning(s)."
    exit 1
  fi

  echo "[enablement-check] PASSED with ${warnings} warning(s)."
}

main "$@"
