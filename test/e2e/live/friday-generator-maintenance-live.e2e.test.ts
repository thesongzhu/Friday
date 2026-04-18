import fs from "node:fs";
import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LIVE_ANTHROPIC_MODEL, liveAnthropicCredentialMessage } from "../_helpers/live-anthropic.js";
import { apiFetch, ensureAnthropicProviders } from "./_helpers/api.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

const ANTHROPIC_BASE_URL = process.env.E2E_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";

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

interface SkillRow {
  installedVersion: string | null;
  latestVersion: string | null;
  status: string;
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
                  status
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

async function ensureAnthropicGeneratorProviders(env: RealHubEnv): Promise<void> {
  const apiKeyEnvRef = FRIDAY_DEEP_PROOF_ANTHROPIC_API_KEY_ENV_REF
    ?? (() => { throw new Error(liveAnthropicCredentialMessage()); })();
  await ensureAnthropicProviders(
    env.baseUrl,
    env.accessToken,
    ANTHROPIC_BASE_URL,
    LIVE_ANTHROPIC_MODEL,
    LIVE_ANTHROPIC_MODEL,
    apiKeyEnvRef,
    { namePrefix: "Generator Maintenance Deep Proof" },
  );
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
): Promise<{ sessionId: string; evidence: SkillGeneratorEvidenceEnvelope["data"]["evidence"] }> {
  const startRes = await apiFetch<SkillGeneratorSessionEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/skills/generator/sessions",
    {
      goal,
      userId: "admin-001",
      channel: "deep-generator-maintenance",
      requestedModel: LIVE_ANTHROPIC_MODEL,
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
        requestedModel: LIVE_ANTHROPIC_MODEL,
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
        evidence: evidenceRes.json.data.evidence,
      };
    }

    const generateRes = await apiFetch<{ ok: boolean; data: { draft: SkillGeneratorSessionEnvelope["data"]["draft"] } }>(
      env.baseUrl,
      env.accessToken,
      "POST",
      `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/generate`,
      { requestedModel: LIVE_ANTHROPIC_MODEL },
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
          requestedModel: LIVE_ANTHROPIC_MODEL,
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

async function testApproveAndRunSkill(
  env: RealHubEnv,
  sessionId: string,
): Promise<{
  skillId: string;
  skillDir: string;
  approve: SkillGeneratorApproveEnvelope["data"];
  run: SkillRunEnvelope["data"];
}> {
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
  expect(testRes.json.data.test.ok).toBe(true);
  if (testRes.json.data.test.behavioralCheck) {
    expect(testRes.json.data.test.behavioralCheck.satisfied).toBe(true);
  }

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

  const skillId = approveRes.json.data.skillId;
  const runInput = buildSkillRunInput(approveRes.json.data.skillDir);

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
        manifestVersion: readInstalledSkillManifestVersion(approveRes.json.data.skillDir),
      })}`,
    );
  }
  expect(runRes.json.data.completionDepth).toBe("executed");

  return {
    skillId,
    skillDir: approveRes.json.data.skillDir,
    approve: approveRes.json.data,
    run: runRes.json.data,
  };
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Generator Maintenance Live (Anthropic API key)", () => {
  let env: RealHubEnv;
  const generatedSkillDirs = new Set<string>();

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
    await ensureAnthropicGeneratorProviders(env);
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
    "creates a new skill, upgrades it in place, and blocks an unverified promotion from replacing the active skill",
    { timeout: 420_000, retry: 1 },
    async () => {
      const skillId = `live-maint-skill-${Date.now().toString(36)}`;
      const markerV1 = `${skillId} v1.0.0`;
      const markerV2 = `${skillId} v2.0.0`;
      const markerV3 = `${skillId} v3.0.0`;

      const first = await createValidatedSkillDraft(
        env,
        [
          `Create a tiny Friday shell skill with manifest id "${skillId}" and manifest version "1.0.0".`,
          `When the skill runs, it must include the exact marker "${markerV1}" in the result payload.`,
          "Keep the implementation deterministic, self-contained, and shell-based.",
        ].join(" "),
      );
      expect(first.evidence.validationSummary.ok).toBe(true);
      expect(first.evidence.approvalReadiness.ready).toBe(false);

      const firstApproval = await testApproveAndRunSkill(env, first.sessionId, {
      });
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

      expect(readInstalledSkillManifestVersion(firstApproval.skillDir)).toBe("1.0.0");

      const second = await createValidatedSkillDraft(
        env,
        [
          `Update the existing installed Friday shell skill with manifest id "${skillId}".`,
          `Keep the exact same manifest id "${skillId}" but change the manifest version to "2.0.0".`,
          `When the skill runs, it must include the exact marker "${markerV2}" in the result payload.`,
          "Do not create a new skill id or a replacement skill.",
        ].join(" "),
      );
      expect(second.evidence.validationSummary.ok).toBe(true);

      const secondApproval = await testApproveAndRunSkill(env, second.sessionId, {
      });
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

      expect(readInstalledSkillManifestVersion(secondApproval.skillDir)).toBe("2.0.0");

      const blockedPromotion = await createValidatedSkillDraft(
        env,
        [
          `Update the existing installed Friday shell skill with manifest id "${skillId}".`,
          `Keep the exact same manifest id "${skillId}" but change the manifest version to "3.0.0".`,
          `When the skill runs, it must include the exact marker "${markerV3}" in the result payload.`,
          "Do not create a new skill id.",
        ].join(" "),
      );
      expect(blockedPromotion.evidence.validationSummary.ok).toBe(true);
      expect(blockedPromotion.evidence.approvalReadiness.ready).toBe(false);
      expect(blockedPromotion.evidence.approvalReadiness.reason).toMatch(/self-test|explicit self-test|QA/i);

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
