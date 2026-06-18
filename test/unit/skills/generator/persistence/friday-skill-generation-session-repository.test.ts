import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { FridaySqliteLayer } from "#state";
import type {
  FridaySkillGenerationSession,
  FridaySkillGenerationTurn,
} from "#skills/generator";
import {
  createFridaySkillGenerationSessionRepository,
} from "#skills/generator";
import { createTestDb, createTestIdGenerator } from "../../../satellites/_helpers/create-test-db.helper.js";

import type { FridaySkillGenerationSessionRepository } from "#skills/generator";

describe("FridaySkillGenerationSessionRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridaySkillGenerationSessionRepository;
  let idGen: () => string;
  const NOW = "2025-02-17T00:00:00.000Z";

  const baseSession: FridaySkillGenerationSession = {
    sessionId: "sess-001",
    userId: "user-1",
    channel: "discord",
    status: "collecting_requirements",
    goal: "Build a timer skill",
    specSummary: "",
    openQuestions: [],
    decisions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
    repo = createFridaySkillGenerationSessionRepository({
      db,
      idGenerator: idGen,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("createSession and getSession roundtrip", () => {
    repo.createSession(baseSession);
    const retrieved = repo.getSession("sess-001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.sessionId).toBe("sess-001");
    expect(retrieved!.goal).toBe("Build a timer skill");
    expect(retrieved!.status).toBe("collecting_requirements");
  });

  it("getSession returns null for nonexistent session", () => {
    const result = repo.getSession("nonexistent");
    expect(result).toBeNull();
  });

  it("updateSession modifies existing session", () => {
    repo.createSession(baseSession);
    const updated: FridaySkillGenerationSession = {
      ...baseSession,
      status: "needs_clarification",
      openQuestions: ["What duration?"],
      updatedAt: "2025-02-17T01:00:00.000Z",
    };
    repo.updateSession(updated);

    const retrieved = repo.getSession("sess-001");
    expect(retrieved!.status).toBe("needs_clarification");
    expect(retrieved!.openQuestions).toEqual(["What duration?"]);
  });

  it("updateSession throws for nonexistent session", () => {
    expect(() =>
      repo.updateSession({ ...baseSession, sessionId: "nonexistent" }),
    ).toThrow("Session not found");
  });

  it("addTurn and getTurns roundtrip", () => {
    repo.createSession(baseSession);

    const turn1: FridaySkillGenerationTurn = {
      turnId: "turn-001",
      sessionId: "sess-001",
      role: "user",
      content: "I want a timer",
      createdAt: NOW,
    };
    const turn2: FridaySkillGenerationTurn = {
      turnId: "turn-002",
      sessionId: "sess-001",
      role: "assistant",
      content: "What duration?",
      createdAt: NOW,
    };

    repo.addTurn(turn1);
    repo.addTurn(turn2);

    const turns = repo.getTurns("sess-001");
    expect(turns).toHaveLength(2);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
  });

  it("getTurns returns empty array for session with no turns", () => {
    const turns = repo.getTurns("sess-001");
    expect(turns).toEqual([]);
  });

  it("deleteSession removes session and all turns", () => {
    repo.createSession(baseSession);
    repo.addTurn({
      turnId: "turn-001",
      sessionId: "sess-001",
      role: "user",
      content: "Hello",
      createdAt: NOW,
    });

    repo.deleteSession("sess-001");
    expect(repo.getSession("sess-001")).toBeNull();
    expect(repo.getTurns("sess-001")).toEqual([]);
  });

  it("deleteSession does not mutate legacy memory_items fallback rows", () => {
    db.withWriteTransaction((writer) => {
      writer.prepare(
        "INSERT INTO memory_items (id, namespace, key, value_json, tags_json, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?)",
      ).run(
        "legacy-session",
        "skill-generator-session",
        "sess-legacy",
        JSON.stringify(baseSession),
        NOW,
        NOW,
      );
    });

    repo.deleteSession("sess-legacy");

    const row = db.withReadConnection((reader) =>
      reader
        .prepare("SELECT COUNT(*) AS count FROM memory_items WHERE namespace = ? AND key = ?")
        .get("skill-generator-session", "sess-legacy"),
    ) as { count: number };
    expect(row.count).toBe(1);
  });

  it("getTurns for one session does not return turns from another", () => {
    repo.createSession(baseSession);
    const session2: FridaySkillGenerationSession = {
      ...baseSession,
      sessionId: "sess-002",
    };
    repo.createSession(session2);

    repo.addTurn({
      turnId: "turn-a1",
      sessionId: "sess-001",
      role: "user",
      content: "Session 1 turn",
      createdAt: NOW,
    });
    repo.addTurn({
      turnId: "turn-b1",
      sessionId: "sess-002",
      role: "user",
      content: "Session 2 turn",
      createdAt: NOW,
    });

    const turns1 = repo.getTurns("sess-001");
    expect(turns1).toHaveLength(1);
    expect(turns1[0].content).toBe("Session 1 turn");

    const turns2 = repo.getTurns("sess-002");
    expect(turns2).toHaveLength(1);
    expect(turns2[0].content).toBe("Session 2 turn");
  });

  it("deleteSession for one session does not affect another", () => {
    repo.createSession(baseSession);
    const session2: FridaySkillGenerationSession = {
      ...baseSession,
      sessionId: "sess-002",
    };
    repo.createSession(session2);
    repo.addTurn({
      turnId: "turn-b1",
      sessionId: "sess-002",
      role: "user",
      content: "Kept",
      createdAt: NOW,
    });

    repo.deleteSession("sess-001");
    expect(repo.getSession("sess-002")).not.toBeNull();
    expect(repo.getTurns("sess-002")).toHaveLength(1);
  });

  it("session with draftSkillId roundtrips correctly", () => {
    const session: FridaySkillGenerationSession = {
      ...baseSession,
      draftSkillId: "skill-timer-v1",
      status: "ready_for_review",
    };
    repo.createSession(session);

    const retrieved = repo.getSession("sess-001");
    expect(retrieved!.draftSkillId).toBe("skill-timer-v1");
  });
});
