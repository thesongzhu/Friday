import fs from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  ensureFridayDeepProofProviders,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_MODEL,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

interface SkillGeneratorSessionEnvelope {
  ok: boolean;
  data: {
    mode: string;
    session: { sessionId: string; status: string };
    draft?: {
      manifest?: { id?: string; version?: string };
      validation?: {
        ok: boolean;
        repaired?: boolean;
        repairAttempts?: number;
        issues?: Array<{ message: string }>;
      };
    };
  };
}

interface SkillGeneratorEvidenceEnvelope {
  ok: boolean;
  data: {
    evidence: {
      approvalReadiness: { ready: boolean; reason: string };
      validationSummary: {
        ok: boolean;
        repaired: boolean;
        repairAttempts: number;
        issueCount: number;
      };
      repairSummary: {
        attempted: boolean;
        attempts: number;
      };
      executableTestSummary?: {
        ok: boolean;
      } | null;
    };
  };
  error?: { code?: string; message?: string };
}

interface SkillGeneratorTestEnvelope {
  ok: boolean;
  data: {
    test: {
      ok: boolean;
      behavioralCheck?: {
        attempted: boolean;
        satisfied: boolean;
        expectedMarkers: string[];
        matchedMarkers: string[];
      };
    };
  };
}

interface SkillGeneratorApproveEnvelope {
  ok: boolean;
  data: {
    skillId: string;
    skillDir: string;
    registryRefreshed: boolean;
    promotionStage: string;
    evidence: {
      approvalReadiness: { ready: boolean; reason: string };
      validationSummary: {
        ok: boolean;
        repaired: boolean;
        repairAttempts: number;
      };
      executableTestSummary?: {
        ok: boolean;
      } | null;
    };
  };
  error?: { code?: string; message?: string };
}

interface SkillRunEnvelope {
  ok: boolean;
  data: {
    status: string;
    completionDepth: string;
    output: Record<string, unknown>;
    stdout?: string;
    stderr?: string;
    input?: Record<string, unknown>;
  };
}

interface SkillDetailEnvelope {
  ok: boolean;
  data: {
    skill: {
      skillId: string;
      installedVersion?: string;
      latestVersion?: string;
      status?: string;
    };
  };
}

interface UpgradeStatusEnvelope {
  ok: boolean;
  data: {
    items: Array<{
      kind: string;
      id: string;
      compatibilityStatus: string;
      promotionChannel: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
      recordedCompatibilityStatus: string;
      derivedCompatibilityStatus: string;
      strategy: string;
      nextStage: string;
      findings: Array<{ id: string; passed: boolean; severity: string }>;
    }>;
  };
}

interface SkillUpgradeActionEnvelope {
  ok: boolean;
  data: {
    skill: {
      skillId: string;
      installedVersion?: string;
      latestVersion?: string;
      status: string;
      promotionChannel?: string;
      compatibilityStatus?: string;
      shadowVersionId?: string;
      canaryStats?: {
        sampleSize: number;
        successCount: number;
        failureCount: number;
        rollbackCount: number;
      };
    };
    status: UpgradeStatusEnvelope["data"]["items"][number] | null;
  };
}

interface RuntimeVersionEnvelope {
  ok: boolean;
  data: {
    version: string;
    apiVersion: string;
  };
}

interface SkillRow {
  installedVersion: string | null;
  latestVersion: string | null;
  status: string;
  compatibilityStatus: string;
  promotionChannel: string;
  shadowVersionId: string | null;
  canaryStatsJson: string;
  lastVerifiedRuntimeVersion: string | null;
  lastVerifiedProviderModel: string | null;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"), { readonly: true, fileMustExist: true });
}

function readSkillRow(stateDir: string, skillId: string): SkillRow | null {
  const db = openStateDb(stateDir);
  try {
    return (
      db
        .prepare(
          `SELECT installed_version AS installedVersion,
                  latest_version AS latestVersion,
                  status,
                  compatibility_status AS compatibilityStatus,
                  promotion_channel AS promotionChannel,
                  shadow_version_id AS shadowVersionId,
                  canary_stats_json AS canaryStatsJson,
                  last_verified_runtime_version AS lastVerifiedRuntimeVersion,
                  last_verified_provider_model AS lastVerifiedProviderModel
             FROM skills
            WHERE id = ?`,
        )
        .get(skillId) as SkillRow | undefined
    ) ?? null;
  } finally {
    db.close();
  }
}

