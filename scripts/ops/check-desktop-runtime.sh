#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"

failures=0
warnings=0

print_ok() {
  echo "[desktop-check][ok] $1"
}

print_warn() {
  echo "[desktop-check][warn] $1"
  warnings=$((warnings + 1))
}

print_fail() {
  echo "[desktop-check][fail] $1"
  failures=$((failures + 1))
}

require_cmd() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    print_ok "found command: $name"
  else
    print_fail "missing command: $name"
  fi
}

platform="$(uname -s 2>/dev/null || echo unknown)"
echo "[desktop-check] platform=${platform}"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ "${FRIDAY_DESKTOP_ENABLED:-false}" == "true" ]]; then
  print_ok "FRIDAY_DESKTOP_ENABLED=true"
else
  print_warn "FRIDAY_DESKTOP_ENABLED is not true. Desktop tool will not be registered."
fi

if [[ -n "${FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS:-}" ]]; then
  print_ok "FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS=${FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS}"
else
  print_warn "FRIDAY_DESKTOP_SANDBOX_ALLOWED_ROOTS is not set. Default workspace root sandbox will be used."
fi

case "$platform" in
  Darwin)
    require_cmd osascript
    require_cmd screencapture
    require_cmd base64
    print_warn "macOS runtime also requires TCC grants: Accessibility, Screen Recording, Input Monitoring, Automation."
    ;;
  Linux)
    if command -v xdotool >/dev/null 2>&1; then
      print_ok "found command: xdotool"
    else
      print_warn "xdotool not found; click/type/keypress automation may be limited."
    fi

    if command -v import >/dev/null 2>&1 || command -v gnome-screenshot >/dev/null 2>&1 || command -v scrot >/dev/null 2>&1; then
      print_ok "found at least one screenshot backend (import/gnome-screenshot/scrot)"
    else
      print_fail "no screenshot backend found (install ImageMagick import, gnome-screenshot, or scrot)"
    fi

    require_cmd base64
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    require_cmd powershell
    print_warn "Windows desktop runtime may require UIAutomation and elevated privileges for some actions."
    ;;
  *)
    print_fail "unsupported platform: ${platform}"
    ;;
esac

if [[ "$failures" -gt 0 ]]; then
  echo "[desktop-check] FAILED with ${failures} failure(s), ${warnings} warning(s)."
  exit 1
fi

echo "[desktop-check] PASSED with ${warnings} warning(s)."
