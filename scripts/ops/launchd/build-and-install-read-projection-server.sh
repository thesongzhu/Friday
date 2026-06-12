#!/usr/bin/env bash
#
# build-and-install-read-projection-server.sh
# =============================================================================
# slice-6 LIVE-ACTIVATION INFRA (DARK/STAGED) — the read-seam CUTOVER tool.
# Operator-run. Read-seam analog of build-and-install-rust-agent-run-ws-server.sh.
# =============================================================================
#
# WHAT THIS IS
#   Scaffolding for the slice-6 live-flip of the Rust READ-PROJECTION WS server
#   (UI direct-read seam, transport 2b). It is NOT wired into any pipeline. At the
#   explicit slice-6 operator gate, ONE command:
#     1. release-BUILDS the two Rust bins (hub_read_projection_server + the
#        read-seam enroll CLI hub_read_seam_enroll);
#     2. FILLS the launchd plist template from operator-supplied values;
#     3. VALIDATES the filled plist (plutil -lint) and the chosen WS port
#        (free + != the agent-run WRITE server port + != the TS hub's port);
#     4. STAGES the filled plist and PRINTS the launchctl bootstrap command for
#        the operator to run.
#
# WHAT THIS DELIBERATELY DOES NOT DO (DARK / operator-gated)
#   * It does NOT copy anything into ~/Library/LaunchAgents.
#   * It does NOT run `launchctl bootstrap` / `kickstart` / `enable`.
#   * It does NOT run hub_read_seam_enroll (a SEPARATE, one-time operator step;
#     it writes the UI peer pubkey into the SAME store dir this script fills into
#     --store-dir; the operator must use the SAME STORE_DIR for both).
#   * It places NO secret in the plist or its env. The server reads its own master
#     key (~/.friday/master.key) at boot; the per-session sealed-WS key is derived
#     per-handshake from the enrolled peer pubkey. Neither is ever an arg/env here.
#   * It sets NO route flag — there is no hub-side read-seam flag; the read path is
#     activated by installing THIS LaunchAgent + the UI presenting an allowlisted
#     peer key (per the 2b topology).
#
# OPTIONAL MASTER-KEY-ENV-FILE WRAPPER MODE (--master-key-env-file <path>)
#   The read server reads its master key from ~/.friday/master.key by default and
#   needs NO wrapper in the common path (unlike the WRITE server, it has NO DeepSeek
#   key requirement). Use this flag ONLY when ~/.friday/master.key is absent for the
#   supervised user and you must deliver FRIDAY_MASTER_KEY at runtime from an
#   operator-approved 0600/0400 env file. The tool then:
#     a. VALIDATES the env file (exists, mode 0600/0400, owned by the invoking user,
#        defines a non-empty FRIDAY_MASTER_KEY) — without ever printing a value;
#     b. GENERATES a 0700 wrapper (read-projection-server-run.sh) into the staging
#        dir that sources ONLY that env file, fail-closed exits 2 when the key is
#        missing, exports FRIDAY_MASTER_KEY, and execs the server bin with the exact
#        same args the direct-mode plist would have used;
#     c. STAGES the plist with ProgramArguments pointing at the wrapper's INSTALL
#        path (<LOG_DIR>/read-projection-server-run.sh).
#   Without the flag, behavior is direct-exec (no wrapper) — the recommended path.
#
# USAGE
#   scripts/ops/launchd/build-and-install-read-projection-server.sh [options]
#
#   Required (env var OR flag; flag wins):
#     REPO_DIR        / --repo-dir <abs>        repo root (contains rust-core/)
#     HUB_DB_PATH     / --hub-db-path <abs>     the Rust Hub SQLite (read READ-ONLY)
#     WS_PORT         / --ws-port <1..65535>    the loopback read port (NON-ZERO; e.g. 48751)
#     OWNER_PRINCIPAL / --owner-principal <s>   the bound-owner allowlist entry (e.g. admin-001)
#
#   Optional:
#     STORE_DIR              / --store-dir <abs>              FileSecureStore dir
#                                                            (default ~/.friday/agent-run-securestore;
#                                                             MUST match what hub_read_seam_enroll used)
#     LOG_DIR                / --log-dir <abs>                launchd log dir (default ~/.friday/launchd)
#     RUST_SERVER_BIN        / --rust-server-bin <abs>        prebuilt read-server bin; default is the
#                                                            just-built rust-core/target/release path
#     WRITE_WS_PORT          / --write-ws-port <1..65535>     the agent-run WRITE server port to avoid
#                                                            (default 48750; verify-b)
#     MASTER_KEY_ENV_FILE    / --master-key-env-file <abs>    opt-in wrapper mode: 0600/0400 env file
#                                                            holding FRIDAY_MASTER_KEY (see above)
#     --stage-dir <abs>                                        where to write the filled plist
#                                                            (default <LOG_DIR>/staging)
#     --skip-build                                            do not cargo build (use an existing bin)
#     --force                                                 overwrite an existing staged plist /
#                                                            proceed despite an EXISTING install
#     -h | --help                                            show this help and exit
#
# EXIT CODES
#   0 ok · 2 bad args/usage (incl. master-key-env-file validation failure) ·
#   64 non-Darwin · 70 build failure ·
#   75 port collision / port not free (verify-b) · 73 plutil -lint failure ·
#   77 refusing to clobber without --force
#
# Run by the operator with a one-time permission at the slice-6 cutover. Until then
# nothing here executes; the read server stays dark.
# =============================================================================

