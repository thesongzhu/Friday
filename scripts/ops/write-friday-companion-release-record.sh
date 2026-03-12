#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${1:-}"
if [[ -z "${REPO_DIR}" ]]; then
  REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi
REPO_DIR="$(cd "${REPO_DIR}" && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-companion-release-record] macOS is required." >&2
  exit 78
fi

NODE_BIN="${FRIDAY_NODE_BIN:-$(command -v node || true)}"
if [[ -z "${NODE_BIN}" ]]; then
  echo "[friday-companion-release-record] node not found in PATH." >&2
  exit 78
fi

APP_DIR="${FRIDAY_SYSTEM_COMPANION_APP_DIR:-${REPO_DIR}/dist/macos/FridayCompanion.app}"
APP_PLIST="${APP_DIR}/Contents/Info.plist"
APP_BINARY="${APP_DIR}/Contents/MacOS/FridayCompanion"
OUTPUT_DIR="${FRIDAY_SYSTEM_COMPANION_RELEASE_RECORD_DIR:-${REPO_DIR}/dist/macos}"
OUTPUT_BASENAME="${FRIDAY_SYSTEM_COMPANION_RELEASE_RECORD_BASENAME:-FridayCompanion.release}"
JSON_PATH="${OUTPUT_DIR}/${OUTPUT_BASENAME}.json"
MD_PATH="${OUTPUT_DIR}/${OUTPUT_BASENAME}.md"
ARCHIVE_PATH="${FRIDAY_SYSTEM_COMPANION_ARCHIVE_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.zip}"
NOTARY_RESULT_PATH="${FRIDAY_SYSTEM_COMPANION_NOTARY_RESULT_PATH:-${REPO_DIR}/dist/macos/FridayCompanion.notary.json}"

if [[ ! -f "${APP_PLIST}" || ! -x "${APP_BINARY}" ]]; then
  echo "[friday-companion-release-record] missing built app at ${APP_DIR}" >&2
  exit 78
fi

mkdir -p "${OUTPUT_DIR}"

APP_VERSION="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "${APP_PLIST}")"
APP_BUILD="$(/usr/bin/plutil -extract CFBundleVersion raw -o - "${APP_PLIST}")"
BUNDLE_IDENTIFIER="$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "${APP_PLIST}")"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
GIT_COMMIT="$(git -C "${REPO_DIR}" rev-parse HEAD 2>/dev/null || true)"
GIT_BRANCH="$(git -C "${REPO_DIR}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64) RELEASE_ARCH="x64" ;;
  arm64) RELEASE_ARCH="arm64" ;;
  *) RELEASE_ARCH="${ARCH}" ;;
esac

RELEASES_DIR="${FRIDAY_MACOS_RELEASE_OUTPUT_DIR:-${REPO_DIR}/dist/releases/macos}"
ZIP_RELEASE_PATH="${FRIDAY_SYSTEM_COMPANION_ZIP_RELEASE_PATH:-${RELEASES_DIR}/FridayCompanion-${APP_VERSION}-macos-${RELEASE_ARCH}.zip}"
DMG_RELEASE_PATH="${FRIDAY_SYSTEM_COMPANION_DMG_RELEASE_PATH:-${RELEASES_DIR}/FridayCompanion-${APP_VERSION}-macos-${RELEASE_ARCH}.dmg}"
MANIFEST_JSON_PATH="${FRIDAY_SYSTEM_COMPANION_RELEASE_MANIFEST_JSON_PATH:-${REPO_DIR}/dist/releases/Friday.release-manifest.json}"
MANIFEST_MD_PATH="${FRIDAY_SYSTEM_COMPANION_RELEASE_MANIFEST_MD_PATH:-${REPO_DIR}/dist/releases/Friday.release-manifest.md}"
HOMEBREW_CASK_PATH="${FRIDAY_SYSTEM_COMPANION_HOMEBREW_CASK_PATH:-${REPO_DIR}/dist/releases/homebrew/Casks/friday.rb}"
SPARKLE_APPCAST_PATH="${FRIDAY_SYSTEM_COMPANION_SPARKLE_APPCAST_PATH:-${REPO_DIR}/dist/releases/macos/appcast.xml}"
SOURCE_RELEASE_GLOB="${FRIDAY_SYSTEM_SOURCE_RELEASE_GLOB:-${REPO_DIR}/dist/releases/source/*.tgz}"
SOURCE_RELEASE_PATH="$(
  SOURCE_RELEASE_GLOB="${SOURCE_RELEASE_GLOB}" \
    "${NODE_BIN}" --input-type=commonjs -e '
      const glob = process.env.SOURCE_RELEASE_GLOB;
      const { execSync } = require("node:child_process");
      try {
        const out = execSync(`ls -1 ${glob} 2>/dev/null | tail -n 1`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        process.stdout.write(out);
      } catch {
        process.stdout.write("");
      }
    '
)"
MACOS_EVIDENCE_PATH="${FRIDAY_CROSS_PLATFORM_MACOS_EVIDENCE_PATH:-${REPO_DIR}/docs/reports/ops/cross-platform-agent-os-beta-evidence/macos-15-clean-machine.md}"

