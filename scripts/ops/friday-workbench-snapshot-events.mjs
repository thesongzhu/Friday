#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-workbench-snapshot-events.mjs \\
    --mission-id=mission_... \\
    --file=/abs/workbench-snapshot.json \\
    --mobile=/abs/mobile-capture \\
    --desktop=/abs/desktop-capture \\
    --channel=/abs/channel-capture \\
    --timeline=/abs/timeline-capture \\
    --out=/abs/workbench-derived-events.jsonl

Options:
  --url=http://127.0.0.1:3141/v1/mission-spine/workbench
  --defer-channel-proof
  --require-ready

Truth: this bridges a preflight-passing Mission Workbench snapshot into
diagnostic UI/device event rows. It does not write proof, does not synthesize
missing stress/security/network observations, and does not mark END-BAR.`);
}

function arg(name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || "";
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const requireReady = args.includes("--require-ready");
const deferChannelProof = args.includes("--defer-channel-proof") || process.env.FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF === "1";
const missionId = arg("mission-id") || process.env.MISSION_ID || "";
const sourceFile = arg("file") || process.env.MISSION_WORKBENCH_SNAPSHOT_FILE || "";
const sourceUrl = arg("url") || process.env.MISSION_WORKBENCH_SNAPSHOT_URL || "";
const outPath = arg("out");
const evidenceArgs = {
  mobile: arg("mobile"),
  desktop: arg("desktop"),
  channel: arg("channel"),
  timeline: arg("timeline"),
};
const blockers = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function requireFile(label, path) {
  if (!path) {
    block("missing_arg", label);
    return "";
  }
  const resolved = abs(path);
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) block("not_file", `${label}:${resolved}`);
    if (stats.size <= 0) block("empty_file", `${label}:${resolved}`);
  } catch {
    block("unreadable_file", `${label}:${resolved}`);
  }
  return resolved;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(abs(path), "utf8"));
  } catch {
    block("source_unreadable_or_invalid_json", abs(path));
    return null;
  }
}

async function readJsonFromUrl(url) {
  const headers = {};
  if (process.env.FRIDAY_API_BEARER) {
    headers.Authorization = `Bearer ${process.env.FRIDAY_API_BEARER}`;
  }
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    block("source_url_fetch_failed", url);
    return null;
  }
  const text = await response.text();
  if (!response.ok) {
    block("source_url_response_not_ok", String(response.status));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    block("source_url_invalid_json", url);
    return null;
  }
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function unwrapSnapshot(payload) {
  const root = object(payload);
  const data = object(root.data);
  return object(data.snapshot || root.snapshot || root);
}

function runPreflight() {
  if (sourceFile && sourceUrl) {
    block("multiple_sources", "choose --file or --url, not both");
    return null;
  }
  if (!sourceFile && !sourceUrl) {
    block("missing_source", "--file or --url");
    return null;
  }
  const preflightArgs = [
    "scripts/qa/check-mission-workbench-snapshot-contract.mjs",
    sourceFile ? `--file=${sourceFile}` : `--url=${sourceUrl}`,
  ];
  if (missionId) preflightArgs.push(`--mission-id=${missionId}`);
  if (deferChannelProof) preflightArgs.push("--diagnostic-timeline-only");
  const result = spawnSync(process.execPath, preflightArgs, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    block("preflight_output_invalid_json", result.stderr || "no stdout");
  }
  const ready = parsed?.readyForLiveCaptureInput === true
    || (deferChannelProof && parsed?.readyForDiagnosticTimelineInput === true);
  if (result.status !== 0 || ready !== true) {
    block("snapshot_preflight_not_ready", JSON.stringify(parsed?.failures || []));
  }
  return parsed;
}

function collectTranscriptEvents(snapshot) {
  return array(snapshot.transcriptSections)
    .flatMap((section) => array(object(section).events).map((event) => object(event)));
}

function hasTranscriptSurface(events, surface) {
  return events.some((event) => event.surface === surface);
}

function hasWorkItem(snapshot, state, done) {
  return array(snapshot.workItems).some((item) => {
    const workItem = object(item);
    return workItem.state === state && workItem.done === done;
  });
}

function hasCompletedProof(snapshot) {
  return array(snapshot.workItems).some((item) => {
    const workItem = object(item);
    return workItem.state === "completed_with_proof" && workItem.done === true && typeof workItem.proofRef === "string";
  });
}

function firstCapturedAt(events) {
  return events.find((event) => typeof event.capturedAt === "string" && event.capturedAt.trim())?.capturedAt
    || new Date().toISOString();
}

function makeRows(snapshot, evidence, truthLabel) {
  const rows = [];
  const transcriptEvents = collectTranscriptEvents(snapshot);
  const capturedAt = firstCapturedAt(transcriptEvents);
  const add = (surface, event, evidenceRef, source) => {
    rows.push({
      surface,
      event,
      mission_id: missionId,
      evidence_ref: evidenceRef,
      truth_label: truthLabel,
      source,
      captured_at: capturedAt,
    });
  };

  if (hasTranscriptSurface(transcriptEvents, "mobile")) {
    add("mobile", "mission_intake_submitted", evidence.mobile, "transcript_surface:mobile");
    add("mobile", "mission_intake_ready", evidence.mobile, "transcript_surface:mobile");
  }
  if (object(snapshot.duplicatePreflight).status === "opens_existing_mission") {
    add("mobile", "duplicate_preflight_visible", evidence.mobile, "duplicate_preflight");
    add("desktop", "duplicate_preflight_visible", evidence.desktop, "duplicate_preflight");
    add("desktop", "duplicate_blocked_opens_existing", evidence.desktop, "duplicate_preflight");
  }
  if (hasWorkItem(snapshot, "provider_ack", false)) {
    add("mobile", "mission_bound_provider_action_visible", evidence.mobile, "work_item:provider_ack");
    add("desktop", "provider_ack_not_done_visible", evidence.desktop, "work_item:provider_ack");
  }
  if (hasCompletedProof(snapshot)) {
    add("desktop", "real_provider_execution_visible", evidence.desktop, "work_item:completed_with_proof");
    add("desktop", "real_provider_execution_receipt_visible", evidence.desktop, "work_item:completed_with_proof");
    add("mobile", "proof_receipt_visible_before_done", evidence.mobile, "work_item:completed_with_proof");
  }
  if (hasTranscriptSurface(transcriptEvents, "desktop")) {
    add("desktop", "same_mission_projection_visible", evidence.desktop, "transcript_surface:desktop");
    add("desktop", "mission_workbench_visible", evidence.desktop, "transcript_surface:desktop");
    add("desktop", "transcript_browser_visible", evidence.desktop, "transcript_surface:desktop");
  }
  if (evidence.channel && (hasTranscriptSurface(transcriptEvents, "telegram") || array(snapshot.channelReceiptRefs).length > 0)) {
    add("channel", "same_mission_projection_visible", evidence.channel, "channel_receipt_refs");
  }
  if (array(snapshot.timelinePages).some((page) => object(page).page === 1)) {
    add("timeline", "bounded_page_1_visible", evidence.timeline, "timeline_page:1");
  }
  if (array(snapshot.timelinePages).some((page) => object(page).page === 2)) {
    add("timeline", "bounded_page_2_visible", evidence.timeline, "timeline_page:2");
  }
  if (array(snapshot.memoryCandidates).some((candidate) => object(candidate).state === "candidate_review_only")) {
    add("timeline", "memory_candidate_review_only", evidence.timeline, "memory_candidate:review_only");
  }
  const statusLabels = new Set(array(snapshot.statusLabels));
  if (statusLabels.has("stale")) add("desktop", "stale_label_visible", evidence.desktop, "status_label:stale");
  if (statusLabels.has("offline")) add("desktop", "offline_label_visible", evidence.desktop, "status_label:offline");
  if (statusLabels.has("error")) add("desktop", "error_label_visible", evidence.desktop, "status_label:error");
  if (
    hasTranscriptSurface(transcriptEvents, "mobile")
    && hasTranscriptSurface(transcriptEvents, "desktop")
    && evidence.channel
    && (hasTranscriptSurface(transcriptEvents, "telegram") || array(snapshot.channelReceiptRefs).length > 0)
  ) {
    add("*", "same_mission_mobile_desktop_channel_visible", evidence.desktop, "transcript_surfaces:mobile_desktop_channel");
  }
  return rows;
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outPath) block("missing_arg", "out");

const evidence = {};
for (const [role, path] of Object.entries(evidenceArgs)) {
  if (role === "channel" && deferChannelProof && !path) {
    evidence[role] = "";
  } else {
    evidence[role] = requireFile(role, path);
  }
}
const preflight = runPreflight();
const payload = sourceFile ? readJson(sourceFile) : sourceUrl ? await readJsonFromUrl(sourceUrl) : null;
const snapshot = payload ? unwrapSnapshot(payload) : {};

const rowTruthLabel = preflight?.readyForLiveCaptureInput === true
  ? "derived_from_preflighted_workbench_snapshot_not_final_proof"
  : "derived_from_diagnostic_workbench_snapshot_not_final_proof";
const rows = blockers.length === 0 ? makeRows(snapshot, evidence, rowTruthLabel) : [];
if (rows.length === 0 && blockers.length === 0) block("no_derivable_events", "snapshot produced no diagnostic rows");

if (blockers.length === 0) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const output = {
  truth: "workbench_snapshot_events_bridge_diagnostic_not_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  out: outPath ? abs(outPath) : null,
  derivedEvents: rows.length,
  preflightReady: preflight?.readyForLiveCaptureInput === true,
  diagnosticTimelineReady: preflight?.readyForDiagnosticTimelineInput === true,
  deferredInputs: deferChannelProof ? [{
    role: "channel",
    status: "deferred_by_operator",
    countsTowardUiDeviceProof: false,
    caveat: "Channel evidence is deferred; this bridge emits only diagnostic non-channel rows and never counts as channel proof.",
  }] : [],
  blockers,
  caveat: "Diagnostic bridge only. Stress/security/network/device observations still require real same-run capture before final proof.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
