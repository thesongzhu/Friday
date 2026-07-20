#!/usr/bin/env bash
#
# stage-rust-agent-run-ws-server-payload.sh
# =============================================================================
# CORE-A round-3 Lane C (finding #4) — the SHARED packaging step that puts the
# Rust agent-run WS server INTO the release artifacts.
# =============================================================================
#
# WHY THIS EXISTS
#   The release runtime routes a qualifying agent-run / session create+append to
#   the loopback Rust sealed-WS server (`hub_agent_run_server`); TS `startRun` is
#   retired to a fail-closed 503 (no silent TS fallback). BEFORE this step the
#   server + its enroll CLI were packaged/launched ONLY by the DARK operator tool
#   `build-and-install-rust-agent-run-ws-server.sh` — there were ZERO
#   `hub_agent_run` / `cargo` / `rust-core` refs in the DMG or source-dist build
#   scripts, so a clean install shipped NO Rust server and every run hit 503.
#
#   This helper is the ONE place that release-BUILDS the two bins and STAGES the
#   packaged payload (both bins + the launchd plist template + the fill/enroll/
#   launch cutover tool + a manifest) into a caller-supplied destination. Both
#   `build-friday-companion-dmg.sh` and `build-friday-source-distribution.sh`
#   call it so the two channels stay byte-consistent; `install-friday-launchagent.sh`
#   consumes the staged payload to install + enroll + launch the 4th launch agent.
#
# WHAT IT STAGES (into <DEST_DIR>/rust-agent-run/)
#   * hub_agent_run_server   — the loopback sealed-WS server bin (--workspace --db
#                              --port --owner --store-dir; reads ~/.friday/master.key)
#   * hub_agent_run_enroll   — enrolls THIS host's client pubkey into --store-dir
#   * com.friday.rust-agent-run-ws-server.plist — the launchd plist TEMPLATE (the
#                              installer fills its placeholders)
#   * build-and-install-rust-agent-run-ws-server.sh — the fill/lint/port-check/
#                              stage cutover tool the installer reuses
#   * payload-manifest.json  — the machine-readable manifest listing the above
#                              (the release-pipeline contract asserts this shape)
#
# USAGE
#   stage-rust-agent-run-ws-server-payload.sh --repo-dir <abs> --dest-dir <abs> [--skip-build]
#   stage-rust-agent-run-ws-server-payload.sh <repo-dir> <dest-dir> [--skip-build]
#
# EXIT CODES
#   0 ok · 2 bad args · 70 build failure / missing bin · 78 missing prerequisite
# =============================================================================

set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-}"
DEST_DIR="${DEST_DIR:-}"
SKIP_BUILD="false"

log() { printf '[stage-rust-agent-run] %s\n' "$*" >&2; }
die() { printf '[stage-rust-agent-run] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

# The payload files (single source of truth for the packaging contract). The two
# bin BASENAMES + the plist template + cutover tool are what every consumer keys on.
SERVER_BIN_NAME="hub_agent_run_server"
ENROLL_BIN_NAME="hub_agent_run_enroll"
PLIST_TEMPLATE_REL="scripts/ops/launchd/com.friday.rust-agent-run-ws-server.plist"
CUTOVER_TOOL_REL="scripts/ops/launchd/build-and-install-rust-agent-run-ws-server.sh"
PAYLOAD_SUBDIR="rust-agent-run"

# --- parse args (flags win over positionals) ---------------------------------
POSITIONAL=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)  REPO_DIR="${2:?missing value for --repo-dir}"; shift 2 ;;
    --dest-dir)  DEST_DIR="${2:?missing value for --dest-dir}"; shift 2 ;;
    --skip-build) SKIP_BUILD="true"; shift ;;
    -h|--help)
      grep -E '^#( |$)' "${BASH_SOURCE[0]}" | sed -E 's/^# ?//'
      exit 0 ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
