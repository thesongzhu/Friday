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
    [--mobile-extra-evidence=/abs/file ...] [--desktop-extra-evidence=/abs/file ...] \\
    [--channel-extra-evidence=/abs/file ...] [--timeline-extra-evidence=/abs/file ...] \\
    [--shared-extra-evidence=/abs/file ...] \\
    [--observations-manifest=/abs/observations-manifest.json] \\
    [--events=/abs/same-run-events.jsonl ...] [--events-dir=/abs/events-dir ...] \\
    [--defer-channel-proof] [--require-ready]

Truth: this indexes already-captured files into an evidence-dir shape. It is not a
UI/device proof and never invents observations. A supplied observations manifest,
or a manifest derived from same-run events merged from real captures, is validated by
scripts/qa/check-mission-spine-ui-proof-inputs.mjs.`);
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
const deferChannelProof = args.includes("--defer-channel-proof")
  || process.env.FRIDAY_UI_DEVICE_DEFER_CHANNEL_PROOF === "1";
const missionId = arg("mission-id");
const outDir = arg("out-dir");
const manifest = arg("observations-manifest");
const eventInputs = argsAll("events");
const eventDirs = argsAll("events-dir");
const inputByRole = {
  mobile: arg("mobile"),
  desktop: arg("desktop"),
  channel: arg("channel"),
  timeline: arg("timeline"),
};
const extraInputByRole = {
  mobile: argsAll("mobile-extra-evidence"),
  desktop: argsAll("desktop-extra-evidence"),
  channel: argsAll("channel-extra-evidence"),
  timeline: argsAll("timeline-extra-evidence"),
  shared: argsAll("shared-extra-evidence"),
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
  if (role === "channel" && deferChannelProof && !path) {
    return null;
  }
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
const extraCaptures = Object.entries(extraInputByRole)
  .flatMap(([role, paths]) => paths.map((path, index) => checkInput(`${role}-extra-${index + 1}`, path)))
  .filter(Boolean);
const readyToWrite = blockers.length === 0 && outDir;

let written = [];
let writtenExtra = [];
let copiedManifest = "";
let derivedEvents = "";
let mergedEvents = "";
let reuseSummary = null;
let derivedManifestProbe = null;
let mergeProbe = null;
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
  writtenExtra = extraCaptures.map((capture) => {
    const target = join(dir, `${capture.role}${safeExt(capture.source)}`);
    copyFileSync(capture.source, target);
    return {
      ...capture,
      target,
      targetName: basename(target),
      targetSha256: sha256(target),
      truth: "copied_role_extra_evidence_file_not_proof",
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
  } else if (eventInputs.length > 0 || eventDirs.length > 0) {
    const byRole = Object.fromEntries(written.map((capture) => [capture.role, capture.target]));
    const sourceToTarget = new Map([...written, ...writtenExtra].map((capture) => [capture.source, capture.target]));
    mergedEvents = join(dir, "same-run-events.merged-source.jsonl");
    derivedEvents = join(dir, "same-run-events.normalized.jsonl");
    copiedManifest = join(dir, "observations-manifest.json");
    const mergeArgs = [
      "scripts/ops/friday-ui-device-events-merge.mjs",
      `--mission-id=${missionId}`,
      `--mobile=${inputByRole.mobile}`,
      `--desktop=${inputByRole.desktop}`,
      `--timeline=${inputByRole.timeline}`,
      `--out=${mergedEvents}`,
      "--require-ready",
      ...eventInputs.map((path) => `--events=${path}`),
      ...eventDirs.map((path) => `--events-dir=${path}`),
      ...extraCaptures.map((capture) => `--extra-evidence-ref=${capture.source}`),
    ];
    if (inputByRole.channel) {
      mergeArgs.splice(4, 0, `--channel=${inputByRole.channel}`);
    }
    const mergeResult = spawnSync(process.execPath, mergeArgs, { encoding: "utf8" });
    mergeProbe = {
      status: mergeResult.status,
      stdoutPath: join(dir, "events-merge.stdout.json"),
      stderrPath: join(dir, "events-merge.stderr.txt"),
    };
    writeFileSync(mergeProbe.stdoutPath, mergeResult.stdout || "");
    writeFileSync(mergeProbe.stderrPath, mergeResult.stderr || "");
    if (mergeResult.status !== 0) {
      copiedManifest = "";
      block("events_merge_failed", `exit_${mergeResult.status}`);
    } else if (normalizeEvents(mergedEvents, sourceToTarget, derivedEvents)) {
      const result = spawnSync(process.execPath, [
        "scripts/ops/friday-ui-device-observations-manifest.mjs",
        `--mission-id=${missionId}`,
        `--mobile=${byRole.mobile}`,
        `--desktop=${byRole.desktop}`,
        `--timeline=${byRole.timeline}`,
        `--events=${derivedEvents}`,
        `--out=${copiedManifest}`,
        ...(byRole.channel ? [`--channel=${byRole.channel}`] : []),
        ...(deferChannelProof ? ["--defer-channel-proof"] : []),
        ...writtenExtra.map((capture) => `--extra-evidence-ref=${capture.target}`),
        "--require-ready",
      ], { encoding: "utf8" });
      derivedManifestProbe = {
        status: result.status,
        stdoutPath: join(dir, "observations-manifest.stdout.json"),
        stderrPath: join(dir, "observations-manifest.stderr.txt"),
        parsed: null,
      };
      writeFileSync(derivedManifestProbe.stdoutPath, result.stdout || "");
      writeFileSync(derivedManifestProbe.stderrPath, result.stderr || "");
      try {
        derivedManifestProbe.parsed = JSON.parse(result.stdout || "{}");
      } catch {
        derivedManifestProbe.parsed = null;
      }
      if (result.status !== 0) {
        copiedManifest = "";
        block("observations_manifest_derivation_failed", `exit_${result.status}`);
        if (Array.isArray(derivedManifestProbe.parsed?.blockers)) {
          for (const blocker of derivedManifestProbe.parsed.blockers) {
            if (blocker && typeof blocker.code === "string") {
              block(`observations_manifest:${blocker.code}`, String(blocker.detail || ""));
            }
          }
        }
      }
    }
  } else {
    block("observations_manifest_missing", "supply --observations-manifest or --events from the same real capture run");
  }

  reuseSummary = {
    truth: "ui_device_capture_dir_reuse_summary_not_proof",
    evidenceDir: dir,
    captures: written.map((capture) => ({
      role: capture.role,
      path: capture.target,
      sha256: capture.targetSha256,
      bytes: statSync(capture.target).size,
      reusableAsUiDeviceEvidenceInput: true,
      countsAsProofByItself: false,
    })),
    extraCaptures: writtenExtra.map((capture) => ({
      role: capture.role,
      path: capture.target,
      sha256: capture.targetSha256,
      bytes: statSync(capture.target).size,
      reusableAsRoleScopedUiDeviceEvidenceInput: true,
      countsAsProofByItself: false,
    })),
    observationsManifest: copiedManifest
      ? {
          path: copiedManifest,
          present: true,
          reusableForPreflight: true,
          countsAsProofByItself: false,
        }
      : {
          path: null,
          present: false,
          reusableForPreflight: false,
          countsAsProofByItself: false,
        },
    mergedEvents: mergedEvents || null,
    normalizedEvents: derivedEvents || null,
    deferredInputs: deferChannelProof ? [{
      role: "channel",
      status: "deferred_by_operator",
      countsTowardUiDeviceProof: false,
      caveat: "Channel proof is deferred. This evidence dir can support non-channel evidence work but cannot satisfy strict UI/device proof or END-BAR.",
    }] : [],
    nextCommand: "scripts/ops/friday-ui-device-proof-readiness.sh --evidence-dir <dir> --require-proof",
    caveat: "Reuse summary only. The strict readiness/assembler/final gate must still bind hashes and observations before proof.",
  };

  const index = {
    truth: "ui_device_capture_dir_index_not_proof",
    status: blockers.length === 0 ? "ready_for_preflight" : "blocked",
    missionId,
    evidenceDir: dir,
    captures: written,
    extraCaptures: writtenExtra,
    observationsManifest: copiedManifest || null,
    mergedEvents: mergedEvents || null,
    normalizedEvents: derivedEvents || null,
    mergeProbe,
    derivedManifestProbe,
    reuseSummary,
    deferredInputs: reuseSummary.deferredInputs,
    blockers,
  };
  writeFileSync(join(dir, "capture-index.json"), `${JSON.stringify(index, null, 2)}\n`);
}

let preflight = null;
if (readyToWrite && copiedManifest) {
  const byRole = Object.fromEntries(written.map((capture) => [capture.role, capture.target]));
  if (deferChannelProof) {
    preflight = {
      status: null,
      skipped: true,
      reason: "channel_deferred",
      countsTowardUiDeviceProof: false,
      caveat: "Strict UI proof input preflight requires channel evidence and was intentionally not claimed.",
    };
  } else {
    const extraPreflightArgs = writtenExtra.map((capture) => {
      if (capture.role.startsWith("shared-extra-")) return `--shared-extra-evidence=${capture.target}`;
      return `--${capture.role.replace(/-extra-\d+$/, "")}-extra-evidence=${capture.target}`;
    });
    const result = spawnSync(process.execPath, [
      "scripts/qa/check-mission-spine-ui-proof-inputs.mjs",
      `--mission-id=${missionId}`,
      `--mobile=${byRole.mobile}`,
      `--desktop=${byRole.desktop}`,
      `--channel=${byRole.channel}`,
      `--timeline=${byRole.timeline}`,
      `--manifest=${copiedManifest}`,
      ...extraPreflightArgs,
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
}

const output = {
  truth: "ui_device_capture_dir_driver_not_proof",
  status: blockers.length === 0 ? "ready" : "blocked",
  missionId: missionId || null,
  evidenceDir: outDir ? abs(outDir) : null,
  captures: written,
  extraCaptures: writtenExtra,
  observationsManifest: copiedManifest || null,
  mergedEvents: mergedEvents || null,
  normalizedEvents: derivedEvents || null,
  mergeProbe,
  derivedManifestProbe,
  reuseSummary,
  preflight,
  deferredInputs: deferChannelProof ? [{
    role: "channel",
    status: "deferred_by_operator",
    countsTowardUiDeviceProof: false,
    caveat: "Channel proof is deferred. This run is not strict UI/device proof or END-BAR.",
  }] : [],
  blockers,
  next: blockers.length === 0
    ? "Run scripts/ops/friday-ui-device-proof-readiness.sh --evidence-dir <dir> --require-proof after the readiness bridge is present."
    : "Fix blockers with real same-run evidence; do not fill synthetic observations.",
};

console.log(JSON.stringify(output, null, 2));
process.exit(blockers.length === 0 || !requireReady ? 0 : 2);
