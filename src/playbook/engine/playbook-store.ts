/**
 * Playbook Store — In-memory CRUD store for playbooks, candidates,
 * versions, scores, matches, and promotion decisions.
 *
 * Provides the persistence abstraction used by all other engine modules.
 * Uses in-memory Maps keyed by entity ID, with secondary indexes for
 * efficient lookup by workflow type, fingerprint, status, etc.
 *
 * @module playbook/engine
 */

import type {
  FridayPlaybook,
  FridayPlaybookCandidate,
  FridayPlaybookCandidateStatus,
  FridayPlaybookLifecycleEvent,
  FridayPlaybookMatch,
  FridayPlaybookScore,
  FridayPlaybookStatus,
  FridayPlaybookVersion,
  FridayPromotionDecision,
  UUID,
} from "../model/friday-playbook.types.js";

// ─── Store Interface ───

/** Read/write interface for playbook persistence. */
export interface PlaybookStore {
  // ─── Playbooks ───
  getPlaybook(id: UUID): FridayPlaybook | undefined;
  getPlaybooksByWorkflowType(workflowType: string, status?: FridayPlaybookStatus): FridayPlaybook[];
  getAllPlaybooks(status?: FridayPlaybookStatus): FridayPlaybook[];
  savePlaybook(playbook: FridayPlaybook): void;
  deletePlaybook(id: UUID): boolean;

  // ─── Candidates ───
  getCandidate(id: UUID): FridayPlaybookCandidate | undefined;
  getCandidateByFingerprint(
    fingerprint: string,
    workflowType?: string,
  ): FridayPlaybookCandidate | undefined;
  getCandidatesByStatus(status: FridayPlaybookCandidateStatus): FridayPlaybookCandidate[];
  getCandidatesByWorkflowType(workflowType: string): FridayPlaybookCandidate[];
  saveCandidate(candidate: FridayPlaybookCandidate): void;
  deleteCandidate(id: UUID): boolean;

  // ─── Versions ───
  getVersion(id: UUID): FridayPlaybookVersion | undefined;
  getVersionsByPlaybookId(playbookId: UUID): FridayPlaybookVersion[];
  getVersionByNumber(playbookId: UUID, versionNumber: number): FridayPlaybookVersion | undefined;
  getLatestVersion(playbookId: UUID): FridayPlaybookVersion | undefined;
  saveVersion(version: FridayPlaybookVersion): void;

  // ─── Scores ───
  getScore(id: UUID): FridayPlaybookScore | undefined;
  getScoresByPlaybookId(playbookId: UUID): FridayPlaybookScore[];
  getLatestScore(playbookId: UUID): FridayPlaybookScore | undefined;
  saveScore(score: FridayPlaybookScore): void;

  // ─── Matches (Selections) ───
  getMatch(id: UUID): FridayPlaybookMatch | undefined;
  getMatchesByPlaybookId(playbookId: UUID): FridayPlaybookMatch[];
  getMatchesByRunId(runId: UUID): FridayPlaybookMatch[];
  saveMatch(match: FridayPlaybookMatch): void;

  // ─── Promotion Decisions ───
  getDecision(id: UUID): FridayPromotionDecision | undefined;
  getDecisionsByCandidateId(candidateId: UUID): FridayPromotionDecision[];
  saveDecision(decision: FridayPromotionDecision): void;

  // ─── Lifecycle Events ───
  getLifecycleEvent(id: UUID): FridayPlaybookLifecycleEvent | undefined;
  getLifecycleEventsByPlaybookId(playbookId: UUID): FridayPlaybookLifecycleEvent[];
  saveLifecycleEvent(event: FridayPlaybookLifecycleEvent): void;
}

// ─── In-Memory Implementation ───