function readInstalledSkillManifestVersion(skillDir: string): string | null {
  const manifestPath = path.join(skillDir, "skill.manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { version?: unknown };
  return typeof parsed.version === "string" ? parsed.version : null;
}

function readInstalledSkillManifest(skillDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(skillDir, "skill.manifest.json"), "utf8")) as Record<string, unknown>;
}

function buildSkillRunInput(skillDir: string): Record<string, unknown> {
  const manifestPath = path.join(skillDir, "skill.manifest.json");
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    id?: string;
    inputs?: Array<{
      key?: string;
      type?: string;
      required?: boolean;
      defaultValue?: unknown;
      label?: string;
      help?: string;
    }>;
  };
  const input: Record<string, unknown> = {};

  for (const field of parsed.inputs ?? []) {
    if (typeof field.key !== "string" || field.key.trim().length === 0) {
      continue;
    }
    if (field.defaultValue !== undefined) {
      input[field.key] = field.defaultValue;
      continue;
    }

    const signal = `${field.key} ${field.label ?? ""} ${field.help ?? ""}`.toLowerCase();
    switch (field.type) {
      case "string":
        if (/(task|prompt|query|message|instruction|text|request)/.test(signal)) {
          input[field.key] = "Return the installed version marker.";
        } else if (/(name|title|label|id)/.test(signal) && typeof parsed.id === "string") {
          input[field.key] = parsed.id;
        } else {
          input[field.key] = "test";
        }
        break;
      case "number":
        input[field.key] = 1;
        break;
      case "boolean":
        input[field.key] = false;
        break;
      case "array":
        input[field.key] = [];
        break;
      case "object":
        input[field.key] = {};
        break;
      default:
        if (field.required) {
          input[field.key] = "test";
        }
        break;
    }
  }

  return input;
}

async function ensureGeneratorMaintenanceDeepProofProviders(env: RealHubEnv): Promise<void> {
  await ensureFridayDeepProofProviders(env, {
    namePrefix: "Generator Maintenance Deep Proof",
  });
}

async function getSkillDraftState(
  env: RealHubEnv,
  sessionId: string,
): Promise<SkillGeneratorSessionEnvelope["data"]["draft"] | undefined> {
  const sessionRes = await apiFetch<SkillGeneratorSessionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}`,
  );
  expect(sessionRes.status).toBe(200);
  expect(sessionRes.json.ok).toBe(true);
  return sessionRes.json.data.draft;
}

async function createValidatedSkillDraft(
  env: RealHubEnv,
  goal: string,
): Promise<{
  sessionId: string;
  draft: SkillGeneratorSessionEnvelope["data"]["draft"] | undefined;
  evidence: SkillGeneratorEvidenceEnvelope["data"]["evidence"];
}> {
  const startRes = await apiFetch<SkillGeneratorSessionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/skills/generator/sessions",
    {
      goal,
      userId: "admin-001",
      channel: "deep-generator-maintenance",
      requestedModel: FRIDAY_DEEP_PROOF_MODEL,
    },
    { timeoutMs: 240_000 },
  );
  expect(startRes.status).toBe(200);
  expect(startRes.json.ok).toBe(true);

  const sessionId = startRes.json.data.session.sessionId;

  if (startRes.json.data.mode === "clarification_required") {
    const clarificationRes = await apiFetch<{ ok: boolean }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        message:
          "Keep the implementation deterministic, shell-based, and as small as possible. " +
          "Preserve the exact requested skill id and version, and make the runtime output include the exact required marker.",
        requestedModel: FRIDAY_DEEP_PROOF_MODEL,
      },
      { timeoutMs: 240_000 },
    );
    expect(clarificationRes.status).toBe(200);
    expect(clarificationRes.json.ok).toBe(true);
  }

  let draft = startRes.json.data.draft ?? await getSkillDraftState(env, sessionId);
  let lastIssues = JSON.stringify(draft?.validation?.issues ?? []).slice(0, 1600);

  for (let attempt = 0; attempt < 4; attempt++) {
    if (draft?.validation?.ok) {
      const evidenceRes = await apiFetch<SkillGeneratorEvidenceEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
      );
      expect(evidenceRes.status).toBe(200);
      expect(evidenceRes.json.ok).toBe(true);
      return {
        sessionId,
        draft,
        evidence: evidenceRes.json.data.evidence,
      };
    }

    const generateRes = await apiFetch<{ ok: boolean; data: { draft: SkillGeneratorSessionEnvelope["data"]["draft"] } }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/generate`,
      { requestedModel: FRIDAY_DEEP_PROOF_MODEL },
      { timeoutMs: 240_000 },
    );
    expect(generateRes.status).toBe(200);
    expect(generateRes.json.ok).toBe(true);
    draft = generateRes.json.data.draft;
    lastIssues = JSON.stringify(draft?.validation?.issues ?? []).slice(0, 1600);

    if (draft?.validation?.ok) {
      const evidenceRes = await apiFetch<SkillGeneratorEvidenceEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
      );
      expect(evidenceRes.status).toBe(200);
      expect(evidenceRes.json.ok).toBe(true);
      return {
        sessionId,
        draft,
        evidence: evidenceRes.json.data.evidence,
      };
    }

    if (attempt < 3) {
      const feedbackRes = await apiFetch<{ ok: boolean }>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          message:
            `The current draft still has validation issues: ${lastIssues}. ` +
            "Fix those exact issues, keep the requested skill identity, and regenerate.",
          requestedModel: FRIDAY_DEEP_PROOF_MODEL,
        },
        { timeoutMs: 240_000 },
      );
      expect(feedbackRes.status).toBe(200);
      expect(feedbackRes.json.ok).toBe(true);
      draft = await getSkillDraftState(env, sessionId);
    }
  }

  throw new Error(`Skill generator draft never reached validation ok. Last issues: ${lastIssues}`);
}

