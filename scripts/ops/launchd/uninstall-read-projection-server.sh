#!/usr/bin/env bash
#
# uninstall-read-projection-server.sh
# =============================================================================
# slice-6 read-seam ROLLBACK tool — take the read-projection LaunchAgent down.
# =============================================================================
#
# WHAT THIS IS
#   The reverse of build-and-install-read-projection-server.sh's install step.
#   It boots the read-projection LaunchAgent out of the operator's gui/$UID domain
#   and removes the installed plist (and, optionally, the installed wrapper). It
#   leaves the SecureStore peer allowlist and the read-only DB UNTOUCHED (the read
#   server writes nothing — there is no DB state to undo).
#
# WHAT THIS DOES NOT DO
#   * It does NOT touch ~/.friday/agent-run-securestore (the peer allowlist), the
#     master key, or the hub DB.
#   * It does NOT touch the agent-run WRITE server or the TS hub.
#   * It does NOT delete the staged plist/wrapper under <LOG_DIR>/staging.
#
# USAGE
#   scripts/ops/launchd/uninstall-read-projection-server.sh [--keep-wrapper] [--log-dir <abs>]
#
#   --keep-wrapper   do not remove the installed wrapper (<LOG_DIR>/read-projection-server-run.sh)
#   --log-dir <abs>  launchd/wrapper dir (default ~/.friday/launchd)
#   -h | --help      show this help
#
# EXIT CODES: 0 ok · 2 bad args · 64 non-Darwin
# =============================================================================

set -Eeuo pipefail

LABEL="com.friday.read-projection-server"
WRAPPER_NAME="read-projection-server-run.sh"
KEEP_WRAPPER="false"
LOG_DIR="${LOG_DIR:-}"

log() { printf '[read-uninstall] %s\n' "$*" >&2; }
die() { printf '[read-uninstall] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-wrapper) KEEP_WRAPPER="true"; shift ;;
    --log-dir)      LOG_DIR="${2:?missing value for --log-dir}"; shift 2 ;;
    -h|--help)
      cat <<'EOF'
uninstall-read-projection-server.sh — take the read-projection LaunchAgent down.

Usage: scripts/ops/launchd/uninstall-read-projection-server.sh [--keep-wrapper] [--log-dir <abs>]

  --keep-wrapper   keep the installed wrapper (<LOG_DIR>/read-projection-server-run.sh)
  --log-dir <abs>  launchd/wrapper dir (default ~/.friday/launchd)

Leaves the SecureStore peer allowlist, master key, and DB untouched (the read
server writes nothing). Does not touch the WRITE server or the TS hub.
EOF
      exit 0 ;;
    *) die "unknown argument: $1" 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  die "macOS LaunchAgents require Darwin." 64
fi

LOG_DIR="${LOG_DIR:-${HOME}/.friday/launchd}"
INSTALLED_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
INSTALLED_WRAPPER="${LOG_DIR}/${WRAPPER_NAME}"

# Boot the service out (idempotent — tolerate "not loaded").
log "booting out gui/$(id -u)/${LABEL} (tolerating not-loaded) ..."
launchctl bootout "gui/$(id -u)" "${INSTALLED_PLIST}" 2>/dev/null || true

if [[ -e "${INSTALLED_PLIST}" ]]; then
  rm -f "${INSTALLED_PLIST}"
  log "removed installed plist: ${INSTALLED_PLIST}"
else
  log "no installed plist at ${INSTALLED_PLIST} (already removed)."
fi

if [[ "${KEEP_WRAPPER}" != "true" && -e "${INSTALLED_WRAPPER}" ]]; then
  rm -f "${INSTALLED_WRAPPER}"
  log "removed installed wrapper: ${INSTALLED_WRAPPER}"
fi

log "done. The read-projection server is DOWN. The peer allowlist + DB were not touched."
