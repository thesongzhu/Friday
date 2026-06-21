#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  TIER1_PARITY_FLOW_SPECS,
  artifactPathFor,
} from "./friday-c1-c2-tier1-parity-capture.mjs";

const RUNNER_TRUTH_LABEL =
  "parity-capture artifact from existing routed harness output; live parity not claimed; strict organic=0";

function envEnabled(env, name) {
  return ["1", "true", "yes", "on"].includes((env[name] ?? "").trim().toLowerCase());
}

function readConfig(env = process.env) {
  return {
    enabled: envEnabled(env, "FRIDAY_C1_C2_TIER1_ARTIFACT_RUN"),
    allowCustomCommand: envEnabled(env, "FRIDAY_C1_C2_TIER1_ALLOW_CUSTOM_COMMAND"),
    artifactRoot: env.FRIDAY_C1_C2_TIER1_CAPTURE_ROOT?.trim() ?? "",
    flowId: env.FRIDAY_C1_C2_TIER1_FLOW_ID?.trim() ?? "",
    commandJson: env.FRIDAY_C1_C2_TIER1_FLOW_COMMAND_JSON?.trim() ?? "",
    repoRoot: env.FRIDAY_REPO_ROOT?.trim() || process.cwd(),
  };
}

function findFlow(flowId) {
  return TIER1_PARITY_FLOW_SPECS.find((flow) => flow.flowId === flowId) ?? null;
}

function parseCommandJson(raw) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item)) {
    throw new Error("FRIDAY_C1_C2_TIER1_FLOW_COMMAND_JSON must be a non-empty JSON string array");
  }
  return parsed;
}

function defaultCommandForFlow(repoRoot, flow) {
  const harnessPath = path.resolve(repoRoot, flow.expectedHarness);
  if (flow.expectedHarness.endsWith(".sh")) {
    return [harnessPath];
  }
  if (flow.expectedHarness.endsWith(".mjs")) {
    return [process.execPath, harnessPath];
  }
  return null;
}

function digestOutput(stdout, stderr) {
  return crypto.createHash("sha256").update(stdout).update(stderr).digest("hex");
}

function buildRecord(flow, command, commandSource, result, startedAt, completedAt) {
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  const exitCode = typeof result.status === "number" ? result.status : null;
  return {
    flowId: flow.flowId,
    order: flow.order,
    lane: flow.lane,
    source: flow.source,
    status: exitCode === 0 ? "passed" : "failed",
    builtDark: true,
    live: false,
    organic: false,
    runKind: "proof",
    truthLabel: RUNNER_TRUTH_LABEL,
    startedAt,
    completedAt,
    harness: flow.expectedHarness,
    commandSource,
    evidence: [
      {
        kind: commandSource === "default" ? "harness-exit" : "custom-command-exit",
        path: flow.expectedHarness,
        argv0: path.basename(command[0]),
        exitCode,
        signal: result.signal ?? null,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        outputSha256: digestOutput(stdout, stderr),
      },
    ],
  };
}

async function writeRecord(root, flow, record) {
  await fs.mkdir(root, { recursive: true });
  const filePath = artifactPathFor(root, flow);
  await fs.writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

export async function runOneFlow(config = readConfig()) {
  if (!config.enabled) {
    return {
      ok: true,
      status: "skipped",
      blocker: "FRIDAY_C1_C2_TIER1_ARTIFACT_RUN is not enabled",
    };
  }
  if (!config.artifactRoot) {
    return { ok: false, status: "blocked", blocker: "FRIDAY_C1_C2_TIER1_CAPTURE_ROOT is required" };
  }
  const flow = findFlow(config.flowId);
  if (!flow) {
    return { ok: false, status: "blocked", blocker: `unknown flow id: ${config.flowId || "(empty)"}` };
  }
  if (config.commandJson && !config.allowCustomCommand) {
    return {
      ok: false,
      status: "blocked",
      blocker: "custom flow commands require FRIDAY_C1_C2_TIER1_ALLOW_CUSTOM_COMMAND=1",
    };
  }

  const commandSource = config.commandJson ? "custom" : "default";
  const command = parseCommandJson(config.commandJson) ?? defaultCommandForFlow(config.repoRoot, flow);
  if (!command) {
    return { ok: false, status: "blocked", blocker: `no default command for ${flow.expectedHarness}` };
  }

  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: config.repoRoot,
    encoding: "buffer",
    env: process.env,
  });
  const completedAt = new Date().toISOString();
  const record = buildRecord(flow, command, commandSource, result, startedAt, completedAt);
  const artifactPath = await writeRecord(config.artifactRoot, flow, record);
  return {
    ok: record.status === "passed",
    status: record.status,
    artifactPath,
    flowId: flow.flowId,
    truthLabel: RUNNER_TRUTH_LABEL,
    blocker: record.status === "passed" ? null : "flow command exited non-zero",
  };
}

export async function main() {
  const result = await runOneFlow();
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