RELEASE_RECORD_JSON_PATH="${JSON_PATH}" \
RELEASE_RECORD_MD_PATH="${MD_PATH}" \
RELEASE_RECORD_GENERATED_AT="${GENERATED_AT}" \
RELEASE_RECORD_REPO_DIR="${REPO_DIR}" \
RELEASE_RECORD_GIT_COMMIT="${GIT_COMMIT}" \
RELEASE_RECORD_GIT_BRANCH="${GIT_BRANCH}" \
RELEASE_RECORD_RELEASE_MODE="${FRIDAY_MACOS_RELEASE_MODE:-local}" \
RELEASE_RECORD_APP_DIR="${APP_DIR}" \
RELEASE_RECORD_APP_BINARY="${APP_BINARY}" \
RELEASE_RECORD_APP_VERSION="${APP_VERSION}" \
RELEASE_RECORD_APP_BUILD="${APP_BUILD}" \
RELEASE_RECORD_BUNDLE_IDENTIFIER="${BUNDLE_IDENTIFIER}" \
RELEASE_RECORD_ARCHIVE_PATH="${ARCHIVE_PATH}" \
RELEASE_RECORD_ARCHIVE_EXISTS="$([[ -f "${ARCHIVE_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_ZIP_RELEASE_PATH="${ZIP_RELEASE_PATH}" \
RELEASE_RECORD_ZIP_RELEASE_EXISTS="$([[ -f "${ZIP_RELEASE_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_DMG_RELEASE_PATH="${DMG_RELEASE_PATH}" \
RELEASE_RECORD_DMG_RELEASE_EXISTS="$([[ -f "${DMG_RELEASE_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_MANIFEST_JSON_PATH="${MANIFEST_JSON_PATH}" \
RELEASE_RECORD_MANIFEST_JSON_EXISTS="$([[ -f "${MANIFEST_JSON_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_MANIFEST_MD_PATH="${MANIFEST_MD_PATH}" \
RELEASE_RECORD_MANIFEST_MD_EXISTS="$([[ -f "${MANIFEST_MD_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_HOMEBREW_CASK_PATH="${HOMEBREW_CASK_PATH}" \
RELEASE_RECORD_HOMEBREW_CASK_EXISTS="$([[ -f "${HOMEBREW_CASK_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_SPARKLE_APPCAST_PATH="${SPARKLE_APPCAST_PATH}" \
RELEASE_RECORD_SPARKLE_APPCAST_EXISTS="$([[ -f "${SPARKLE_APPCAST_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_SOURCE_RELEASE_PATH="${SOURCE_RELEASE_PATH}" \
RELEASE_RECORD_SOURCE_RELEASE_EXISTS="$([[ -n "${SOURCE_RELEASE_PATH}" && -f "${SOURCE_RELEASE_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_MACOS_EVIDENCE_PATH="${MACOS_EVIDENCE_PATH}" \
RELEASE_RECORD_MACOS_EVIDENCE_EXISTS="$([[ -f "${MACOS_EVIDENCE_PATH}" ]] && echo true || echo false)" \
RELEASE_RECORD_CODESIGN_MODE="${FRIDAY_MACOS_CODESIGN_MODE:-adhoc}" \
RELEASE_RECORD_CODESIGN_IDENTITY="${FRIDAY_MACOS_CODESIGN_IDENTITY:-adhoc}" \
RELEASE_RECORD_NOTARY_PROFILE="${FRIDAY_MACOS_NOTARY_PROFILE:-}" \
RELEASE_RECORD_TEAM_ID="${FRIDAY_MACOS_TEAM_ID:-}" \
RELEASE_RECORD_NOTARIZATION_STATUS="${FRIDAY_SYSTEM_COMPANION_NOTARIZATION_STATUS:-not_requested}" \
RELEASE_RECORD_NOTARY_RESULT_PATH="${NOTARY_RESULT_PATH}" \
RELEASE_RECORD_NOTARY_RESULT_EXISTS="$([[ -f "${NOTARY_RESULT_PATH}" ]] && echo true || echo false)" \
  "${NODE_BIN}" --input-type=commonjs <<'NODE'
const fs = require("node:fs");

const archiveExists = process.env.RELEASE_RECORD_ARCHIVE_EXISTS === "true";
const notaryResultExists = process.env.RELEASE_RECORD_NOTARY_RESULT_EXISTS === "true";
const zipReleaseExists = process.env.RELEASE_RECORD_ZIP_RELEASE_EXISTS === "true";
const dmgReleaseExists = process.env.RELEASE_RECORD_DMG_RELEASE_EXISTS === "true";
const manifestJsonExists = process.env.RELEASE_RECORD_MANIFEST_JSON_EXISTS === "true";
const manifestMdExists = process.env.RELEASE_RECORD_MANIFEST_MD_EXISTS === "true";
const homebrewCaskExists = process.env.RELEASE_RECORD_HOMEBREW_CASK_EXISTS === "true";
const sparkleAppcastExists = process.env.RELEASE_RECORD_SPARKLE_APPCAST_EXISTS === "true";
const sourceReleaseExists = process.env.RELEASE_RECORD_SOURCE_RELEASE_EXISTS === "true";
const macosEvidenceExists = process.env.RELEASE_RECORD_MACOS_EVIDENCE_EXISTS === "true";

const payload = {
  generatedAt: process.env.RELEASE_RECORD_GENERATED_AT,
  repoDir: process.env.RELEASE_RECORD_REPO_DIR,
  gitBranch: process.env.RELEASE_RECORD_GIT_BRANCH,
  gitCommit: process.env.RELEASE_RECORD_GIT_COMMIT,
  releaseMode: process.env.RELEASE_RECORD_RELEASE_MODE,
  bundleIdentifier: process.env.RELEASE_RECORD_BUNDLE_IDENTIFIER,
  appVersion: process.env.RELEASE_RECORD_APP_VERSION,
  appBuild: process.env.RELEASE_RECORD_APP_BUILD,
  appDir: process.env.RELEASE_RECORD_APP_DIR,
  appBinary: process.env.RELEASE_RECORD_APP_BINARY,
  archivePath: archiveExists ? process.env.RELEASE_RECORD_ARCHIVE_PATH : null,
  zipReleasePath: zipReleaseExists ? process.env.RELEASE_RECORD_ZIP_RELEASE_PATH : null,
  dmgReleasePath: dmgReleaseExists ? process.env.RELEASE_RECORD_DMG_RELEASE_PATH : null,
  manifestJsonPath: manifestJsonExists ? process.env.RELEASE_RECORD_MANIFEST_JSON_PATH : null,
  manifestMarkdownPath: manifestMdExists ? process.env.RELEASE_RECORD_MANIFEST_MD_PATH : null,
  homebrewCaskPath: homebrewCaskExists ? process.env.RELEASE_RECORD_HOMEBREW_CASK_PATH : null,
  sparkleAppcastPath: sparkleAppcastExists ? process.env.RELEASE_RECORD_SPARKLE_APPCAST_PATH : null,
  sourceReleasePath: sourceReleaseExists ? process.env.RELEASE_RECORD_SOURCE_RELEASE_PATH : null,
  macosEvidencePath: macosEvidenceExists ? process.env.RELEASE_RECORD_MACOS_EVIDENCE_PATH : null,
  codesignMode: process.env.RELEASE_RECORD_CODESIGN_MODE,
  codesignIdentity: process.env.RELEASE_RECORD_CODESIGN_IDENTITY,
  notaryProfile: process.env.RELEASE_RECORD_NOTARY_PROFILE || null,
  teamId: process.env.RELEASE_RECORD_TEAM_ID || null,
  notarizationStatus: process.env.RELEASE_RECORD_NOTARIZATION_STATUS,
  notaryResultPath: notaryResultExists ? process.env.RELEASE_RECORD_NOTARY_RESULT_PATH : null,
  rolloutSteps: [
    "bash scripts/ops/install-friday-launchagent.sh",
    "bash scripts/ops/friday-launchagent-status.sh",
    "launchctl kickstart -k gui/${UID}/com.friday.companion",
    "Open the Operator Console and confirm /v1/system/state reports the native companion healthy",
    "Complete trusted-device passkey enrollment before opening a remote session",
  ],
};

fs.writeFileSync(process.env.RELEASE_RECORD_JSON_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

const lines = [
  "# Friday Companion Release Record",
  "",
  `- Generated At: \`${payload.generatedAt}\``,
  `- Git Branch: \`${payload.gitBranch}\``,
  `- Git Commit: \`${payload.gitCommit}\``,
  `- Release Mode: \`${payload.releaseMode}\``,
  `- Bundle Identifier: \`${payload.bundleIdentifier}\``,
  `- App Version: \`${payload.appVersion}\``,
  `- App Build: \`${payload.appBuild}\``,
  `- App Directory: \`${payload.appDir}\``,
  `- Archive Path: \`${payload.archivePath ?? "not created"}\``,
  `- Zip Release Path: \`${payload.zipReleasePath ?? "not created"}\``,
  `- DMG Release Path: \`${payload.dmgReleasePath ?? "not created"}\``,
  `- Release Manifest JSON: \`${payload.manifestJsonPath ?? "not created"}\``,
  `- Release Manifest Markdown: \`${payload.manifestMarkdownPath ?? "not created"}\``,
  `- Homebrew Cask Path: \`${payload.homebrewCaskPath ?? "not created"}\``,
  `- Sparkle Appcast Path: \`${payload.sparkleAppcastPath ?? "not created"}\``,
  `- Source Release Path: \`${payload.sourceReleasePath ?? "not created"}\``,
  `- macOS Evidence Path: \`${payload.macosEvidencePath ?? "not recorded"}\``,
  `- Codesign Mode: \`${payload.codesignMode}\``,
  `- Codesign Identity: \`${payload.codesignIdentity}\``,
  `- Notary Profile: \`${payload.notaryProfile ?? "not set"}\``,
  `- Team ID: \`${payload.teamId ?? "not set"}\``,
  `- Notarization Status: \`${payload.notarizationStatus}\``,
  `- Notary Result Path: \`${payload.notaryResultPath ?? "not created"}\``,
  "",
  "## Rollout Steps",
  "",
  ...payload.rolloutSteps.map((step, index) => `${index + 1}. ${step}`),
  "",
];

fs.writeFileSync(process.env.RELEASE_RECORD_MD_PATH, lines.join("\n"), "utf8");
NODE

echo "${JSON_PATH}"
