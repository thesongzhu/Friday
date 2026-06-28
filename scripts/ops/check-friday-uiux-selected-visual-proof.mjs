#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-uiux-selected-visual-proof.mjs \\
    [--repo-root=/abs/repo] [--design-root=/abs/friday-design-handoff-20260602] \\
    [--evidence-dir=/abs/evidence] [--ios-manifest=/abs/ios-design-destination-capture-manifest.json] \\
    [--desktop-capture=/abs/desktop-ax-accessibility-capture.json] [--out=/abs/report.json] \\
    [--require-complete]

Truth: checks whether the operator-selected mobile+desktop visual baseline has
fresh native screenshot/capture evidence. It does not treat static Swift source,
old proof PNGs, accessibility rows, or action-runtime evidence as visual parity.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

function argsAll(name) {
  const prefix = `--${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) {
      values.push(value.slice(prefix.length));
    } else if (value === `--${name}` && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const designRoot = resolve(
  arg("design-root") ||
  process.env.FRIDAY_DESIGN_HANDOFF_ROOT ||
  `${process.env.HOME || process.env.USERPROFILE || "."}/Desktop/friday-design-handoff-20260602`,
);
const evidenceDirs = [
  ...argsAll("evidence-dir"),
  ...(process.env.FRIDAY_UIUX_VISUAL_PROOF_EVIDENCE_DIRS
    ? process.env.FRIDAY_UIUX_VISUAL_PROOF_EVIDENCE_DIRS.split(/[:\n]/).filter(Boolean)
    : []),
].map(abs);
const iosManifests = [
  ...argsAll("ios-manifest"),
  ...(process.env.FRIDAY_UIUX_IOS_VISUAL_MANIFEST
    ? process.env.FRIDAY_UIUX_IOS_VISUAL_MANIFEST.split(/[:\n]/).filter(Boolean)
    : []),
].map(abs);
const desktopCaptures = [
  ...argsAll("desktop-capture"),
  ...(process.env.FRIDAY_UIUX_DESKTOP_VISUAL_CAPTURE
    ? process.env.FRIDAY_UIUX_DESKTOP_VISUAL_CAPTURE.split(/[:\n]/).filter(Boolean)
    : []),
].map(abs);
const outPath = arg("out") || process.env.FRIDAY_UIUX_SELECTED_VISUAL_PROOF_REPORT || "";
const requireComplete = args.includes("--require-complete");

const blockers = [];
const notes = [];

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function block(code, detail) {
  blockers.push({ code, detail });
}

function note(code, detail) {
  notes.push({ code, detail });
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    block("json_unreadable", `${label}:${path}:${error.message}`);
    return null;
  }
}

function selection(surface) {
  const path = resolve(designRoot, "saved", `${surface}-selection.json`);
  if (!existsSync(path)) {
    block("design_selection_missing", path);
    return { surface, path, status: "missing" };
  }
  const value = readJson(path, `${surface}-selection`);
  const state = value?.state || {};
  const issues = [];
  if (value?.operatorConfirmed !== true) issues.push("not_operator_confirmed");
  if (state.truthLabel !== "designProofOnly") issues.push("truth_label_not_designProofOnly");
  return {
    surface,
    path,
    status: issues.length === 0 ? "operator_confirmed_design_proof_only" : "invalid",
    selectionKind: value?.selectionKind || null,
    state,
    locked: Array.isArray(value?.locked) ? value.locked : [],
    issues,
  };
}

function currentHead() {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    note("git_head_unavailable", repoRoot);
    return null;
  }
}

function currentHeadTimeMs() {
  try {
    return Date.parse(execFileSync("git", ["-C", repoRoot, "log", "-1", "--format=%cI"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    note("git_head_time_unavailable", repoRoot);
    return null;
  }
}

function fileFreshness(paths, headTimeMs) {
  return paths.map((path) => {
    if (!existsSync(path)) {
      return { path, status: "missing" };
    }
    const stat = statSync(path);
    const newerThanHead = typeof headTimeMs === "number" ? stat.mtimeMs >= headTimeMs : null;
    return {
      path,
      status: newerThanHead === false ? "stale_before_head" : "present",
      mtime: stat.mtime.toISOString(),
      size: stat.size,
      newerThanHead,
    };
  });
}

function addEvidenceDir(dir) {
  if (!existsSync(dir)) return;
  const ios = resolve(dir, "ios-design-destination-capture-manifest.json");
  const iosNested = resolve(dir, "ios-design-destination-capture", "ios-design-destination-capture-manifest.json");
  const desktop = resolve(dir, "desktop-ax-accessibility-capture.json");
  const desktopNested = resolve(dir, "desktop-ax", "desktop-ax-accessibility-capture.json");
  const desktopAccessibilityNested = resolve(dir, "desktop-ax-accessibility", "desktop-ax-accessibility-capture.json");
  if (existsSync(ios)) iosManifests.push(ios);
  if (existsSync(iosNested)) iosManifests.push(iosNested);
  if (existsSync(desktop)) desktopCaptures.push(desktop);
  if (existsSync(desktopNested)) desktopCaptures.push(desktopNested);
  if (existsSync(desktopAccessibilityNested)) desktopCaptures.push(desktopAccessibilityNested);
}

for (const dir of evidenceDirs) addEvidenceDir(dir);

function unique(values) {
  return [...new Set(values)];
}

const requiredMobileDestinations = [
  "home",
  "session",
  "contextPassport",
  "tokenLedger",
  "shareIntake",
  "voice",
  "pairing",
  "providerAuth",
  "activity",
  "workflows",
];
const requiredDesktopDestinations = [
  "operations",
  "chat",
  "session",
  "pairingProvisioning",
  "providerAdmin",
  "parity",
  "workflow",
  "evidence",
];

function evaluateIosManifest(path) {
  if (!existsSync(path)) return { path, status: "missing" };
  const manifest = readJson(path, "ios-manifest");
  if (!manifest) return { path, status: "invalid" };
  const captured = new Set((manifest.captures || []).map((capture) => capture.destination));
  const missing = requiredMobileDestinations.filter((destination) => !captured.has(destination));
  const truthOk = manifest.truth_label === "ios_selected_design_destination_capture_not_live_closure";
  const statusOk = manifest.status === "ready";
  return {
    path,
    status: truthOk && statusOk && missing.length === 0 ? "ready" : "gap",
    truth_label: manifest.truth_label || null,
    manifest_status: manifest.status || null,
    generated_at_utc: manifest.generated_at_utc || null,
    mode: manifest.mode || null,
    requiredMobileDestinations,
    capturedDestinations: [...captured],
    missingDestinations: missing,
    caveat: manifest.caveat || null,
  };
}

function evaluateDesktopCapture(path) {
  if (!existsSync(path)) return { path, status: "missing" };
  const capture = readJson(path, "desktop-capture");
  if (!capture) return { path, status: "invalid" };
  const normalizeDestination = (value) => value === "fridayChat" ? "chat" : value;
  const observed = new Set(
    [
      ...(capture.observed || []).map((row) => row.destination),
      ...(capture.ui_actions || []).map((row) => row.screen),
      ...(capture.destinations || []).filter((value) => typeof value === "string"),
    ].filter(Boolean).map(normalizeDestination),
  );
  const missing = requiredDesktopDestinations.filter((destination) => !observed.has(destination));
  const truthOk = [
    "desktop_ax_accessibility_capture_not_screenshot_not_endbar",
    "ui_device_accessibility_click_capture_real_ui_not_endbar",
  ].includes(capture.truth_label);
  const statusOk = ["ready", "partial_capture_ready", undefined, null].includes(capture.status);
  return {
    path,
    status: truthOk && statusOk && missing.length === 0 ? "ready" : "gap",
    truth_label: capture.truth_label || null,
    capture_status: capture.status || null,
    generated_at_utc: capture.generated_at_utc || null,
    requiredDesktopDestinations,
    observedDestinations: [...observed],
    missingDestinations: missing,
    caveat: capture.caveat || null,
  };
}

const mobileSelection = selection("mobile");
const desktopSelection = selection("desktop");
const head = currentHead();
const headTimeMs = currentHeadTimeMs();
const repoProofFiles = [
  resolve(repoRoot, "apps/friday-ios/proof/friday-ios-home-honest-unavailable.png"),
  resolve(repoRoot, "apps/macos/FridayHubConsole/proof/operations-loaded-mock.png"),
  resolve(repoRoot, "apps/macos/FridayHubConsole/proof/operations-offline.png"),
  resolve(repoRoot, "apps/macos/FridayHubConsole/proof/operations-unavailable-503.png"),
];
const repoProofFreshness = fileFreshness(repoProofFiles, headTimeMs);
const staleRepoProof = repoProofFreshness.filter((item) => item.status === "missing" || item.status === "stale_before_head");
if (staleRepoProof.length > 0) {
  note("repo_committed_screenshot_proofs_not_current_head_visual_pass", `${staleRepoProof.length}/${repoProofFreshness.length}`);
}

const iosVisualEvidence = unique(iosManifests).map(evaluateIosManifest);
const desktopVisualEvidence = unique(desktopCaptures).map(evaluateDesktopCapture);
const iosReady = iosVisualEvidence.some((item) => item.status === "ready");
const desktopReady = desktopVisualEvidence.some((item) => item.status === "ready");

if (!iosReady) {
  block(
    "mobile_selected_visual_proof_missing",
    "Run proof:ios:design-destinations on current HEAD and pass its ios-design-destination-capture-manifest.json",
  );
}
if (!desktopReady) {
  block(
    "desktop_selected_visual_proof_missing",
    "Run desktop GUI/AX capture on current HEAD with selected desktop destinations and pass desktop-ax-accessibility-capture.json",
  );
}

const report = {
  truth: "selected_uiux_visual_proof_not_static_linkage_not_action_runtime_not_endbar",
  status: blockers.length === 0 ? "selected_visual_proof_ready" : "selected_visual_proof_gaps_present",
  repoRoot,
  designRoot,
  head,
  selections: {
    mobile: mobileSelection,
    desktop: desktopSelection,
  },
  requiredVisualEvidence: {
    mobile: requiredMobileDestinations,
    desktop: requiredDesktopDestinations,
  },
  evidenceInputs: {
    evidenceDirs: unique(evidenceDirs),
    iosManifests: unique(iosManifests),
    desktopCaptures: unique(desktopCaptures),
  },
  evidence: {
    ios: iosVisualEvidence,
    desktop: desktopVisualEvidence,
    committedProofFreshness: repoProofFreshness,
  },
  notes,
  blockers,
  caveat:
    "This is the visual-proof gate for the operator-selected UI baseline. It does not claim pixel-perfect parity, live action closure, release, adoption, or END-BAR; it prevents old screenshots/static linkage from being counted as visual PASS.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(requireComplete && blockers.length > 0 ? 1 : 0);
