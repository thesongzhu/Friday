#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function resolveRepoRoot() {
  const explicit = process.argv[2]?.trim() || process.env.FRIDAY_DESKTOP_GUI_SMOKE_REPO_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
}

function read(root, relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function requireText(haystack, needle, label) {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: missing ${JSON.stringify(needle)}`);
  }
}

function forbidPattern(haystack, pattern, label) {
  if (pattern.test(haystack)) {
    throw new Error(`${label}: forbidden pattern ${pattern}`);
  }
}

const root = resolveRepoRoot();
const scriptPath = "scripts/ops/friday-desktop-gui-smoke-proof.sh";
const script = read(root, scriptPath);

requireText(script, "desktop_gui_smoke_real_app_launch_screenshot_not_endbar", scriptPath);
requireText(script, "FRIDAY_DESKTOP_GUI_SMOKE_MODE:-live", scriptPath);
requireText(script, "FRIDAY_CONSOLE_MOCK=1", scriptPath);
requireText(script, "screencapture -x", scriptPath);
requireText(script, "This is not END-BAR", scriptPath);
requireText(script, "not a GUI tap/closed-loop proof", scriptPath);
requireText(script, "only terminates the app process it spawned", scriptPath);
requireText(script, "/bin/kill \"${APP_PID}\"", scriptPath);

forbidPattern(script, /\bkillall\b/, scriptPath);
forbidPattern(script, /\bpkill\b/, scriptPath);
forbidPattern(script, /lsof\s+-ti\s+:(48750|48751|3141)/, scriptPath);
forbidPattern(script, /kill\s+-9\s+\$\(lsof/, scriptPath);

const mockDefaultIndex = script.indexOf("FRIDAY_DESKTOP_GUI_SMOKE_MODE:-live");
const mockAssignmentIndex = script.indexOf("FRIDAY_CONSOLE_MOCK=1");
if (mockDefaultIndex < 0 || mockAssignmentIndex < 0 || mockAssignmentIndex < mockDefaultIndex) {
  throw new Error(`${scriptPath}: mock mode must stay explicit and live must remain the default`);
}

console.log(JSON.stringify({
  status: "passed",
  script: scriptPath,
  truth_label: "desktop_gui_smoke_contract_static_no_endbar_overclaim",
}, null, 2));
