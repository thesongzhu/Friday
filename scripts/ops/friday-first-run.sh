#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

MIN_NODE_VERSION=22
HOST="${FRIDAY_HOST:-127.0.0.1}"
if [[ "${HOST}" == "0.0.0.0" ]]; then
  HOST="localhost"
fi
PORT="${FRIDAY_PORT:-3141}"
BASE_URL="${FRIDAY_PUBLIC_APP_BASE_URL:-http://${HOST}:${PORT}}"
SETUP_URL="${BASE_URL%/}/setup"
HEALTH_URL="${BASE_URL%/}/v1/health"

info() { printf "[friday] %s\n" "$*"; }
warn() { printf "[friday] warning: %s\n" "$*" >&2; }
fail() { printf "[friday] error: %s\n" "$*" >&2; exit 1; }

absolute_install_path() {
  local target="$1"
  local parent
  local name

  parent="$(dirname "${target}")"
  name="$(basename "${target}")"
  mkdir -p "${parent}"
  parent="$(cd "${parent}" && pwd)"
  printf "%s/%s\n" "${parent}" "${name}"
}

directory_has_contents() {
  local target="$1"
  find "${target}" -mindepth 1 -maxdepth 1 -print -quit | grep -q .
}

source_needs_launchd_safe_copy() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 1
  fi

  local home_dir
  home_dir="$(cd "${HOME}" && pwd)"
  case "${REPO_DIR}" in
    "${home_dir}/Desktop"|"${home_dir}/Desktop/"*|\
    "${home_dir}/Documents"|"${home_dir}/Documents/"*|\
    "${home_dir}/Downloads"|"${home_dir}/Downloads/"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

relocate_for_launchd_if_needed() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    return 0
  fi
  if [[ "${FRIDAY_FIRST_RUN_RELOCATED:-false}" == "true" ]]; then
    return 0
  fi

  local install_dir="${FRIDAY_INSTALL_DIR:-}"
  local reason=""
  if [[ -n "${install_dir}" ]]; then
    reason="FRIDAY_INSTALL_DIR is set"
  elif source_needs_launchd_safe_copy; then
    install_dir="${HOME}/Friday"
    reason="Friday was opened from Desktop, Documents, or Downloads"
  else
    return 0
  fi

  local target
  target="$(absolute_install_path "${install_dir}")"
  if [[ "${target}" == "${REPO_DIR}" ]]; then
    return 0
  fi
  if [[ "${target}/" == "${REPO_DIR}/"* ]]; then
    fail "Install target cannot be inside the source checkout: ${target}"
  fi
  if [[ -e "${target}" && ! -d "${target}" ]]; then
    fail "Install target exists and is not a directory: ${target}"
  fi
  if [[ -d "${target}" && ! -f "${target}/package.json" ]] && directory_has_contents "${target}"; then
    fail "Install target exists and does not look like Friday: ${target}"
  fi

  command -v rsync >/dev/null 2>&1 || fail "rsync is required to prepare ${target}."

  info "${reason}; preparing launchd-safe runtime at ${target}"
  mkdir -p "${target}"
  rsync -a --delete \
    --exclude ".git/" \
    --exclude ".friday/" \
    --exclude "node_modules/" \
    --exclude "apps/macos/FridayCompanion/.build/" \
    "${REPO_DIR}/" "${target}/"
  chmod +x "${target}/Friday Setup.command" "${target}/scripts/ops/"*.sh >/dev/null 2>&1 || true

  info "Continuing setup from ${target}"
  exec env \
    FRIDAY_FIRST_RUN_RELOCATED=true \
    FRIDAY_FIRST_RUN_SOURCE_DIR="${REPO_DIR}" \
    bash "${target}/scripts/ops/friday-first-run.sh" "${target}"
}

open_url() {
  local url="$1"
  case "$(uname -s)" in
    Darwin)
      open "$url" >/dev/null 2>&1 || warn "Could not open ${url}. Open it manually."
      ;;
    Linux)
      xdg-open "$url" >/dev/null 2>&1 || warn "Could not open ${url}. Open it manually."
      ;;
    MINGW*|MSYS*|CYGWIN*)
      rundll32.exe url.dll,FileProtocolHandler "$url" >/dev/null 2>&1 || warn "Could not open ${url}. Open it manually."
      ;;
    *)
      warn "Unsupported platform for auto-open. Open ${url} manually."
      ;;
  esac
}

wait_for_health() {
  local attempts="${FRIDAY_FIRST_RUN_WAIT_ATTEMPTS:-90}"
  local sleep_seconds="${FRIDAY_FIRST_RUN_WAIT_SECONDS:-1}"

  for ((i = 0; i < attempts; i += 1)); do
    if command -v curl >/dev/null 2>&1 && curl -fsS "${HEALTH_URL}" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${sleep_seconds}"
  done
  return 1
}

relocate_for_launchd_if_needed

info "Preparing Friday from ${REPO_DIR}"
cd "${REPO_DIR}"

command -v node >/dev/null 2>&1 || fail "Node.js ${MIN_NODE_VERSION}+ is required. Install Node.js, then run this again."
command -v npm >/dev/null 2>&1 || fail "npm is required. Install Node.js with npm, then run this again."

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [[ "${NODE_MAJOR}" -lt "${MIN_NODE_VERSION}" ]]; then
  fail "Node.js ${MIN_NODE_VERSION}+ is required. Found $(node -v)."
fi

info "Installing dependencies"
if [[ -f package-lock.json ]]; then
  npm ci --prefer-offline || npm install
else
  npm install
fi

info "Building Friday"
npm run build

if [[ "$(uname -s)" == "Darwin" ]]; then
  if command -v swift >/dev/null 2>&1 && [[ -f apps/macos/FridayCompanion/Package.swift ]]; then
    info "Building the macOS menu bar companion"
    swift build -c release --package-path apps/macos/FridayCompanion
  else
    warn "Swift was not found; Friday will use the Node companion fallback if available."
  fi

  info "Installing login startup and menu bar companion"
  bash scripts/ops/install-friday-launchagent.sh "${REPO_DIR}"
else
  info "Starting Friday in the background"
  FRIDAY_AUTO_OPEN_UI=false node dist/cli/friday-cli.js daemon start || true
fi

info "Waiting for Friday to become ready"
if wait_for_health; then
  info "Opening first-run setup: ${SETUP_URL}"
  open_url "${SETUP_URL}"
else
  warn "Friday did not answer health checks yet."
  warn "Try opening ${SETUP_URL} after a moment."
fi

cat <<EOF

Friday is installed.

Open setup:
  ${SETUP_URL}

After this, Friday will open automatically on login when the macOS startup agent is installed.
EOF
