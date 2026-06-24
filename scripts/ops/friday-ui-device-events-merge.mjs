#!/usr/bin/env node

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-events-merge.mjs \\
    --mission-id=mission_... \\
    --events=/abs/events-a.jsonl [--events=/abs/events-b.jsonl ...] \\
    [--events-dir=/abs/dir] \\
    [--mobile=/abs/mobile-capture] [--desktop=/abs/desktop-capture] \\
    [--channel=/abs/channel-capture] [--timeline=/abs/timeline-capture] \\
    --out=/abs/same-run-events.jsonl [--require-ready]

Truth: this merges already-captured same-run UI/device event rows. It validates
mission_id and known evidence_ref values when evidence files are supplied. It
does not invent observations, does not derive cross-surface proof rows, and is
not a UI/device proof.`);
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

const requireReady = args.includes("--require-ready");
const missionId = arg("mission-id");
const outPath = arg("out");
const eventInputs = argsAll("events");
const eventDirs = argsAll("events-dir");
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

function readableFile(label, path) {
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

function collectEventsDir(dir) {
  const resolved = abs(dir);
  try {
    const stats = statSync(resolved);
    if (!stats.isDirectory()) {
      block("events_dir_not_directory", resolved);
      return [];
    }
    return readdirSync(resolved)
      .filter((name) => extname(name).toLowerCase() === ".jsonl")
      .sort()
      .map((name) => join(resolved, name));
  } catch {
    block("events_dir_unreadable", resolved);
    return [];
  }
}

function parseJsonl(path) {
  const resolved = readableFile("events", path);
  if (!resolved) return [];
  try {
    return readFileSync(resolved, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, index) => {
        try {
          return { source: resolved, line: index + 1, row: JSON.parse(line) };
        } catch {
          block("invalid_jsonl", `${resolved}:${index + 1}`);
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    block("events_unreadable", resolved);
    return [];
  }
}

function normalizedEntry(entry, knownEvidenceRefs) {
  const label = `${entry.source}:${entry.line}`;
  const raw = entry.row && typeof entry.row === "object" && !Array.isArray(entry.row) ? entry.row : {};
  const surface = typeof raw.surface === "string" ? raw.surface.trim() : "";
  const event = typeof raw.event === "string" ? raw.event.trim() : "";
  const eventMissionId = typeof raw.mission_id === "string" ? raw.mission_id.trim() : "";
  const evidenceRef = typeof raw.evidence_ref === "string" ? raw.evidence_ref.trim() : "";
  if (!surface) block("event_missing_surface", label);
  if (!event) block("event_missing_event", label);
  if (!eventMissionId) block("event_missing_mission_id", label);
  if (eventMissionId && eventMissionId !== missionId) block("event_mission_mismatch", `${label}:${eventMissionId}`);
  if (!evidenceRef) block("event_missing_evidence_ref", label);
  if (knownEvidenceRefs.size > 0 && evidenceRef && !knownEvidenceRefs.has(evidenceRef)) {
    block("event_evidence_ref_unknown", `${label}:${evidenceRef}`);
  }
  return {
    surface,
    event,
    mission_id: eventMissionId,
    evidence_ref: evidenceRef,
  };
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outPath) block("missing_arg", "out");

const eventFiles = [
  ...eventInputs,
  ...eventDirs.flatMap(collectEventsDir),
].map((path) => abs(path));
if (eventFiles.length === 0) block("missing_events", "supply --events or --events-dir");

const knownEvidenceRefs = new Set(
  Object.entries(evidenceArgs)
    .map(([role, path]) => readableFile(role, path))
    .filter(Boolean),
);

const rows = eventFiles.flatMap(parseJsonl).map((entry) => normalizedEntry(entry, knownEvidenceRefs));
const uniqueRows = [];
const seen = new Set();
const repeatableEvents = new Set([
  "pressure_20_50_consecutive_asks_visible",
]);
for (const row of rows) {
  const key = JSON.stringify(row);
  if (repeatableEvents.has(row.event)) {
    uniqueRows.push(row);
    continue;
  }
  if (seen.has(key)) continue;
  seen.add(key);
  uniqueRows.push(row);
}

if (uniqueRows.length === 0 && blockers.length === 0) block("no_events_observed", "event inputs produced no rows");

if (blockers.length === 0 && outPath) {
  const out = abs(outPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${uniqueRows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

const output = {
  truth: "ui_device_events_merge_not_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  inputs: eventFiles,
  out: outPath ? abs(outPath) : null,
  inputRows: rows.length,
  outputRows: uniqueRows.length,
  deduplicatedRows: Math.max(0, rows.length - uniqueRows.length),
  knownEvidenceRefs: [...knownEvidenceRefs].sort(),
  blockers,
  caveat: "Merge only. Missing observations must still be captured from real same-run UI/device evidence before proof assembly.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