async function testSkillDraft(
  env: RealHubEnv,
  sessionId: string,
): Promise<{
  test: SkillGeneratorTestEnvelope["data"]["test"];
  evidence: SkillGeneratorEvidenceEnvelope["data"]["evidence"];
}> {
  let lastFailure = "";

  for (let attempt = 0; attempt < 4; attempt++) {
    const testRes = await apiFetch<SkillGeneratorTestEnvelope>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/test`,
      undefined,
      { timeoutMs: 240_000 },
    );
    expect(testRes.status).toBe(200);
    expect(testRes.json.ok).toBe(true);

    const test = testRes.json.data.test;
    const behavioralSatisfied = test.behavioralCheck ? test.behavioralCheck.satisfied : true;
    if (test.ok && behavioralSatisfied) {
      const evidenceRes = await apiFetch<SkillGeneratorEvidenceEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/evidence`,
      );
      expect(evidenceRes.status).toBe(200);
      expect(evidenceRes.json.ok).toBe(true);
      expect(evidenceRes.json.data.evidence.validationSummary.ok).toBe(true);
      expect(evidenceRes.json.data.evidence.approvalReadiness.ready).toBe(true);
      expect(evidenceRes.json.data.evidence.executableTestSummary?.ok).toBe(true);

      return {
        test,
        evidence: evidenceRes.json.data.evidence,
      };
    }

    lastFailure = JSON.stringify(test).slice(0, 1600);
    if (attempt >= 3) {
      break;
    }

    const feedbackRes = await apiFetch<{ ok: boolean }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        message:
          `The explicit self-test failed: ${lastFailure}. ` +
          "Fix the draft so the self-test passes, preserve the exact skill id/version, and regenerate.",
        requestedModel: FRIDAY_DEEP_PROOF_MODEL,
      },
      { timeoutMs: 240_000 },
    );
    expect(feedbackRes.status).toBe(200);
    expect(feedbackRes.json.ok).toBe(true);

    const generateRes = await apiFetch<{ ok: boolean; data: { draft: SkillGeneratorSessionEnvelope["data"]["draft"] } }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/generate`,
      { requestedModel: FRIDAY_DEEP_PROOF_MODEL },
      { timeoutMs: 240_000 },
    );
    expect(generateRes.status).toBe(200);
    expect(generateRes.json.ok).toBe(true);
  }

  throw new Error(`Skill draft explicit self-test never passed. Last failure: ${lastFailure}`);
}

async function approveSkillDraft(
  env: RealHubEnv,
  sessionId: string,
): Promise<SkillGeneratorApproveEnvelope["data"]> {
  const approveRes = await apiFetch<SkillGeneratorApproveEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/approve`,
    undefined,
    { timeoutMs: 240_000 },
  );
  expect(approveRes.status).toBe(200);
  expect(approveRes.json.ok).toBe(true);
  expect(approveRes.json.data.registryRefreshed).toBe(true);
  expect(approveRes.json.data.promotionStage).toBe("stabilized");
  expect(approveRes.json.data.evidence.validationSummary.ok).toBe(true);
  expect(approveRes.json.data.evidence.approvalReadiness.ready).toBe(true);
  expect(approveRes.json.data.evidence.executableTestSummary?.ok).toBe(true);

  return approveRes.json.data;
}