if [[ -z "${REPO_DIR}" && ${#POSITIONAL[@]} -ge 1 ]]; then REPO_DIR="${POSITIONAL[0]}"; fi
if [[ -z "${DEST_DIR}" && ${#POSITIONAL[@]} -ge 2 ]]; then DEST_DIR="${POSITIONAL[1]}"; fi

[[ -n "${REPO_DIR}" ]] || die "REPO_DIR is required (--repo-dir or positional)." 2
[[ -d "${REPO_DIR}" ]] || die "REPO_DIR is not a directory: ${REPO_DIR}" 2
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
[[ -n "${DEST_DIR}" ]] || die "DEST_DIR is required (--dest-dir or positional)." 2

RUST_CORE_DIR="${REPO_DIR}/rust-core"
[[ -d "${RUST_CORE_DIR}" ]] || die "rust-core/ not found under REPO_DIR: ${RUST_CORE_DIR}" 78
PLIST_TEMPLATE="${REPO_DIR}/${PLIST_TEMPLATE_REL}"
[[ -f "${PLIST_TEMPLATE}" ]] || die "plist template not found: ${PLIST_TEMPLATE}" 78
CUTOVER_TOOL="${REPO_DIR}/${CUTOVER_TOOL_REL}"
[[ -f "${CUTOVER_TOOL}" ]] || die "cutover tool not found: ${CUTOVER_TOOL}" 78

RELEASE_DIR="${RUST_CORE_DIR}/target/release"
SERVER_BIN="${RELEASE_DIR}/${SERVER_BIN_NAME}"
ENROLL_BIN="${RELEASE_DIR}/${ENROLL_BIN_NAME}"

# --- release-build the two bins (same invocation as the cutover tool) --------
if [[ "${SKIP_BUILD}" == "true" ]]; then
  log "skip-build: using existing release bins."
else
  command -v cargo >/dev/null 2>&1 || die "cargo not found in PATH; install the Rust toolchain." 70
  log "release-building ${SERVER_BIN_NAME} + ${ENROLL_BIN_NAME} (cargo --release) ..."
  ( cd "${RUST_CORE_DIR}" \
      && cargo build --release --bin "${SERVER_BIN_NAME}" --bin "${ENROLL_BIN_NAME}" ) \
    || die "cargo build --release failed." 70
fi
[[ -x "${SERVER_BIN}" ]] || die "server bin missing/not executable: ${SERVER_BIN} (build first)." 70
[[ -x "${ENROLL_BIN}" ]] || die "enroll bin missing/not executable: ${ENROLL_BIN} (build first)." 70

# --- stage the payload -------------------------------------------------------
PAYLOAD_DIR="${DEST_DIR%/}/${PAYLOAD_SUBDIR}"
mkdir -p "${PAYLOAD_DIR}"
install -m 0755 "${SERVER_BIN}" "${PAYLOAD_DIR}/${SERVER_BIN_NAME}"
install -m 0755 "${ENROLL_BIN}" "${PAYLOAD_DIR}/${ENROLL_BIN_NAME}"
install -m 0644 "${PLIST_TEMPLATE}" "${PAYLOAD_DIR}/$(basename "${PLIST_TEMPLATE_REL}")"
install -m 0755 "${CUTOVER_TOOL}" "${PAYLOAD_DIR}/$(basename "${CUTOVER_TOOL_REL}")"

ARCH="$(uname -m)"
OS="$(uname -s)"
sha_of() { if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'; else echo "unavailable"; fi; }

# The manifest is the machine-readable packaging contract the release-pipeline
# check asserts on. It names BOTH bins + the plist template (+ the cutover tool)
# and the installer that consumes them.
cat > "${PAYLOAD_DIR}/payload-manifest.json" <<EOF
{
  "schema": "friday.rust-agent-run.payload.manifest.v1",
  "label": "com.friday.rust-agent-run-ws-server",
  "os": "${OS}",
  "arch": "${ARCH}",
  "bins": [
    { "name": "${SERVER_BIN_NAME}", "role": "server", "sha256": "$(sha_of "${PAYLOAD_DIR}/${SERVER_BIN_NAME}")" },
    { "name": "${ENROLL_BIN_NAME}", "role": "enroll", "sha256": "$(sha_of "${PAYLOAD_DIR}/${ENROLL_BIN_NAME}")" }
  ],
  "plistTemplate": "$(basename "${PLIST_TEMPLATE_REL}")",
  "cutoverTool": "$(basename "${CUTOVER_TOOL_REL}")",
  "installer": "scripts/ops/install-friday-launchagent.sh",
  "serverArgs": ["--workspace", "--db", "--port", "--owner", "--store-dir"],
  "installerSteps": ["fill-plist", "plutil-lint", "port-check", "provision-master-key", "hub_agent_run_enroll", "launchctl-bootstrap"]
}
EOF

log "staged Rust agent-run WS server payload → ${PAYLOAD_DIR}"
log "  ${SERVER_BIN_NAME}, ${ENROLL_BIN_NAME}, $(basename "${PLIST_TEMPLATE_REL}"), $(basename "${CUTOVER_TOOL_REL}"), payload-manifest.json"
printf '%s\n' "${PAYLOAD_DIR}"
