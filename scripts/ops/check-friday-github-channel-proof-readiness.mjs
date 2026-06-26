#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const args = process.argv.slice(2);

function usage() {
  console.error(`usage:
  node scripts/ops/check-friday-github-channel-proof-readiness.mjs [--repo=owner/name]
    [--environment=phase-24-live-channels]
    [--workflow=telegram-live-proof.yml]
    [--secrets-json=/abs/secrets.json]
    [--variables-json=/abs/variables.json]
    [--runs-json=/abs/runs.json]
    [--artifacts-json=/abs/artifacts.json]
    [--out=/abs/report.json]
    [--require-live-artifact-metadata]

Truth:
  This check reads GitHub secret names, variable metadata, workflow run metadata,
  and artifact metadata only. It never reads secret values and never claims
  END-BAR or same-mission UI/device proof.`);
}

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
}

if (args.includes("--help") || args.includes("-h")) {
  usage();
  process.exit(0);
}

const repo = arg("repo", "thesongzhu/Friday");
const environment = arg("environment", "phase-24-live-channels");
const workflow = arg("workflow", "telegram-live-proof.yml");
const out = arg("out");
const requireLiveArtifactMetadata = args.includes("--require-live-artifact-metadata") || args.includes("--require-live-proof");

function abs(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function readJson(path) {
  return JSON.parse(readFileSync(abs(path), "utf8"));
}

function ghJson(commandArgs) {
  const stdout = execFileSync("gh", commandArgs, { encoding: "utf8" });
  return JSON.parse(stdout);
}

function ghLines(commandArgs) {
  const stdout = execFileSync("gh", commandArgs, { encoding: "utf8" });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function namesFromSecretFixture(value) {
  if (Array.isArray(value)) return value.map((entry) => typeof entry === "string" ? entry : entry?.name).filter(Boolean);
  if (Array.isArray(value?.secrets)) return value.secrets.map((entry) => entry?.name).filter(Boolean);
  return [];
}

function variablesFromFixture(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => typeof entry === "string" ? { name: entry, value: "" } : entry)
      .filter((entry) => entry?.name);
  }
  if (Array.isArray(value?.variables)) return value.variables.filter((entry) => entry?.name);
  return [];
}

function loadSecretNames() {
  const fixture = arg("secrets-json");
  if (fixture) return namesFromSecretFixture(readJson(fixture));
  return ghLines(["secret", "list", "--env", environment, "--repo", repo])
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
}

function loadVariables() {
  const fixture = arg("variables-json");
  if (fixture) return variablesFromFixture(readJson(fixture));
  return ghLines(["variable", "list", "--env", environment, "--repo", repo])
    .map((line) => {
      const [name, value = ""] = line.split(/\t/);
      return { name, value };
    })
    .filter((entry) => entry.name);
}

function loadRuns() {
  const fixture = arg("runs-json");
  if (fixture) {
    const value = readJson(fixture);
    return Array.isArray(value) ? value : value.runs || [];
  }
  return ghJson([
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    workflow,
    "--limit",
    "20",
    "--json",
    "databaseId,status,conclusion,event,headBranch,headSha,createdAt,displayTitle,url",
  ]);
}

function loadArtifactsByRun() {
  const fixture = arg("artifacts-json");
  if (fixture) return readJson(fixture);
  const artifactsByRun = {};
  for (const run of runs) {
    if (!run.databaseId) continue;
    try {
      const result = ghJson(["api", `repos/${repo}/actions/runs/${run.databaseId}/artifacts`]);
      artifactsByRun[String(run.databaseId)] = result.artifacts || [];
    } catch {
      artifactsByRun[String(run.databaseId)] = [];
    }
  }
  return artifactsByRun;
}

function hasName(collection, name) {
  return collection.includes(name);
}

function variableValue(variables, name) {
  const found = variables.find((entry) => entry.name === name);
  return typeof found?.value === "string" ? found.value : "";
}

function sortedRuns(collection) {
  return [...collection].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
}

const secretNames = loadSecretNames();
const variables = loadVariables();
const runs = loadRuns();
const artifactsByRun = loadArtifactsByRun();

const requiredSecrets = ["FRIDAY_TELEGRAM_BOT_TOKEN"];
const requiredVariables = ["FRIDAY_TELEGRAM_ALLOWED_USER_ID", "FRIDAY_TELEGRAM_CHAT_ID", "FRIDAY_TELEGRAM_MODE"];
const missingSecrets = requiredSecrets.filter((name) => !hasName(secretNames, name));
const missingVariables = requiredVariables.filter((name) => !variables.some((entry) => entry.name === name && String(entry.value || "").trim()));
const envReady = missingSecrets.length === 0 && missingVariables.length === 0;

