#!/usr/bin/env bash
#
# build-and-install-rust-agent-run-ws-server.sh
# =============================================================================
# execrun-enablement SLICE 5 (DARK) — the SLICE-6 CUTOVER tool. Operator-run.
# =============================================================================
#
# WHAT THIS IS
#   This is scaffolding for the slice-6 live-flip of the Rust agent-run WS
#   server. It is NOT run by slice 5 and it is NOT wired into any pipeline. It
#   exists so that, at the explicit slice-6 operator gate, ONE command:
#     1. release-BUILDS the two Rust bins (hub_agent_run_server + the enroll CLI);
#     2. FILLS the launchd plist template from operator-supplied values;
#     3. VALIDATES the filled plist (plutil -lint) and the chosen WS port
#        (free + not the TS hub's port — "verify-b", single-owner of the port);
#     4. STAGES the filled plist and PRINTS the launchctl bootstrap command for
#        the operator to run.
#
# WHAT THIS DELIBERATELY DOES NOT DO (DARK / operator-gated)
#   * It does NOT copy anything into ~/Library/LaunchAgents.
#   * It does NOT run `launchctl bootstrap` / `kickstart` / `enable`.
#   * It does NOT run `hub_agent_run_enroll` (that is a SEPARATE, one-time
#     operator step — see CUTOVER-rust-agent-run-ws-server.md). The enroll CLI
#     writes the client pubkey into the SAME store dir this script fills into
#     `--store-dir`; the operator must use the SAME STORE_DIR for both.
#   * It places NO secret in the plist or its env. The WS X25519 secret is
#     resolved on the TS side from SecureStore; the server reads its own master
#     key (~/.friday/master.key) at boot. Neither is ever an arg/env here.
#   * It does NOT set the TS-side route flag (FRIDAY_ROUTE_AGENT_RUN_VIA_RUST) —
#     that belongs on the TS hub (com.friday.hub), not on this Rust server.
#
# USAGE
#   scripts/ops/launchd/build-and-install-rust-agent-run-ws-server.sh [options]
#
#   Required (env var OR flag; flag wins):
#     REPO_DIR        / --repo-dir <abs>        repo root (contains rust-core/)
#     WORKSPACE_ROOT  / --workspace-root <abs>  the read-only-loop workspace root
#     HUB_DB_PATH     / --hub-db-path <abs>     the Rust Hub SQLite (owner readback)
#     WS_PORT         / --ws-port <1..65535>    the loopback WS port (NON-ZERO)
#     OWNER_PRINCIPAL / --owner-principal <s>   the bound-owner allowlist entry
#
#   Optional:
#     STORE_DIR       / --store-dir <abs>       FileSecureStore dir
#                                               (default ~/.friday/agent-run-securestore;
#                                                MUST match what hub_agent_run_enroll used)
#     LOG_DIR         / --log-dir <abs>         launchd log dir
#                                               (default ~/.friday/launchd)
#     RUST_SERVER_BIN / --rust-server-bin <abs> prebuilt server bin; default is the
#                                               just-built rust-core/target/release path
#     --stage-dir <abs>                         where to write the filled plist
#                                               (default ~/.friday/launchd/staging)
#     --skip-build                              do not cargo build (use an existing bin)
#     --force                                   overwrite an existing staged plist /
#                                               proceed despite an EXISTING install
#     -h | --help                               show this help and exit
#
# EXIT CODES
#   0 ok · 2 bad args/usage · 64 non-Darwin · 70 build failure ·
#   75 port collision / port not free (verify-b) · 73 plutil -lint failure ·
#   77 refusing to clobber without --force
#
# This tool is run by the operator with a one-time permission at the slice-6
# cutover. Until then nothing here executes; the server stays dark.
# =============================================================================

set -Eeuo pipefail

LABEL="com.friday.rust-agent-run-ws-server"
HUB_LABEL="com.friday.hub"
TEMPLATE_REL="scripts/ops/launchd/${LABEL}.plist"

