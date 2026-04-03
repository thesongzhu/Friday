import { describe, it, expect } from "vitest";
import { createTestDb } from "../../../helpers/friday-test-db.helper.js";
import { createFridayPatternExtractor } from "../../../../src/memory/services/friday-pattern-extractor.js";

function insertEpisode(
  db: ReturnType<typeof createTestDb>,
  opts: {
    id: string;
    userId: string;
    taskIntent: string;
    outcome?: string;
    toolSequence?: string[];
    steps?: Array<{ seq: number; action: string; observation: string }>;
    createdAt?: string;
  },
) {
  db.withWriteTransaction((conn) => {
    conn
      .prepare(
        `INSERT INTO friday_episodes
           (id, user_id, run_id, task_intent, task_profile, outcome, steps_json, tool_sequence_json, duration_ms, context_files_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.id,
        opts.userId,
        `run-${opts.id}`,
        opts.taskIntent,
        null,
        opts.outcome ?? "success",
        JSON.stringify(opts.steps ?? []),
        JSON.stringify(opts.toolSequence ?? []),
        1000,
        "[]",
        opts.createdAt ?? new Date().toISOString(),
      );
  });
}

describe("FridayPatternExtractor", () => {
  it("returns empty array when no episodes exist", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });
      const refreshed = await extractor.refreshPatterns("user-1", 10);
      const listed = await extractor.listPatterns("user-1", 10);
      expect(refreshed).toEqual([]);
      expect(listed).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("extracts tool sequence trigram patterns", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      // Insert 3 episodes with the same tool sequence trigram
      for (let i = 0; i < 3; i++) {
        insertEpisode(db, {
          id: `ep-seq-${i}`,
          userId: "user-1",
          taskIntent: "read and fix file",
          toolSequence: ["read", "edit", "write"],
        });
      }

      const patterns = await extractor.refreshPatterns("user-1");
      const seqPatterns = patterns.filter((p) => p.kind === "tool_sequence");
      expect(seqPatterns.length).toBeGreaterThanOrEqual(1);

      const readEditWrite = seqPatterns.find((p) =>
        (p.pattern as any).sequence?.join(" → ") === "read → edit → write",
      );
      expect(readEditWrite).toBeDefined();
      expect(readEditWrite!.sampleCount).toBe(3);
      expect(readEditWrite!.confidence).toBeGreaterThan(0.3);
    } finally {
      db.close();
    }
  });

  it("extracts failure mode patterns", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      // Insert 3 failed episodes with similar task intent
      for (let i = 0; i < 3; i++) {
        insertEpisode(db, {
          id: `ep-fail-${i}`,
          userId: "user-1",
          taskIntent: "deploy server config",
          outcome: "failure",
          toolSequence: ["read"],
          steps: [
            { seq: 1, action: "read", observation: "connection timeout error" },
          ],
        });
      }

      const patterns = await extractor.refreshPatterns("user-1");
      const failPatterns = patterns.filter((p) => p.kind === "failure_mode");
      expect(failPatterns.length).toBeGreaterThanOrEqual(1);

      const deployFail = failPatterns.find((p) =>
        (p.pattern as any).intentPrefix === "deploy server config",
      );
      expect(deployFail).toBeDefined();
      expect(deployFail!.sampleCount).toBe(3);
    } finally {
      db.close();
    }
  });

  it("extracts temporal patterns when enough episodes exist", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      // Insert 6 episodes at various hours
      for (let i = 0; i < 6; i++) {
        const hour = i < 4 ? 14 : 9; // most at 14:00 UTC
        const dt = new Date(`2025-06-15T${String(hour).padStart(2, "0")}:${String(i * 10).padStart(2, "0")}:00Z`);
        insertEpisode(db, {
          id: `ep-time-${i}`,
          userId: "user-1",
          taskIntent: `task number ${i}`,
          toolSequence: ["read"],
          createdAt: dt.toISOString(),
        });
      }

      const patterns = await extractor.refreshPatterns("user-1");
      const temporal = patterns.filter((p) => p.kind === "temporal");
      expect(temporal.length).toBeGreaterThanOrEqual(1);

      const activityPattern = temporal.find((p) => p.description.includes("Most active"));
      expect(activityPattern).toBeDefined();
      expect(activityPattern!.description).toContain("14:00 UTC");
    } finally {
      db.close();
    }
  });

  it("extracts successful execution preference patterns from repeated wins", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      for (let i = 0; i < 2; i++) {
        insertEpisode(db, {
          id: `ep-pref-${i}`,
          userId: "user-1",
          taskIntent: "review architecture risks",
          outcome: "success",
          toolSequence: ["read", "grep"],
        });
      }

      const patterns = await extractor.refreshPatterns("user-1");
      const preference = patterns.find((pattern) => pattern.kind === "preference");
      expect(preference).toBeDefined();
      expect(preference!.description).toContain("Repeated successful execution preference");
      expect((preference!.pattern as { taskFingerprint?: string }).taskFingerprint).toBe("review architecture risks");
    } finally {
      db.close();
    }
  });

  it("isolates patterns by userId", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      // Insert episodes for user-1
      for (let i = 0; i < 3; i++) {
        insertEpisode(db, {
          id: `ep-u1-${i}`,
          userId: "user-1",
          taskIntent: "fix bug",
          toolSequence: ["read", "edit", "write"],
        });
      }
      // Insert episodes for user-2
      for (let i = 0; i < 3; i++) {
        insertEpisode(db, {
          id: `ep-u2-${i}`,
          userId: "user-2",
          taskIntent: "deploy service",
          toolSequence: ["deploy", "verify", "notify"],
        });
      }

      const u1Patterns = await extractor.refreshPatterns("user-1");
      const u2Patterns = await extractor.refreshPatterns("user-2");

      // Each user should have their own patterns
      expect(u1Patterns.every((p) => p.userId === "user-1")).toBe(true);
      expect(u2Patterns.every((p) => p.userId === "user-2")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("does not create patterns from insufficient data", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      // Single episode — not enough for any pattern
      insertEpisode(db, {
        id: "ep-lone",
        userId: "user-1",
        taskIntent: "one-off task",
        toolSequence: ["read", "edit", "write"],
      });

      const patterns = await extractor.refreshPatterns("user-1");
      // Tool sequence needs ≥2 episodes, temporal needs ≥5
      expect(patterns).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("lists stored patterns without recomputing them", async () => {
    const db = createTestDb();
    try {
      const extractor = createFridayPatternExtractor({ db });

      for (let i = 0; i < 2; i++) {
        insertEpisode(db, {
          id: `ep-list-${i}`,
          userId: "user-1",
          taskIntent: "review architecture risks",
          outcome: "success",
          toolSequence: ["read", "grep"],
        });
      }

      const refreshed = await extractor.refreshPatterns("user-1");
      db.withWriteTransaction((conn) => {
        conn.prepare("DELETE FROM friday_episodes WHERE user_id = ?").run("user-1");
      });

      const listed = await extractor.listPatterns("user-1");

      expect(refreshed.length).toBeGreaterThan(0);
      expect(listed).toEqual(refreshed);
    } finally {
      db.close();
    }
  });

  it("does not rewrite unchanged patterns on repeated refreshes", async () => {
    const db = createTestDb();
    let currentNow = "2026-04-03T10:00:00.000Z";
    try {
      const extractor = createFridayPatternExtractor({
        db,
        nowIso: () => currentNow,
      });

      for (let i = 0; i < 2; i++) {
        insertEpisode(db, {
          id: `ep-stable-${i}`,
          userId: "user-1",
          taskIntent: "review architecture risks",
          outcome: "success",
          toolSequence: ["read", "grep"],
        });
      }

      const firstRefresh = await extractor.refreshPatterns("user-1");
      expect(firstRefresh.length).toBeGreaterThan(0);
      const firstUpdatedAt = firstRefresh[0]!.lastUpdated;

      currentNow = "2026-04-03T11:00:00.000Z";
      const secondRefresh = await extractor.refreshPatterns("user-1");

      expect(secondRefresh.length).toBeGreaterThan(0);
      expect(secondRefresh[0]!.lastUpdated).toBe(firstUpdatedAt);
    } finally {
      db.close();
    }
  });
});
