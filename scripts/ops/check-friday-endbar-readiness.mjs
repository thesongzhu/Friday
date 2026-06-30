#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-endbar-readiness.mjs \\
    [--repo-root=/abs/repo] \\
    [--manifest=/abs/or/repo-relative/friday-endbar-acceptance-manifest.json] \\
    [--mechanism-report=/abs/report.json] \\
    [--ui-real-use-report=/abs/report.json] \\
    [--selected-uiux-report=/abs/report.json] \\
    [--provider-entitlement-report=/abs/report.json] \\
    [--integrated-tape-report=/abs/report.json] \\
    [--out=/abs/endbar-readiness.json] [--require-complete]

Truth: aggregates already-captured reports against the five END-BAR acceptance
groups. It does not run providers, synthesize evidence, insert DB rows, mark
GO-LIVE, or claim adoption.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}` && args[index + 1]) return args[index + 1];
  }
  return "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const requireComplete = args.includes("--require-complete");
const repoRoot = resolve(arg("repo-root") || process.env.FRIDAY_REPO_ROOT || new URL("../..", import.meta.url).pathname);
const manifestPathInput = arg("manifest") || process.env.FRIDAY_ENDBAR_ACCEPTANCE_MANIFEST || "docs/ops/friday-endbar-acceptance-manifest.json";
const manifestPath = isAbsolute(manifestPathInput) ? manifestPathInput : resolve(repoRoot, manifestPathInput);
const outPath = arg("out") || process.env.FRIDAY_ENDBAR_READINESS_REPORT || "";

const reportInputs = {
  mechanism_multiangle_stress: arg("mechanism-report") || process.env.FRIDAY_ENDBAR_MECHANISM_REPORT || "",
  ui_real_use_mobile_desktop: arg("ui-real-use-report") || process.env.FRIDAY_ENDBAR_UI_REAL_USE_REPORT || "",
  selected_uiux_conformance: arg("selected-uiux-report") || process.env.FRIDAY_ENDBAR_SELECTED_UIUX_REPORT || "",
  provider_entitlement_matrix: arg("provider-entitlement-report") || process.env.FRIDAY_ENDBAR_PROVIDER_ENTITLEMENT_REPORT || "",
  integrated_end_to_end_tape: arg("integrated-tape-report") || process.env.FRIDAY_ENDBAR_INTEGRATED_TAPE_REPORT || "",
};

const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    block("json_unreadable", `${label}:${path}:${error.message}`);
    return null;
  }
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function field(value, name) {
  return value && typeof value === "object" ? value[name] : undefined;
}

function statusText(value) {
  return String(field(value, "status") || field(value, "result") || field(value, "proof") || "");
}

function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truthText(value) {
  return String(field(value, "truth") || field(value, "truth_label") || field(value, "truthLabel") || "");
}

function haystackFor(report, reportPath = "") {
  return `${reportPath}\n${statusText(report)}\n${truthText(report)}`.toLowerCase();
}

function hasAnySignal(value, signals) {
  return signals.some((signal) => value.includes(signal));
}

function hasDeferredSignal(value) {
  const status = statusText(value).toLowerCase();
  if (status.includes("defer")) return true;
  if (asArray(field(value, "deferredInputs")).length > 0) return true;
  if (asArray(field(value, "deferred_inputs")).length > 0) return true;
  const blockers = [
    text(field(value, "blockers")),
    text(field(value, "readinessBlockers")),
  ].join("\n").toLowerCase();
  return blockers.includes("defer") || blockers.includes("channel_deferred");
}

function deferredBlockerKey(value) {
  if (!hasDeferredSignal(value)) return null;
  const body = [
    statusText(value),
    truthText(value),
    text(field(value, "blockers")),
    text(field(value, "readinessBlockers")),
    text(field(value, "deferredInputs")),
    text(field(value, "deferred_inputs")),
    text(field(value, "fullProofGaps")),
  ].join("\n").toLowerCase();
  if (
    body.includes("channel")
    || body.includes("same_mission_mobile_desktop_channel")
    || body.includes("channel_deferred")
  ) {
    return "channel_current_linked_proof_deferred";
  }
  return "deferred_external_input";
}

function isPassLike(value) {
  const status = statusText(value);
  return [
    "pass",
    "passed",
    "ready",
    "complete",
    "complete_inputs_observed",
    "uiux_product_closure_evidence_ready",
  ].includes(status);
}

function expectedStatusForGroup(groupId, report, reportPath = "") {
  if (!report) return { status: "missing_report", blocker: "report not supplied" };
  if (hasDeferredSignal(report)) {
    return {
      status: "deferred",
      blocker: "deferred input remains outside strict END-BAR",
      sharedBlockerKey: deferredBlockerKey(report),
    };
  }
  if (groupId === "provider_entitlement_matrix") {
    const haystack = haystackFor(report, reportPath);
    return report.status === "passed" && hasAnySignal(haystack, ["provider_entitlement", "provider-entitlement"])
      ? { status: "satisfied" }
      : { status: "blocked", blocker: statusText(report) || "provider entitlement report not passed or not group-level" };
  }
  if (groupId === "selected_uiux_conformance") {
    return statusText(report) === "uiux_product_closure_evidence_ready"
      ? { status: "satisfied" }
      : { status: "blocked", blocker: statusText(report) || "selected UI/UX product closure report not complete" };
  }
  if (groupId === "mechanism_multiangle_stress") {
    const haystack = haystackFor(report, reportPath);
    const groupLevel = hasAnySignal(haystack, ["mechanism_multiangle", "mechanism-stress"]);
    return groupLevel && isPassLike(report)
      ? { status: "satisfied" }
      : { status: "blocked", blocker: statusText(report) || "mechanism report not complete or not group-level" };
  }
  if (groupId === "ui_real_use_mobile_desktop") {
    const status = statusText(report);
    const haystack = haystackFor(report, reportPath);
    const strictStatus = status === "strict_uiux_real_use_ready" || status === "strict_ui_device_ready";
    const groupLevel = hasAnySignal(haystack, ["ui_real_use_mobile_desktop", "ui-real-use", "uiux_real_use", "ui-device", "ui_device"]);
    return (strictStatus || (groupLevel && isPassLike(report)))
      ? { status: "satisfied" }
      : { status: "blocked", blocker: status || "UI real-use report not strict or not group-level" };
  }
  if (groupId === "integrated_end_to_end_tape") {
    return statusText(report) === "integrated_end_to_end_tape_ready"
      ? { status: "satisfied" }
      : { status: "blocked", blocker: statusText(report) || "integrated tape report not ready" };
  }
  return isPassLike(report)
    ? { status: "satisfied" }
    : { status: "blocked", blocker: statusText(report) || "report not pass-like" };
}

function readReport(groupId, inputPath) {
  if (!inputPath) return null;
  const resolved = abs(inputPath);
  if (!existsSync(resolved)) {
    block("report_missing", `${groupId}:${resolved}`);
    return null;
  }
  return {
    path: resolved,
    value: readJson(resolved, groupId),
  };
}

if (!existsSync(manifestPath)) {
  block("manifest_missing", manifestPath);
}

const manifest = existsSync(manifestPath) ? readJson(manifestPath, "endbar-acceptance-manifest") : null;
const groups = asArray(field(manifest, "acceptanceGroups"));
const requiredGroups = groups.filter((group) => field(group, "requiredForEndBar") === true);

for (const requiredId of [
  "mechanism_multiangle_stress",
  "ui_real_use_mobile_desktop",
  "selected_uiux_conformance",
  "provider_entitlement_matrix",
  "integrated_end_to_end_tape",
]) {
  if (!requiredGroups.some((group) => field(group, "id") === requiredId)) {
    block("acceptance_group_missing", requiredId);
  }
}

const rows = requiredGroups.map((group) => {
  const id = field(group, "id");
  const loaded = readReport(id, reportInputs[id] || "");
  const evaluation = expectedStatusForGroup(id, loaded?.value || null, loaded?.path || "");
  return {
    id,
    requiredForEndBar: true,
    status: evaluation.status,
    reportPath: loaded?.path || null,
    reportStatus: loaded?.value ? statusText(loaded.value) || null : null,
    blocker: evaluation.blocker || null,
    sharedBlockerKey: evaluation.sharedBlockerKey || null,
    passBar: asArray(field(group, "passBar")),
  };
});

for (const row of rows) {
  if (row.status !== "satisfied") {
    block("acceptance_group_not_satisfied", `${row.id}:${row.status}`);
  }
}

const satisfiedCount = rows.filter((row) => row.status === "satisfied").length;
const deferredCount = rows.filter((row) => row.status === "deferred").length;
const missingReportCount = rows.filter((row) => row.status === "missing_report").length;
const sharedBlockers = Object.values(rows.reduce((acc, row) => {
  if (!row.sharedBlockerKey || row.status === "satisfied") return acc;
  acc[row.sharedBlockerKey] ||= {
    key: row.sharedBlockerKey,
    status: row.status,
    affectedGroups: [],
    description: row.sharedBlockerKey === "channel_current_linked_proof_deferred"
      ? "Channel/current-linked proof is deferred, so all affected groups remain outside strict END-BAR."
      : "A deferred external input keeps all affected groups outside strict END-BAR.",
  };
  acc[row.sharedBlockerKey].affectedGroups.push(row.id);
  return acc;
}, {}));
const strictEndBarReady = rows.length > 0 && satisfiedCount === rows.length && blockers.length === 0;

const report = {
  truth: "endbar_readiness_aggregator_not_runtime_proof_not_release",
  status: strictEndBarReady ? "strict_endbar_inputs_satisfied" : "blocked",
  repoRoot,
  manifestPath,
  counts: {
    requiredGroups: rows.length,
    satisfied: satisfiedCount,
    deferred: deferredCount,
    missingReport: missingReportCount,
  },
  groups: rows,
  blockers,
  sharedBlockers,
  strictEndBarReady,
  caveat: "This report aggregates supplied evidence reports only. It never creates evidence, never counts deferred channel proof as strict END-BAR, and never turns report coverage into adoption.",
};

if (outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(strictEndBarReady || !requireComplete ? 0 : 2);
