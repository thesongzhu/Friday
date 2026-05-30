import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import {
  signFridayCanonicalApproval,
  type FridayCanonicalApprovalResolution,
} from "../../../src/security/friday-mutating-action-gate.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  ensureFridayDeepProofProviders,
  FRIDAY_DEEP_PROOF_GATED,
  FRIDAY_DEEP_PROOF_MODEL,
  FRIDAY_DEEP_PROOF_PROVIDER_LABEL,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

// The generated-skill candidate-staging approve route is gated by the canonical
// approval gate (since the B0 carve-out). Drive the REAL approved path: take the
// gate's computed actionDigest from the requires-approval response and return a
// properly signed canonical approval bound to that exact digest. The hub is given
// this same secret as its tokenSecret so the signature verifies. This does NOT
// weaken the gate — an unsigned/forged/mismatched approval is still rejected.
const SKILL_GENERATOR_SIGNING_MATERIAL =
  "generator-maintenance-live-proof-signing-material"; // pragma: allowlist secret
const LOCAL_LIVE_PRINCIPAL_ID = "admin-001";

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
    candidateId: string;
    candidateDir: string;
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
      stagedCandidateIdentity?: {
        skillId: string;
        candidateId?: string;
        candidateDir?: string;
        filesDir?: string;
      };
    };
  };
  error?: { code?: string; message?: string };
}

interface SkillRunBlockedEnvelope {
  ok?: boolean;
  error?: {
    code?: string;
    message?: string;
  };
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
  // Step 1: probe the canonical-approval gate (no approval) and read the
  // gate-computed actionDigest from the requires-approval (403) response.
  const gateProbe = await apiFetch<{
    ok: boolean;
    error?: { code?: string; details?: { canonicalGate?: { actionDigest?: string } } };
  }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/approve`,
    undefined,
    { timeoutMs: 240_000 },
  );
  expect(gateProbe.status).toBe(403);
  expect(gateProbe.json.error?.code).toBe("SKILL_GENERATOR_CANDIDATE_APPROVAL_REQUIRED");
  const actionDigest = gateProbe.json.error?.details?.canonicalGate?.actionDigest;
  expect(typeof actionDigest).toBe("string");

  // Step 2: build a properly signed canonical approval bound to that exact digest
  // (the hub was given SKILL_GENERATOR_SIGNING_MATERIAL as its tokenSecret).
  const canonicalApproval: FridayCanonicalApprovalResolution = signFridayCanonicalApproval(
    {
      decision: "approved",
      approvalId: "generator-maintenance-live-stage",
      decidedByPrincipalId: LOCAL_LIVE_PRINCIPAL_ID,
      actionDigest: actionDigest!,
      expiresAt: "2027-05-07T00:00:00.000Z",
    },
    SKILL_GENERATOR_SIGNING_MATERIAL,
  );

  // Step 3: approve with the signed canonical approval — the real approved path.
  const approveRes = await apiFetch<SkillGeneratorApproveEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/skills/generator/sessions/${encodeURIComponent(sessionId)}/approve`,
    { canonicalApproval },
    { timeoutMs: 240_000 },
  );
  expect(approveRes.status).toBe(200);
  expect(approveRes.json.ok).toBe(true);
  expect(approveRes.json.data.registryRefreshed).toBe(false);
  expect(approveRes.json.data.promotionStage).toBe("candidate_staged");
  expect(approveRes.json.data.candidateId).toBeTruthy();
  expect(approveRes.json.data.candidateDir).toBeTruthy();
  expect(approveRes.json.data.evidence.validationSummary.ok).toBe(true);
  expect(approveRes.json.data.evidence.approvalReadiness.ready).toBe(true);
  expect(approveRes.json.data.evidence.executableTestSummary?.ok).toBe(true);
  expect(approveRes.json.data.evidence.stagedCandidateIdentity).toMatchObject({
    skillId: approveRes.json.data.skillId,
    candidateId: approveRes.json.data.candidateId,
    candidateDir: approveRes.json.data.candidateDir,
    filesDir: approveRes.json.data.skillDir,
  });

  return approveRes.json.data;
}

async function expectStagedSkillRunBlocked(
  env: RealHubEnv,
  approve: SkillGeneratorApproveEnvelope["data"],
): Promise<{ status: number; code?: string; message?: string }> {
  const runRes = await apiFetch<SkillRunBlockedEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/skills/${encodeURIComponent(approve.skillId)}/run`,
    { input: { task: "Attempt direct run before lifecycle promotion." } },
    { timeoutMs: 240_000 },
  );
  expect(runRes.status).not.toBe(200);
  expect(runRes.json.ok).not.toBe(true);
  expect(runRes.json.error?.code).toMatch(/SKILL_NOT_AVAILABLE|SKILL_NOT_FOUND/);
  expect(runRes.json.error?.message ?? "").toMatch(/not available|not found|installed|promoted/i);
  return {
    status: runRes.status,
    code: runRes.json.error?.code,
    message: runRes.json.error?.message,
  };
}

async function testApproveAndBlockDirectSkillRun(
  env: RealHubEnv,
  sessionId: string,
): Promise<{
  skillId: string;
  skillDir: string;
  approve: SkillGeneratorApproveEnvelope["data"];
  blockedRun: { status: number; code?: string; message?: string };
}> {
  await testSkillDraft(env, sessionId);
  const approve = await approveSkillDraft(env, sessionId);
  const blockedRun = await expectStagedSkillRunBlocked(env, approve);

  return {
    skillId: approve.skillId,
    skillDir: approve.skillDir,
    approve,
    blockedRun,
  };
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)(`Friday Generator Maintenance Live (${FRIDAY_DEEP_PROOF_PROVIDER_LABEL})`, () => {
  let env: RealHubEnv;
  const generatedSkillDirs = new Set<string>();

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv({
      hubConfig: { tokenSecret: SKILL_GENERATOR_SIGNING_MATERIAL },
    });
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
    "stages a generated skill candidate and blocks direct run until lifecycle promotion",
    { timeout: 420_000, retry: 1 },
    async () => {
      const skillId = `live-maint-skill-${Date.now().toString(36)}`;
      const markerCandidate = `${skillId} candidate v1.0.0`;

      const first = await createValidatedSkillDraft(
        env,
        [
          `Create a tiny Friday shell skill with manifest id "${skillId}" and manifest version "1.0.0".`,
          'Set runtime.apiVersion to "1" and runtime.minHubVersion to "1.0.0".',
          `When the skill self-test runs, it must include the exact marker "${markerCandidate}" in the result payload.`,
          "Keep the implementation deterministic, self-contained, and shell-based.",
        ].join(" "),
      );
      expect(first.evidence.validationSummary.ok).toBe(true);
      expect(first.evidence.approvalReadiness.ready).toBe(false);

      const firstApproval = await testApproveAndBlockDirectSkillRun(env, first.sessionId);
      generatedSkillDirs.add(firstApproval.approve.candidateDir);
      generatedSkillDirs.add(firstApproval.skillDir);
      expect(firstApproval.skillId).toBe(skillId);
      expect(firstApproval.approve.registryRefreshed).toBe(false);
      expect(firstApproval.approve.promotionStage).toBe("candidate_staged");
      expect(firstApproval.approve.candidateId).toBeTruthy();
      expect(firstApproval.approve.candidateDir).toBeTruthy();
      expect(firstApproval.blockedRun.status).not.toBe(200);
      expect(firstApproval.blockedRun.code).toMatch(/SKILL_NOT_AVAILABLE|SKILL_NOT_FOUND/);
    },
  );
});