set -Eeuo pipefail

LABEL="com.friday.read-projection-server"
HUB_LABEL="com.friday.hub"
TEMPLATE_REL="scripts/ops/launchd/${LABEL}.plist"
WRAPPER_TEMPLATE_REL="scripts/ops/launchd/read-projection-server-run.sh.template"

# --- defaults (overridable by env, then flags) -------------------------------
REPO_DIR="${REPO_DIR:-}"
HUB_DB_PATH="${HUB_DB_PATH:-}"
WS_PORT="${WS_PORT:-}"
OWNER_PRINCIPAL="${OWNER_PRINCIPAL:-}"
STORE_DIR="${STORE_DIR:-}"
LOG_DIR="${LOG_DIR:-}"
RUST_SERVER_BIN="${RUST_SERVER_BIN:-}"
WRITE_WS_PORT="${WRITE_WS_PORT:-48750}"
MASTER_KEY_ENV_FILE="${MASTER_KEY_ENV_FILE:-}"
STAGE_DIR=""
SKIP_BUILD="false"
FORCE="false"

WRAPPER_NAME="read-projection-server-run.sh"

log()  { printf '[read-cutover] %s\n' "$*" >&2; }
die()  { printf '[read-cutover] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

usage() {
  cat <<'EOF'
build-and-install-read-projection-server.sh — slice-6 read-seam cutover tool (DARK).

Release-builds the Rust read-projection WS server bins, fills the launchd plist
template, runs verify-b (port free + != the WRITE server port + != the TS hub's
port, loopback-only), validates with plutil -lint, STAGES the filled plist, and
PRINTS the launchctl bootstrap command. It does NOT install, bootstrap, enroll,
place any secret, or set any route flag.

Usage:
  scripts/ops/launchd/build-and-install-read-projection-server.sh [options]

Required (env var OR flag; flag wins):
  REPO_DIR        / --repo-dir <abs>          repo root (contains rust-core/)
  HUB_DB_PATH     / --hub-db-path <abs>       Rust Hub SQLite (read READ-ONLY)
  WS_PORT         / --ws-port <1..65535>      loopback read port (NON-ZERO; e.g. 48751)
  OWNER_PRINCIPAL / --owner-principal <s>     bound-owner allowlist entry (e.g. admin-001)

Optional:
  STORE_DIR            / --store-dir <abs>            FileSecureStore dir
                                                      (default ~/.friday/agent-run-securestore;
                                                       MUST match the dir hub_read_seam_enroll used)
  LOG_DIR              / --log-dir <abs>              launchd log dir (default ~/.friday/launchd)
  RUST_SERVER_BIN      / --rust-server-bin <abs>      prebuilt server bin (default: just-built release)
  WRITE_WS_PORT        / --write-ws-port <1..65535>   WRITE server port to avoid (default 48750)
  MASTER_KEY_ENV_FILE  / --master-key-env-file <abs>  opt-in WRAPPER MODE: a 0600/0400 env file,
                                                      owned by you, defining FRIDAY_MASTER_KEY.
                                                      Only needed when ~/.friday/master.key is absent.
  --stage-dir <abs>                                   filled-plist staging dir (default <LOG_DIR>/staging)
  --skip-build                                        use an existing bin; do not cargo build
  --force                                             overwrite a staged plist / proceed despite an install
  -h | --help                                         show this help

Exit codes: 0 ok · 2 bad args (incl. env-file validation) · 64 non-Darwin · 70 build ·
            75 port collision (verify-b) · 73 plutil -lint · 77 refuse-to-clobber (use --force).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)             REPO_DIR="${2:?missing value for --repo-dir}"; shift 2 ;;
    --hub-db-path)          HUB_DB_PATH="${2:?missing value for --hub-db-path}"; shift 2 ;;
    --ws-port)              WS_PORT="${2:?missing value for --ws-port}"; shift 2 ;;
    --owner-principal)      OWNER_PRINCIPAL="${2:?missing value for --owner-principal}"; shift 2 ;;
    --store-dir)            STORE_DIR="${2:?missing value for --store-dir}"; shift 2 ;;
    --log-dir)              LOG_DIR="${2:?missing value for --log-dir}"; shift 2 ;;
    --rust-server-bin)      RUST_SERVER_BIN="${2:?missing value for --rust-server-bin}"; shift 2 ;;
    --write-ws-port)        WRITE_WS_PORT="${2:?missing value for --write-ws-port}"; shift 2 ;;
    --master-key-env-file)  MASTER_KEY_ENV_FILE="${2:?missing value for --master-key-env-file}"; shift 2 ;;
    --stage-dir)            STAGE_DIR="${2:?missing value for --stage-dir}"; shift 2 ;;
    --skip-build)           SKIP_BUILD="true"; shift ;;
    --force)                FORCE="true"; shift ;;
    -h|--help)              usage; exit 0 ;;
    *)                      usage; die "unknown argument: $1" 2 ;;
  esac
