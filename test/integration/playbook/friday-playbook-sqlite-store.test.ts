import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createFridaySqliteLayer } from "#state";
import { createSqlitePlaybookStore } from "#playbook";
import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookLifecycleEvent,
  FridayPlaybookMatch,
  FridayPlaybookScore,
  FridayPlaybookVersion,
  FridayPromotionDecision,
} from "#playbook";

const NOW = "2026-02-28T12:00:00.000Z";

function makeCandidate(overrides: Partial<FridayPlaybookCandidate> = {}): FridayPlaybookCandidate {
  return {
    id: "cand-1",
    fingerprint: "fingerprint-1",
    workflowType: "playbook-store-integration",
    tags: ["core"],
    pattern: { nodeSequence: [{ nodeType: "action", adapterType: "tool" }] },
    status: "pending",
    evidenceCount: 6,
    successCount: 6,
    failureCount: 0,
    totalDurationMs: 1200,
    totalCost: { tokenCost: 30, apiCallCost: 1, latencyMs: 400 },
    sourceRunIds: ["run-1", "run-2", "run-3"],
    firstObservedAt: "2026-02-25T12:00:00.000Z",
    lastObservedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<FridayPlaybook> = {}): FridayPlaybook {
  return {
    id: "pb-1",
    name: "integration-playbook",
    description: "persisted playbook",
    workflowType: "playbook-store-integration",
    tags: ["core"],
    status: "active",
    activeVersionNumber: 1,
    sourceCandidateId: "cand-1",
    compositeScore: 0.92,
    totalUses: 12,
    totalSuccesses: 11,
    lastUsedAt: NOW,
    lastSuccessfulAt: NOW,
    etag: "etag-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeVersion(overrides: Partial<FridayPlaybookVersion> = {}): FridayPlaybookVersion {
  return {
    id: "ver-1",
    playbookId: "pb-1",
    versionNumber: 1,
    fingerprint: "fingerprint-1",
    pattern: { nodeSequence: [{ nodeType: "action", adapterType: "tool" }] },
    candidateId: "cand-1",
    changeNote: "initial",
    createdAt: NOW,
    ...overrides,
  };
}

function makeScore(overrides: Partial<FridayPlaybookScore> = {}): FridayPlaybookScore {
  return {
    id: "score-1",
    playbookId: "pb-1",
    versionNumber: 1,
    compositeScore: 0.92,
    successRate: 0.91,
    speedScore: 0.8,
    costEfficiencyScore: 0.88,
    satisfactionScore: 0.83,
    sampleSize: 12,
    calculatedAt: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<FridayPlaybookMatch> = {}): FridayPlaybookMatch {
  return {
    id: "match-1",
    runId: "run-100",
    workflowId: "wf-100",
    playbookId: "pb-1",
    versionNumber: 1,
    matchScore: 0.95,
    similarity: 0.97,
    reason: "matched",
    context: {
      workflowType: "playbook-store-integration",
      workflowId: "wf-100",
      runId: "run-100",
      nodeSequence: [{ nodeType: "action", adapterType: "tool" }],
      tags: ["core"],
    },
    selectedAt: NOW,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<FridayPromotionDecision> = {}): FridayPromotionDecision {
  return {
    id: "decision-1",
    candidateId: "cand-1",
    decision: "promote",
    reason: "thresholds passed",
    ruleResults: [{
      ruleId: "min-evidence",
      passed: true,
      actualValue: 6,
      threshold: 5,
    }],
    scoreSnapshot: makeScore({
      id: "snapshot-score-1",
      playbookId: null,
      versionNumber: null,
      sampleSize: 6,
    }),
    decidedAt: NOW,
    ...overrides,
  };
}

function makeLifecycleEvent(
  overrides: Partial<FridayPlaybookLifecycleEvent> = {},
): FridayPlaybookLifecycleEvent {
  return {
    id: "evt-1",
    playbookId: "pb-1",
    type: "rollback",
    reason: "integration-check",
    fromVersionNumber: 2,
    toVersionNumber: 1,
    occurredAt: NOW,
    ...overrides,
  };
}

describe("SQLite PlaybookStore integration", () => {
  let tmpDir = "";
  let dbPath = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-playbook-store-"));
    dbPath = path.join(tmpDir, "friday.db");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists playbook entities across sqlite layer restarts", () => {
    const db1 = createFridaySqliteLayer({
      dbPath,
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });
    const store1 = createSqlitePlaybookStore({ db: db1 });

    const candidate = makeCandidate();
    const playbook = makePlaybook();
    const version = makeVersion();
    const score = makeScore();
    const match = makeMatch();
    const decision = makeDecision();
    const event = makeLifecycleEvent();

    store1.saveCandidate(candidate);
    store1.savePlaybook(playbook);
    store1.saveVersion(version);
    store1.saveScore(score);
    store1.saveMatch(match);
    store1.saveDecision(decision);
    store1.saveLifecycleEvent(event);

    db1.close();

    const db2 = createFridaySqliteLayer({
      dbPath,
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
    });
    const store2 = createSqlitePlaybookStore({ db: db2 });

    expect(store2.getCandidate(candidate.id)).toEqual(candidate);
    expect(store2.getPlaybook(playbook.id)).toEqual(playbook);
    expect(store2.getVersion(version.id)).toEqual(version);
    expect(store2.getScore(score.id)).toEqual(score);
    expect(store2.getMatch(match.id)).toEqual(match);
    expect(store2.getDecision(decision.id)).toEqual(decision);
    expect(store2.getLifecycleEvent(event.id)).toEqual(event);

    // Validate sorted collection queries from persisted rows.
    expect(store2.getVersionsByPlaybookId(playbook.id).map((item) => item.id)).toEqual([version.id]);
    expect(store2.getScoresByPlaybookId(playbook.id).map((item) => item.id)).toEqual([score.id]);
    expect(store2.getMatchesByRunId(match.runId).map((item) => item.id)).toEqual([match.id]);
    expect(store2.getDecisionsByCandidateId(candidate.id).map((item) => item.id)).toEqual([decision.id]);
    expect(store2.getLifecycleEventsByPlaybookId(playbook.id).map((item) => item.id)).toEqual([event.id]);

    db2.close();
  });

  it("fails fast when v032 playbook tables are unavailable", () => {
    const db = createFridaySqliteLayer({
      dbPath,
      readPoolSize: 1,
      pragmas: { busyTimeoutMs: 5000, synchronous: "NORMAL" },
      runMigrations: false,
    });

    expect(() => createSqlitePlaybookStore({ db })).toThrowError("PLAYBOOK_TABLES_NOT_AVAILABLE");
    db.close();
  });
});

