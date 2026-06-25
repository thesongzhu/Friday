#!/usr/bin/env node

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-channel-proof-events.mjs \\
    --mission-id=mission_... \\
    --channel-live-proof=/abs/channel-live-proof.json \\
    --channel-capture=/abs/channel-capture.json \\
    --out=/abs/channel-events.jsonl [--require-ready]

Truth: converts a redacted channel live proof wrapper into conservative
same-run UI/device event rows. It does not synthesize replay, timeline,
mobile/desktop/channel convergence, END-BAR, GO-LIVE, or adoption proof.`);
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
const missionId = arg("mission-id");
const channelLiveProofPath = arg("channel-live-proof");
const channelCapturePath = arg("channel-capture");
const outPath = arg("out");
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

function readJson(path, label) {
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    block("invalid_json", label);
    return null;
  }
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outPath) block("missing_arg", "out");

const channelLiveProof = requireFile("channel-live-proof", channelLiveProofPath);
const channelCapture = requireFile("channel-capture", channelCapturePath);
const proof = readJson(channelLiveProof, "channel-live-proof");

if (proof) {
  if (proof.proof !== "mission_spine_channel_live_proof") block("channel_live_proof_mismatch", String(proof.proof ?? ""));
  if (proof.status !== "passed") block("channel_live_proof_not_passed", String(proof.status ?? ""));
  if (proof.secret_policy?.artifact_contains_redacted_text_only !== true) {
    block("channel_live_proof_secret_policy_not_redacted", "artifact_contains_redacted_text_only");
  }
  if (!String(proof.remaining_requirement || "").includes("UI/device consumption evidence")) {
    block("channel_live_proof_missing_ui_device_boundary", "remaining_requirement");
  }
}

const capturedAt = typeof proof?.generated_at_utc === "string" && proof.generated_at_utc.trim()
  ? proof.generated_at_utc.trim()
  : new Date(0).toISOString();
const rows = blockers.length === 0 ? [{
  surface: "channel",
  event: "same_mission_projection_visible",
  mission_id: missionId,
  evidence_ref: channelCapture,
  truth_label: "derived_from_redacted_channel_live_proof_not_final_ui_device_proof",
  source: "mission_spine_channel_live_proof",
  captured_at: capturedAt,
}] : [];

if (blockers.length === 0 && outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const output = {
  truth: "channel_proof_events_not_ui_device_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  channelLiveProof: channelLiveProof || null,
  channelCapture: channelCapture || null,
  out: outPath ? abs(outPath) : null,
  outputRows: rows.length,
  emittedEvents: rows.map((row) => `${row.surface}:${row.event}`),
  blockers,
  caveat: "Conservative channel event bridge only. It does not claim replay proof, timeline proof, mobile/desktop/channel convergence, END-BAR, or GO-LIVE.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
