#!/usr/bin/env node

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/friday-ui-device-capture-dir.mjs \\
    --mission-id=mission_... \\
    --out-dir=/abs/evidence-dir \\
    --mobile=/abs/mobile-capture \\
    --desktop=/abs/desktop-capture \\
    --channel=/abs/channel-capture \\
    --timeline=/abs/timeline-capture \\
    [--observations-manifest=/abs/observations-manifest.json] \\
    [--events=/abs/same-run-events.jsonl] [--require-ready]

Truth: this indexes already-captured files into an evidence-dir shape. It is not a
UI/device proof and never invents observations. A supplied observations manifest,
or a manifest derived from same-run events, is validated by
scripts/qa/check-mission-spine-ui-proof-inputs.mjs.`);
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
const outDir = arg("out-dir");
const manifest = arg("observations-manifest");
const events = arg("events");
const inputByRole = {
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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeExt(path) {
  const ext = extname(path).toLowerCase();
  return [".json", ".trace", ".log", ".png"].includes(ext) ? ext : ".trace";
}

function checkInput(role, path) {
  if (!path) {
    block("missing_capture", role);
    return null;
  }
  const resolved = abs(path);
  try {
    const stats = statSync(resolved);
    if (!stats.isFile()) {
      block("capture_not_file", `${role}:${resolved}`);
      return null;
    }
    if (stats.size <= 0) {
      block("capture_empty", `${role}:${resolved}`);
    }
    return { role, source: resolved, bytes: stats.size, sha256: sha256(resolved) };
  } catch {
    block("capture_unreadable", `${role}:${resolved}`);
    return null;
  }
}

function normalizeEvents(sourcePath, replacements, targetPath) {
  const source = abs(sourcePath);
  try {
    const lines = readFileSync(source, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const normalized = lines.map((line) => {
      const row = JSON.parse(line);
      if (typeof row.evidence_ref === "string" && replacements.has(row.evidence_ref)) {
        row.evidence_ref = replacements.get(row.evidence_ref);
      }
      return JSON.stringify(row);
    });
    writeFileSync(targetPath, `${normalized.join("\n")}\n`);
    return true;
  } catch {
    block("events_unreadable_or_invalid_jsonl", source);
    return false;
  }
}

if (!missionId || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(missionId) || !missionId.toLowerCase().includes("mission")) {
  block("mission_id_unexpected_shape", missionId || "<missing>");
}
if (!outDir) {
  block("missing_out_dir", "out-dir");
}

const captures = Object.entries(inputByRole).map(([role, path]) => checkInput(role, path)).filter(Boolean);
const readyToWrite = blockers.length === 0 && outDir;

let written = [];
let copiedManifest = "";
let derivedEvents = "";
if (readyToWrite) {
  const dir = abs(outDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mission-id.txt"), `${missionId}\n`);

  written = captures.map((capture) => {
    const target = join(dir, `${capture.role}${safeExt(capture.source)}`);
    copyFileSync(capture.source, target);
    return {
      ...capture,
      target,
      targetName: basename(target),
      targetSha256: sha256(target),
      truth: "copied_capture_file_not_proof",
    };
  });

  if (manifest) {
    const manifestSource = abs(manifest);
    try {
      statSync(manifestSource);
      copiedManifest = join(dir, "observations-manifest.json");
      copyFileSync(manifestSource, copiedManifest);
    } catch {
      block("observations_manifest_unreadable", manifestSource);
    }
  } else if (events) {
    const byRole = Object.fromEntries(written.map((capture) => [capture.role, capture.target]));
    const sourceToTarget = new Map(written.map((capture) => [capture.source, capture.target]));
    derivedEvents = join(dir, "same-run-events.normalized.jsonl");
    copiedManifest = join(dir, "observations-manifest.json");
    if (normalizeEvents(events, sourceToTarget, derivedEvents)) {
      const result = spawnSync(process.execPath, [
        "scripts/ops/friday-ui-device-observations-manifest.mjs",
        `--mission-id=${missionId}`,
        `--mobile=${byRole.mobile}`,
        `--desktop=${byRole.desktop}`,
        `--channel=${byRole.channel}`,
        `--timeline=${byRole.timeline}`,
        `--events=${derivedEvents}`,
        `--out=${copiedManifest}`,
        "--require-ready",
      ], { encoding: "utf8" });
      if (result.status !== 0) {
        copiedManifest = "";
        block("observations_manifest_derivation_failed", `exit_${result.status}`);
      }
    }
  } else {
    block("observations_manifest_missing", "supply --observations-manifest or --events from the same real capture run");
  }

  const index = {
    truth: "ui_device_capture_dir_index_not_proof",
    status: blockers.length === 0 ? "ready_for_preflight" : "blocked",
    missionId,
    evidenceDir: dir,
    captures: written,
    observationsManifest: copiedManifest || null,
    normalizedEvents: derivedEvents || null,
    blockers,
  };
  writeFileSync(join(dir, "capture-index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

let preflight = null;
if (readyToWrite && copiedManifest) {
  const byRole = Object.fromEntries(written.map((capture) => [capture.role, capture.target]));
  const result = spawnSync(process.execPath, [
    "scripts/qa/check-mission-spine-ui-proof-inputs.mjs",
    `--mission-id=${missionId}`,
    `--mobile=${byRole.mobile}`,
    `--desktop=${byRole.desktop}`,
    `--channel=${byRole.channel}`,
    `--timeline=${byRole.timeline}`,
    `--manifest=${copiedManifest}`,
  ], { encoding: "utf8" });
  preflight = {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
  if (result.status !== 0) {
    block("ui_proof_inputs_preflight_failed", `exit_${result.status}`);
  }
}

const output = {
  truth: "ui_device_capture_dir_driver_not_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  evidenceDir: outDir ? abs(outDir) : null,
  captures: written,
  observationsManifest: copiedManifest || null,
  normalizedEvents: derivedEvents || null,
  preflight,
  blockers,
  next: blockers.length === 0
    ? "Run scripts/ops/friday-ui-device-proof-readiness.sh --evidence-dir <dir> --require-proof after the readiness bridge is present."
    : "Fix blockers with real same-run evidence; do not fill synthetic observations.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