done

# --- platform gate -----------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  die "macOS LaunchAgents require Darwin; this cutover tool runs on the operator's Mac." 64
fi

# --- resolve + validate REPO_DIR (and locate the templates) ------------------
[[ -n "${REPO_DIR}" ]] || die "REPO_DIR is required (env REPO_DIR or --repo-dir)." 2
[[ -d "${REPO_DIR}" ]] || die "REPO_DIR is not a directory: ${REPO_DIR}" 2
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"   # absolutize
TEMPLATE="${REPO_DIR}/${TEMPLATE_REL}"
[[ -f "${TEMPLATE}" ]] || die "plist template not found at ${TEMPLATE}" 2
WRAPPER_TEMPLATE="${REPO_DIR}/${WRAPPER_TEMPLATE_REL}"
RUST_CORE_DIR="${REPO_DIR}/rust-core"
[[ -d "${RUST_CORE_DIR}" ]] || die "rust-core/ not found under REPO_DIR: ${RUST_CORE_DIR}" 2

# --- require absolute paths (launchd does NOT expand ~) ----------------------
expand_abs() {
  local label="$1" val="$2" tilde='~'
  if [[ "${val}" == "${tilde}" ]]; then
    val="${HOME}"
  elif [[ "${val}" == "${tilde}/"* ]]; then
    val="${HOME}/${val#"${tilde}"/}"
  fi
  [[ "${val}" == /* ]] || die "${label} must be an absolute path (got: ${val})" 2
  printf '%s' "${val}"
}

[[ -n "${HUB_DB_PATH}"     ]] || die "HUB_DB_PATH is required." 2
[[ -n "${OWNER_PRINCIPAL}" ]] || die "OWNER_PRINCIPAL is required." 2
HUB_DB_PATH="$(expand_abs HUB_DB_PATH "${HUB_DB_PATH}")"

# STORE_DIR / LOG_DIR defaults mirror the Rust key_source default + the house launchd log dir.
STORE_DIR="${STORE_DIR:-${HOME}/.friday/agent-run-securestore}"
LOG_DIR="${LOG_DIR:-${HOME}/.friday/launchd}"
STORE_DIR="$(expand_abs STORE_DIR "${STORE_DIR}")"
LOG_DIR="$(expand_abs LOG_DIR "${LOG_DIR}")"

# --- WS_PORT: require a CONCRETE, non-zero port ------------------------------
# The read bin's --port DEFAULTS TO 0 (OS-assign) if omitted — NOT valid for a
# launchd-supervised server a client dials by number. Require 1..65535.
[[ -n "${WS_PORT}" ]] || die "WS_PORT is required (a concrete loopback read port, 1..65535; e.g. 48751)." 2
[[ "${WS_PORT}" =~ ^[0-9]+$ ]] || die "WS_PORT must be numeric (got: ${WS_PORT})." 2
if (( WS_PORT < 1 || WS_PORT > 65535 )); then
  die "WS_PORT must be 1..65535 (got ${WS_PORT}); 0/OS-assign is not allowed for a supervised server." 2
fi
[[ "${WRITE_WS_PORT}" =~ ^[0-9]+$ ]] || die "WRITE_WS_PORT must be numeric (got: ${WRITE_WS_PORT})." 2

# --- MASTER_KEY_ENV_FILE (opt-in wrapper mode): validate WITHOUT printing any value --
if [[ -n "${MASTER_KEY_ENV_FILE}" ]]; then
  MASTER_KEY_ENV_FILE="$(expand_abs MASTER_KEY_ENV_FILE "${MASTER_KEY_ENV_FILE}")"
  [[ -f "${MASTER_KEY_ENV_FILE}" ]] || die "--master-key-env-file is not a regular file: ${MASTER_KEY_ENV_FILE}" 2
  KEY_ENV_PERMS="$(stat -L -f '%Lp' "${MASTER_KEY_ENV_FILE}" 2>/dev/null || true)"
  case "${KEY_ENV_PERMS}" in
    600|400) ;;
    *) die "--master-key-env-file must be mode 0600 or 0400 (got ${KEY_ENV_PERMS:-unreadable}): ${MASTER_KEY_ENV_FILE} — chmod 600 it." 2 ;;
  esac
  KEY_ENV_OWNER="$(stat -L -f '%u' "${MASTER_KEY_ENV_FILE}" 2>/dev/null || true)"
  if [[ "${KEY_ENV_OWNER}" != "$(id -u)" ]]; then
    die "--master-key-env-file must be owned by the invoking user (uid $(id -u); file owner uid ${KEY_ENV_OWNER:-unreadable})." 2
  fi
  # shellcheck source=/dev/null
  if ! ( set -a; . "${MASTER_KEY_ENV_FILE}" >/dev/null 2>&1; [[ -n "${FRIDAY_MASTER_KEY:-}" ]] ); then
    die "--master-key-env-file does not define a non-empty FRIDAY_MASTER_KEY: ${MASTER_KEY_ENV_FILE}" 2
  fi
  [[ -f "${WRAPPER_TEMPLATE}" ]] || die "wrapper template not found at ${WRAPPER_TEMPLATE}" 2
  log "master-key-env-file OK: ${MASTER_KEY_ENV_FILE} (mode 0${KEY_ENV_PERMS}, owner-only; key present — value not read into this tool)."
fi

# --- release build (the two bins) --------------------------------------------
RELEASE_DIR="${RUST_CORE_DIR}/target/release"
DEFAULT_SERVER_BIN="${RELEASE_DIR}/hub_read_projection_server"
ENROLL_BIN="${RELEASE_DIR}/hub_read_seam_enroll"

if [[ "${SKIP_BUILD}" == "true" ]]; then
  log "skip-build: not invoking cargo (using existing release bin)."
else
  command -v cargo >/dev/null 2>&1 || die "cargo not found in PATH; install the Rust toolchain." 70
  log "release-building hub_read_projection_server + hub_read_seam_enroll (cargo --release) ..."
  ( cd "${RUST_CORE_DIR}" \
      && cargo build --release --bin hub_read_projection_server --bin hub_read_seam_enroll ) \
    || die "cargo build --release failed." 70
  log "built: ${DEFAULT_SERVER_BIN}"
  log "built: ${ENROLL_BIN}  (run ONCE to enroll the UI peer pubkey — see runbook)"
fi

RUST_SERVER_BIN="${RUST_SERVER_BIN:-${DEFAULT_SERVER_BIN}}"
RUST_SERVER_BIN="$(expand_abs RUST_SERVER_BIN "${RUST_SERVER_BIN}")"
[[ -f "${RUST_SERVER_BIN}" ]] || die "server bin not found: ${RUST_SERVER_BIN} (build first, or pass --rust-server-bin)." 70
[[ -x "${RUST_SERVER_BIN}" ]] || die "server bin is not executable: ${RUST_SERVER_BIN}" 70

# =============================================================================
# verify-b — PORT COLLISION / SINGLE-OWNER of the loopback read port
# =============================================================================
# The launchd-supervised read server is the SINGLE owner of WS_PORT on 127.0.0.1.
# Before emitting the bootstrap command we check, fail-closed:
#   (1) WS_PORT is NOT already LISTENing (lsof);
#   (2) WS_PORT is NOT the agent-run WRITE server port; and
#   (3) WS_PORT is NOT the port the TS hub (com.friday.hub) uses.
log "verify-b: WS_PORT=${WS_PORT} must be free + != the WRITE port (${WRITE_WS_PORT}) + != the TS hub's port (loopback-only)."

# (1) Is anything already LISTENing on WS_PORT?
if command -v lsof >/dev/null 2>&1; then
  if lsof -nP -iTCP:"${WS_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    die "WS_PORT ${WS_PORT} is already in use (something is LISTENing). Choose a free port." 75
  fi
  log "verify-b: port ${WS_PORT} is free (no LISTENer)."
else
  log "verify-b: WARNING — lsof not found; could not confirm port ${WS_PORT} is free. Confirm manually."
fi

# (2) != the agent-run WRITE server port.
if (( WS_PORT == WRITE_WS_PORT )); then
  die "WS_PORT ${WS_PORT} collides with the agent-run WRITE server port (${WRITE_WS_PORT}). Pick a different loopback port (e.g. 48751)." 75
fi
log "verify-b: WS_PORT ${WS_PORT} != WRITE server port ${WRITE_WS_PORT}. OK."

# (3) Discover the TS hub's port WITHOUT reading any secret (FRIDAY_PORT env key only).
HUB_PLIST="${HOME}/Library/LaunchAgents/${HUB_LABEL}.plist"
read_hub_port() {
  local raw=""
  if command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
    raw="$(/usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:FRIDAY_PORT" "${HUB_PLIST}" 2>/dev/null || true)"
  fi
  if [[ ! "${raw}" =~ ^[0-9]+$ ]] && command -v plutil >/dev/null 2>&1; then
    raw="$(plutil -extract EnvironmentVariables.FRIDAY_PORT raw -o - "${HUB_PLIST}" 2>/dev/null || true)"
  fi
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
      HUB_PORT="3141"
      HUB_PORT_SOURCE="default"
    fi
  else
    HUB_PORT_SOURCE="unreadable"
  fi
fi

case "${HUB_PORT_SOURCE}" in
  explicit) log "verify-b: TS hub port is ${HUB_PORT} (FRIDAY_PORT in ${HUB_LABEL}.plist)." ;;
  default)  log "verify-b: ${HUB_LABEL}.plist sets no FRIDAY_PORT; TS hub uses its default (3141)." ;;
  unreadable)
    log "verify-b: WARNING — ${HUB_LABEL}.plist exists but could not be parsed; could NOT read the TS hub port. Confirm WS_PORT != the TS hub's port MANUALLY." ;;
  none)
    log "verify-b: WARNING — ${HUB_LABEL}.plist not installed; cannot auto-discover the TS hub port. Confirm WS_PORT != the TS hub's port MANUALLY." ;;
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
case "${STAGE_DIR}" in
  "${HOME}/Library/LaunchAgents" | "${HOME}/Library/LaunchAgents/"*)
    die "--stage-dir must not be inside ~/Library/LaunchAgents (staging is not installation; bootstrap manually)." 2 ;;
esac
mkdir -p "${STAGE_DIR}" "${LOG_DIR}"
STAGED_PLIST="${STAGE_DIR}/${LABEL}.plist"

if [[ -e "${STAGED_PLIST}" && "${FORCE}" != "true" ]]; then
  die "staged plist already exists: ${STAGED_PLIST} (pass --force to overwrite)." 77
fi

STAGED_WRAPPER="${STAGE_DIR}/${WRAPPER_NAME}"
WRAPPER_INSTALL_PATH="${LOG_DIR}/${WRAPPER_NAME}"
if [[ -n "${MASTER_KEY_ENV_FILE}" && -e "${STAGED_WRAPPER}" && "${FORCE}" != "true" ]]; then
  die "staged wrapper already exists: ${STAGED_WRAPPER} (pass --force to overwrite)." 77
fi

INSTALLED_PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
if [[ -e "${INSTALLED_PLIST}" && "${FORCE}" != "true" ]]; then
  die "${LABEL} is ALREADY installed at ${INSTALLED_PLIST}. Re-run with --force to re-stage (you still bootstrap manually)." 77
fi

# sed-escape a replacement value (so a path with & or / cannot corrupt the substitution).
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&/]/\\&/g'; }

fill_template() {
  sed \
    -e "s/__RUST_SERVER_BIN__/$(sed_escape "${RUST_SERVER_BIN}")/g" \
    -e "s/__HUB_DB_PATH__/$(sed_escape "${HUB_DB_PATH}")/g" \
    -e "s/__WS_PORT__/$(sed_escape "${WS_PORT}")/g" \
    -e "s/__OWNER_PRINCIPAL__/$(sed_escape "${OWNER_PRINCIPAL}")/g" \
    -e "s/__STORE_DIR__/$(sed_escape "${STORE_DIR}")/g" \
    -e "s/__LOG_DIR__/$(sed_escape "${LOG_DIR}")/g" \
    -e "s/__REPO_DIR__/$(sed_escape "${REPO_DIR}")/g" \
    "${TEMPLATE}"
}

fill_template > "${STAGED_PLIST}"

if grep -q '__[A-Z_]*__' "${STAGED_PLIST}"; then
  log "remaining unfilled placeholders:"
  grep -o '__[A-Z_]*__' "${STAGED_PLIST}" | sort -u >&2
  rm -f "${STAGED_PLIST}"
  die "the filled plist still has unfilled placeholders (see above)." 2
fi

# =============================================================================
# OPTIONAL MASTER-KEY-ENV-FILE WRAPPER MODE — fill the wrapper + repoint ProgramArguments
# =============================================================================
if [[ -n "${MASTER_KEY_ENV_FILE}" ]]; then
  for _wv in "${MASTER_KEY_ENV_FILE}" "${RUST_SERVER_BIN}" "${HUB_DB_PATH}" \
             "${WS_PORT}" "${OWNER_PRINCIPAL}" "${STORE_DIR}"; do
    case "${_wv}" in
      *"'"*) die "wrapper mode cannot embed a value containing a single quote: ${_wv}" 2 ;;
    esac
  done

  sed \
    -e "s/__MASTER_KEY_ENV_FILE__/$(sed_escape "${MASTER_KEY_ENV_FILE}")/g" \
    -e "s/__RUST_SERVER_BIN__/$(sed_escape "${RUST_SERVER_BIN}")/g" \
    -e "s/__HUB_DB_PATH__/$(sed_escape "${HUB_DB_PATH}")/g" \
    -e "s/__WS_PORT__/$(sed_escape "${WS_PORT}")/g" \
    -e "s/__OWNER_PRINCIPAL__/$(sed_escape "${OWNER_PRINCIPAL}")/g" \
    -e "s/__STORE_DIR__/$(sed_escape "${STORE_DIR}")/g" \
    "${WRAPPER_TEMPLATE}" > "${STAGED_WRAPPER}"

  if grep -q '__[A-Z_]*__' "${STAGED_WRAPPER}"; then
    log "remaining unfilled wrapper placeholders:"
    grep -o '__[A-Z_]*__' "${STAGED_WRAPPER}" | sort -u >&2
    rm -f "${STAGED_WRAPPER}" "${STAGED_PLIST}"
    die "the filled wrapper still has unfilled placeholders (see above)." 2
  fi
  chmod 0700 "${STAGED_WRAPPER}"
  if ! sh -n "${STAGED_WRAPPER}"; then
    rm -f "${STAGED_WRAPPER}" "${STAGED_PLIST}"
    die "generated wrapper failed sh -n syntax check: ${STAGED_WRAPPER}" 2
  fi
  log "staged master-key-delivery wrapper (0700): ${STAGED_WRAPPER}"

  # Repoint ProgramArguments at the wrapper's INSTALL path (the wrapper carries the
  # full server arg list itself, so the array becomes the single wrapper path).
  WRAPPER_PLIST_TMP="${STAGED_PLIST}.wrapper-mode.tmp"
  WRAPPER_INSTALL_PATH="${WRAPPER_INSTALL_PATH}" awk '
    /<key>ProgramArguments<\/key>/ { print; inpa=1; next }
    inpa && /<array>/ {
      print "  <array>"
      print "    <!-- MASTER-KEY-ENV-FILE WRAPPER MODE: launchd execs this 0700 wrapper, which"
      print "         sources ONLY FRIDAY_MASTER_KEY from the operator-approved 0600 env file at"
      print "         runtime (fail-closed exit 2 when missing) and execs the server bin with the"
      print "         exact args direct mode would have used. NO secret lives in this plist — only"
      print "         the wrapper PATH appears here. -->"
      printf "    <string>%s</string>\n", ENVIRON["WRAPPER_INSTALL_PATH"]
      print "  </array>"
      inpa=0; skip=1; next
    }
    skip { if (/<\/array>/) { skip=0 }; next }
    { print }
  ' "${STAGED_PLIST}" > "${WRAPPER_PLIST_TMP}"
  mv "${WRAPPER_PLIST_TMP}" "${STAGED_PLIST}"
  log "staged plist repointed at wrapper install path: ${WRAPPER_INSTALL_PATH}"
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
{
  cat <<EOF

[read-cutover] DARK staging complete — NOTHING was installed or loaded.
[read-cutover]   staged plist : ${STAGED_PLIST}
EOF

  if [[ -n "${MASTER_KEY_ENV_FILE}" ]]; then
    cat <<EOF
[read-cutover]   staged wrapper : ${STAGED_WRAPPER}  (0700; plist execs its INSTALL path below)
[read-cutover]   wrapper install: ${WRAPPER_INSTALL_PATH}
[read-cutover]   master-key file: ${MASTER_KEY_ENV_FILE}  (0600/0400 owner-only; sourced by the wrapper at RUNTIME — never read into the plist)
EOF
  fi

  cat <<EOF
[read-cutover]   server bin   : ${RUST_SERVER_BIN}
[read-cutover]   enroll bin   : ${ENROLL_BIN}
[read-cutover]   store-dir    : ${STORE_DIR}   (MUST equal the dir you ran hub_read_seam_enroll into)
[read-cutover]   ws port      : ${WS_PORT} (loopback 127.0.0.1 only)
[read-cutover]   log dir      : ${LOG_DIR}

[read-cutover] PRECHECK before bootstrap:
[read-cutover]   * You ran hub_read_seam_enroll ONCE into the SAME store-dir above
[read-cutover]     (desktop UI: hub_read_seam_enroll --from-master; or a device pubkey via --pubkey).
[read-cutover]   * ~/.friday/master.key exists for THIS login user (same \$HOME), or you used
[read-cutover]     --master-key-env-file; else the server boots fail-closed (master_key_unavailable).
[read-cutover]   * The read seam needs NO hub-side route flag — installing this LaunchAgent +
[read-cutover]     the UI presenting an allowlisted peer key is what activates the read path.

[read-cutover] To INSTALL + LOAD (operator runs these manually — this tool does NOT):
EOF

  if [[ -n "${MASTER_KEY_ENV_FILE}" ]]; then
    cat <<EOF
[read-cutover]   install -m 0700 '${STAGED_WRAPPER}' '${WRAPPER_INSTALL_PATH}'
EOF
  fi

  cat <<EOF
[read-cutover]   cp '${STAGED_PLIST}' '${INSTALLED_PLIST}'
[read-cutover]   launchctl bootout   "gui/\${UID}" '${INSTALLED_PLIST}' 2>/dev/null || true
[read-cutover]   launchctl enable    "gui/\${UID}/${LABEL}"
[read-cutover]   launchctl bootstrap "gui/\${UID}" '${INSTALLED_PLIST}'
[read-cutover]   launchctl kickstart -k "gui/\${UID}/${LABEL}"
[read-cutover]
[read-cutover] To UNINSTALL: scripts/ops/launchd/uninstall-read-projection-server.sh

EOF
} >&2

log "done (dark). Review the staged plist, then run the bootstrap commands above by hand."
