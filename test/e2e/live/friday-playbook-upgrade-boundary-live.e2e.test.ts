import Database from "better-sqlite3";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiFetch } from "./_helpers/api.js";
import {
  cleanupFridayDeepProofHubEnv,
  createFridayDeepProofHubEnv,
  FRIDAY_DEEP_PROOF_GATED,
  type RealHubEnv,
} from "./_helpers/deep-proof-env.js";

interface CandidateRecord {
  id: string;
  fingerprint: string;
  workflowType: string;
  evidenceCount: number;
  successCount: number;
  failureCount: number;
  status: string;
}

interface PromoteEnvelope {
  ok: boolean;
  data: {
    decision: {
      decision: string;
      reason: string;
      ruleResults: Array<{
        ruleId: string;
        passed: boolean;
        actualValue: number;
        threshold: number;
      }>;
    };
    playbook: {
      id: string;
      workflowType: string;
      activeVersionNumber: number;
      status: string;
    } | null;
    version: {
      id: string;
      versionNumber: number;
      candidateId: string;
    } | null;
  };
}

interface SelectEnvelope {
  ok: boolean;
  data: {
    match: {
      reason: string;
      playbookId: string | null;
      versionNumber: number | null;
      similarity: number;
    };
  };
}

interface PlaybookVersionsRow {
  versionNumber: number;
  candidateId: string;
}

interface LifecycleEventRow {
  type: string;
  reason: string;
  fromVersionNumber: number | null;
  toVersionNumber: number | null;
}

function openStateDb(stateDir: string): Database.Database {
  return new Database(path.join(stateDir, "friday.db"));
}

function ageCandidate(stateDir: string, candidateId: string, firstObservedAt: string): void {
  const db = openStateDb(stateDir);
  try {
    db.prepare(
      `UPDATE playbook_candidates
          SET first_observed_at = @firstObservedAt,
              updated_at = @updatedAt
        WHERE id = @candidateId`,
    ).run({
      candidateId,
      firstObservedAt,
      updatedAt: "2026-04-17T00:00:00.000Z",
    });
  } finally {
    db.close();
  }
}

function readPlaybookVersions(stateDir: string, playbookId: string): PlaybookVersionsRow[] {
  const db = openStateDb(stateDir);
  try {
    return db.prepare(
      `SELECT version_number AS versionNumber,
              candidate_id AS candidateId
         FROM playbook_versions
        WHERE playbook_id = ?
        ORDER BY version_number ASC`,
    ).all(playbookId) as PlaybookVersionsRow[];
  } finally {
    db.close();
  }
}

function readLifecycleEvents(stateDir: string, playbookId: string): LifecycleEventRow[] {
  const db = openStateDb(stateDir);
  try {
    return db.prepare(
      `SELECT type,
              reason,
              from_version_number AS fromVersionNumber,
              to_version_number AS toVersionNumber
         FROM playbook_lifecycle_events
        WHERE playbook_id = ?
        ORDER BY occurred_at ASC, id ASC`,
    ).all(playbookId) as LifecycleEventRow[];
  } finally {
    db.close();
  }
}

async function executeEvidenceRun(
  env: RealHubEnv,
  workflowType: string,
  runId: string,
  inputData: Record<string, unknown>,
): Promise<void> {
  const response = await apiFetch<{
    ok: boolean;
    data: {
      execution: {
        executionId: string;
        status: string;
      };
    };
  }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/node-runner/execute",
    {
      nodeId: `node-${runId}`,
      runId,
      workflowId: `workflow-${runId}`,
      workflowType,
      nodeType: "data",
      label: "Playbook upgrade boundary live proof",
      nodeConfig: {
        mapping: {
          stage: "playbook-upgrade-boundary",
        },
      },
      inputData,
      tags: ["deep-proof", "playbook-upgrade"],
    },
    { timeoutMs: 60_000 },
  );

  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  expect(response.json.data.execution.status).toBe("completed");
}

async function listCandidates(
  env: RealHubEnv,
  workflowType: string,
): Promise<CandidateRecord[]> {
  const response = await apiFetch<{
    ok: boolean;
    data: {
      items: CandidateRecord[];
    };
  }>(
    env.baseUrl,
    env.accessToken,
    "GET",
    `/v1/playbooks/candidates?workflowType=${encodeURIComponent(workflowType)}`,
  );

  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.items;
}

