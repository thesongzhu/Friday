#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: friday-desktop-gui-smoke-proof.sh [--repo-dir <path>] [--out-dir <path>] [--app-dir <path>] [--timeout-seconds <n>]

Builds or verifies FridayHubConsole.app, launches the real macOS app process, captures a
desktop screenshot, and writes a truth-labeled manifest.

Truth: this proves a real local app launch + screenshot only. It is not END-BAR, not
adoption, not a GUI tap/closed-loop proof, and not a substitute for live mobile+desktop
product closure.
USAGE
}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_DIR="${FRIDAY_DESKTOP_GUI_SMOKE_OUT_DIR:-}"
APP_DIR="${FRIDAY_HUB_CONSOLE_APP_DIR:-}"
TIMEOUT_SECONDS="${FRIDAY_DESKTOP_GUI_SMOKE_TIMEOUT_SECONDS:-20}"
MODE="${FRIDAY_DESKTOP_GUI_SMOKE_MODE:-live}"
BUILD_APP="${FRIDAY_DESKTOP_GUI_SMOKE_BUILD_APP:-true}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --app-dir)
      APP_DIR="$2"
      shift 2
      ;;
    --timeout-seconds)
      TIMEOUT_SECONDS="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[friday-desktop-gui-smoke] unknown argument: $1" >&2
      usage
      exit 64
      ;;
  esac
done

REPO_DIR="$(cd "${REPO_DIR}" && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[friday-desktop-gui-smoke] macOS is required." >&2
  exit 78
fi

case "${MODE}" in
  live|mock) ;;
  *)
    echo "[friday-desktop-gui-smoke] invalid FRIDAY_DESKTOP_GUI_SMOKE_MODE=${MODE}; expected live|mock." >&2
    exit 64
    ;;
esac

if ! [[ "${TIMEOUT_SECONDS}" =~ ^[0-9]+$ ]] || [[ "${TIMEOUT_SECONDS}" -lt 5 ]]; then
  echo "[friday-desktop-gui-smoke] timeout must be an integer >= 5 seconds." >&2
  exit 64
fi

if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/friday-desktop-gui-smoke.XXXXXX")"
fi
mkdir -p "${OUT_DIR}"

if [[ -z "${APP_DIR}" ]]; then
  if [[ "${BUILD_APP}" == "true" ]]; then
    APP_DIR="$(bash "${REPO_DIR}/scripts/ops/build-friday-hub-console-app.sh" "${REPO_DIR}")"
  else
    APP_DIR="${REPO_DIR}/dist/macos/FridayHubConsole.app"
  fi
fi

APP_BINARY="${APP_DIR}/Contents/MacOS/FridayHubConsole"
APP_PLIST="${APP_DIR}/Contents/Info.plist"
if [[ ! -x "${APP_BINARY}" ]]; then
  echo "[friday-desktop-gui-smoke] missing app binary: ${APP_BINARY}" >&2
  exit 78
fi
if [[ ! -f "${APP_PLIST}" ]]; then
  echo "[friday-desktop-gui-smoke] missing app Info.plist: ${APP_PLIST}" >&2
  exit 78
fi

STDOUT_LOG="${OUT_DIR}/app.stdout.log"
STDERR_LOG="${OUT_DIR}/app.stderr.log"
SCREENSHOT="${OUT_DIR}/desktop-gui-smoke.png"
WINDOW_PROBE="${OUT_DIR}/window-probe.txt"
MANIFEST="${OUT_DIR}/desktop-gui-smoke-manifest.json"
APP_PID=""

