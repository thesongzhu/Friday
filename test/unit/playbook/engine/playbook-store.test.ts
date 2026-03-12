import { describe, it, expect, beforeEach } from "vitest";
import { createPlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type { PlaybookStore } from "../../../../src/playbook/engine/playbook-store.js";
import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookVersion,
  FridayPlaybookScore,
  FridayPlaybookMatch,
  FridayPromotionDecision,
  FridayPlaybookLifecycleEvent,
} from "../../../../src/playbook/model/friday-playbook.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T10:00:00.000Z";

function makePlaybook(overrides: Partial<FridayPlaybook> = {}): FridayPlaybook {
  return {
    id: "pb-1",
    name: "test-playbook",
    workflowType: "data-pipeline",
    tags: ["etl"],
    status: "active",
    activeVersionNumber: 1,
    sourceCandidateId: "cand-1",
    compositeScore: 0.85,
    totalUses: 10,
    totalSuccesses: 9,
    etag: "etag-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<FridayPlaybookCandidate> = {}): FridayPlaybookCandidate {
  return {
    id: "cand-1",
    fingerprint: "abc123",
    workflowType: "data-pipeline",
    tags: ["etl"],
    pattern: { nodeSequence: [] },
    status: "observed",
    evidenceCount: 1,
    successCount: 1,
    failureCount: 0,
    totalDurationMs: 1000,
    totalCost: { tokenCost: 100, apiCallCost: 5, latencyMs: 500 },
    sourceRunIds: ["run-1"],
    firstObservedAt: NOW,
    lastObservedAt: NOW,
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
    fingerprint: "abc123",
    pattern: { nodeSequence: [] },
    candidateId: "cand-1",
    changeNote: "Initial version.",
    createdAt: NOW,
    ...overrides,
  };
}

function makeScore(overrides: Partial<FridayPlaybookScore> = {}): FridayPlaybookScore {
  return {
    id: "score-1",
    playbookId: "pb-1",
    versionNumber: 1,
    compositeScore: 0.85,
    successRate: 0.9,
    speedScore: 0.7,
    costEfficiencyScore: 0.8,
    satisfactionScore: 0.6,
    sampleSize: 10,
    calculatedAt: NOW,
    ...overrides,
  };
}

function makeMatch(overrides: Partial<FridayPlaybookMatch> = {}): FridayPlaybookMatch {
  return {
    id: "match-1",
    runId: "run-1",
    workflowId: "wf-1",
    playbookId: "pb-1",
    versionNumber: 1,
    matchScore: 0.85,
    similarity: 0.9,
    reason: "matched",
    context: {
      workflowType: "data-pipeline",
      workflowId: "wf-1",
      runId: "run-1",
      nodeSequence: [],
      tags: ["etl"],
    },
    selectedAt: NOW,
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
    reason: "Regression",
    fromVersionNumber: 2,
    toVersionNumber: 1,
    occurredAt: NOW,
    ...overrides,
  };
}

// ─── Tests ───

describe("PlaybookStore", () => {
  let store: PlaybookStore;

  beforeEach(() => {
    store = createPlaybookStore();
  });

  describe("Playbooks", () => {
    it("saves and retrieves a playbook by ID", () => {
      const pb = makePlaybook();
      store.savePlaybook(pb);
      expect(store.getPlaybook("pb-1")).toEqual(pb);
    });

    it("returns undefined for non-existent playbook", () => {
      expect(store.getPlaybook("nonexistent")).toBeUndefined();
    });

    it("filters playbooks by workflow type", () => {
      store.savePlaybook(makePlaybook({ id: "pb-1", workflowType: "etl" }));
      store.savePlaybook(makePlaybook({ id: "pb-2", workflowType: "ml" }));
      store.savePlaybook(makePlaybook({ id: "pb-3", workflowType: "etl" }));

      expect(store.getPlaybooksByWorkflowType("etl")).toHaveLength(2);
      expect(store.getPlaybooksByWorkflowType("ml")).toHaveLength(1);
      expect(store.getPlaybooksByWorkflowType("unknown")).toHaveLength(0);
    });

    it("filters playbooks by workflow type and status", () => {
      store.savePlaybook(makePlaybook({ id: "pb-1", workflowType: "etl", status: "active" }));
      store.savePlaybook(makePlaybook({ id: "pb-2", workflowType: "etl", status: "archived" }));

      expect(store.getPlaybooksByWorkflowType("etl", "active")).toHaveLength(1);
      expect(store.getPlaybooksByWorkflowType("etl", "archived")).toHaveLength(1);
    });

    it("lists all playbooks with optional status filter", () => {
      store.savePlaybook(makePlaybook({ id: "pb-1", status: "active" }));
      store.savePlaybook(makePlaybook({ id: "pb-2", status: "archived" }));

      expect(store.getAllPlaybooks()).toHaveLength(2);
      expect(store.getAllPlaybooks("active")).toHaveLength(1);
    });

    it("deletes a playbook", () => {
      store.savePlaybook(makePlaybook());
      expect(store.deletePlaybook("pb-1")).toBe(true);
      expect(store.getPlaybook("pb-1")).toBeUndefined();
      expect(store.deletePlaybook("pb-1")).toBe(false);
    });
  });

  describe("Candidates", () => {
    it("saves and retrieves by ID and fingerprint", () => {
      const cand = makeCandidate();
      store.saveCandidate(cand);

      expect(store.getCandidate("cand-1")).toEqual(cand);
      expect(store.getCandidateByFingerprint("abc123")).toEqual(cand);
    });

    it("returns undefined for unknown fingerprint", () => {
      expect(store.getCandidateByFingerprint("unknown")).toBeUndefined();
    });

    it("filters by status", () => {
      store.saveCandidate(makeCandidate({ id: "c1", fingerprint: "f1", status: "observed" }));
      store.saveCandidate(makeCandidate({ id: "c2", fingerprint: "f2", status: "pending" }));
      store.saveCandidate(makeCandidate({ id: "c3", fingerprint: "f3", status: "observed" }));

      expect(store.getCandidatesByStatus("observed")).toHaveLength(2);
      expect(store.getCandidatesByStatus("pending")).toHaveLength(1);
    });

    it("filters by workflow type", () => {
      store.saveCandidate(makeCandidate({ id: "c1", fingerprint: "f1", workflowType: "etl" }));
      store.saveCandidate(makeCandidate({ id: "c2", fingerprint: "f2", workflowType: "ml" }));

      expect(store.getCandidatesByWorkflowType("etl")).toHaveLength(1);
    });

    it("cleans up fingerprint index on delete", () => {
      store.saveCandidate(makeCandidate());
      store.deleteCandidate("cand-1");
      expect(store.getCandidateByFingerprint("abc123")).toBeUndefined();
    });

    it("cleans up stale fingerprint mapping when a candidate fingerprint changes", () => {
      store.saveCandidate(makeCandidate({ id: "cand-1", fingerprint: "old-fp" }));
      store.saveCandidate(makeCandidate({ id: "cand-1", fingerprint: "new-fp" }));

      expect(store.getCandidateByFingerprint("old-fp")).toBeUndefined();
      expect(store.getCandidateByFingerprint("new-fp")?.id).toBe("cand-1");
    });

    it("supports workflow-scoped fingerprint lookup", () => {
      store.saveCandidate(makeCandidate({ id: "c1", workflowType: "etl", fingerprint: "same-fp" }));
      store.saveCandidate(makeCandidate({ id: "c2", workflowType: "ml", fingerprint: "same-fp" }));

      expect(store.getCandidateByFingerprint("same-fp", "etl")?.id).toBe("c1");
      expect(store.getCandidateByFingerprint("same-fp", "ml")?.id).toBe("c2");
    });
  });

  describe("Versions", () => {
    it("saves and retrieves versions sorted by version number", () => {
      store.saveVersion(makeVersion({ id: "v2", versionNumber: 2 }));
      store.saveVersion(makeVersion({ id: "v1", versionNumber: 1 }));

      const versions = store.getVersionsByPlaybookId("pb-1");
      expect(versions).toHaveLength(2);
      expect(versions[0].versionNumber).toBe(1);
      expect(versions[1].versionNumber).toBe(2);
    });

    it("retrieves version by number", () => {
      store.saveVersion(makeVersion({ id: "v1", versionNumber: 1 }));
      store.saveVersion(makeVersion({ id: "v2", versionNumber: 2 }));

      expect(store.getVersionByNumber("pb-1", 2)?.id).toBe("v2");
      expect(store.getVersionByNumber("pb-1", 3)).toBeUndefined();
    });

    it("gets latest version", () => {
      store.saveVersion(makeVersion({ id: "v1", versionNumber: 1 }));
      store.saveVersion(makeVersion({ id: "v3", versionNumber: 3 }));
      store.saveVersion(makeVersion({ id: "v2", versionNumber: 2 }));

      expect(store.getLatestVersion("pb-1")?.versionNumber).toBe(3);
    });
  });

  describe("Scores", () => {
    it("saves and retrieves scores sorted by calculatedAt", () => {
      store.saveScore(makeScore({ id: "s2", calculatedAt: "2026-02-24T12:00:00.000Z" }));
      store.saveScore(makeScore({ id: "s1", calculatedAt: "2026-02-24T10:00:00.000Z" }));

      const scores = store.getScoresByPlaybookId("pb-1");
      expect(scores).toHaveLength(2);
      expect(scores[0].id).toBe("s1");
    });

    it("gets latest score", () => {
      store.saveScore(makeScore({ id: "s1", calculatedAt: "2026-02-24T10:00:00.000Z" }));
      store.saveScore(makeScore({ id: "s2", calculatedAt: "2026-02-24T12:00:00.000Z" }));

      expect(store.getLatestScore("pb-1")?.id).toBe("s2");
    });
  });

  describe("Matches", () => {
    it("retrieves by playbook ID and run ID", () => {
      store.saveMatch(makeMatch({ id: "m1", playbookId: "pb-1", runId: "run-1" }));
      store.saveMatch(makeMatch({ id: "m2", playbookId: "pb-1", runId: "run-2" }));
      store.saveMatch(makeMatch({ id: "m3", playbookId: "pb-2", runId: "run-1" }));

      expect(store.getMatchesByPlaybookId("pb-1")).toHaveLength(2);
      expect(store.getMatchesByRunId("run-1")).toHaveLength(2);
    });
  });

  describe("Decisions", () => {
    it("retrieves decisions by candidate ID sorted by decidedAt", () => {
      const decision: FridayPromotionDecision = {
        id: "dec-1",
        candidateId: "cand-1",
        decision: "defer",
        reason: "Not enough evidence.",
        ruleResults: [],
        scoreSnapshot: makeScore(),
        decidedAt: NOW,
      };

      store.saveDecision(decision);
      expect(store.getDecisionsByCandidateId("cand-1")).toHaveLength(1);
      expect(store.getDecision("dec-1")).toEqual(decision);
    });
  });

  describe("Lifecycle Events", () => {
    it("saves and retrieves lifecycle events by ID", () => {
      const event = makeLifecycleEvent();
      store.saveLifecycleEvent(event);
      expect(store.getLifecycleEvent("evt-1")).toEqual(event);
    });

    it("lists lifecycle events for a playbook sorted by occurredAt", () => {
      store.saveLifecycleEvent(makeLifecycleEvent({ id: "evt-2", occurredAt: "2026-02-24T12:00:00.000Z" }));
      store.saveLifecycleEvent(makeLifecycleEvent({ id: "evt-1", occurredAt: "2026-02-24T10:00:00.000Z" }));

      const events = store.getLifecycleEventsByPlaybookId("pb-1");
      expect(events).toHaveLength(2);
      expect(events[0].id).toBe("evt-1");
      expect(events[1].id).toBe("evt-2");
    });
  });
});
