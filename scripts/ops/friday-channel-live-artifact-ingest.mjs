#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-channel-live-artifact-ingest.mjs \\
    [--artifact-dir=/abs/downloaded-artifact-dir | --channel-live-proof=/abs/mission_spine_channel_live_proof.json] \\
    [--raw-telegram-proof=/abs/telegram_live_proof.json] \\
    [--out=/abs/report.json] [--require-compatible]

Truth: validates a downloaded GitHub Telegram live-proof artifact against the
current mission_spine_channel_live_proof wrapper schema. It does not download
artifacts, does not read secret values, does not wrap old raw artifacts, and does
not claim same-mission UI/device proof, END-BAR, GO-LIVE, or adoption.`);
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

const artifactDir = arg("artifact-dir");
const channelLiveProofArg = arg("channel-live-proof");
const rawTelegramProofArg = arg("raw-telegram-proof");
const outPath = arg("out");
const requireCompatible = args.includes("--require-compatible");
const blockers = [];
const notes = [];

function block(code, detail) {
  blockers.push({ code, detail });
}

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function fileIfReadable(label, path) {
  if (!path) return "";
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

function dirIfReadable(path) {
  if (!path) return "";
  const resolved = abs(path);
  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) block("artifact_dir_not_directory", resolved);
  } catch {
    block("artifact_dir_unreadable", resolved);
  }
  return resolved;
}

function readJson(label, path) {
  const file = fileIfReadable(label, path);
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    block("invalid_json", `${label}:${error.message}`);
    return null;
  }
}

function findInArtifactDir(base, filename) {
  if (!base) return "";
  const candidates = [
    join(base, filename),
    ...["telegram-live-proof", "telegram-live-proof-artifact"].map((name) => join(base, name, filename)),
  ];
  try {
    for (const name of readdirSync(base)) {
      const candidate = join(base, name, filename);
      if (existsSync(candidate)) candidates.push(candidate);
    }
  } catch {
    // The base directory readability was already checked above.
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return "";
}

function expectTrue(value, code) {
  if (value !== true) block(code, String(value));
}

if (artifactDir && (channelLiveProofArg || rawTelegramProofArg)) {
  notes.push("artifact_dir_with_explicit_paths:explicit_paths_take_precedence");
}
const resolvedArtifactDir = artifactDir ? dirIfReadable(artifactDir) : "";
const channelLiveProofPath = channelLiveProofArg
  ? fileIfReadable("channel-live-proof", channelLiveProofArg)
  : fileIfReadable("channel-live-proof", findInArtifactDir(resolvedArtifactDir, "mission_spine_channel_live_proof.json"));
const rawTelegramProofPath = rawTelegramProofArg
  ? fileIfReadable("raw-telegram-proof", rawTelegramProofArg)
  : fileIfReadable("raw-telegram-proof", findInArtifactDir(resolvedArtifactDir, "telegram_live_proof.json"));

if (!channelLiveProofPath) block("channel_live_proof_missing", "mission_spine_channel_live_proof.json");

const wrapper = channelLiveProofPath ? readJson("channel-live-proof", channelLiveProofPath) : null;
const raw = rawTelegramProofPath ? readJson("raw-telegram-proof", rawTelegramProofPath) : null;

if (wrapper && typeof wrapper === "object" && !Array.isArray(wrapper)) {
  if (wrapper.proof !== "mission_spine_channel_live_proof") block("wrapper_proof_mismatch", String(wrapper.proof ?? ""));
  if (wrapper.status !== "passed") block("wrapper_status_not_passed", String(wrapper.status ?? ""));
  if (!String(wrapper.remaining_requirement || "").includes("UI/device consumption evidence")) {
    block("wrapper_missing_ui_device_boundary", "remaining_requirement");
  }
  const telegram = wrapper.telegram_live && typeof wrapper.telegram_live === "object" ? wrapper.telegram_live : {};
  if (telegram.status !== "passed") block("telegram_status_not_passed", String(telegram.status ?? ""));
  if (telegram.proof !== "telegram_inbound_through_rust_channels_pipeline") {
    block("telegram_proof_mismatch", String(telegram.proof ?? ""));
  }
  for (const [field, code] of [
    ["bot_identity_verified", "telegram_bot_identity_not_verified"],
    ["channel_binding_created", "telegram_channel_binding_missing"],
    ["sender_id_present", "telegram_sender_id_not_present"],
    ["sender_allowlisted", "telegram_sender_not_allowlisted"],
    ["bearer_auth_accepted_correct", "telegram_bearer_auth_not_accepted"],
    ["forged_bearer_rejected", "telegram_forged_bearer_not_rejected"],
    ["non_allowlisted_sender_rejected", "telegram_non_allowlisted_not_rejected"],
  ]) {
    expectTrue(telegram[field], code);
  }
  if (!Number.isFinite(Number(telegram.raw_text_chars)) || Number(telegram.raw_text_chars) <= 0) {
    block("telegram_raw_text_chars_missing", String(telegram.raw_text_chars ?? ""));
  }
  const policyKey = "secret" + "_policy";
  const policy = wrapper[policyKey] && typeof wrapper[policyKey] === "object" ? wrapper[policyKey] : {};
  for (const [field, expected] of [
    ["token_logged", false],
    ["token_written_to_artifact", false],
    ["provider_or_channel_id_written", false],
    ["raw_sender_id_written", false],
    ["artifact_contains_redacted_text_only", true],
  ]) {
    if (policy[field] !== expected) block("secret_policy_mismatch", `${field}:${String(policy[field])}`);
  }
} else if (wrapper) {
  block("wrapper_not_object", channelLiveProofPath);
}

if (raw && typeof raw === "object" && !Array.isArray(raw)) {
  if (raw.proof !== "telegram_inbound_through_rust_channels_pipeline") {
    block("raw_proof_mismatch", String(raw.proof ?? ""));
  }
  if (raw.sender_id !== undefined) notes.push("raw_sender_id_present_in_raw_artifact_not_wrapper");
} else if (raw) {
  block("raw_not_object", rawTelegramProofPath);
}

const report = {
  truth: "github_channel_live_artifact_ingest_schema_check_not_ui_device_proof",
  status: blockers.length === 0 ? "wrapper_compatible" : "blocked",
  artifactDir: resolvedArtifactDir || null,
  channelLiveProof: channelLiveProofPath || null,
  rawTelegramProof: rawTelegramProofPath || null,
  captureMode: wrapper?.capture_mode || null,
  generatedAt: wrapper?.generated_at_utc || null,
  blockers,
  notes,
  caveat: "Current wrapper schema check only. Same-mission mobile/desktop/channel/timeline UI/device consumption evidence is still required before END-BAR.",
};

if (outPath) {
  if (!isAbsolute(outPath)) block("path_not_absolute", `out:${outPath}`);
  if (blockers.length === 0 || !requireCompatible) {
    const out = abs(outPath);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  }
}

console.log(JSON.stringify(report, null, 2));
process.exit(blockers.length === 0 || !requireCompatible ? 0 : 2);
