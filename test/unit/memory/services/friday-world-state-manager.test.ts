import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, createTestIdGenerator } from "../../../helpers/friday-test-db.helper.js";
import { createFridayWorldStateManager } from "../../../../src/agent/runtime/friday-agent-world-state-manager.js";
import type { FridaySqliteLayer } from "#state";
import type { FridayEpisode } from "#agent";

describe("FridayWorldStateManager", () => {
  let db: FridaySqliteLayer;
  let idGen: () => string;
  const nowIso = () => "2026-03-29T00:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    idGen = createTestIdGenerator();
  });

  afterEach(() => {
    db.close();
  });

  function makeEpisode(overrides: Partial<FridayEpisode> = {}): FridayEpisode {
    return {
      id: idGen(),
      userId: "user-1",
      runId: "run-1",
      taskIntent: 'Deploy the "MyProject" app to Production server',
      outcome: "success",
      steps: [
        { seq: 0, action: "read", category: "read", observation: "text", durationMs: 100 },
        { seq: 1, action: "exec", category: "mutate", observation: "text", durationMs: 200 },
      ],
      toolSequence: ["read", "exec"],
      durationMs: 300,
      contextFiles: [],
      createdAt: "2026-03-29T00:00:00.000Z",
      ...overrides,
    };
  }

  it("loadState returns empty state when no data exists", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });
    const state = await mgr.loadState("user-1");

    expect(state.userId).toBe("user-1");
    expect(state.entities).toEqual([]);
    expect(state.recentActions).toEqual([]);
    expect(state.activeGoals).toEqual([]);
    expect(state.preferences).toEqual({});
    expect(state.environmentFacts).toEqual({});
  });

  it("updateFromEpisode extracts entities from task intent", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });
    const episode = makeEpisode();

    await mgr.updateFromEpisode("user-1", episode);

    // Check entities were created
    const entities = db.withReadConnection((conn) =>
      conn
        .prepare("SELECT * FROM friday_world_entities WHERE user_id = ?")
        .all("user-1") as Array<{ name: string; mention_count: number }>,
    );

    // Should extract "MyProject" (quoted) and "Production" (capitalized)
    const names = entities.map((e) => e.name);
    expect(names).toContain("MyProject");
    expect(names).toContain("Production");
  });

  it("updateFromEpisode increments mention_count for existing entities", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });

    // Two episodes mentioning the same entity
    await mgr.updateFromEpisode("user-1", makeEpisode());
    await mgr.updateFromEpisode("user-1", makeEpisode({ id: idGen(), runId: "run-2" }));

    const entity = db.withReadConnection((conn) =>
      conn
        .prepare("SELECT mention_count FROM friday_world_entities WHERE user_id = ? AND name = ?")
        .get("user-1", "MyProject") as { mention_count: number } | undefined,
    );

    expect(entity).toBeDefined();
    expect(entity!.mention_count).toBe(2);
  });

  it("saveSnapshot persists and loadState retrieves it", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });

    const state = await mgr.loadState("user-1");
    state.activeGoals = ["deploy v2"];
    state.preferences = { theme: "dark" };

    await mgr.saveSnapshot(state);

    // Load again — should get the snapshot
    const loaded = await mgr.loadState("user-1");
    expect(loaded.activeGoals).toEqual(["deploy v2"]);
    expect(loaded.preferences).toEqual({ theme: "dark" });
  });

  it("saveSnapshot keeps only last 10 snapshots per user", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });

    // Save 12 snapshots
    for (let i = 0; i < 12; i++) {
      await mgr.saveSnapshot({
        userId: "user-1",
        entities: [],
        recentActions: [],
        activeGoals: [`goal-${i}`],
        preferences: {},
        environmentFacts: {},
        lastUpdated: nowIso(),
      });
    }

    const count = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as c FROM friday_world_state_snapshots WHERE user_id = ?").get("user-1") as { c: number }).c,
    );

    expect(count).toBe(10);
  });

  it("getRecentEpisodes returns episodes in descending order", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });

    // Seed episodes directly
    db.withWriteTransaction((conn) => {
      for (let i = 0; i < 3; i++) {
        conn
          .prepare(
            `INSERT INTO friday_episodes
               (id, user_id, run_id, task_intent, outcome, steps_json,
                tool_sequence_json, duration_ms, context_files_json, created_at)
             VALUES (?, 'user-1', ?, ?, 'success', '[]', '[]', 100, '[]', ?)`,
          )
          .run(
            idGen(),
            `run-${i}`,
            `task ${i}`,
            `2026-03-2${i}T00:00:00.000Z`,
          );
      }
    });

    const episodes = await mgr.getRecentEpisodes("user-1", 10);
    expect(episodes).toHaveLength(3);
    // Most recent first
    expect(episodes[0].taskIntent).toBe("task 2");
    expect(episodes[2].taskIntent).toBe("task 0");
  });

  it("updateFromEpisode persists a world state snapshot", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });
    const episode = makeEpisode();

    await mgr.updateFromEpisode("user-1", episode);

    const count = db.withReadConnection((conn) =>
      (conn.prepare("SELECT COUNT(*) as c FROM friday_world_state_snapshots WHERE user_id = ?").get("user-1") as { c: number }).c,
    );
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("updateFromEpisode prunes stale entities older than 90 days with low mention count", async () => {
    const mgr = createFridayWorldStateManager({ db, idGenerator: idGen, nowIso });

    // Seed an old entity with low mention count
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_world_entities
             (id, user_id, type, name, attributes_json, relations_json,
              last_mentioned, mention_count, created_at, updated_at)
           VALUES (?, 'user-1', 'concept', 'OldThing', '{}', '[]', '2025-01-01T00:00:00.000Z', 1, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
        )
        .run(idGen());
    });

    // Seed an old entity with HIGH mention count (should survive)
    db.withWriteTransaction((conn) => {
      conn
        .prepare(
          `INSERT INTO friday_world_entities
             (id, user_id, type, name, attributes_json, relations_json,
              last_mentioned, mention_count, created_at, updated_at)
           VALUES (?, 'user-1', 'concept', 'ImportantThing', '{}', '[]', '2025-01-01T00:00:00.000Z', 5, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`,
        )
        .run(idGen());
    });

    await mgr.updateFromEpisode("user-1", makeEpisode());

    const entities = db.withReadConnection((conn) =>
      conn
        .prepare("SELECT name FROM friday_world_entities WHERE user_id = ?")
        .all("user-1") as Array<{ name: string }>,
    );
    const names = entities.map((e) => e.name);

    // OldThing should be pruned (mention_count=1, >90 days old)
    expect(names).not.toContain("OldThing");
    // ImportantThing should survive (mention_count=5)
    expect(names).toContain("ImportantThing");
  });
});
