#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import { FridayClient } from "../../validation/real-world/lib/client.mjs";
import { collectEnvironmentTruth } from "../../validation/real-world/lib/env-truth.mjs";
import { createRunId, ensureDir, writeJson, writeText } from "../../validation/real-world/lib/io.mjs";
import { runRealWorldValidation } from "../../validation/real-world/lib/runner.mjs";
import { checkBranchConformance } from "./check-branch-conformance.mjs";

const DAILY_CORE_SCENARIOS = [
  "l0-runtime-health",
  "l0-provider-lanes-ready",
  "l0-onboarding-truth-mismatch",
  "l1-chat-ui",
  "l1-assistant-ui",
  "l1-observability-ui",
  "l1-settings-ui",
  "l3-chat-direct-answer",
  "l3-summary-misroute-guard",
  "l3-long-summary-direct",
  "l3-json-extraction",
  "l3-multi-turn-memory",
  "l4-file-tool-roundtrip",
  "l5-workflow-approval-roundtrip",
];

const CLAUDE_SKILL_TESTS = [
  "test/unit/skills/registry/friday-skill-discovery.test.ts",
  "test/unit/skills/manifest/friday-skill-package-loader.test.ts",
  "test/integration/skills/friday-skill-registry-lifecycle.test.ts",
];

const CONVERGENCE_FEATURE_TESTS = [
  "test/unit/deeplink/friday-deeplink-parser.test.ts",
  "test/unit/deeplink/friday-deeplink-validator.test.ts",
  "test/unit/security/policy-extension-chain.test.ts",
  "test/unit/skills/safety/friday-shell-safety-scanner.test.ts",
];

function resolveCurrentBranch(repoRoot) {
  const envBranch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME;
  if (envBranch && envBranch.trim().length > 0) {
    return envBranch.trim();
  }
  return runCommandCapture(repoRoot, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim() || "main";
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    mintLocalAdminToken: false,
    dailyCoreRepetitions: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--repo-root":
        options.repoRoot = path.resolve(next);
        index += 1;
        break;
      case "--base-url":
        options.baseUrl = next;
        index += 1;
        break;
      case "--ui-base-url":
        options.uiBaseUrl = next;
        index += 1;
        break;
      case "--branch":
        options.branch = next;
        index += 1;
        break;
      case "--report-root":
        options.reportRoot = path.resolve(next);
        index += 1;
        break;
      case "--daily-core-repetitions":
        options.dailyCoreRepetitions = Number.parseInt(next, 10) || 1;
        index += 1;
        break;
      case "--mint-local-admin-token":
        options.mintLocalAdminToken = true;
        break;
      case "--skip-skill-tests":
        options.skipSkillTests = true;
        break;
      default:
        break;
    }
  }
  options.branch ??= resolveCurrentBranch(options.repoRoot);
  return options;
}