const readonlyRuns = sortedRuns(runs.filter((run) => run.event === "workflow_dispatch" && run.conclusion === "success"));
const latestReadonly = readonlyRuns[0] || null;
const listenRuns = sortedRuns(runs.filter((run) => run.event === "workflow_dispatch" && run.displayTitle === "Telegram Live Proof (Rust channels)"));
const latestListen = listenRuns[0] || null;
const successfulLiveRuns = sortedRuns(runs.filter((run) => {
  if (run.event !== "workflow_dispatch" || run.conclusion !== "success") return false;
  const artifacts = artifactsByRun[String(run.databaseId)] || [];
  return artifacts.some((artifact) => String(artifact.name || "").startsWith("telegram-live-proof-") && artifact.expired !== true);
}));
const latestLiveArtifactMetadataRun = successfulLiveRuns[0] || null;
const latestLiveArtifacts = latestLiveArtifactMetadataRun ? artifactsByRun[String(latestLiveArtifactMetadataRun.databaseId)] || [] : [];

const telegramMode = variableValue(variables, "FRIDAY_TELEGRAM_MODE");
const blockers = [];
const notes = [];

if (!envReady) {
  for (const name of missingSecrets) blockers.push(`missing_secret_name:${name}`);
  for (const name of missingVariables) blockers.push(`missing_variable:${name}`);
}
if (!latestReadonly) {
  blockers.push("telegram_readonly_probe:not_observed");
} else {
  notes.push(`telegram_readonly_probe:success:${latestReadonly.databaseId}`);
}
if (!latestLiveArtifactMetadataRun) {
  blockers.push("telegram_live_listen_artifact:not_observed");
}
if (telegramMode && telegramMode !== "polling") {
  blockers.push(`telegram_mode:not_polling:${telegramMode}`);
}

const liveArtifactMetadataReady = envReady && latestLiveArtifactMetadataRun !== null;
const status = liveArtifactMetadataReady
  ? "github_channel_live_artifact_metadata_available"
  : envReady && latestReadonly
    ? "github_channel_credentials_ready_needs_trusted_message"
    : "github_channel_readiness_incomplete";

const report = {
  truth: "github_channel_proof_readiness_metadata_only_no_secret_values_not_endbar",
  status,
  repo,
  environment,
  workflow,
  credentialReadiness: {
    status: envReady ? "ready" : "incomplete",
    requiredSecretsPresentByNameOnly: requiredSecrets.filter((name) => hasName(secretNames, name)),
    requiredVariablesPresent: requiredVariables.filter((name) => !missingVariables.includes(name)),
    missingSecretsByNameOnly: missingSecrets,
    missingVariables,
    telegramMode: telegramMode || null,
  },
  readonlyProbe: latestReadonly
    ? {
        status: "success",
        runId: latestReadonly.databaseId,
        createdAt: latestReadonly.createdAt,
        url: latestReadonly.url,
      }
    : { status: "missing" },
  liveListen: {
    latestRun: latestListen
      ? {
          runId: latestListen.databaseId,
          status: latestListen.status,
          conclusion: latestListen.conclusion || null,
          createdAt: latestListen.createdAt,
          url: latestListen.url,
        }
      : null,
    latestArtifactMetadataRun: latestLiveArtifactMetadataRun
      ? {
          runId: latestLiveArtifactMetadataRun.databaseId,
          headSha: latestLiveArtifactMetadataRun.headSha,
          createdAt: latestLiveArtifactMetadataRun.createdAt,
          url: latestLiveArtifactMetadataRun.url,
          artifactSchemaValidated: false,
          wrapperCompatible: null,
          artifacts: latestLiveArtifacts
            .filter((artifact) => String(artifact.name || "").startsWith("telegram-live-proof-"))
            .map((artifact) => ({
              id: artifact.id,
              name: artifact.name,
              expired: artifact.expired,
              sizeInBytes: artifact.size_in_bytes ?? artifact.sizeInBytes ?? null,
            })),
        }
      : null,
    nextCommand: `gh workflow run ${workflow} --repo ${repo} -r main -f mode=listen`,
    operatorAction: "send one real Telegram message to the configured bot during the listen window",
  },
  blockers,
  notes,
  caveat: "This is GitHub metadata readiness. A historical artifact is supporting channel evidence only unless separately schema-validated against the current wrapper; END-BAR still requires same-mission mobile, desktop, channel, timeline, provider, stress, and negative-control evidence.",
};

if (out) {
  const resolved = abs(out);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
process.exit(requireLiveArtifactMetadata && !liveArtifactMetadataReady ? 2 : 0);
