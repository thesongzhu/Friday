import { describe, it, expect, vi, beforeEach } from "vitest";

import { createFridayWorkflowGenerationSessionRepository } from "#workflows";
import type {
  FridayWorkflowGenerationSession,
  FridayWorkflowGenerationTurn,
  FridayWorkflowGenerationSessionRepository,
} from "#workflows";
import type { FridaySqliteLayer } from "#state";

// ─── In-memory mock DB ───

function makeMockDb(): FridaySqliteLayer {
  const store = new Map<string, {
    id: string;
    namespace: string;
    key: string;
    value_json: string;
    tags_json: string;
    created_at: string;
    updated_at: string;
  }>();

  function makeDb() {
    return {
      prepare: vi.fn((sql: string) => {
        if (sql.startsWith("INSERT INTO memory_items")) {
          return {
            run: vi.fn(
              (
                id: string,
                namespace: string,
                key: string,
                valueJson: string,
                tagsJson: string,
                createdAt: string,
                updatedAt: string,
              ) => {
                const storeKey = `${namespace}:${key}`;
                const existing = store.get(storeKey);
                store.set(storeKey, {
                  id: existing ? existing.id : id,
                  namespace,
                  key,
                  value_json: valueJson,
                  tags_json: tagsJson,
                  created_at: existing ? existing.created_at : createdAt,
                  updated_at: updatedAt,
                });
              },
            ),
          };
        }
        if (sql.startsWith("SELECT * FROM memory_items WHERE namespace = ? AND key = ?")) {
          return {
            get: vi.fn((namespace: string, key: string) => {
              return store.get(`${namespace}:${key}`) ?? undefined;
            }),
          };
        }
        if (sql.includes("key LIKE ?") && sql.includes("ORDER BY")) {
          return {
            all: vi.fn((namespace: string, keyPrefix: string) => {
              const prefix = keyPrefix.replace(/%$/, "");
              const results: unknown[] = [];
              for (const [, row] of store.entries()) {
                if (row.namespace === namespace && row.key.startsWith(prefix)) {
                  results.push(row);
                }
              }
              return results;
            }),
          };
        }
        if (sql.startsWith("DELETE FROM memory_items WHERE namespace = ? AND key = ?")) {
          return {
            run: vi.fn((namespace: string, key: string) => {
              store.delete(`${namespace}:${key}`);
            }),
          };
        }
        if (sql.startsWith("DELETE FROM memory_items WHERE namespace = ? AND key LIKE ?")) {
          return {
            run: vi.fn((namespace: string, keyPrefix: string) => {
              const prefix = keyPrefix.replace(/%$/, "");
              for (const storeKey of [...store.keys()]) {
                const row = store.get(storeKey);
                if (row && row.namespace === namespace && row.key.startsWith(prefix)) {
                  store.delete(storeKey);
                }
              }
            }),
          };
        }
        return {
          run: vi.fn(),
          get: vi.fn(() => undefined),
          all: vi.fn(() => []),
        };
      }),
    };
  }

  const db = makeDb();

  return {
    withReadConnection: vi.fn((fn: (db: unknown) => unknown) => fn(db)),
    withWriteTransaction: vi.fn((fn: (db: unknown) => void) => fn(db)),
  } as unknown as FridaySqliteLayer;
}

// ─── Tests ───

const NOW = "2026-02-18T10:00:00.000Z";

describe("FridayWorkflowGenerationSessionRepository", () => {
  let repo: FridayWorkflowGenerationSessionRepository;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    const db = makeMockDb();
    repo = createFridayWorkflowGenerationSessionRepository({
      db,
      idGenerator: () => `id-${++idCounter}`,
      nowIso: () => NOW,
    });
  });

  function makeSession(overrides?: Partial<FridayWorkflowGenerationSession>): FridayWorkflowGenerationSession {
    return {
      sessionId: "s-1",
      userId: "u-1",
      channel: "test",
      status: "collecting_requirements",
      goal: "Build a workflow",
      requirementsSummary: "",
      openQuestions: [],
      decisions: [],
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("creates and retrieves a session", () => {
    const session = makeSession();
    repo.createSession(session);
    const fetched = repo.getSession("s-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.sessionId).toBe("s-1");
    expect(fetched!.goal).toBe("Build a workflow");
  });

  it("returns null for non-existent session", () => {
    const result = repo.getSession("nonexistent");
    expect(result).toBeNull();
  });

  it("updates a session", () => {
    const session = makeSession();
    repo.createSession(session);
    const updated = { ...session, status: "needs_clarification" as const, openQuestions: ["Q1"] };
    repo.updateSession(updated);
    const fetched = repo.getSession("s-1");
    expect(fetched!.status).toBe("needs_clarification");
    expect(fetched!.openQuestions).toEqual(["Q1"]);
  });

  it("throws when updating non-existent session", () => {
    expect(() =>
      repo.updateSession(makeSession({ sessionId: "nonexistent" })),
    ).toThrow("Session not found");
  });

  it("deletes a session and its turns", () => {
    repo.createSession(makeSession());
    const turn: FridayWorkflowGenerationTurn = {
      turnId: "t-1",
      sessionId: "s-1",
      role: "user",
      content: "hello",
      createdAt: NOW,
    };
    repo.addTurn(turn);
    expect(repo.getSession("s-1")).not.toBeNull();
    expect(repo.getTurns("s-1")).toHaveLength(1);

    repo.deleteSession("s-1");
    expect(repo.getSession("s-1")).toBeNull();
    expect(repo.getTurns("s-1")).toHaveLength(0);
  });

  it("adds and retrieves turns in order", () => {
    repo.createSession(makeSession());
    const t1: FridayWorkflowGenerationTurn = {
      turnId: "t-1",
      sessionId: "s-1",
      role: "user",
      content: "first",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const t2: FridayWorkflowGenerationTurn = {
      turnId: "t-2",
      sessionId: "s-1",
      role: "assistant",
      content: "second",
      createdAt: "2026-01-01T00:00:01.000Z",
    };
    repo.addTurn(t1);
    repo.addTurn(t2);

    const turns = repo.getTurns("s-1");
    expect(turns).toHaveLength(2);
    expect(turns[0].content).toBe("first");
    expect(turns[1].content).toBe("second");
  });

  it("isolates sessions by ID", () => {
    repo.createSession(makeSession({ sessionId: "s-1" }));
    repo.createSession(makeSession({ sessionId: "s-2", goal: "Other goal" }));

    repo.addTurn({
      turnId: "t-1",
      sessionId: "s-1",
      role: "user",
      content: "for s-1",
      createdAt: NOW,
    });
    repo.addTurn({
      turnId: "t-2",
      sessionId: "s-2",
      role: "user",
      content: "for s-2",
      createdAt: NOW,
    });

    const s1Turns = repo.getTurns("s-1");
    const s2Turns = repo.getTurns("s-2");
    expect(s1Turns).toHaveLength(1);
    expect(s1Turns[0].content).toBe("for s-1");
    expect(s2Turns).toHaveLength(1);
    expect(s2Turns[0].content).toBe("for s-2");
  });
});
