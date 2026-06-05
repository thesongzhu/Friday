import path from "node:path";
import { REAL_WORLD_SCENARIOS } from "../catalog/scenarios.mjs";
import { FridayClient } from "./client.mjs";
import {
  SUITE_PROFILES,
  resolveScenarioRepetitions,
  scenarioSupportsSuite,
  slugify,
  validateCatalog,
} from "./defs.mjs";
import { collectEnvironmentTruth, resolveScenarioBlockers, resolveScenarioLanes } from "./env-truth.mjs";
import { closeSharedUiProbeSession, executeScenario } from "./executors.mjs";
import { createRunId, ensureDir, resolveValidationReportRoot, writeJson } from "./io.mjs";
import { evaluateBehavioralRubric, finalizeArtifact, runLlmJudge } from "./judge.mjs";
import { writeReports } from "./reporting.mjs";

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
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected an integer but received "${String(value)}".`);
  }
  return parsed;
}

function matchesFilter(scenario, options) {
  if (options.scenarioIds?.length && !options.scenarioIds.includes(scenario.id)) {
    return false;
  }
  if (options.excludedScenarioIds?.length && options.excludedScenarioIds.includes(scenario.id)) {
    return false;
  }
  if (options.layers?.length && !options.layers.includes(scenario.layer)) {
    return false;
  }
  if (options.tags?.length && !options.tags.some((tag) => scenario.tags?.includes(tag))) {
    return false;
  }
  if (options.excludeProviderScenarios === true && scenario.providerLane !== "none") {
    return false;
  }
  return true;
}

function getSoakConfig(scenario, suite) {
  return scenario.execution?.soak?.[suite] ?? null;
}

function shouldRunSoakForLane(lane, soakConfig) {
  if (!Array.isArray(soakConfig?.laneKeys) || soakConfig.laneKeys.length === 0) {
    return true;
  }
  return soakConfig.laneKeys.includes(lane.laneKey);
}

async function runSingleAttempt(context) {
  const artifact = await executeScenario(context);
  const rubric = evaluateBehavioralRubric({
    scenario: context.scenario,
    artifact,
  });
  const judge = await runLlmJudge({
    client: context.client,
    scenario: context.scenario,
    artifact,
    envTruth: context.envTruth,
    judgePolicy: context.judgePolicy,
  });
  return finalizeArtifact({
    scenario: context.scenario,
    artifact,
    rubric,
    judge,
  });
}

async function runSoakScenario({
  scenario,
  lane,
  soakConfig,
  baseContext,
  artifacts,
  reportRoot,
}) {
  const deadline = Date.now() + soakConfig.durationMs;
  const workers = [];
  const concurrency = Math.max(1, soakConfig.concurrency ?? 1);
  for (let workerIndex = 0; workerIndex < concurrency; workerIndex += 1) {
    workers.push((async () => {
      let attempt = 0;
      while (Date.now() < deadline) {
        attempt += 1;
        const artifact = await runSingleAttempt({
          ...baseContext,
          scenario,
          lane,
          attemptIndex: attempt,
          soakWorkerIndex: workerIndex,
        });
        artifact.raw = {
          ...(artifact.raw ?? {}),
          soakWorkerIndex: workerIndex,
          soakAttempt: attempt,
        };
        artifacts.push(artifact);
        const attemptFile = path.join(
          reportRoot,
          "attempts",
          scenario.id,
          `${slugify(`${lane.id}-worker-${workerIndex}-attempt-${attempt}`)}.json`,
        );
        writeJson(attemptFile, artifact);
      }
    })());
  }
  await Promise.all(workers);
}

export async function runRealWorldValidation(options = {}) {
  const suite = options.suite ?? "smoke";
  if (!SUITE_PROFILES[suite]) {
    throw new Error(`Unknown suite "${suite}". Expected one of: ${Object.keys(SUITE_PROFILES).join(", ")}`);
  }
  const repoRoot = options.repoRoot ?? process.cwd();
  const catalog = options.catalog ?? REAL_WORLD_SCENARIOS;
  const catalogValidation = validateCatalog(catalog);
  if (!catalogValidation.ok) {
    throw new Error(`Scenario catalog invalid:\n${catalogValidation.errors.join("\n")}`);
  }

  const scenarios = catalog
    .filter((scenario) => scenarioSupportsSuite(scenario, suite))
    .filter((scenario) => matchesFilter(scenario, options));
  if (scenarios.length === 0) {
    throw new Error("No scenarios selected.");
  }

  const runId = options.runId ?? createRunId();
  const reportRoot = options.reportRoot ?? resolveValidationReportRoot(repoRoot, runId);
  ensureDir(reportRoot);
  writeJson(path.join(reportRoot, "selected-scenarios.json"), scenarios);

  if (options.catalogOnly) {
    return {
      runId,
      suite,
      scenarioCount: scenarios.length,
      reportRoot,
      catalogOnly: true,
    };
  }

  const baseUrl = options.baseUrl ?? process.env.FRIDAY_BASE_URL ?? "http://127.0.0.1:3141";
  const uiBaseUrl = options.uiBaseUrl ?? process.env.FRIDAY_UI_BASE_URL ?? baseUrl;
  const client = new FridayClient({
    baseUrl,
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
  });
  const envTruth = await collectEnvironmentTruth({
    client,
    baseUrl,
    uiBaseUrl,
  });
  writeJson(path.join(reportRoot, "environment-truth.json"), envTruth);

  const artifacts = [];
  for (const scenario of scenarios) {
    const blockers = resolveScenarioBlockers(scenario, envTruth);
    const lanes = resolveScenarioLanes(scenario, envTruth);
    for (const lane of lanes) {
      const soakConfig = getSoakConfig(scenario, suite);
      if (soakConfig && !lane.blockedReason && blockers.length === 0) {
        if (!shouldRunSoakForLane(lane, soakConfig)) {
          continue;
        }
        await runSoakScenario({
          scenario,
          lane,
          soakConfig,
          baseContext: {
            runId,
            suite,
            client,
            envTruth,
            reportRoot,
            uiBaseUrl,
            judgePolicy: options.judgePolicy ?? SUITE_PROFILES[suite].allowJudge,
          },
          artifacts,
          reportRoot,
        });
        continue;
      }

      const repetitions = resolveScenarioRepetitions(scenario, suite, options.repetitions);
      for (let attempt = 1; attempt <= repetitions; attempt += 1) {
        const artifact = await runSingleAttempt({
          runId,
          suite,
          scenario,
          lane,
          client,
          envTruth,
          reportRoot,
          uiBaseUrl,
          blockers,
          judgePolicy: options.judgePolicy ?? SUITE_PROFILES[suite].allowJudge,
          attemptIndex: attempt,
        });
        artifact.raw = {
          ...(artifact.raw ?? {}),
          attempt,
        };
        artifacts.push(artifact);
        const attemptFile = path.join(
          reportRoot,
          "attempts",
          scenario.id,
          `${slugify(`${lane.id}-attempt-${attempt}`)}.json`,
        );
        writeJson(attemptFile, artifact);
      }
    }
  }

  try {
    const summary = writeReports({
      repoRoot,
      reportRoot,
      runId,
      suite,
      scenarios,
      artifacts,
      envTruth,
      options,
    });
    return {
      ...summary,
      reportRoot,
    };
  } finally {
    await closeSharedUiProbeSession();
  }
}