# --- defaults (overridable by env, then flags) -------------------------------
REPO_DIR="${REPO_DIR:-}"
WORKSPACE_ROOT="${WORKSPACE_ROOT:-}"
HUB_DB_PATH="${HUB_DB_PATH:-}"
WS_PORT="${WS_PORT:-}"
OWNER_PRINCIPAL="${OWNER_PRINCIPAL:-}"
STORE_DIR="${STORE_DIR:-}"
LOG_DIR="${LOG_DIR:-}"
RUST_SERVER_BIN="${RUST_SERVER_BIN:-}"
STAGE_DIR=""
SKIP_BUILD="false"
FORCE="false"

log()  { printf '[cutover] %s\n' "$*" >&2; }
die()  { printf '[cutover] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
build-and-install-rust-agent-run-ws-server.sh — execrun-enablement slice-6 cutover tool (DARK).

Release-builds the Rust agent-run WS server bins, fills the launchd plist template, runs
verify-b (port free + != the TS hub's port, loopback-only), validates with plutil -lint,
STAGES the filled plist, and PRINTS the launchctl bootstrap command. It does NOT install,
bootstrap, enroll, place any secret, or set the TS-side route flag.

Usage:
  scripts/ops/launchd/build-and-install-rust-agent-run-ws-server.sh [options]

Required (env var OR flag; flag wins):
  REPO_DIR        / --repo-dir <abs>          repo root (contains rust-core/)
  WORKSPACE_ROOT  / --workspace-root <abs>    read-only-loop workspace root
  HUB_DB_PATH     / --hub-db-path <abs>       Rust Hub SQLite (owner readback)
  WS_PORT         / --ws-port <1..65535>      loopback WS port (NON-ZERO, concrete)
  OWNER_PRINCIPAL / --owner-principal <s>     bound-owner allowlist entry

Optional:
  STORE_DIR       / --store-dir <abs>         FileSecureStore dir
                                              (default ~/.friday/agent-run-securestore;
                                               MUST match the dir hub_agent_run_enroll used)
  LOG_DIR         / --log-dir <abs>           launchd log dir (default ~/.friday/launchd)
  RUST_SERVER_BIN / --rust-server-bin <abs>   prebuilt server bin (default: just-built release)
  --stage-dir <abs>                           filled-plist staging dir (default <LOG_DIR>/staging)
  --skip-build                                use an existing bin; do not cargo build
  --force                                     overwrite a staged plist / proceed despite an install
  -h | --help                                 show this help

Exit codes: 0 ok · 2 bad args · 64 non-Darwin · 70 build · 75 port collision (verify-b) ·
            73 plutil -lint · 77 refuse-to-clobber (use --force).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)        REPO_DIR="${2:?missing value for --repo-dir}"; shift 2 ;;
    --workspace-root)  WORKSPACE_ROOT="${2:?missing value for --workspace-root}"; shift 2 ;;
    --hub-db-path)     HUB_DB_PATH="${2:?missing value for --hub-db-path}"; shift 2 ;;
    --ws-port)         WS_PORT="${2:?missing value for --ws-port}"; shift 2 ;;
    --owner-principal) OWNER_PRINCIPAL="${2:?missing value for --owner-principal}"; shift 2 ;;
    --store-dir)       STORE_DIR="${2:?missing value for --store-dir}"; shift 2 ;;
    --log-dir)         LOG_DIR="${2:?missing value for --log-dir}"; shift 2 ;;
    --rust-server-bin) RUST_SERVER_BIN="${2:?missing value for --rust-server-bin}"; shift 2 ;;
    --stage-dir)       STAGE_DIR="${2:?missing value for --stage-dir}"; shift 2 ;;
    --skip-build)      SKIP_BUILD="true"; shift ;;
    --force)           FORCE="true"; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage; die "unknown argument: $1" 2 ;;
  esac
done

# --- platform gate -----------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  die "macOS LaunchAgents require Darwin; this cutover tool runs on the operator's Mac." 64
fi

