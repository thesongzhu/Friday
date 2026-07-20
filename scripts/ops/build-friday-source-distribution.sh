#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-source-dist] node not found in PATH." >&2
  exit 78
fi

NPM_BIN="${FRIDAY_NPM_BIN:-$(command -v npm || true)}"
if [[ -z "${NPM_BIN}" ]]; then
  echo "[friday-source-dist] npm not found in PATH." >&2
  exit 78
fi

OUTPUT_DIR="${FRIDAY_SOURCE_RELEASE_OUTPUT_DIR:-${REPO_DIR}/dist/releases/source}"
mkdir -p "${OUTPUT_DIR}"

VERSION="$("${NODE_BIN}" -p "require('${REPO_DIR}/package.json').version")"
PACKAGE_PREFIX="friday-${VERSION}"

# Never let previously generated source release artifacts re-enter the next package.
rm -f "${OUTPUT_DIR}/${PACKAGE_PREFIX}.tgz" "${OUTPUT_DIR}/${PACKAGE_PREFIX}.tgz.artifact.json"

PACK_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friday-source-dist.XXXXXX")"
cleanup() {
  rm -rf "${PACK_TEMP_DIR}"
}
trap cleanup EXIT

PACKAGE_TGZ="$("${NPM_BIN}" pack --ignore-scripts --silent --pack-destination "${PACK_TEMP_DIR}" "${REPO_DIR}" | tail -n 1 | tr -d '\r')"
mv "${PACK_TEMP_DIR}/${PACKAGE_TGZ}" "${OUTPUT_DIR}/${PACKAGE_TGZ}"

# CORE-A round-3 Lane C (finding #4): the cross-platform npm tarball cannot embed the
# arch-specific Rust agent-run WS server, so stage the server payload — both bins
# (hub_agent_run_server + hub_agent_run_enroll), the launchd plist TEMPLATE, the
# fill/enroll/launch cutover tool, and a payload-manifest.json — as a SIBLING release
# artifact (dist/releases/source/rust-agent-run/) next to the tgz. The release runtime
# routes a qualifying agent-run / session create+append to this loopback sealed-WS
# server; TS startRun is retired to a fail-closed 503 with NO silent fallback. Before
# this, the source distribution shipped ZERO Rust server, so a clean install hit 503 on
# every run. install-friday-launchagent.sh consumes the staged payload to install +
# enroll + launch the server.
bash "${REPO_DIR}/scripts/ops/launchd/stage-rust-agent-run-ws-server-payload.sh" \
  --repo-dir "${REPO_DIR}" --dest-dir "${OUTPUT_DIR}" >/dev/null

ARTIFACT_PATH="${OUTPUT_DIR}/${PACKAGE_TGZ}"
DOWNLOAD_BASE_URL="${FRIDAY_RELEASE_DOWNLOAD_BASE_URL:-https://github.com/thesongzhu/Friday/releases/download/v${VERSION}}"

FRIDAY_ARTIFACT_REPO_ROOT="${REPO_DIR}" \
FRIDAY_ARTIFACT_PATH="${ARTIFACT_PATH}" \
FRIDAY_ARTIFACT_METADATA_PATH="${ARTIFACT_PATH}.artifact.json" \
FRIDAY_ARTIFACT_ID="source-npm-tgz" \
FRIDAY_ARTIFACT_PLATFORM="source" \
FRIDAY_ARTIFACT_KIND="tgz" \
FRIDAY_ARTIFACT_ARCH="all" \
FRIDAY_ARTIFACT_DISPLAY_NAME="Friday npm package" \
FRIDAY_ARTIFACT_AVAILABILITY="available" \
FRIDAY_ARTIFACT_INSTALL_SUMMARY="Install with npm install -g ${PACKAGE_TGZ} or npm install -g @thesongzhu/friday." \
FRIDAY_ARTIFACT_SIGNING_STATUS="npm_registry" \
FRIDAY_ARTIFACT_RUNTIME_KIND="node_hub" \
FRIDAY_ARTIFACT_DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL}" \
FRIDAY_ARTIFACT_NOTES='["Cross-platform developer distribution.","Preferred fallback for Windows and Linux until native installer channels ship."]' \
  "${NODE_BIN}" "${REPO_DIR}/scripts/ops/write-friday-artifact-metadata.mjs" >/dev/null

echo "${ARTIFACT_PATH}"