/** Create an in-memory playbook store. */
export function createPlaybookStore(): PlaybookStore {
  const playbooks = new Map<UUID, FridayPlaybook>();
  const candidates = new Map<UUID, FridayPlaybookCandidate>();
  const versions = new Map<UUID, FridayPlaybookVersion>();
  const scores = new Map<UUID, FridayPlaybookScore>();
  const matches = new Map<UUID, FridayPlaybookMatch>();
  const decisions = new Map<UUID, FridayPromotionDecision>();
  const lifecycleEvents = new Map<UUID, FridayPlaybookLifecycleEvent>();

  // Secondary indexes for candidate lookups.
  const fingerprintIndex = new Map<string, UUID>();
  const workflowFingerprintIndex = new Map<string, UUID>();

  function makeWorkflowFingerprintKey(workflowType: string, fingerprint: string): string {
    return `${workflowType}\u0000${fingerprint}`;
  }

  function removeCandidateIndexes(candidate: FridayPlaybookCandidate): void {
    const workflowFingerprintKey = makeWorkflowFingerprintKey(candidate.workflowType, candidate.fingerprint);
    if (workflowFingerprintIndex.get(workflowFingerprintKey) === candidate.id) {
      workflowFingerprintIndex.delete(workflowFingerprintKey);
    }

    if (fingerprintIndex.get(candidate.fingerprint) !== candidate.id) {
      return;
    }

    // Candidate owns the legacy fingerprint slot; remove and point to another
    // candidate with the same fingerprint if one exists.
    fingerprintIndex.delete(candidate.fingerprint);
    for (const existing of candidates.values()) {
      if (existing.id === candidate.id) continue;
      if (existing.fingerprint !== candidate.fingerprint) continue;
      fingerprintIndex.set(existing.fingerprint, existing.id);
      break;
    }
  }

  function setCandidateIndexes(candidate: FridayPlaybookCandidate): void {
    fingerprintIndex.set(candidate.fingerprint, candidate.id);
    workflowFingerprintIndex.set(
      makeWorkflowFingerprintKey(candidate.workflowType, candidate.fingerprint),
      candidate.id,
    );
  }

  return {
    // ─── Playbooks ───

    getPlaybook(id) {
      return playbooks.get(id);
    },

    getPlaybooksByWorkflowType(workflowType, status) {
      const result: FridayPlaybook[] = [];
      for (const pb of playbooks.values()) {
        if (pb.workflowType !== workflowType) continue;
        if (status !== undefined && pb.status !== status) continue;
        result.push(pb);
      }
      return result;
    },

    getAllPlaybooks(status) {
      const result: FridayPlaybook[] = [];
      for (const pb of playbooks.values()) {
        if (status !== undefined && pb.status !== status) continue;
        result.push(pb);
      }
      return result;
    },

    savePlaybook(playbook) {
      playbooks.set(playbook.id, playbook);
    },

    deletePlaybook(id) {
      return playbooks.delete(id);
    },

    // ─── Candidates ───

    getCandidate(id) {
      return candidates.get(id);
    },

    getCandidateByFingerprint(fingerprint, workflowType) {
      const id = workflowType === undefined
        ? fingerprintIndex.get(fingerprint)
        : workflowFingerprintIndex.get(makeWorkflowFingerprintKey(workflowType, fingerprint));
      return id !== undefined ? candidates.get(id) : undefined;
    },

    getCandidatesByStatus(status) {
      const result: FridayPlaybookCandidate[] = [];
      for (const c of candidates.values()) {
        if (c.status === status) result.push(c);
      }
      return result;
    },

    getCandidatesByWorkflowType(workflowType) {
      const result: FridayPlaybookCandidate[] = [];
      for (const c of candidates.values()) {
        if (c.workflowType === workflowType) result.push(c);
      }
      return result;
    },

    saveCandidate(candidate) {
      const existing = candidates.get(candidate.id);
      if (existing) {
        removeCandidateIndexes(existing);
      }
      candidates.set(candidate.id, candidate);
      setCandidateIndexes(candidate);
    },

    deleteCandidate(id) {
      const candidate = candidates.get(id);
      if (candidate) {
        removeCandidateIndexes(candidate);
      }
      return candidates.delete(id);
    },

    // ─── Versions ───

    getVersion(id) {
      return versions.get(id);
    },

    getVersionsByPlaybookId(playbookId) {
      const result: FridayPlaybookVersion[] = [];
      for (const v of versions.values()) {
        if (v.playbookId === playbookId) result.push(v);
      }
      return result.sort((a, b) => a.versionNumber - b.versionNumber);
    },

    getVersionByNumber(playbookId, versionNumber) {
      for (const v of versions.values()) {
        if (v.playbookId === playbookId && v.versionNumber === versionNumber) return v;
      }
      return undefined;
    },

    getLatestVersion(playbookId) {
      let latest: FridayPlaybookVersion | undefined;
      for (const v of versions.values()) {
        if (v.playbookId !== playbookId) continue;
        if (!latest || v.versionNumber > latest.versionNumber) latest = v;
      }
      return latest;
    },

    saveVersion(version) {
      versions.set(version.id, version);
    },

    // ─── Scores ───

    getScore(id) {
      return scores.get(id);
    },

    getScoresByPlaybookId(playbookId) {
      const result: FridayPlaybookScore[] = [];
      for (const s of scores.values()) {
        if (s.playbookId === playbookId) result.push(s);
      }
      return result.sort((a, b) => a.calculatedAt.localeCompare(b.calculatedAt));
    },

    getLatestScore(playbookId) {
      let latest: FridayPlaybookScore | undefined;
      for (const s of scores.values()) {
        if (s.playbookId !== playbookId) continue;
        if (!latest || s.calculatedAt > latest.calculatedAt) latest = s;
      }
      return latest;
    },

    saveScore(score) {
      scores.set(score.id, score);
    },

    // ─── Matches ───

    getMatch(id) {
      return matches.get(id);
    },

    getMatchesByPlaybookId(playbookId) {
      const result: FridayPlaybookMatch[] = [];
      for (const m of matches.values()) {
        if (m.playbookId === playbookId) result.push(m);
      }
      return result;
    },

    getMatchesByRunId(runId) {
      const result: FridayPlaybookMatch[] = [];
      for (const m of matches.values()) {
        if (m.runId === runId) result.push(m);
      }
      return result;
    },

    saveMatch(match) {
      matches.set(match.id, match);
    },

    // ─── Decisions ───

    getDecision(id) {
      return decisions.get(id);
    },

    getDecisionsByCandidateId(candidateId) {
      const result: FridayPromotionDecision[] = [];
      for (const d of decisions.values()) {
        if (d.candidateId === candidateId) result.push(d);
      }
      return result.sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
    },

    saveDecision(decision) {
      decisions.set(decision.id, decision);
    },

    // ─── Lifecycle Events ───

    getLifecycleEvent(id) {
      return lifecycleEvents.get(id);
    },

    getLifecycleEventsByPlaybookId(playbookId) {
      const result: FridayPlaybookLifecycleEvent[] = [];
      for (const event of lifecycleEvents.values()) {
        if (event.playbookId === playbookId) result.push(event);
      }
      return result.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    },

    saveLifecycleEvent(event) {
      lifecycleEvents.set(event.id, event);
    },
  };
}