# --- resolve + validate REPO_DIR (and locate the template) -------------------
[[ -n "${REPO_DIR}" ]] || die "REPO_DIR is required (env REPO_DIR or --repo-dir)." 2
[[ -d "${REPO_DIR}" ]] || die "REPO_DIR is not a directory: ${REPO_DIR}" 2
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"   # absolutize
TEMPLATE="${REPO_DIR}/${TEMPLATE_REL}"
[[ -f "${TEMPLATE}" ]] || die "plist template not found at ${TEMPLATE}" 2
RUST_CORE_DIR="${REPO_DIR}/rust-core"
[[ -d "${RUST_CORE_DIR}" ]] || die "rust-core/ not found under REPO_DIR: ${RUST_CORE_DIR}" 2

# --- require absolute paths (launchd does NOT expand ~) ----------------------
# We expand a leading ~ ourselves and then REQUIRE the result be absolute, so a
# literal '~/...' or a relative path can never silently break the supervised
# server's boot.
expand_abs() {
  # $1 = human label, $2 = value. Echoes the absolutized value or dies.
  # A leading tilde is expanded to $HOME by HAND (this runs in `case`/`${#}`
  # contexts where the shell does NOT do tilde expansion); `tilde` holds the
  # literal '~' char so there is no unquoted/quoted-tilde ambiguity.
  local label="$1" val="$2" tilde='~'
  if [[ "${val}" == "${tilde}" ]]; then
    val="${HOME}"
  elif [[ "${val}" == "${tilde}/"* ]]; then
    val="${HOME}/${val#"${tilde}"/}"
  fi
  [[ "${val}" == /* ]] || die "${label} must be an absolute path (got: ${val})" 2
  printf '%s' "${val}"
}

[[ -n "${WORKSPACE_ROOT}" ]] || die "WORKSPACE_ROOT is required." 2
[[ -n "${HUB_DB_PATH}"    ]] || die "HUB_DB_PATH is required." 2
[[ -n "${OWNER_PRINCIPAL}" ]] || die "OWNER_PRINCIPAL is required." 2
WORKSPACE_ROOT="$(expand_abs WORKSPACE_ROOT "${WORKSPACE_ROOT}")"
HUB_DB_PATH="$(expand_abs HUB_DB_PATH "${HUB_DB_PATH}")"

# STORE_DIR / LOG_DIR defaults mirror the Rust key_source default + the house
# launchd log dir. Both absolutized; STORE_DIR MUST match the enroll CLI's.
STORE_DIR="${STORE_DIR:-${HOME}/.friday/agent-run-securestore}"
LOG_DIR="${LOG_DIR:-${HOME}/.friday/launchd}"
STORE_DIR="$(expand_abs STORE_DIR "${STORE_DIR}")"
LOG_DIR="$(expand_abs LOG_DIR "${LOG_DIR}")"

# --- WS_PORT: require a CONCRETE, non-zero port ------------------------------
# The TS client default (0 = OS-assign) is NOT valid for a launchd-supervised
# server the client dials by number; `lsof -iTCP:0` is meaningless. Require
# 1..65535.
[[ -n "${WS_PORT}" ]] || die "WS_PORT is required (a concrete loopback port, 1..65535)." 2
[[ "${WS_PORT}" =~ ^[0-9]+$ ]] || die "WS_PORT must be numeric (got: ${WS_PORT})." 2
if (( WS_PORT < 1 || WS_PORT > 65535 )); then
  die "WS_PORT must be 1..65535 (got ${WS_PORT}); 0/OS-assign is not allowed for a supervised server." 2
fi

# --- release build (the two bins) --------------------------------------------
RELEASE_DIR="${RUST_CORE_DIR}/target/release"
DEFAULT_SERVER_BIN="${RELEASE_DIR}/hub_agent_run_server"
ENROLL_BIN="${RELEASE_DIR}/hub_agent_run_enroll"

if [[ "${SKIP_BUILD}" == "true" ]]; then
  log "skip-build: not invoking cargo (using existing release bin)."
else
  command -v cargo >/dev/null 2>&1 || die "cargo not found in PATH; install the Rust toolchain." 70
  log "release-building hub_agent_run_server + hub_agent_run_enroll (cargo --release) ..."
  ( cd "${RUST_CORE_DIR}" \
      && cargo build --release --bin hub_agent_run_server --bin hub_agent_run_enroll ) \
    || die "cargo build --release failed." 70
  log "built: ${DEFAULT_SERVER_BIN}"
  log "built: ${ENROLL_BIN}  (run ONCE to enroll the client pubkey — see runbook)"
fi

# Default the server bin to the just-built release path unless overridden.
RUST_SERVER_BIN="${RUST_SERVER_BIN:-${DEFAULT_SERVER_BIN}}"
RUST_SERVER_BIN="$(expand_abs RUST_SERVER_BIN "${RUST_SERVER_BIN}")"
[[ -f "${RUST_SERVER_BIN}" ]] || die "server bin not found: ${RUST_SERVER_BIN} (build first, or pass --rust-server-bin)." 70
[[ -x "${RUST_SERVER_BIN}" ]] || die "server bin is not executable: ${RUST_SERVER_BIN}" 70

# =============================================================================
# verify-b — PORT COLLISION / SINGLE-OWNER of the loopback port
# =============================================================================
# The launchd-supervised server is the SINGLE owner of WS_PORT on 127.0.0.1.
# Before emitting the bootstrap command we check, fail-closed:
#   (1) WS_PORT is NOT already LISTENing (lsof); and
#   (2) WS_PORT is NOT the port the TS hub (com.friday.hub) uses.
# Reminder: the server binds 127.0.0.1 ONLY (loopback) — never the LAN.

log "verify-b: WS_PORT=${WS_PORT} must be free + distinct from the TS hub's port (loopback-only)."

# (1) Is anything already LISTENing on WS_PORT?
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"${WS_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "WS_PORT ${WS_PORT} is already in use (something is LISTENing). Choose a free port." 75
  fi
  log "verify-b: port ${WS_PORT} is free (no LISTENer)."
else
  log "verify-b: WARNING — lsof not found; could not confirm port ${WS_PORT} is free. Confirm manually."
fi

# (2) Discover the TS hub's port WITHOUT reading any secret. The hub's port is
# the FRIDAY_PORT EnvironmentVariables key in ~/Library/LaunchAgents/com.friday.hub.plist
# (default 3141 when absent). The hub plist's env ALSO holds a real auth token
# (FRIDAY_SYSTEM_COMPANION_AUTH_TOKEN), so we extract ONLY the single FRIDAY_PORT
# key — we NEVER cat/grep/Print the whole file, and we sanitize the captured value
# to digits-only IMMEDIATELY so a tool error string (PlistBuddy prints "Error
# Reading File: ..." on stdout for a malformed/unreadable plist) can never become
# a port or leak into a comparison.
HUB_PLIST="${HOME}/Library/LaunchAgents/${HUB_LABEL}.plist"

# Read JUST the FRIDAY_PORT env key as a bare value; echo only [0-9]+ or nothing.
read_hub_port() {
  local raw=""
  if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
    raw="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:FRIDAY_PORT" "${HUB_PLIST}" 2>/dev/null || true)"
  fi
  if [[ ! "${raw}" =~ ^[0-9]+$ ]] && command -v plutil >/dev/null 2>&1; then
    raw="$(plutil -extract EnvironmentVariables.FRIDAY_PORT raw -o - "${HUB_PLIST}" 2>/dev/null || true)"
  fi
  # Only a pure-integer capture is trusted; anything else (empty, "Error Reading
  # File", "<missing>") is discarded → caller treats it as "could not read".
  # NOTE: this must `return 0` on the no-port path. A trailing `[[ … ]] && printf`
  # would make the function exit 1 when no port is found, and the caller's bare
  # `HUB_PORT="$(read_hub_port)"` assignment under `set -e` would then abort the
  # whole script BEFORE the default-3141 branch — exactly the common production
  # case (the house installer sets no FRIDAY_PORT). So print conditionally, then
  # always succeed.
  if [[ "${raw}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${raw}"
  fi
  return 0
}

HUB_PORT=""
HUB_PORT_SOURCE="none"
if [[ -f "${HUB_PLIST}" ]]; then
  if plutil -lint "${HUB_PLIST}" >/dev/null 2>&1; then
    HUB_PORT="$(read_hub_port)"
    if [[ -n "${HUB_PORT}" ]]; then
      HUB_PORT_SOURCE="explicit"
    else
      # Valid plist but no FRIDAY_PORT key → the TS hub falls back to 3141.
      HUB_PORT="3141"
      HUB_PORT_SOURCE="default"
    fi
  else
    # The file exists but is not a readable/valid plist — do NOT assume 3141
    # (assuming a default we can't confirm could silently pick a colliding port).
    HUB_PORT_SOURCE="unreadable"
  fi
fi

case "${HUB_PORT_SOURCE}" in
  explicit) log "verify-b: TS hub port is ${HUB_PORT} (FRIDAY_PORT in ${HUB_LABEL}.plist)." ;;
  default)  log "verify-b: ${HUB_LABEL}.plist sets no FRIDAY_PORT; TS hub uses its default (3141)." ;;
  unreadable)
    log "verify-b: WARNING — ${HUB_LABEL}.plist exists but could not be parsed; could NOT read the TS hub port. Confirm WS_PORT != the TS hub's port MANUALLY."
    ;;
  none)
    log "verify-b: WARNING — ${HUB_LABEL}.plist not installed; cannot auto-discover the TS hub port. Confirm WS_PORT != the TS hub's port MANUALLY."
    ;;
esac

if [[ "${HUB_PORT}" =~ ^[0-9]+$ ]]; then
  if (( WS_PORT == HUB_PORT )); then
    die "WS_PORT ${WS_PORT} collides with the TS hub port (${HUB_PORT}). Pick a different loopback port." 75
  fi
  log "verify-b: WS_PORT ${WS_PORT} != TS hub port ${HUB_PORT}. OK."
fi

# =============================================================================
# FILL the template → stage (NOT into ~/Library/LaunchAgents)
# =============================================================================
STAGE_DIR="${STAGE_DIR:-${LOG_DIR}/staging}"
STAGE_DIR="$(expand_abs STAGE_DIR "${STAGE_DIR}")"
# Staging is NOT installation: refuse to write the filled plist into the live
# LaunchAgents dir (where launchd would auto-load it at next login). The operator
# bootstraps manually from the staged copy — this tool never installs.
case "${STAGE_DIR}" in
  "${HOME}/Library/LaunchAgents" | "${HOME}/Library/LaunchAgents/"*)
    die "--stage-dir must not be inside ~/Library/LaunchAgents (staging is not installation; bootstrap manually)." 2 ;;
esac
mkdir -p "${STAGE_DIR}" "${LOG_DIR}"
STAGED_PLIST="${STAGE_DIR}/${LABEL}.plist"

if [[ -e "${STAGED_PLIST}" && "${FORCE}" != "true" ]]; then
  die "staged plist already exists: ${STAGED_PLIST} (pass --force to overwrite)." 77
fi

# Refuse to clobber an EXISTING install without --force (idempotency / safety).
INSTALLED_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
if [[ -e "${INSTALLED_PLIST}" && "${FORCE}" != "true" ]]; then
  die "${LABEL} is ALREADY installed at ${INSTALLED_PLIST}. Re-run with --force to re-stage (you still bootstrap manually)." 77
fi

# sed-escape a replacement value (so a path with & or / cannot corrupt the
# substitution). Escapes \, &, and the / delimiter.
# NOTE: this escapes for SED, not XML. A value containing an XML-special char
# (& < >) — unusual in the expected inputs (paths under ~/.friday, a principal id,
# a port) — is NOT XML-escaped here. That cannot cause a SILENT bad install: the
# `plutil -lint` gate below rejects any malformed result and the script aborts
# (exit 73) before staging is considered valid. Operators should pass XML-clean
# values; if one isn't, the lint abort tells them so.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&/]/\\&/g'; }

fill_template() {
  sed \
    -e "s/__RUST_SERVER_BIN__/$(sed_escape "${RUST_SERVER_BIN}")/g" \
    -e "s/__WORKSPACE_ROOT__/$(sed_escape "${WORKSPACE_ROOT}")/g" \
    -e "s/__HUB_DB_PATH__/$(sed_escape "${HUB_DB_PATH}")/g" \
    -e "s/__WS_PORT__/$(sed_escape "${WS_PORT}")/g" \
    -e "s/__OWNER_PRINCIPAL__/$(sed_escape "${OWNER_PRINCIPAL}")/g" \
    -e "s/__STORE_DIR__/$(sed_escape "${STORE_DIR}")/g" \
    -e "s/__LOG_DIR__/$(sed_escape "${LOG_DIR}")/g" \
    -e "s/__REPO_DIR__/$(sed_escape "${REPO_DIR}")/g" \
    "${TEMPLATE}"
}

fill_template > "${STAGED_PLIST}"

# Guard: no unfilled placeholder may survive (a missed __X__ would be a silent
# boot failure). Fail loudly if any remain.
if grep -q '__[A-Z_]*__' "${STAGED_PLIST}"; then
  log "remaining unfilled placeholders:"
  grep -o '__[A-Z_]*__' "${STAGED_PLIST}" | sort -u >&2
  rm -f "${STAGED_PLIST}"
  die "the filled plist still has unfilled placeholders (see above)." 2
fi

# --- VALIDATE: plutil -lint --------------------------------------------------
if command -v plutil >/dev/null 2>&1; then
  if ! plutil -lint "${STAGED_PLIST}" >/dev/null; then
    plutil -lint "${STAGED_PLIST}" >&2 || true
    die "plutil -lint FAILED on the filled plist: ${STAGED_PLIST}" 73
  fi
  log "plutil -lint OK: ${STAGED_PLIST}"
else
  log "WARNING — plutil not found; could not lint the filled plist. Validate manually before bootstrap."
fi

# --- emit the operator's bootstrap command (DO NOT RUN IT) -------------------
cat >&2 <<EOF

[cutover] DARK staging complete — NOTHING was installed or loaded.
[cutover]   staged plist : ${STAGED_PLIST}
[cutover]   server bin   : ${RUST_SERVER_BIN}
[cutover]   enroll bin   : ${ENROLL_BIN}
[cutover]   store-dir    : ${STORE_DIR}   (MUST equal the dir you ran hub_agent_run_enroll into)
[cutover]   ws port      : ${WS_PORT} (loopback 127.0.0.1 only)
[cutover]   log dir      : ${LOG_DIR}

[cutover] PRECHECK before bootstrap:
[cutover]   * You ran hub_agent_run_enroll ONCE into the SAME store-dir above.
[cutover]   * ~/.friday/master.key exists for THIS login user (same \$HOME), or
[cutover]     the server boots fail-closed (master_key_unavailable).
[cutover]   * On the TS hub (com.friday.hub) you will set FRIDAY_ROUTE_AGENT_RUN_VIA_RUST=1
[cutover]     and FRIDAY_HUB_AGENT_RUN_WS_PORT=${WS_PORT} (NOT here on the Rust server).

[cutover] To INSTALL + LOAD (operator runs these manually — this tool does NOT):
[cutover]   cp '${STAGED_PLIST}' '${INSTALLED_PLIST}'
[cutover]   launchctl bootout   "gui/\${UID}" '${INSTALLED_PLIST}' 2>/dev/null || true
[cutover]   launchctl enable    "gui/\${UID}/${LABEL}"
[cutover]   launchctl bootstrap "gui/\${UID}" '${INSTALLED_PLIST}'
[cutover]   launchctl kickstart -k "gui/\${UID}/${LABEL}"

EOF

log "done (dark). Review the staged plist, then run the bootstrap commands above by hand."