function parseBooleanFlag(value) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parseOptionalInteger(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function exec(repoRoot, command, args) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runCommandCapture(repoRoot, command, args) {
  const startedAt = Date.now();
  try {
    const stdout = exec(repoRoot, command, args);
    return {
      ok: true,
      command: [command, ...args].join(" "),
      durationMs: Date.now() - startedAt,
      stdout,
      stderr: "",
    };
  } catch (error) {
    return {
      ok: false,
      command: [command, ...args].join(" "),
      durationMs: Date.now() - startedAt,
      stdout: error instanceof Error && "stdout" in error ? String(error.stdout ?? "") : "",
      stderr: error instanceof Error && "stderr" in error ? String(error.stderr ?? "") : "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function renderMarkdown(summary) {
  return [
    "# Real Green Gate",
    "",
    `- Run id: ${summary.runId}`,
    `- Checked at: ${summary.generatedAt}`,
    `- Gate passed: ${String(summary.gate.passed)}`,
    `- Repo root: ${summary.repoRoot}`,
    `- Smoke report: ${summary.smoke?.reportRoot ?? "n/a"}`,
    `- Daily core report: ${summary.dailyCore?.reportRoot ?? "n/a"}`,
    `- Branch conformance: ${summary.branchConformance?.recommendation ?? "n/a"}`,
    `- Skill conformance: ${summary.skillConformance?.ok === true ? "passed" : "failed"}`,
    "",
    "## Gate Reasons",
    "",
    ...(summary.gate.reasons.length > 0 ? summary.gate.reasons.map((reason) => `- ${reason}`) : ["- none"]),
    "",
    "## Preflight",
    "",
    `- Auth ok: ${String(summary.preflight?.envTruth?.auth?.ok === true)}`,
    `- Default lane: ${summary.preflight?.envTruth?.providerLanes?.default?.model ?? "missing"}`,
    `- Fallback lane: ${summary.preflight?.envTruth?.providerLanes?.fallback?.model ?? "missing"}`,
    "",
    "## Branch",
    "",
    `- Branch: ${summary.branchConformance?.branch?.input ?? "n/a"}`,
    `- Ahead: ${String(summary.branchConformance?.ahead ?? 0)}`,
    `- Behind: ${String(summary.branchConformance?.behind ?? 0)}`,
    `- Merge ready: ${String(summary.branchConformance?.shouldMerge ?? false)}`,
    `- No-op: ${String(summary.branchConformance?.shouldNoop ?? false)}`,
    "",
  ].join("\n");
}

function buildClientOptions(options) {
  return {
    baseUrl: options.baseUrl ?? process.env.FRIDAY_BASE_URL ?? "http://127.0.0.1:3141",
    authMode: options.authMode ?? "local",
    accessToken: options.accessToken ?? process.env.FRIDAY_ACCESS_TOKEN,
    localPassphrase: options.localPassphrase ?? process.env.FRIDAY_LOCAL_PASSPHRASE,
    email: options.email ?? process.env.FRIDAY_AUTH_EMAIL,
    password: options.password ?? process.env.FRIDAY_AUTH_PASSWORD,
    mintLocalAdminToken: options.mintLocalAdminToken
      ?? parseBooleanFlag(process.env.FRIDAY_REAL_WORLD_MINT_LOCAL_ADMIN_TOKEN),
    mintStateDbPath: options.mintStateDbPath ?? process.env.FRIDAY_REAL_WORLD_MINT_STATE_DB_PATH,
    mintTokenSecret: options.mintTokenSecret ?? process.env.FRIDAY_TOKEN_SECRET,
    mintTokenSecretFile: options.mintTokenSecretFile ?? process.env.FRIDAY_REAL_WORLD_MINT_TOKEN_SECRET_FILE,
    mintUserId: options.mintUserId ?? process.env.FRIDAY_REAL_WORLD_MINT_USER_ID,
    mintUserEmail: options.mintUserEmail ?? process.env.FRIDAY_REAL_WORLD_MINT_USER_EMAIL,
    mintTenantId: options.mintTenantId ?? process.env.FRIDAY_REAL_WORLD_MINT_TENANT_ID,
    mintAccessTokenTtlSec: options.mintAccessTokenTtlSec
      ?? parseOptionalInteger(
        process.env.FRIDAY_REAL_WORLD_MINT_ACCESS_TOKEN_TTL_SEC
          ?? process.env.FRIDAY_REAL_WORLD_MINT_ACCESS_TTL_SEC,
      ),
  };
}

function summarizeRun(run) {
  return {
    runId: run.runId,
    suite: run.suite,
    reportRoot: run.reportRoot,
    resultCounts: run.resultCounts ?? run.results ?? {},
    failureClassCounts: run.failureClassCounts ?? {},
    defectBucketCounts: run.defectBucketCounts ?? {},
    providerLanes: run.providerLanes ?? {},
  };
}

function hasOnlyPassed(run) {
  const counts = run.resultCounts ?? run.results ?? {};
  return Object.entries(counts).every(([key, value]) => key === "passed" || Number(value) === 0);
}

function deriveGateReasons({ preflight, smoke, dailyCore, branchConformance, skillConformance }) {
  const reasons = [];
  if (preflight.envTruth?.auth?.ok !== true) {
    reasons.push("preflight auth is not healthy");
  }
  if (!preflight.envTruth?.providerLanes?.default || !preflight.envTruth?.providerLanes?.fallback) {
    reasons.push("provider lanes are incomplete");
  }
  if (!hasOnlyPassed(smoke)) {
    reasons.push("smoke suite is not fully passed");
  }
  if (!hasOnlyPassed(dailyCore)) {
    reasons.push("daily core suite is not fully passed");
  }
  const branchReady = branchConformance?.shouldNoop === true || branchConformance?.shouldMerge === true;
  if (!branchReady) {
    reasons.push("branch under test is neither merge-ready nor patch-equivalent to main");
  }
  if (skillConformance?.ok !== true) {
    reasons.push("skill conformance tests failed");
  }
  return reasons;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = options.repoRoot;
  const runId = createRunId();
  const reportRoot = options.reportRoot
    ?? path.join(repoRoot, "docs", "reports", "ops", "real-green-gate", runId);
  ensureDir(reportRoot);

  const gitStatus = runCommandCapture(repoRoot, "git", ["status", "--short", "--branch"]);
  const gitHead = runCommandCapture(repoRoot, "git", ["rev-parse", "HEAD"]);
  const clientOptions = buildClientOptions(options);
  const uiBaseUrl = options.uiBaseUrl ?? process.env.FRIDAY_UI_BASE_URL ?? clientOptions.baseUrl;
  const client = new FridayClient(clientOptions);
  const envTruth = await collectEnvironmentTruth({
    client,
    baseUrl: clientOptions.baseUrl,
    uiBaseUrl,
  });
  const preflight = {
    checkedAt: new Date().toISOString(),
    gitStatus,
    gitHead,
    envTruth,
  };
  writeJson(path.join(reportRoot, "preflight.json"), preflight);

  const smoke = await runRealWorldValidation({
    repoRoot,
    suite: "smoke",
    baseUrl: clientOptions.baseUrl,
    uiBaseUrl,
    authMode: clientOptions.authMode,
    accessToken: clientOptions.accessToken,
    localPassphrase: clientOptions.localPassphrase,
    email: clientOptions.email,
    password: clientOptions.password,
    mintLocalAdminToken: clientOptions.mintLocalAdminToken,
    mintStateDbPath: clientOptions.mintStateDbPath,
    mintTokenSecret: clientOptions.mintTokenSecret,
    mintTokenSecretFile: clientOptions.mintTokenSecretFile,
    mintUserId: clientOptions.mintUserId,
    mintUserEmail: clientOptions.mintUserEmail,
    mintTenantId: clientOptions.mintTenantId,
    mintAccessTokenTtlSec: clientOptions.mintAccessTokenTtlSec,
  });

  const dailyCore = await runRealWorldValidation({
    repoRoot,
    suite: "daily",
    scenarioIds: DAILY_CORE_SCENARIOS,
    repetitions: options.dailyCoreRepetitions,
    baseUrl: clientOptions.baseUrl,
    uiBaseUrl,
    authMode: clientOptions.authMode,
    accessToken: clientOptions.accessToken,
    localPassphrase: clientOptions.localPassphrase,
    email: clientOptions.email,
    password: clientOptions.password,
    mintLocalAdminToken: clientOptions.mintLocalAdminToken,
    mintStateDbPath: clientOptions.mintStateDbPath,
    mintTokenSecret: clientOptions.mintTokenSecret,
    mintTokenSecretFile: clientOptions.mintTokenSecretFile,
    mintUserId: clientOptions.mintUserId,
    mintUserEmail: clientOptions.mintUserEmail,
    mintTenantId: clientOptions.mintTenantId,
    mintAccessTokenTtlSec: clientOptions.mintAccessTokenTtlSec,
  });

  const branchReportRoot = path.join(reportRoot, "branch");
  const branchConformance = checkBranchConformance({
    repoRoot,
    base: "main",
    branch: options.branch,
    reportRoot: branchReportRoot,
  });

  const skillConformance = options.skipSkillTests
    ? {
      ok: true,
      skipped: true,
      command: null,
      stdout: "",
      stderr: "",
    }
    : runCommandCapture(repoRoot, "npx", ["vitest", "run", ...CLAUDE_SKILL_TESTS]);
  writeJson(path.join(reportRoot, "skill-conformance.json"), skillConformance);

  const summary = {
    runId,
    generatedAt: new Date().toISOString(),
    repoRoot,
    branch: options.branch,
    preflight,
    smoke: summarizeRun(smoke),
    dailyCore: summarizeRun(dailyCore),
    branchConformance,
    skillConformance,
  };
  summary.gate = {
    passed: false,
    reasons: deriveGateReasons(summary),
  };
  summary.gate.passed = summary.gate.reasons.length === 0;

  writeJson(path.join(reportRoot, "summary.json"), summary);
  writeText(path.join(reportRoot, "index.md"), renderMarkdown(summary));
  console.log(JSON.stringify({
    ...summary,
    reportRoot,
  }, null, 2));
  if (!summary.gate.passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