async function runInstalledSkill(
  env: RealHubEnv,
  skillId: string,
  skillDir: string,
): Promise<SkillRunEnvelope["data"]> {
  const runInput = buildSkillRunInput(skillDir);

  const runRes = await apiFetch<SkillRunEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/skills/${encodeURIComponent(skillId)}/run`,
    { input: runInput },
    { timeoutMs: 240_000 },
  );
  expect(runRes.status).toBe(200);
  expect(runRes.json.ok).toBe(true);
  if (runRes.json.data.status !== "completed") {
    throw new Error(
      `Skill run failed after approval: ${JSON.stringify({
        skillId,
        status: runRes.json.data.status,
        completionDepth: runRes.json.data.completionDepth,
        input: runRes.json.data.input,
        stdout: runRes.json.data.stdout,
        stderr: runRes.json.data.stderr,
        output: runRes.json.data.output,
        manifestVersion: readInstalledSkillManifestVersion(skillDir),
      })}`,
    );
  }
  expect(runRes.json.data.completionDepth).toBe("executed");

  return runRes.json.data;
}

async function testApproveAndRunSkill(
  env: RealHubEnv,
  sessionId: string,
): Promise<{
  skillId: string;
  skillDir: string;
  approve: SkillGeneratorApproveEnvelope["data"];
  run: SkillRunEnvelope["data"];
}> {
  await testSkillDraft(env, sessionId);
  const approve = await approveSkillDraft(env, sessionId);
  const run = await runInstalledSkill(env, approve.skillId, approve.skillDir);

  return {
    skillId: approve.skillId,
    skillDir: approve.skillDir,
    approve,
    run,
  };
}

async function getRuntimeVersion(env: RealHubEnv): Promise<string> {
  const response = await apiFetch<RuntimeVersionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    "/v1/version",
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.version;
}

async function getSkillUpgradeStatus(
  env: RealHubEnv,
  skillId: string,
): Promise<UpgradeStatusEnvelope["data"]["items"][number]> {
  const response = await apiFetch<UpgradeStatusEnvelope>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/autonomy/upgrade-status?kind=skill&id=${encodeURIComponent(skillId)}`,
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.items).toHaveLength(1);
  return response.json.data.items[0]!;
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Generator Maintenance Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
  let env: RealHubEnv;
  const generatedSkillDirs = new Set<string>();

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
    await ensureGeneratorMaintenanceDeepProofProviders(env);
  }, 120_000);

  afterAll(async () => {
    for (const skillDir of generatedSkillDirs) {
      fs.rmSync(skillDir, { recursive: true, force: true });
    }
    const managedSkillsDir = path.join(process.cwd(), "managed-skills");
    if (fs.existsSync(managedSkillsDir)) {
      for (const entry of fs.readdirSync(managedSkillsDir)) {
        if (entry.startsWith("live-maint-skill-")) {
          fs.rmSync(path.join(managedSkillsDir, entry), { recursive: true, force: true });
        }
      }
    }
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "creates a new skill, upgrades it in place through shadow/canary/promote, and rolls back a blocked upgrade attempt",
    { timeout: 420_000, retry: 1 },
    async () => {
      const skillId = `live-maint-skill-${Date.now().toString(36)}`;
      const markerV1 = `${skillId} v1.0.0`;
      const markerV2 = `${skillId} v2.0.0`;
      const markerV3 = `${skillId} v3.0.0`;
      const runtimeVersion = await getRuntimeVersion(env);

      const first = await createValidatedSkillDraft(
        env,
        [
          `Create a tiny Friday shell skill with manifest id "${skillId}" and manifest version "1.0.0".`,
          'Set runtime.apiVersion to "1" and runtime.minHubVersion to "1.0.0".',
          `When the skill runs, it must include the exact marker "${markerV1}" in the result payload.`,
          "Keep the implementation deterministic, self-contained, and shell-based.",
        ].join(" "),
      );
      expect(first.evidence.validationSummary.ok).toBe(true);
      expect(first.evidence.approvalReadiness.ready).toBe(false);

      const firstApproval = await testApproveAndRunSkill(env, first.sessionId);
      generatedSkillDirs.add(firstApproval.skillDir);
      expect(firstApproval.skillId).toBe(skillId);
      const firstOutput = JSON.stringify(firstApproval.run.output);
      expect(firstOutput).toContain("v1.0.0");
      expect(firstOutput).not.toContain("v2.0.0");
      expect(firstOutput).not.toContain("v3.0.0");

      const skillAfterV1 = await apiFetch<SkillDetailEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/skills/${encodeURIComponent(skillId)}`,
      );
      expect(skillAfterV1.status).toBe(200);
      expect(skillAfterV1.json.ok).toBe(true);
      expect(skillAfterV1.json.data.skill.installedVersion).toBe("1.0.0");
      expect(skillAfterV1.json.data.skill.latestVersion).toBe("1.0.0");

      const baselineRow = readSkillRow(env.stateDir!, skillId);
      expect(baselineRow).toMatchObject({
        installedVersion: "1.0.0",
        latestVersion: "1.0.0",
        status: "installed",
        compatibilityStatus: "unknown",
        promotionChannel: "none",
        shadowVersionId: null,
      });
      expect(readInstalledSkillManifestVersion(firstApproval.skillDir)).toBe("1.0.0");
      const firstManifest = readInstalledSkillManifest(firstApproval.skillDir);
      expect((firstManifest.runtime as Record<string, unknown>).apiVersion).toBe("1");
      expect((firstManifest.runtime as Record<string, unknown>).minHubVersion).toBe("1.0.0");

      const baselineStatus = await getSkillUpgradeStatus(env, skillId);
      expect(baselineStatus.kind).toBe("skill");
      expect(baselineStatus.id).toBe(skillId);
      expect(baselineStatus.recordedCompatibilityStatus).toBe("unknown");
      expect(baselineStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(baselineStatus.promotionChannel).toBe("none");
      expect(baselineStatus.nextStage).toBe("shadow");
      expect(
        baselineStatus.findings.some((finding) => finding.id === "skill_installed_version" && finding.passed),
      ).toBe(true);

      const second = await createValidatedSkillDraft(
        env,
        [
          `Update the existing installed Friday shell skill with manifest id "${skillId}".`,
          `Keep the exact same manifest id "${skillId}" but change the manifest version to "2.0.0".`,
          'Keep runtime.apiVersion at "1" and runtime.minHubVersion at "1.0.0".',
          `When the skill runs, it must include the exact marker "${markerV2}" in the result payload.`,
          "Do not create a new skill id or a replacement skill.",
        ].join(" "),
      );
      expect(second.evidence.validationSummary.ok).toBe(true);
      expect(second.evidence.approvalReadiness.ready).toBe(false);
      expect(second.draft?.manifest?.version).toBe("2.0.0");

      const replay = await testSkillDraft(env, second.sessionId);
      expect(replay.test.ok).toBe(true);
      expect(replay.evidence.approvalReadiness.ready).toBe(true);

      const shadowV2Res = await apiFetch<SkillUpgradeActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(skillId)}/shadow`,
        {
          shadowVersionId: second.draft!.manifest!.version,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(shadowV2Res.status).toBe(200);
      expect(shadowV2Res.json.ok).toBe(true);
      expect(shadowV2Res.json.data.skill.skillId).toBe(skillId);
      expect(shadowV2Res.json.data.skill.promotionChannel).toBe("shadow");
      expect(shadowV2Res.json.data.skill.shadowVersionId).toBe("2.0.0");
      expect(shadowV2Res.json.data.status?.promotionChannel).toBe("shadow");
      expect(shadowV2Res.json.data.status?.recordedCompatibilityStatus).toBe("adaptation_required");
      expect(shadowV2Res.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const secondApprove = await approveSkillDraft(env, second.sessionId);
      const secondRun = await runInstalledSkill(env, secondApprove.skillId, secondApprove.skillDir);
      const secondApproval = {
        skillId: secondApprove.skillId,
        skillDir: secondApprove.skillDir,
        approve: secondApprove,
        run: secondRun,
      };
      generatedSkillDirs.add(secondApproval.skillDir);
      expect(secondApproval.skillId).toBe(skillId);
      const secondOutput = JSON.stringify(secondApproval.run.output);
      expect(secondOutput).toContain("v2.0.0");
      expect(secondOutput).not.toContain("v1.0.0");
      expect(secondOutput).not.toContain("v3.0.0");

      const skillAfterV2 = await apiFetch<SkillDetailEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/skills/${encodeURIComponent(skillId)}`,
      );
      expect(skillAfterV2.status).toBe(200);
      expect(skillAfterV2.json.ok).toBe(true);
      expect(skillAfterV2.json.data.skill.installedVersion).toBe("2.0.0");
      expect(skillAfterV2.json.data.skill.latestVersion).toBe("2.0.0");

      const canaryRes = await apiFetch<SkillUpgradeActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(skillId)}/canary`,
        { success: true },
      );
      expect(canaryRes.status).toBe(200);
      expect(canaryRes.json.ok).toBe(true);
      expect(canaryRes.json.data.skill.promotionChannel).toBe("canary");
      expect(canaryRes.json.data.skill.canaryStats).toMatchObject({
        sampleSize: 1,
        successCount: 1,
        failureCount: 0,
        rollbackCount: 0,
      });
      expect(canaryRes.json.data.status?.promotionChannel).toBe("canary");

      const promoteRes = await apiFetch<SkillUpgradeActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(skillId)}/promote`,
        {
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(promoteRes.status).toBe(200);
      expect(promoteRes.json.ok).toBe(true);
      expect(promoteRes.json.data.skill.promotionChannel).toBe("active");
      expect(promoteRes.json.data.skill.compatibilityStatus).toBe("compatible");
      expect(promoteRes.json.data.status?.promotionChannel).toBe("active");
      expect(promoteRes.json.data.status?.recordedCompatibilityStatus).toBe("compatible");
      expect(promoteRes.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const promotedRow = readSkillRow(env.stateDir!, skillId);
      expect(promotedRow).toMatchObject({
        installedVersion: "2.0.0",
        latestVersion: "2.0.0",
        status: "installed",
        compatibilityStatus: "compatible",
        promotionChannel: "active",
        shadowVersionId: "2.0.0",
        lastVerifiedRuntimeVersion: runtimeVersion,
        lastVerifiedProviderModel: FRIDAY_DEEP_PROOF_MODEL,
      });
      expect(JSON.parse(promotedRow!.canaryStatsJson)).toMatchObject({
        sampleSize: 1,
        successCount: 1,
        failureCount: 0,
        rollbackCount: 0,
      });

      const promotedStatus = await getSkillUpgradeStatus(env, skillId);
      expect(promotedStatus.promotionChannel).toBe("active");
      expect(promotedStatus.recordedCompatibilityStatus).toBe("compatible");
      expect(promotedStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(promotedStatus.shadowVersionId).toBe("2.0.0");

      expect(readInstalledSkillManifestVersion(secondApproval.skillDir)).toBe("2.0.0");

      const blockedPromotion = await createValidatedSkillDraft(
        env,
        [
          `Update the existing installed Friday shell skill with manifest id "${skillId}".`,
          `Keep the exact same manifest id "${skillId}" but change the manifest version to "3.0.0".`,
          'Keep runtime.apiVersion at "1" and runtime.minHubVersion at "1.0.0".',
          `When the skill runs, it must include the exact marker "${markerV3}" in the result payload.`,
          "Do not create a new skill id.",
        ].join(" "),
      );
      expect(blockedPromotion.evidence.validationSummary.ok).toBe(true);
      expect(blockedPromotion.evidence.approvalReadiness.ready).toBe(false);
      expect(blockedPromotion.evidence.approvalReadiness.reason).toMatch(/self-test|explicit self-test|QA/i);
      expect(blockedPromotion.draft?.manifest?.version).toBe("3.0.0");

      const shadowV3Res = await apiFetch<SkillUpgradeActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(skillId)}/shadow`,
        {
          shadowVersionId: blockedPromotion.draft!.manifest!.version,
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(shadowV3Res.status).toBe(200);
      expect(shadowV3Res.json.ok).toBe(true);
      expect(shadowV3Res.json.data.skill.shadowVersionId).toBe("3.0.0");
      expect(shadowV3Res.json.data.skill.promotionChannel).toBe("shadow");

      const blockedApproveRes = await apiFetch<SkillGeneratorApproveEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/skills/generator/sessions/${encodeURIComponent(blockedPromotion.sessionId)}/approve`,
        undefined,
        { timeoutMs: 240_000 },
      );
      expect(blockedApproveRes.status).toBe(422);
      expect(blockedApproveRes.json.ok).not.toBe(true);

      const skillAfterBlocked = await apiFetch<SkillDetailEnvelope>(
        env.baseUrl,
        env.accessToken,
        "GET",
        `/v1/skills/${encodeURIComponent(skillId)}`,
      );
      expect(skillAfterBlocked.status).toBe(200);
      expect(skillAfterBlocked.json.ok).toBe(true);
      expect(skillAfterBlocked.json.data.skill.installedVersion).toBe("2.0.0");
      expect(skillAfterBlocked.json.data.skill.latestVersion).toBe("2.0.0");

      const rollbackRes = await apiFetch<SkillUpgradeActionEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/autonomy/skills/${encodeURIComponent(skillId)}/rollback`,
        {
          runtimeVersion,
          providerModel: FRIDAY_DEEP_PROOF_MODEL,
        },
      );
      expect(rollbackRes.status).toBe(200);
      expect(rollbackRes.json.ok).toBe(true);
      expect(rollbackRes.json.data.skill.promotionChannel).toBe("rolled_back");
      expect(rollbackRes.json.data.skill.compatibilityStatus).toBe("adaptation_required");
      expect(rollbackRes.json.data.skill.shadowVersionId).toBeUndefined();
      expect(rollbackRes.json.data.skill.canaryStats).toMatchObject({
        sampleSize: 1,
        successCount: 1,
        failureCount: 0,
        rollbackCount: 1,
      });
      expect(rollbackRes.json.data.status?.promotionChannel).toBe("rolled_back");
      expect(rollbackRes.json.data.status?.recordedCompatibilityStatus).toBe("adaptation_required");
      expect(rollbackRes.json.data.status?.derivedCompatibilityStatus).toBe("compatible");

      const rolledBackStatus = await getSkillUpgradeStatus(env, skillId);
      expect(rolledBackStatus.promotionChannel).toBe("rolled_back");
      expect(rolledBackStatus.recordedCompatibilityStatus).toBe("adaptation_required");
      expect(rolledBackStatus.derivedCompatibilityStatus).toBe("compatible");
      expect(rolledBackStatus.shadowVersionId).toBeUndefined();

      const rolledBackRow = readSkillRow(env.stateDir!, skillId);
      expect(rolledBackRow).toMatchObject({
        installedVersion: "2.0.0",
        latestVersion: "2.0.0",
        status: "installed",
        compatibilityStatus: "adaptation_required",
        promotionChannel: "rolled_back",
        shadowVersionId: null,
        lastVerifiedRuntimeVersion: runtimeVersion,
        lastVerifiedProviderModel: FRIDAY_DEEP_PROOF_MODEL,
      });
      expect(JSON.parse(rolledBackRow!.canaryStatsJson)).toMatchObject({
        sampleSize: 1,
        successCount: 1,
        failureCount: 0,
        rollbackCount: 1,
      });

      expect(readInstalledSkillManifestVersion(secondApproval.skillDir)).toBe("2.0.0");

      const activeRunAfterBlocked = await apiFetch<SkillRunEnvelope>(
        env.baseUrl,
        env.accessToken,
        "POST",
        `/v1/skills/${encodeURIComponent(skillId)}/run`,
        {
          input: {
            task: "Run the still-active version after the blocked promotion attempt.",
          },
        },
        { timeoutMs: 240_000 },
      );
      expect(activeRunAfterBlocked.status).toBe(200);
      expect(activeRunAfterBlocked.json.ok).toBe(true);
      expect(activeRunAfterBlocked.json.data.status).toBe("completed");
      expect(activeRunAfterBlocked.json.data.completionDepth).toBe("executed");
      const activeOutput = JSON.stringify(activeRunAfterBlocked.json.data.output);
      expect(activeOutput).toContain("v2.0.0");
      expect(activeOutput).not.toContain("v3.0.0");
    },
  );
});
