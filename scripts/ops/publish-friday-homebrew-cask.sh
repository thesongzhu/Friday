#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-homebrew-publish] node not found in PATH." >&2
  exit 78
fi

if [[ -z "${FRIDAY_HOMEBREW_TAP_REPO:-}" ]]; then
  echo "[friday-homebrew-publish] FRIDAY_HOMEBREW_TAP_REPO is required." >&2
  exit 78
fi

CASK_PATH="${FRIDAY_SYSTEM_COMPANION_HOMEBREW_CASK_PATH:-${REPO_DIR}/dist/releases/homebrew/Casks/friday.rb}"
if [[ ! -f "${CASK_PATH}" ]]; then
  echo "[friday-homebrew-publish] generated cask not found at ${CASK_PATH}" >&2
  exit 78
fi

TAP_REPO="${FRIDAY_HOMEBREW_TAP_REPO}"
CHANNELS_DIR="${REPO_DIR}/dist/releases/channels"
CHANNELS_DIR="${FRIDAY_RELEASE_CHANNELS_DIR:-${CHANNELS_DIR}}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friday-homebrew-tap.XXXXXX")"
ASKPASS_SCRIPT=""
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

make_git_askpass() {
  if [[ -n "${ASKPASS_SCRIPT}" ]]; then
    return
  fi

  ASKPASS_SCRIPT="${TEMP_DIR}/git-askpass.sh"
  cat > "${ASKPASS_SCRIPT}" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*)
    printf '%s\n' "${FRIDAY_GIT_ASKPASS_USERNAME:-x-access-token}"
    ;;
  *Password*)
    printf '%s\n' "${FRIDAY_GIT_ASKPASS_PASSWORD:-}"
    ;;
  *)
    printf '\n'
    ;;
esac
EOF
  chmod 700 "${ASKPASS_SCRIPT}"
}

require_github_token() {
  if [[ -z "${FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN:-}" ]]; then
    echo "[friday-homebrew-publish] FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN is required for GitHub tap repos." >&2
    exit 78
  fi
  make_git_askpass
}

run_git() {
  if [[ -n "${ASKPASS_SCRIPT}" ]]; then
    env \
      GIT_ASKPASS="${ASKPASS_SCRIPT}" \
      GIT_TERMINAL_PROMPT=0 \
      FRIDAY_GIT_ASKPASS_USERNAME="x-access-token" \
      FRIDAY_GIT_ASKPASS_PASSWORD="${FRIDAY_HOMEBREW_TAP_GITHUB_TOKEN}" \
      "$@"
    return
  fi

  "$@"
}

clone_target() {
  if [[ "${TAP_REPO}" == /* || "${TAP_REPO}" == file://* || "${TAP_REPO}" == *.git ]]; then
    printf '%s\n' "${TAP_REPO}"
    return
  fi

  require_github_token
  printf 'https://github.com/%s.git\n' "${TAP_REPO}"
}

REMOTE_URL="$(clone_target)"
run_git git clone "${REMOTE_URL}" "${TEMP_DIR}/tap" >/dev/null 2>&1

mkdir -p "${TEMP_DIR}/tap/Casks"
cp "${CASK_PATH}" "${TEMP_DIR}/tap/Casks/friday.rb"

pushd "${TEMP_DIR}/tap" >/dev/null
if [[ -z "$(git status --short -- Casks/friday.rb)" ]]; then
  :
else
  git add Casks/friday.rb
  git -c user.name="Codex" -c user.email="codex@openai.com" \
    commit -m "friday: update cask" >/dev/null
  run_git git push origin HEAD >/dev/null 2>&1
fi
popd >/dev/null

RAW_URL="$("${NODE_BIN}" --input-type=module -e "
  const tap = process.argv[1];
  if (tap.startsWith('/') || tap.startsWith('file://') || tap.endsWith('.git')) {
    console.log('');
    process.exit(0);
  }
  console.log(\`https://raw.githubusercontent.com/\${tap}/main/Casks/friday.rb\`);
" "${TAP_REPO}")"

FRIDAY_CHANNEL_METADATA_PATH="${CHANNELS_DIR}/homebrew.json" \
FRIDAY_CHANNEL_KIND="homebrew" \
FRIDAY_CHANNEL_AVAILABILITY="published" \
FRIDAY_CHANNEL_DETAILS_JSON="$("${NODE_BIN}" --input-type=module -e "console.log(JSON.stringify({tapRepo: process.argv[1], caskPath: process.argv[2], rawUrl: process.argv[3] || null}))" "${TAP_REPO}" "${CASK_PATH}" "${RAW_URL}")" \
  "${NODE_BIN}" "${REPO_DIR}/scripts/ops/write-friday-channel-metadata.mjs" >/dev/null

echo "${TEMP_DIR}/tap/Casks/friday.rb"
