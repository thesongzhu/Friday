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
    [--desktop-capture=/abs/desktop-ax-accessibility-capture.json] \\
    [--served-ui-report=/abs/served-ui-design-fidelity.json] [--out=/abs/report.json] \\
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
const servedUiReports = [
  ...argsAll("served-ui-report"),
  ...(process.env.FRIDAY_UIUX_SERVED_UI_DESIGN_FIDELITY_REPORT
    ? process.env.FRIDAY_UIUX_SERVED_UI_DESIGN_FIDELITY_REPORT.split(/[:\n]/).filter(Boolean)
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
  const servedUi = resolve(dir, "served-ui-design-fidelity.json");
  const servedUiReport = resolve(dir, "served-ui-design-fidelity-report.json");
  const servedUiNested = resolve(dir, "served-ui", "served-ui-design-fidelity.json");
  if (existsSync(ios)) iosManifests.push(ios);
  if (existsSync(iosNested)) iosManifests.push(iosNested);
  if (existsSync(desktop)) desktopCaptures.push(desktop);
  if (existsSync(desktopNested)) desktopCaptures.push(desktopNested);
  if (existsSync(desktopAccessibilityNested)) desktopCaptures.push(desktopAccessibilityNested);
  if (existsSync(servedUi)) servedUiReports.push(servedUi);
  if (existsSync(servedUiReport)) servedUiReports.push(servedUiReport);
  if (existsSync(servedUiNested)) servedUiReports.push(servedUiNested);
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
  const mode = manifest.mode || null;
  const allowedVisualModes = ["design-proof-sample", "live-loopback"];
  const modeOk = allowedVisualModes.includes(mode);
  return {
    path,
    status: truthOk && statusOk && modeOk && missing.length === 0 ? "ready" : "gap",
    truth_label: manifest.truth_label || null,
    manifest_status: manifest.status || null,
    generated_at_utc: manifest.generated_at_utc || null,
    mode,
    allowedVisualModes,
    modeStatus: modeOk ? "visual_proof_mode" : mode === "offline-truth" ? "negative_control_not_visual_proof" : "missing_or_unknown_mode",
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
  const declaredMode = typeof capture.mode === "string" ? capture.mode : null;
  const liveConnection = capture.live_connection && typeof capture.live_connection === "object"
    ? capture.live_connection
    : null;
  const desktopLiveModes = new Set(["live-loopback", "product-live", "same-run-live"]);
  const desktopLiveConnected = desktopLiveModes.has(declaredMode)
    && liveConnection?.status === "mission_bound_live_read_requested"
    && liveConnection?.mock === false
    && typeof liveConnection?.workbench_mission_id === "string"
    && liveConnection.workbench_mission_id.length > 0
    && typeof liveConnection?.read_host === "string"
    && liveConnection.read_host.length > 0
    && typeof liveConnection?.read_port === "string"
    && /^[0-9]+$/.test(liveConnection.read_port);
  return {
    path,
    eligibleForAggregate: truthOk && statusOk && desktopLiveConnected,
    aggregate_key: desktopLiveConnected
      ? [
        declaredMode,
        liveConnection.read_host,
        liveConnection.read_port,
        liveConnection.workbench_mission_id,
      ].join("\u001f")
      : null,
    status: truthOk && statusOk && missing.length === 0 ? "ready" : "gap",
    truth_label: capture.truth_label || null,
    capture_status: capture.status || null,
    generated_at_utc: capture.generated_at_utc || null,
    mode: desktopLiveConnected ? declaredMode : null,
    declaredMode,
    live_connection: liveConnection,
    modeStatus: desktopLiveConnected
      ? "live_connected_visual_proof_mode"
      : declaredMode
        ? "declared_mode_not_live_connected"
        : "missing_live_mode",
    requiredDesktopDestinations,
    observedDestinations: [...observed],
    missingDestinations: missing,
    caveat: capture.caveat || null,
  };
}

function evaluateServedUiReport(path) {
  if (!existsSync(path)) return { path, status: "missing" };
  const report = readJson(path, "served-ui-report");
  if (!report) return { path, status: "invalid" };
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const checkMessages = checks
    .filter((check) => check?.ok === true && typeof check.message === "string")
    .map((check) => check.message);
  const hasRenderedDesktop = checkMessages.includes("served desktop rendered structure matches selected design");
  const hasBuiltCss = checkMessages.includes("built css applies cyan/coral tokens and excludes amber/jade tokens");
  const hasIosDesignSystem = checkMessages.includes("iOS source applies selected mobile design system and keeps debug/readiness surfaces out of the user path");
  const truthOk = report.truth_label === "served_desktop_and_ios_design_fidelity_reads_real_selection_and_live_sources";
  const statusOk = report.status === "pass" && Number(report.failureCount || 0) === 0;
  const headOk = !head ? true : report.head === head;
  const distRoot = typeof report.distRoot === "string" ? report.distRoot : null;
  const iosSourceRoot = typeof report.iosSourceRoot === "string" ? report.iosSourceRoot : null;
  const sourceOk = distRoot?.endsWith("/dist/ui") === true && iosSourceRoot?.includes("/apps/friday-ios/") === true;
  const ready = truthOk && statusOk && headOk && sourceOk && hasRenderedDesktop && hasBuiltCss && hasIosDesignSystem;
  return {
    path,
    status: ready ? "ready" : "gap",
    truth_label: report.truth_label || null,
    report_status: report.status || null,
    generated_at_utc: report.generated_at_utc || null,
    head: report.head || null,
    expectedHead: head,
    headStatus: headOk ? "current_or_unavailable" : "stale_or_wrong_head",
    distRoot,
    iosSourceRoot,
    sourceStatus: sourceOk ? "served_desktop_dist_ui_and_ios_source" : "unexpected_source_scope",
    checks: {
      renderedDesktop: hasRenderedDesktop,
      builtCss: hasBuiltCss,
      iosDesignSystem: hasIosDesignSystem,
    },
    caveat: "Served UI fidelity proves current-HEAD selected desktop visual/structure/component fidelity for dist/ui plus iOS source design-system guards; it is not runtime action closure, release, adoption, or END-BAR.",
  };
}

function aggregateDesktopCaptures(items) {
  const groups = new Map();
  for (const item of items) {
    if (item.aggregate_key === null || item.eligibleForAggregate !== true) continue;
    const group = groups.get(item.aggregate_key) || [];
    group.push(item);
    groups.set(item.aggregate_key, group);
  }

  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => {
      const observed = new Set(group.flatMap((item) => item.observedDestinations || []));
      const missing = requiredDesktopDestinations.filter((destination) => !observed.has(destination));
      const first = group[0];
      return {
        status: missing.length === 0 ? "ready" : "gap",
        truth_label: "segmented_desktop_visual_capture_aggregate_not_endbar",
        capture_status: "segmented_aggregate",
        generated_at_utc: new Date().toISOString(),
        mode: first.mode,
        declaredMode: first.declaredMode,
        live_connection: first.live_connection,
        modeStatus: first.modeStatus,
        requiredDesktopDestinations,
        observedDestinations: [...observed],
        missingDestinations: missing,
        segmentCount: group.length,
        segmentPaths: group.map((item) => item.path),
        caveat: "Aggregates same-mission live desktop AX capture segments for selected visual proof only; not END-BAR, adoption, or runtime action closure.",
      };
    });
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
const desktopAggregateEvidence = aggregateDesktopCaptures(desktopVisualEvidence);
const servedUiVisualEvidence = unique(servedUiReports).map(evaluateServedUiReport);
const iosReady = iosVisualEvidence.some((item) => item.status === "ready");
const desktopReady = desktopVisualEvidence.some((item) => item.status === "ready")
  || desktopAggregateEvidence.some((item) => item.status === "ready")
  || servedUiVisualEvidence.some((item) => item.status === "ready");

if (!iosReady) {
  block(
    "mobile_selected_visual_proof_missing",
    "Run proof:ios:design-destinations on current HEAD in design-proof-sample or live-loopback mode and pass its ios-design-destination-capture-manifest.json; offline-truth is a negative-control lane and is not selected visual proof",
  );
}
if (!desktopReady) {
  block(
    "desktop_selected_visual_proof_missing",
    "Run served UI design fidelity on current HEAD and pass served-ui-design-fidelity.json, or run desktop GUI/AX capture with selected desktop destinations and pass desktop-ax-accessibility-capture.json",
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
    servedUiReports: unique(servedUiReports),
  },
  evidence: {
    ios: iosVisualEvidence,
    desktop: desktopVisualEvidence,
    desktopAggregates: desktopAggregateEvidence,
    servedUi: servedUiVisualEvidence,
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
