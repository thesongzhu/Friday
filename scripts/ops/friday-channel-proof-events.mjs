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

Truth: converts a redacted channel live proof artifact into conservative
same-run UI/device event rows. It accepts the mission-spine Telegram wrapper
and Phase24 trusted-inbound channel artifacts that already passed their own
live listener. It does not synthesize replay, timeline,
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

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" ? value : "";
}

function validateMissionSpineWrapper(proof) {
  const failures = [];
  if (proof.proof !== "mission_spine_channel_live_proof") failures.push("channel_live_proof_mismatch");
  if (proof.status !== "passed") failures.push("channel_live_proof_not_passed");
  if (proof.secret_policy?.artifact_contains_redacted_text_only !== true) {
    failures.push("channel_live_proof_secret_policy_not_redacted");
  }
  const telegram = isObject(proof.telegram_live) ? proof.telegram_live : {};
  const forgedRejected = telegram.forged_bearer_rejected === true || proof.forged_bearer_rejected === true;
  const nonAllowlistedRejected = telegram.non_allowlisted_sender_rejected === true || proof.non_allowlisted_sender_rejected === true;
  if (!forgedRejected || !nonAllowlistedRejected) {
    failures.push("channel_live_proof_replay_controls_missing");
  }
  if (!String(proof.remaining_requirement || "").includes("UI/device consumption evidence")) {
    failures.push("channel_live_proof_missing_ui_device_boundary");
  }
  return {
    source: "mission_spine_channel_live_proof",
    capturedAt: stringValue(proof.generated_at_utc),
    truthLabel: "derived_from_redacted_channel_live_proof_not_final_ui_device_proof",
    canEmitReplayBlocked: failures.length === 0,
    failures,
  };
}

function phase24ObservedEventKey(schemaVersion) {
  if (schemaVersion === "friday.phase24b.discord_trusted_inbound_proof.v1") return "observedDiscordEvent";
  if (schemaVersion === "friday.phase24c.telegram_trusted_inbound_proof.v1") return "observedTelegramEvent";
  if (schemaVersion === "friday.phase24d.lark_feishu_trusted_inbound_proof.v1") return "observedLarkFeishuEvent";
  return "";
}

function validatePhase24TrustedInbound(proof) {
  const failures = [];
  const observedEventKey = phase24ObservedEventKey(proof.schemaVersion);
  if (!observedEventKey) failures.push("phase24_channel_schema_unsupported");
  if (proof.status !== "passed") failures.push("phase24_channel_status_not_passed");
  if (!Array.isArray(proof.failures) || proof.failures.length !== 0) failures.push("phase24_channel_failures_present");
  if (proof.criteria?.artifactHasNoToken !== true) failures.push("phase24_channel_artifact_token_check_missing");
  if (proof.criteria?.channelBoundaryConsumable !== true) failures.push("phase24_channel_boundary_not_consumable");
  if (proof.criteria?.channelBoundaryNoLiveClaim !== true) failures.push("phase24_channel_boundary_live_claim_missing");
  if (proof.criteria?.fullEvidenceSurfaceExported !== true) failures.push("phase24_channel_evidence_surface_not_exported");
  if (observedEventKey && !isObject(proof[observedEventKey])) failures.push(`phase24_channel_observed_event_missing:${observedEventKey}`);
  if (!isObject(proof.evidenceSurface)) failures.push("phase24_channel_evidence_surface_missing");
  return {
    source: proof.schemaVersion || "phase24_channel_trusted_inbound",
    capturedAt: stringValue(proof.completedAt || proof.startedAt),
    truthLabel: "derived_from_phase24_trusted_inbound_channel_proof_not_final_ui_device_proof",
    canEmitReplayBlocked: false,
    failures,
  };
}

function validateChannelProof(proof) {
  if (!isObject(proof)) {
    return {
      source: "unknown_channel_proof",
      capturedAt: "",
      truthLabel: "invalid_channel_proof_not_ui_device_proof",
      canEmitReplayBlocked: false,
      failures: ["channel_live_proof_not_object"],
    };
  }
  if (proof.proof === "mission_spine_channel_live_proof") return validateMissionSpineWrapper(proof);
  if (phase24ObservedEventKey(proof.schemaVersion)) return validatePhase24TrustedInbound(proof);
  return {
    source: stringValue(proof.schemaVersion || proof.proof || "unknown_channel_proof"),
    capturedAt: "",
    truthLabel: "unsupported_channel_proof_not_ui_device_proof",
    canEmitReplayBlocked: false,
    failures: ["channel_live_proof_unsupported_schema"],
  };
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outPath) block("missing_arg", "out");

const channelLiveProof = requireFile("channel-live-proof", channelLiveProofPath);
const channelCapture = requireFile("channel-capture", channelCapturePath);
const proof = readJson(channelLiveProof, "channel-live-proof");
const proofDecision = validateChannelProof(proof);

for (const failure of proofDecision.failures) {
  const [code, detail = ""] = failure.split(":");
  block(code, detail);
}

const capturedAt = proofDecision.capturedAt.trim()
  ? proofDecision.capturedAt.trim()
  : new Date(0).toISOString();
const rows = blockers.length === 0 ? [{
  surface: "channel",
  event: "same_mission_projection_visible",
  mission_id: missionId,
  evidence_ref: channelCapture,
  truth_label: proofDecision.truthLabel,
  source: proofDecision.source,
  captured_at: capturedAt,
}] : [];
if (blockers.length === 0 && proofDecision.canEmitReplayBlocked) {
  rows.push(
  {
    surface: "channel",
    event: "channel_replay_blocked_visible",
    mission_id: missionId,
    evidence_ref: channelCapture,
    truth_label: "derived_from_redacted_channel_live_proof_negative_controls_not_final_ui_device_proof",
    source: proofDecision.source,
    captured_at: capturedAt,
  });
}

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
  caveat: "Conservative channel event bridge only. Replay-blocked visibility is emitted only when the channel proof includes replay controls. Phase24 trusted-inbound artifacts prove user-origin channel consumption but do not emit replay-blocked visibility unless their own proof includes replay controls; this does not claim timeline proof, mobile/desktop/channel convergence, END-BAR, or GO-LIVE.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
