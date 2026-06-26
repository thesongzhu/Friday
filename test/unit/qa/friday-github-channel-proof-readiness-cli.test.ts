import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = "scripts/ops/check-friday-github-channel-proof-readiness.mjs";

function writeJson(root: string, name: string, value: unknown) {
  const path = join(root, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
}

function writeReadyFixtures(root: string, options: { liveArtifact?: boolean; latestFailure?: boolean } = {}) {
  const secrets = writeJson(root, "secrets.json", {
    secrets: [
      { name: "FRIDAY_TELEGRAM_BOT_TOKEN" },
      { name: "FRIDAY_DISCORD_BOT_TOKEN" },
    ],
  });
  const variables = writeJson(root, "variables.json", {
    variables: [
      { name: "FRIDAY_TELEGRAM_ALLOWED_USER_ID", value: "6757457607" },
      { name: "FRIDAY_TELEGRAM_CHAT_ID", value: "6757457607" },
      { name: "FRIDAY_TELEGRAM_MODE", value: "polling" },
    ],
  });
  const runs = [
    {
      databaseId: 28246705231,
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "sha-readonly",
      createdAt: "2026-06-26T15:07:13Z",
      displayTitle: "Telegram Live Proof (Rust channels)",
      url: "https://example.test/runs/28246705231",
    },
  ];
  if (options.latestFailure) {
    runs.unshift({
      databaseId: 28246893952,
      status: "completed",
      conclusion: "failure",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "sha-listen-failed",
      createdAt: "2026-06-26T15:10:38Z",
      displayTitle: "Telegram Live Proof (Rust channels)",
      url: "https://example.test/runs/28246893952",
    });
  }
  if (options.liveArtifact) {
    runs.push({
      databaseId: 26923313714,
      status: "completed",
      conclusion: "success",
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: "sha-live",
      createdAt: "2026-06-04T01:03:41Z",
      displayTitle: "Telegram Live Proof (Rust channels)",
      url: "https://example.test/runs/26923313714",
    });
  }
  const runsPath = writeJson(root, "runs.json", runs);
  const artifacts = writeJson(root, "artifacts.json", options.liveArtifact
    ? {
        "26923313714": [
          {
            id: 7400495110,
            name: "telegram-live-proof-26923313714",
            expired: false,
            size_in_bytes: 469,
          },
        ],
      }
    : {});
  return { secrets, variables, runs: runsPath, artifacts };
}

function runChecker(root: string, fixtures: ReturnType<typeof writeReadyFixtures>, extraArgs: string[] = []) {
  const out = join(root, "report.json");
  const stdout = execFileSync("node", [
    script,
    `--secrets-json=${fixtures.secrets}`,
    `--variables-json=${fixtures.variables}`,
    `--runs-json=${fixtures.runs}`,
    `--artifacts-json=${fixtures.artifacts}`,
    `--out=${out}`,
    ...extraArgs,
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return {
    stdout: JSON.parse(stdout),
    out: JSON.parse(readFileSync(out, "utf8")),
  };
}

describe("check-friday-github-channel-proof-readiness", () => {
  it("reports live artifact metadata without exposing secret values or claiming wrapper validation", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-github-channel-ready-"));
    const fixtures = writeReadyFixtures(root, { liveArtifact: true });
    const { out } = runChecker(root, fixtures, ["--require-live-artifact-metadata"]);

    expect(out.truth).toBe("github_channel_proof_readiness_metadata_only_no_secret_values_not_endbar");
    expect(out.status).toBe("github_channel_live_artifact_metadata_available");
    expect(out.credentialReadiness.status).toBe("ready");
    expect(out.credentialReadiness.requiredSecretsPresentByNameOnly).toEqual(["FRIDAY_TELEGRAM_BOT_TOKEN"]);
    expect(JSON.stringify(out)).not.toContain("bot-token");
    expect(out.liveListen.latestArtifactMetadataRun).toMatchObject({
      artifactSchemaValidated: false,
      wrapperCompatible: null,
    });
    expect(out.liveListen.latestArtifactMetadataRun.artifacts[0]).toMatchObject({
      name: "telegram-live-proof-26923313714",
      expired: false,
    });
  });

  it("keeps the state honest when credentials are ready but no live message artifact exists", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-github-channel-message-"));
    const fixtures = writeReadyFixtures(root, { latestFailure: true });
    const { out } = runChecker(root, fixtures);

    expect(out.status).toBe("github_channel_credentials_ready_needs_trusted_message");
    expect(out.blockers).toContain("telegram_live_listen_artifact:not_observed");
    expect(out.liveListen.latestRun).toMatchObject({
      runId: 28246893952,
      conclusion: "failure",
    });
    expect(out.liveListen.operatorAction).toContain("send one real Telegram message");
  });

  it("fails require-live-artifact-metadata when metadata is incomplete", () => {
    const root = mkdtempSync(join(tmpdir(), "friday-github-channel-incomplete-"));
    mkdirSync(root, { recursive: true });
    const fixtures = {
      secrets: writeJson(root, "secrets.json", { secrets: [] }),
      variables: writeJson(root, "variables.json", { variables: [] }),
      runs: writeJson(root, "runs.json", []),
      artifacts: writeJson(root, "artifacts.json", {}),
    };

    let failed = false;
    try {
      runChecker(root, fixtures, ["--require-live-artifact-metadata"]);
    } catch (error) {
      failed = true;
      const stdout = JSON.parse(String((error as { stdout?: Buffer | string }).stdout ?? "{}"));
      expect(stdout.status).toBe("github_channel_readiness_incomplete");
      expect(stdout.blockers).toContain("missing_secret_name:FRIDAY_TELEGRAM_BOT_TOKEN");
      expect(stdout.blockers).toContain("telegram_readonly_probe:not_observed");
    }
    expect(failed).toBe(true);
  });
});