async function promoteCandidate(env: RealHubEnv, candidateId: string): Promise<PromoteEnvelope> {
  const response = await apiFetch<PromoteEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/playbooks/candidates/${encodeURIComponent(candidateId)}/promote`,
    {},
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json;
}

async function selectPlaybook(env: RealHubEnv, workflowType: string): Promise<SelectEnvelope> {
  const response = await apiFetch<SelectEnvelope>(
    env.baseUrl,
    env.accessToken,
    "POST",
    "/v1/playbooks/select",
    {
      workflowType,
      workflowId: `select-${workflowType}`,
      runId: `select-run-${Date.now().toString(36)}`,
      nodeSequence: [{ nodeType: "data" }],
      tags: ["deep-proof", "playbook-upgrade"],
      metadata: {
        lane: "phase-5-upgrade",
      },
    },
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json;
}

async function rollbackPlaybook(env: RealHubEnv, playbookId: string, targetVersionNumber: number) {
  const response = await apiFetch<{
    ok: boolean;
    data: {
      playbook: {
        id: string;
        activeVersionNumber: number;
        status: string;
      };
    };
  }>(
    env.baseUrl,
    env.accessToken,
    "POST",
    `/v1/playbooks/${encodeURIComponent(playbookId)}/rollback`,
    {
      targetVersionNumber,
      reason: "Regression proof rollback",
    },
  );
  expect(response.status).toBe(200);
  expect(response.json.ok).toBe(true);
  return response.json.data.playbook;
}

describe.skipIf(!FRIDAY_DEEP_PROOF_GATED)("Friday Playbook Upgrade Boundary Live (Anthropic API key)", () => {
  let env: RealHubEnv;

  beforeAll(async () => {
    env = await createFridayDeepProofHubEnv();
  }, 60_000);

  afterAll(async () => {
    if (env) {
      await cleanupFridayDeepProofHubEnv(env);
    }
  }, 30_000);

  it(
    "proves detect -> defer -> promote -> evolve -> rollback on a real runtime with SQLite readback",
    { timeout: 180_000, retry: 1 },
    async () => {
      const workflowType = `playbook-upgrade-live-${Date.now().toString(36)}`;

      for (let index = 0; index < 5; index += 1) {
        await executeEvidenceRun(env, workflowType, `v1-${index}`, {
          alpha: index,
          beta: true,
        });
      }

      const firstCandidates = await listCandidates(env, workflowType);
      expect(firstCandidates).toHaveLength(1);
      const firstCandidate = firstCandidates[0]!;
      expect(firstCandidate.evidenceCount).toBeGreaterThanOrEqual(5);
      expect(firstCandidate.status).toBe("pending");

      const firstDeferred = await promoteCandidate(env, firstCandidate.id);
      expect(firstDeferred.data.decision.decision).toBe("defer");
      expect(firstDeferred.data.playbook).toBeNull();
      expect(firstDeferred.data.version).toBeNull();
      expect(
        firstDeferred.data.decision.ruleResults.some((rule) => rule.ruleId === "min-age" && rule.passed === false),
      ).toBe(true);

      ageCandidate(env.stateDir!, firstCandidate.id, "2026-04-15T00:00:00.000Z");

      const firstPromoted = await promoteCandidate(env, firstCandidate.id);
      expect(firstPromoted.data.decision.decision).toBe("promote");
      expect(firstPromoted.data.playbook).not.toBeNull();
      expect(firstPromoted.data.version?.versionNumber).toBe(1);
      const playbookId = firstPromoted.data.playbook!.id;

      const firstSelection = await selectPlaybook(env, workflowType);
      expect(firstSelection.data.match.reason).toBe("matched");
      expect(firstSelection.data.match.playbookId).toBe(playbookId);
      expect(firstSelection.data.match.versionNumber).toBe(1);

      for (let index = 0; index < 5; index += 1) {
        await executeEvidenceRun(env, workflowType, `v2-${index}`, {
          alpha: index,
          beta: true,
          gamma: "upgrade",
        });
      }

      const secondCandidates = await listCandidates(env, workflowType);
      const secondCandidate = secondCandidates.find((candidate) => candidate.id !== firstCandidate.id);
      expect(secondCandidate).toBeDefined();
      expect(secondCandidate?.fingerprint).not.toBe(firstCandidate.fingerprint);
      expect(secondCandidate?.status).toBe("pending");

      const secondDeferred = await promoteCandidate(env, secondCandidate!.id);
      expect(secondDeferred.data.decision.decision).toBe("defer");
      expect(
        secondDeferred.data.decision.ruleResults.some((rule) => rule.ruleId === "min-age" && rule.passed === false),
      ).toBe(true);

      ageCandidate(env.stateDir!, secondCandidate!.id, "2026-04-15T00:00:00.000Z");

      const secondPromoted = await promoteCandidate(env, secondCandidate!.id);
      expect(secondPromoted.data.decision.decision).toBe("promote");
      expect(secondPromoted.data.playbook?.id).toBe(playbookId);
      expect(secondPromoted.data.version?.versionNumber).toBe(2);
      expect(secondPromoted.data.playbook?.activeVersionNumber).toBe(2);

      const versionsBeforeRollback = readPlaybookVersions(env.stateDir!, playbookId);
      expect(versionsBeforeRollback.map((row) => row.versionNumber)).toEqual([1, 2]);
      expect(versionsBeforeRollback.map((row) => row.candidateId)).toEqual([firstCandidate.id, secondCandidate!.id]);

      const secondSelection = await selectPlaybook(env, workflowType);
      expect(secondSelection.data.match.reason).toBe("matched");
      expect(secondSelection.data.match.playbookId).toBe(playbookId);
      expect(secondSelection.data.match.versionNumber).toBe(2);

      const rolledBack = await rollbackPlaybook(env, playbookId, 1);
      expect(rolledBack.activeVersionNumber).toBe(1);
      expect(rolledBack.status).toBe("active");

      const versionsAfterRollback = readPlaybookVersions(env.stateDir!, playbookId);
      expect(versionsAfterRollback.map((row) => row.versionNumber)).toEqual([1, 2]);

      const lifecycleEvents = readLifecycleEvents(env.stateDir!, playbookId);
      expect(
        lifecycleEvents.some(
          (event) =>
            event.type === "rollback"
            && event.fromVersionNumber === 2
            && event.toVersionNumber === 1
            && event.reason === "Regression proof rollback",
        ),
      ).toBe(true);

      const rolledBackSelection = await selectPlaybook(env, workflowType);
      expect(rolledBackSelection.data.match.reason).toBe("matched");
      expect(rolledBackSelection.data.match.playbookId).toBe(playbookId);
      expect(rolledBackSelection.data.match.versionNumber).toBe(1);
    },
  );
});
