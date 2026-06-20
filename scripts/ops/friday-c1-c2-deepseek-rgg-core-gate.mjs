#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { REAL_GREEN_GATE_RESULT_FILENAME } from "./lib/real-green-gate-result.mjs";

const DEFAULT_BLOCKED_REASON = "external channel prerequisite is not ready: unknown";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..", "..");

function envEnabled(env, name) {
  return ["1", "true", "yes", "on"].includes((env[name] ?? "").trim().toLowerCase());
}

function parseArgs(argv) {
  const options = {
    repoRoot: DEFAULT_REPO_ROOT,
    reportRoot: process.env.FRIDAY_C1_C2_DEEPSEEK_RGG_REPORT_ROOT?.trim()
      || path.join(os.tmpdir(), `friday-c1-c2-deepseek-rgg-core-${String(Date.now())}`),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--repo-root":
        options.repoRoot = path.resolve(next);
        index += 1;
        break;
      case "--report-root":
        options.reportRoot = path.resolve(next);
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readTextIfPresent(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

export async function evaluateDeepSeekRggCoreResult(reportRoot) {
  const resultPath = path.join(reportRoot, REAL_GREEN_GATE_RESULT_FILENAME);
  const phaseStatusPath = path.join(reportRoot, "phase-status.json");
  const runtimeMetaPath = path.join(reportRoot, "self-hosted-runtime-meta.txt");
  const result = await readJson(resultPath);
  const phaseStatus = await readJson(phaseStatusPath).catch(() => ({}));
  const runtimeMeta = await readTextIfPresent(runtimeMetaPath);
  const blockedReasons = arrayOfStrings(result.blocked_reasons);
  const onlyExternalChannelPrereqBlocked = blockedReasons.length === 1
    && blockedReasons[0] === DEFAULT_BLOCKED_REASON;
  const noBlockedReasons = blockedReasons.length === 0;
  const scenariosRun = Number(result.scenarios_run ?? 0);
  const scenariosTotal = Number(result.scenarios_total ?? 0);
  const scenariosPassed = Number(result.scenarios_passed ?? -1);
  const allScenariosPassed = scenariosRun > 0
    && scenariosRun === scenariosTotal
    && scenariosPassed === scenariosTotal;
  const deepseekRoutingConfigured = /^deepseekRoutingConfigured=true$/m.test(runtimeMeta);
  const singleProviderDefaultOnly = result.provider_lane_scope?.scope === "single_provider_default_only";
  const externalChannelsSkipped = phaseStatus.phases?.externalChannels?.status === "skipped";
  const externalChannelReason = phaseStatus.phases?.externalChannels?.reason ?? null;

  const ok = allScenariosPassed
    && deepseekRoutingConfigured
    && singleProviderDefaultOnly
    && (
      result.status === "passed"
      || (result.status === "failed" && onlyExternalChannelPrereqBlocked && externalChannelsSkipped)
    )
    && (noBlockedReasons || onlyExternalChannelPrereqBlocked);

  const failures = [];
  if (!allScenariosPassed) failures.push("RGG scenarios did not all pass");
  if (!deepseekRoutingConfigured) failures.push("DeepSeek routing was not configured");
  if (!singleProviderDefaultOnly) failures.push("RGG did not prove the single-provider DeepSeek default lane");
  if (!(noBlockedReasons || onlyExternalChannelPrereqBlocked)) {
    failures.push(`unexpected blocked reasons: ${blockedReasons.join("; ") || "<none>"}`);
  }
  if (onlyExternalChannelPrereqBlocked && !externalChannelsSkipped) {
    failures.push("external channel prerequisite was blocked but externalChannels phase was not skipped");
  }
  if (result.status !== "passed" && !(result.status === "failed" && onlyExternalChannelPrereqBlocked)) {
    failures.push(`unexpected RGG status: ${String(result.status)}`);
  }

  return {
    ok,
    reportRoot,
    resultPath,
    phaseStatusPath,
    status: ok ? "passed" : "failed",
    truthLabel:
      "C1/C2 DeepSeek RGG core diagnostic; external-channel prerequisite is tracked by live-synthetic flows; strict organic=0",
    scenariosRun,
    scenariosTotal,
    scenariosPassed,
    blockedReasons,
    deepseekRoutingConfigured,
    providerLaneScope: result.provider_lane_scope?.scope ?? null,
    externalChannelsSkipped,
    externalChannelReason,
    failures,
  };
}

export function runSelfHostedRgg({ repoRoot, reportRoot, env = process.env }) {
  const scriptPath = path.join(repoRoot, "scripts", "ops", "run-real-green-gate-self-hosted.mjs");
  return spawnSync(process.execPath, [
    scriptPath,
    "--repo-root",
    repoRoot,
    "--report-root",
    reportRoot,
  ], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const evaluateOnly = envEnabled(env, "FRIDAY_C1_C2_DEEPSEEK_RGG_EVALUATE_ONLY");
  if (!evaluateOnly) {
    await fs.rm(options.reportRoot, { recursive: true, force: true });
  }
  await fs.mkdir(options.reportRoot, { recursive: true });

  if (!evaluateOnly) {
    const result = runSelfHostedRgg({ repoRoot: options.repoRoot, reportRoot: options.reportRoot, env });
    if (result.error) {
      throw result.error;
    }
  }

  const evaluation = await evaluateDeepSeekRggCoreResult(options.reportRoot);
  console.log(JSON.stringify(evaluation, null, 2));
  return evaluation.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
