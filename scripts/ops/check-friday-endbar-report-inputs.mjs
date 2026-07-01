#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-endbar-report-inputs.mjs \\
    [--repo-root=/abs/repo] \\
    --search-root=/abs/artifact-dir [--search-root=/abs/other-dir ...] \\
    [--search-roots=/abs/artifact-dir,/abs/other-dir] \\
    [--max-depth=5] [--out=/abs/report-inputs.json]

Truth: discovers existing END-BAR report candidates and prints the readiness
aggregator command. It does not run providers, create evidence, write DB rows,
mark GO-LIVE, count deferred channel proof as strict END-BAR, or claim release.`);
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

function allArgs(name) {
  const prefix = `--${name}=`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith(prefix)) values.push(value.slice(prefix.length));
    if (value === `--${name}` && args[index + 1]) {
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
const searchRoots = [
  ...allArgs("search-root"),
  ...allArgs("search-roots").flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean)),
].map((path) => isAbsolute(path) ? path : resolve(path));
const outPath = arg("out") || process.env.FRIDAY_ENDBAR_REPORT_INPUT_DISCOVERY || "";
const maxDepth = Number.parseInt(arg("max-depth") || process.env.FRIDAY_ENDBAR_REPORT_INPUT_MAX_DEPTH || "5", 10);

const groupOrder = [
  "mechanism_multiangle_stress",
  "ui_real_use_mobile_desktop",
  "selected_uiux_conformance",
  "provider_entitlement_matrix",
  "integrated_end_to_end_tape",
];

const optionByGroup = {
  mechanism_multiangle_stress: "--mechanism-report",
  ui_real_use_mobile_desktop: "--ui-real-use-report",
  selected_uiux_conformance: "--selected-uiux-report",
  provider_entitlement_matrix: "--provider-entitlement-report",
  integrated_end_to_end_tape: "--integrated-tape-report",
};

const blockers = [];
const notes = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
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

function statusText(report) {
  return text(report?.status || report?.result || report?.proof || "");
}

function truthText(report) {
  return text(report?.truth || report?.truth_label || report?.truthLabel || "");
}

function hasDeferredSignal(report) {
  const haystack = [
    statusText(report),
    truthText(report),
    text(report?.blockers),
    text(report?.readinessBlockers),
    text(report?.deferredInputs),
    text(report?.deferred_inputs),
  ].join("\n").toLowerCase();
  return haystack.includes("defer") || haystack.includes("channel_deferred");
}

function hasBlockers(report) {
  return asArray(report?.blockers).length > 0 || asArray(report?.readinessBlockers).length > 0;
}

function hasAnySignal(value, signals) {
  const lower = value.toLowerCase();
  return signals.some((signal) => lower.includes(signal));
}

function classifyForGroup(groupId, report, path) {
  const status = statusText(report);
  const truth = truthText(report);
  const pathAndTruth = `${path}\n${truth}`.toLowerCase();
  const deferred = hasDeferredSignal(report);
  if (deferred) {
    return { classification: "deferred", score: 55, reason: "report contains deferred/channel-deferred signal" };
  }

  if (groupId === "provider_entitlement_matrix") {
    if (status === "passed" && truth.includes("endbar_acceptance_manifest_check")) {
      return { classification: "boundary_only", score: 35, reason: "provider boundary checker passed but is not runtime provider proof" };
    }
    if (status === "passed") return { classification: "satisfied", score: 90, reason: "provider entitlement report status is passed" };
    return { classification: "candidate", score: 20, reason: `status=${status || "<missing>"}` };
  }

  if (groupId === "selected_uiux_conformance") {
    const partialStatuses = new Set([
      "selected_visual_proof_ready",
      "product_runtime_actions_traceable",
      "runtime_actions_covered",
      "runtime_capture_required",
      "passed",
    ]);
    if (status === "uiux_product_closure_evidence_ready" && !hasBlockers(report)) {
      return { classification: "satisfied", score: 95, reason: "selected UI/UX product closure evidence is ready" };
    }
    if (status === "uiux_product_closure_evidence_ready") {
      return { classification: "candidate_with_blockers", score: 45, reason: "product closure status is present but blockers remain" };
    }
    if (partialStatuses.has(status)) {
      return { classification: "partial", score: 45, reason: `selected UI/UX partial status ${status} is not final product closure` };
    }
    return { classification: "candidate", score: 20, reason: `status=${status || "<missing>"}` };
  }

  if (groupId === "ui_real_use_mobile_desktop") {
    if (status === "strict_uiux_real_use_ready" || status === "strict_ui_device_ready" || status === "pass" || status === "passed") {
      if (status === "strict_uiux_real_use_ready" || status === "strict_ui_device_ready") {
        return { classification: "satisfied", score: 95, reason: `strict UI/device status ${status}` };
      }
      if (hasAnySignal(pathAndTruth, ["ui-real-use-report", "ui_real_use_mobile_desktop", "uiux_real_use"])) {
        return { classification: "satisfied", score: 90, reason: `group-level UI real-use report status ${status}` };
      }
      return { classification: "partial", score: 45, reason: `single proof is pass-like but not a strict/group UI real-use report (${truth || path})` };
    }
    if (status === "partial_ready" || status === "ready_for_runtime_capture") {
      return { classification: "partial", score: 50, reason: `non-strict UI/device status ${status}` };
    }
    return { classification: "candidate", score: 20, reason: `status=${status || "<missing>"}` };
  }

  if (groupId === "integrated_end_to_end_tape") {
    if (status === "integrated_end_to_end_tape_ready") {
      return { classification: "satisfied", score: 95, reason: "integrated tape ready status" };
    }
    if (status === "partial_ready" || status === "ready_for_runtime_capture") {
      return { classification: "partial", score: 40, reason: `not an integrated tape report (${status})` };
    }
    return { classification: "candidate", score: 20, reason: `status=${status || "<missing>"}` };
  }

  if (groupId === "mechanism_multiangle_stress") {
    if (["pass", "passed", "ready", "complete", "complete_inputs_observed"].includes(status)) {
      if (hasAnySignal(pathAndTruth, ["mechanism_multiangle", "multiangle", "mission_spine_closure", "mission-spine-closure", "mechanism-stress"])) {
        return { classification: "satisfied", score: 90, reason: `group-level mechanism report status ${status}` };
      }
      return { classification: "partial", score: 35, reason: `pass-like report is not identifiable as mechanism multiangle stress (${truth || path})` };
    }
    return { classification: "candidate", score: 20, reason: `status=${status || "<missing>"}` };
  }

  if (["pass", "passed", "ready", "complete", "complete_inputs_observed"].includes(status)) {
    return { classification: "satisfied", score: 90, reason: `pass-like status ${status}` };
  }
  return { classification: "candidate", score: 20, reason: `status=${status || "<missing>"}` };
}

function looksRelevant(path, report) {
  const name = path.toLowerCase();
  const body = `${statusText(report)}\n${truthText(report)}`.toLowerCase();
  return name.includes("endbar")
    || name.includes("uiux")
    || name.includes("ui-real-use")
    || name.includes("ui_real_use")
    || name.includes("ui-device")
    || name.includes("provider")
    || name.includes("integrated")
    || name.includes("tape")
    || name.includes("mission-spine")
    || name.includes("mechanism")
    || name.includes("multiangle")
    || name.includes("objective")
    || name.includes("backend-live")
    || body.includes("endbar")
    || body.includes("mechanism_multiangle")
    || body.includes("mechanism-stress")
    || body.includes("ui_device")
    || body.includes("ui_real_use_mobile_desktop")
    || body.includes("uiux")
    || body.includes("provider")
    || body.includes("integrated_end_to_end_tape")
    || body.includes("integrated-tape")
    || body.includes("mission_spine");
}

function appliesToGroup(groupId, path, report) {
  const haystack = `${path}\n${statusText(report)}\n${truthText(report)}`.toLowerCase();
  if (groupId === "mechanism_multiangle_stress") {
    return hasAnySignal(haystack, ["mechanism_multiangle", "multiangle", "mechanism-stress", "mission_spine_closure", "mission-spine-closure", "mission-spine-proof", "backend-live-proof"]);
  }
  if (groupId === "ui_real_use_mobile_desktop") {
    return hasAnySignal(haystack, ["ui_real_use_mobile_desktop", "ui-real-use", "uiux_real_use", "ui-device", "ui_device", "mobile_desktop"]);
  }
  if (groupId === "selected_uiux_conformance") {
    return hasAnySignal(haystack, ["selected_uiux", "selected-uiux", "selected_visual", "selected-visual", "design-action", "action-traceability", "runtime-action", "native-linkage", "product-closure"]);
  }
  if (groupId === "provider_entitlement_matrix") {
    return hasAnySignal(haystack, ["provider_entitlement", "provider-entitlement", "provider-routing", "provider entitlement", "endbar_acceptance_manifest_check"]);
  }
  if (groupId === "integrated_end_to_end_tape") {
    return hasAnySignal(haystack, ["integrated_end_to_end_tape", "integrated-tape", "end-to-end-tape", "product-auto-followup", "auto-followup"]);
  }
  return false;
}

function walkJsonFiles(root, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  let entries = [];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(path, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(path);
    }
  }
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

if (!Number.isFinite(maxDepth) || maxDepth < 0 || maxDepth > 12) {
  block("invalid_max_depth", String(maxDepth));
}

if (searchRoots.length === 0) {
  block("search_root_missing", "provide at least one --search-root");
}

const files = [];
for (const root of searchRoots) {
  if (!existsSync(root)) {
    block("search_root_missing", root);
    continue;
  }
  let stats = null;
  try {
    stats = statSync(root);
  } catch {
    block("search_root_unreadable", root);
    continue;
  }
  if (stats.isFile() && root.endsWith(".json")) {
    files.push(root);
  } else if (stats.isDirectory()) {
    files.push(...walkJsonFiles(root));
  }
}

const byGroup = Object.fromEntries(groupOrder.map((groupId) => [groupId, []]));
for (const path of files) {
  const report = readJson(path);
  if (!report || !looksRelevant(path, report)) continue;
  for (const groupId of groupOrder) {
    if (!appliesToGroup(groupId, path, report)) continue;
    const classification = classifyForGroup(groupId, report, path);
    if (classification.score < 35) continue;
    byGroup[groupId].push({
      path,
      status: statusText(report) || null,
      truth: truthText(report) || null,
      classification: classification.classification,
      score: classification.score,
      reason: classification.reason,
    });
  }
}

const groups = groupOrder.map((groupId) => {
  const candidates = byGroup[groupId]
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, 8);
  const selected = candidates.find((candidate) => candidate.classification === "satisfied") || candidates[0] || null;
  if (!selected) block("report_candidate_missing", groupId);
  if (selected && selected.classification !== "satisfied") {
    block("report_candidate_not_satisfied", `${groupId}:${selected.classification}`);
  }
  return {
    id: groupId,
    selectedCandidate: selected,
    candidates,
  };
});

const selectedByGroup = Object.fromEntries(groups.map((group) => [group.id, group.selectedCandidate?.path || ""]));
const allSatisfied = groups.every((group) => group.selectedCandidate?.classification === "satisfied");
const command = allSatisfied
  ? [
      "node",
      "scripts/ops/check-friday-endbar-readiness.mjs",
      ...groupOrder.map((groupId) => `${optionByGroup[groupId]}=${selectedByGroup[groupId]}`),
      "--require-complete",
    ]
  : null;

if (searchRoots.some((root) => root === "/tmp" || root === "/private/tmp")) {
  notes.push("large tmp roots can contain stale evidence; prefer a run-specific artifact directory when possible");
}

const report = {
  truth: "endbar_report_input_discovery_not_runtime_proof_not_release",
  status: allSatisfied && blockers.length === 0 ? "complete_candidate_set" : "partial_candidate_set",
  repoRoot,
  searchRoots,
  maxDepth,
  counts: {
    jsonFilesScanned: files.length,
    groups: groupOrder.length,
    satisfiedCandidates: groups.filter((group) => group.selectedCandidate?.classification === "satisfied").length,
  },
  groups,
  command,
  notes,
  blockers,
  caveat: "Candidate discovery is not evidence generation and not release approval. Run the printed readiness command and inspect each source report before any END-BAR claim.",
};

if (outPath) {
  const resolved = isAbsolute(outPath) ? outPath : resolve(outPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(blockers.length === 0 ? 0 : 2);
