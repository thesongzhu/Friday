#!/usr/bin/env node

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-proof-evidence-harvest.mjs \\
    --mission-id=mission_... \\
    --search-dir=/abs/artifacts [--search-dir=/abs/other-artifacts ...] \\
    [--out=/abs/harvest.json] [--require-ready] [--defer-channel-proof]

Truth: scans existing artifact files and reports which ones are eligible inputs
for the strict UI/device proof pipeline. It does not create proof rows, does not
synthesize observations, and does not make old or cross-mission captures count.`);
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

const missionId = arg("mission-id");
const searchDirs = argsAll("search-dir");
const out = arg("out");
const requireReady = args.includes("--require-ready");
const deferChannelProof = args.includes("--defer-channel-proof") || process.env.FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF === "1";
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function readJson(path) {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size > 5 * 1024 * 1024) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function jsonMission(value) {
  if (!value || typeof value !== "object") return "";
  const candidates = [
    value.missionId,
    value.mission_id,
    value.mission?.mission_id,
    value.mission?.id,
    value.workItem?.mission_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function fileKind(path, json) {
  const lower = path.toLowerCase();
  const name = basename(lower);
  if (name.endsWith(".jsonl") && (name.includes("event") || name.includes("same-run"))) return "events";
  if (name === "observations-manifest.json") return "manifest";
  if (json?.proof === "mission_spine_backend_api_live_pressure") return "backendLiveProof";
  if (json?.proof === "mission_spine_channel_live_proof") return "channelLiveProof";
  if (Array.isArray(json?.requirements) || String(json?.remaining_requirement || "").includes("UI or device consumption")) return "objectiveCoverage";
  if (name === "ios-live-write-read-proof.json" || name === "mobile.json") return "mobile";
  if (name === "macos-live-write-read-proof.json" || name === "desktop.json") return "desktop";
  if (name === "timeline-capture.json" || name === "timeline.json" || name === "timeline.trace" || name === "old-timeline-db.json") return "timeline";
  if (name === "channel-capture.json" || name === "channel.json" || name === "channel.log" || name === "channel.trace") return "channel";
  if (name.startsWith("screenshot ") && name.endsWith(".png")) return "screenshot";
  return "";
}

function shouldReject(path, json, kind) {
  const truth = String(json?.truth || json?.truth_label || "");
  const foundMission = jsonMission(json);
  const reasons = [];
  if (foundMission && foundMission !== missionId) reasons.push(`mission_mismatch:${foundMission}`);
  if (truth.includes("synthetic")) reasons.push("synthetic_truth_label");
  if (truth.includes("partial_not_mission_spine_ui_device_proof") && kind !== "timeline") {
    reasons.push("explicit_partial_non_ui_device_truth_label");
  }
  if (kind === "timeline" && truth.includes("partial_not_mission_spine_ui_device_proof")) {
    reasons.push("timeline_partial_only");
  }
  if (kind === "screenshot") reasons.push("screenshot_only_not_action_evidence");
  return reasons;
}

function jsonlRejectReasons(path) {
  const reasons = [];
  let rows = [];
  try {
    rows = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return ["events_unreadable_or_invalid_jsonl"];
  }
  if (rows.length === 0) return ["events_empty"];
  const missions = new Set(rows.map((row) => typeof row?.mission_id === "string" ? row.mission_id.trim() : "").filter(Boolean));
  if (missions.size === 0) return ["events_missing_mission_id"];
  if (missions.size !== 1 || !missions.has(missionId)) return [`events_mission_mismatch:${[...missions].sort().join(",")}`];
  return reasons;
}

function walk(dir, files = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    block("search_dir_unreadable", dir);
    return files;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if ([".git", "node_modules", ".build", "DerivedData"].includes(entry.name)) continue;
      walk(path, files);
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (searchDirs.length === 0) block("missing_search_dir", "supply at least one --search-dir");

const candidates = [];
for (const input of searchDirs) {
  const dir = abs(input);
  let stats = null;
  try {
    stats = statSync(dir);
  } catch {
    block("search_dir_missing", dir);
    continue;
  }
  if (!stats.isDirectory()) {
    block("search_dir_not_directory", dir);
    continue;
  }
  for (const path of walk(dir)) {
    const json = path.endsWith(".json") ? readJson(path) : null;
    const kind = fileKind(path, json);
    if (!kind) continue;
    const rejectReasons = shouldReject(path, json, kind);
    if (kind === "events") rejectReasons.push(...jsonlRejectReasons(path));
    candidates.push({
      kind,
      path,
      missionId: jsonMission(json) || null,
      truth: typeof json?.truth === "string" ? json.truth : typeof json?.truth_label === "string" ? json.truth_label : null,
      eligible: rejectReasons.length === 0,
      rejectReasons,
    });
  }
}

function firstEligible(kind) {
  return candidates.find((candidate) => candidate.kind === kind && candidate.eligible)?.path || "";
}

const selected = {
  mobile: firstEligible("mobile"),
  desktop: firstEligible("desktop"),
  channel: firstEligible("channel"),
  timeline: firstEligible("timeline"),
  manifest: firstEligible("manifest"),
  events: candidates.filter((candidate) => candidate.kind === "events" && candidate.eligible).map((candidate) => candidate.path),
  backendLiveProof: firstEligible("backendLiveProof"),
  channelLiveProof: firstEligible("channelLiveProof"),
  objectiveCoverage: firstEligible("objectiveCoverage"),
};

for (const role of ["mobile", "desktop", "channel", "timeline"]) {
  if (role === "channel" && deferChannelProof) continue;
  if (!selected[role]) block("missing_eligible_capture", role);
}
if (!selected.manifest && selected.events.length === 0) {
  block("missing_manifest_or_events", "need observations-manifest.json or same-run event jsonl");
}

const captureDirCommand = selected.mobile && selected.desktop && selected.channel && selected.timeline
  ? [
      "node scripts/ops/friday-ui-device-capture-dir.mjs",
      `--mission-id=${missionId}`,
      "--out-dir=/abs/evidence-dir",
      `--mobile=${selected.mobile}`,
      `--desktop=${selected.desktop}`,
      `--channel=${selected.channel}`,
      `--timeline=${selected.timeline}`,
      selected.manifest ? `--observations-manifest=${selected.manifest}` : "",
      ...selected.events.map((path) => `--events=${path}`),
      "--require-ready",
    ].filter(Boolean).join(" \\\n  ")
  : null;

const proofRunnerCommand = [
  "scripts/ops/friday-ui-device-proof-shortlist-runner.sh",
  "--out-dir /abs/ui-device-proof-run",
  selected.backendLiveProof ? `--backend-live-proof ${selected.backendLiveProof}` : "",
  selected.objectiveCoverage ? `--objective-coverage ${selected.objectiveCoverage}` : "",
  selected.channelLiveProof ? `--channel-live-proof ${selected.channelLiveProof}` : "",
  selected.channel ? `--channel-capture ${selected.channel}` : "",
  selected.timeline ? `--timeline-capture ${selected.timeline}` : "",
  ...selected.events.map((path) => `--same-run-events ${path}`),
].filter(Boolean).join(" \\\n  ");

const deferredInputs = [];
if (deferChannelProof && !selected.channel) {
  deferredInputs.push({
    role: "channel",
    status: "deferred_by_operator",
    countsTowardUiDeviceProof: false,
    caveat: "Channel live proof is intentionally deferred; this harvest can unblock non-channel evidence work but cannot satisfy strict UI/device proof or END-BAR.",
  });
}

const pipelineReady = blockers.length === 0 && deferredInputs.length === 0;
const status = pipelineReady
  ? "ready_for_strict_pipeline"
  : blockers.length === 0 && deferredInputs.length > 0
    ? "non_channel_inputs_ready_channel_deferred"
    : "partial";

const result = {
  truth: "ui_device_proof_evidence_harvest_not_proof_not_endbar",
  status,
  missionId,
  searched: searchDirs.map(abs),
  selected,
  deferredInputs,
  counts: {
    candidates: candidates.length,
    eligible: candidates.filter((candidate) => candidate.eligible).length,
    rejected: candidates.filter((candidate) => !candidate.eligible).length,
  },
  rejected: candidates.filter((candidate) => !candidate.eligible),
  captureDirCommand,
  proofRunnerCommand,
  blockers,
  caveat: "Harvest only. Run the emitted strict pipeline commands and gates before claiming UI/device proof, END-BAR, or release readiness.",
};

if (out) {
  const resolved = abs(out);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`);
}

console.log(JSON.stringify(result, null, 2));
process.exit(pipelineReady || !requireReady ? 0 : 2);