cleanup() {
  if [[ -n "${APP_PID}" ]] && /bin/ps -p "${APP_PID}" >/dev/null 2>&1; then
    /usr/bin/osascript >/dev/null 2>&1 <<'APPLESCRIPT' || true
tell application "FridayHubConsole" to quit
APPLESCRIPT
    for _ in 1 2 3 4 5; do
      /bin/ps -p "${APP_PID}" >/dev/null 2>&1 || break
      sleep 0.2
    done
    if /bin/ps -p "${APP_PID}" >/dev/null 2>&1; then
      /bin/kill "${APP_PID}" >/dev/null 2>&1 || true
      wait "${APP_PID}" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

echo "[friday-desktop-gui-smoke] launching ${APP_BINARY} mode=${MODE}" >&2
if [[ "${MODE}" == "mock" ]]; then
  FRIDAY_CONSOLE_MOCK=1 "${APP_BINARY}" >"${STDOUT_LOG}" 2>"${STDERR_LOG}" &
else
  FRIDAY_CONSOLE_MOCK=0 "${APP_BINARY}" >"${STDOUT_LOG}" 2>"${STDERR_LOG}" &
fi
APP_PID="$!"

deadline=$((SECONDS + TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  if ! /bin/ps -p "${APP_PID}" >/dev/null 2>&1; then
    echo "[friday-desktop-gui-smoke] app exited before screenshot; stderr follows:" >&2
    sed -n '1,120p' "${STDERR_LOG}" >&2 || true
    exit 78
  fi

  if /usr/bin/osascript >"${WINDOW_PROBE}" 2>&1 <<'APPLESCRIPT'
tell application "FridayHubConsole" to activate
delay 0.2
tell application "System Events"
  if exists process "FridayHubConsole" then
    tell process "FridayHubConsole"
      set frontmost to true
      set windowCount to count of windows
      if windowCount > 0 then
        return "window_count=" & windowCount & "\nfrontmost=" & frontmost & "\nfirst_window=" & name of window 1
      end if
      return "window_count=0\nfrontmost=" & frontmost
    end tell
  end if
end tell
return "process_missing"
APPLESCRIPT
  then
    if grep -q '^window_count=[1-9]' "${WINDOW_PROBE}"; then
      break
    fi
  fi
  sleep 0.5
done

if ! /bin/ps -p "${APP_PID}" >/dev/null 2>&1; then
  echo "[friday-desktop-gui-smoke] app process is not alive at capture time." >&2
  exit 78
fi

if [[ ! -s "${WINDOW_PROBE}" ]]; then
  printf 'window_probe_unavailable\n' >"${WINDOW_PROBE}"
fi

/usr/sbin/screencapture -x "${SCREENSHOT}"
if [[ ! -s "${SCREENSHOT}" ]]; then
  echo "[friday-desktop-gui-smoke] screenshot was not created: ${SCREENSHOT}" >&2
  exit 78
fi

FRIDAY_DESKTOP_GUI_SMOKE_REPO_DIR="${REPO_DIR}" \
FRIDAY_DESKTOP_GUI_SMOKE_OUT_DIR="${OUT_DIR}" \
FRIDAY_DESKTOP_GUI_SMOKE_APP_DIR="${APP_DIR}" \
FRIDAY_DESKTOP_GUI_SMOKE_APP_BINARY="${APP_BINARY}" \
FRIDAY_DESKTOP_GUI_SMOKE_APP_PLIST="${APP_PLIST}" \
FRIDAY_DESKTOP_GUI_SMOKE_APP_PID="${APP_PID}" \
FRIDAY_DESKTOP_GUI_SMOKE_MODE="${MODE}" \
FRIDAY_DESKTOP_GUI_SMOKE_SCREENSHOT="${SCREENSHOT}" \
FRIDAY_DESKTOP_GUI_SMOKE_STDOUT="${STDOUT_LOG}" \
FRIDAY_DESKTOP_GUI_SMOKE_STDERR="${STDERR_LOG}" \
FRIDAY_DESKTOP_GUI_SMOKE_WINDOW_PROBE="${WINDOW_PROBE}" \
FRIDAY_DESKTOP_GUI_SMOKE_MANIFEST="${MANIFEST}" \
node --input-type=module <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function text(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
}

const repoDir = process.env.FRIDAY_DESKTOP_GUI_SMOKE_REPO_DIR;
const gitHead = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
const status = spawnSync("git", ["-C", repoDir, "status", "--short"], { encoding: "utf8" }).stdout.trim();
const manifest = {
  generated_at_utc: new Date().toISOString(),
  truth_label: "desktop_gui_smoke_real_app_launch_screenshot_not_endbar",
  repo: {
    root: repoDir,
    head: gitHead,
    status_short: status,
  },
  app: {
    dir: process.env.FRIDAY_DESKTOP_GUI_SMOKE_APP_DIR,
    binary: process.env.FRIDAY_DESKTOP_GUI_SMOKE_APP_BINARY,
    info_plist: process.env.FRIDAY_DESKTOP_GUI_SMOKE_APP_PLIST,
    binary_sha256: sha256(process.env.FRIDAY_DESKTOP_GUI_SMOKE_APP_BINARY),
    pid: Number(process.env.FRIDAY_DESKTOP_GUI_SMOKE_APP_PID),
    launch_mode: process.env.FRIDAY_DESKTOP_GUI_SMOKE_MODE,
    mock_is_explicit_only: process.env.FRIDAY_DESKTOP_GUI_SMOKE_MODE === "mock",
  },
  evidence: {
    screenshot: process.env.FRIDAY_DESKTOP_GUI_SMOKE_SCREENSHOT,
    screenshot_sha256: sha256(process.env.FRIDAY_DESKTOP_GUI_SMOKE_SCREENSHOT),
    stdout_log: process.env.FRIDAY_DESKTOP_GUI_SMOKE_STDOUT,
    stderr_log: process.env.FRIDAY_DESKTOP_GUI_SMOKE_STDERR,
    window_probe: process.env.FRIDAY_DESKTOP_GUI_SMOKE_WINDOW_PROBE,
    window_probe_text: text(process.env.FRIDAY_DESKTOP_GUI_SMOKE_WINDOW_PROBE),
  },
  caveats: [
    "This proves a real local macOS app process launched and a desktop screenshot was captured.",
    "This is not END-BAR, not adoption, not a GUI tap/closed-loop proof, and not a mobile proof.",
    "Live mode is the default; mock mode is an explicit proof mode and is truth-labeled when used.",
    "The script only terminates the app process it spawned; it does not kill Friday hub ports or production services.",
  ],
};

fs.writeFileSync(process.env.FRIDAY_DESKTOP_GUI_SMOKE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  status: "passed",
  truth_label: manifest.truth_label,
  manifest: process.env.FRIDAY_DESKTOP_GUI_SMOKE_MANIFEST,
  screenshot: process.env.FRIDAY_DESKTOP_GUI_SMOKE_SCREENSHOT,
}, null, 2));
NODE

echo "Truth: desktop GUI smoke launch+screenshot only; not END-BAR / not adoption / not GUI closed-loop." >&2
