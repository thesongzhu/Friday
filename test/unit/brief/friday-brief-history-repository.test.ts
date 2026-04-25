import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";

import { createFridayBriefHistoryRepository } from "../../../src/brief/friday-brief-history-repository.js";
import { V075_DAILY_BRIEF_RUNS_SQL } from "../../../src/state/sqlite/migrations/v075-daily-brief-runs.js";

describe("createFridayBriefHistoryRepository", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(V075_DAILY_BRIEF_RUNS_SQL);
  });

  afterEach(() => {
    db.close();
  });

  it("creates a pending record with empty result arrays", () => {
    const repo = createFridayBriefHistoryRepository();
    const record = repo.create(db, {
      id: "run-1",
      triggeredBy: "manual_cli",
      windowStartAt: "2026-04-24T00:00:00.000Z",
      windowEndAt: "2026-04-24T20:00:00.000Z",
      nowIso: "2026-04-24T20:00:00.000Z",
    });

    expect(record.id).toBe("run-1");
    expect(record.triggeredBy).toBe("manual_cli");
    expect(record.status).toBe("pending");
    expect(record.sourceResults).toEqual([]);
    expect(record.deliveryAttempts).toEqual([]);
    expect(record.transcript).toBeUndefined();
    expect(record.createdAt).toBe("2026-04-24T20:00:00.000Z");
  });

  it("returns null for unknown ids", () => {
    const repo = createFridayBriefHistoryRepository();
    expect(repo.get(db, "missing")).toBeNull();
  });

  it("returns the record after create", () => {
    const repo = createFridayBriefHistoryRepository();
    repo.create(db, {
      id: "run-1",
      triggeredBy: "scheduled",
      windowStartAt: "2026-04-24T00:00:00.000Z",
      windowEndAt: "2026-04-24T20:00:00.000Z",
      nowIso: "2026-04-24T20:00:00.000Z",
    });

    const fetched = repo.get(db, "run-1");
    expect(fetched?.id).toBe("run-1");
    expect(fetched?.triggeredBy).toBe("scheduled");
  });

  it("updates a record and persists transcript/language/status", () => {
    const repo = createFridayBriefHistoryRepository();
    repo.create(db, {
      id: "run-1",
      triggeredBy: "manual_http",
      windowStartAt: "2026-04-24T00:00:00.000Z",
      windowEndAt: "2026-04-24T20:00:00.000Z",
      nowIso: "2026-04-24T20:00:00.000Z",
    });

    const updated = repo.update(
      db,
      "run-1",
      {
        status: "delivered",
        transcript: "Today you shipped two PRs.",
        language: "en-US",
        sourceResults: [
          { source: "git_repos", eventCount: 3, durationMs: 12, skipped: false },
        ],
        deliveryAttempts: [
          {
            channel: "telegram",
            order: 0,
            attemptedAt: "2026-04-24T20:00:05.000Z",
            audioAttached: true,
            ok: true,
            durationMs: 300,
          },
        ],
        audio: { provider: "azure", voice: "en-US-AvaNeural", bytes: 12345 },
      },
      "2026-04-24T20:00:10.000Z",
    );

    expect(updated?.status).toBe("delivered");
    expect(updated?.transcript).toBe("Today you shipped two PRs.");
    expect(updated?.language).toBe("en-US");
    expect(updated?.sourceResults).toHaveLength(1);
    expect(updated?.deliveryAttempts[0]?.channel).toBe("telegram");
    expect(updated?.audio?.provider).toBe("azure");
    expect(updated?.updatedAt).toBe("2026-04-24T20:00:10.000Z");
  });

  it("allows clearing fields by passing null", () => {
    const repo = createFridayBriefHistoryRepository();
    repo.create(db, {
      id: "run-1",
      triggeredBy: "scheduled",
      windowStartAt: "2026-04-24T00:00:00.000Z",
      windowEndAt: "2026-04-24T20:00:00.000Z",
      nowIso: "2026-04-24T20:00:00.000Z",
    });
    repo.update(
      db,
      "run-1",
      { transcript: "set", audio: { provider: "azure", voice: "v", bytes: 10 } },
      "2026-04-24T20:01:00.000Z",
    );
    const cleared = repo.update(db, "run-1", { transcript: null, audio: null }, "2026-04-24T20:02:00.000Z");

    expect(cleared?.transcript).toBeUndefined();
    expect(cleared?.audio).toBeUndefined();
  });

  it("returns null when updating a missing id", () => {
    const repo = createFridayBriefHistoryRepository();
    expect(
      repo.update(db, "missing", { status: "delivered" }, "2026-04-24T20:00:00.000Z"),
    ).toBeNull();
  });

  it("lists records in reverse chronological order with a limit", () => {
    const repo = createFridayBriefHistoryRepository();
    for (let i = 1; i <= 5; i += 1) {
      repo.create(db, {
        id: `run-${i}`,
        triggeredBy: "scheduled",
        windowStartAt: "2026-04-24T00:00:00.000Z",
        windowEndAt: "2026-04-24T20:00:00.000Z",
        nowIso: `2026-04-24T20:0${i}:00.000Z`,
      });
    }

    const list = repo.list(db, { limit: 3 });
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.id)).toEqual(["run-5", "run-4", "run-3"]);
  });

  it("paginates using beforeId", () => {
    const repo = createFridayBriefHistoryRepository();
    for (let i = 1; i <= 4; i += 1) {
      repo.create(db, {
        id: `run-${i}`,
        triggeredBy: "scheduled",
        windowStartAt: "2026-04-24T00:00:00.000Z",
        windowEndAt: "2026-04-24T20:00:00.000Z",
        nowIso: `2026-04-24T20:0${i}:00.000Z`,
      });
    }

    const firstPage = repo.list(db, { limit: 2 });
    expect(firstPage.map((r) => r.id)).toEqual(["run-4", "run-3"]);

    const secondPage = repo.list(db, { limit: 2, beforeId: "run-3" });
    expect(secondPage.map((r) => r.id)).toEqual(["run-2", "run-1"]);
  });

  it("prune is a no-op when no policy is given", () => {
    const repo = createFridayBriefHistoryRepository();
    repo.create(db, {
      id: "run-1",
      triggeredBy: "scheduled",
      windowStartAt: "2026-04-24T00:00:00.000Z",
      windowEndAt: "2026-04-24T20:00:00.000Z",
      nowIso: "2026-04-24T20:00:00.000Z",
    });
    const result = repo.prune(db, { nowMs: Date.parse("2026-04-24T20:00:00.000Z") });
    expect(result.deletedIds).toEqual([]);
    expect(repo.get(db, "run-1")).not.toBeNull();
  });

  it("prune keeps only the latest N rows when keepLatestCount is set", () => {
    const repo = createFridayBriefHistoryRepository();
    for (let i = 1; i <= 5; i += 1) {
      repo.create(db, {
        id: `run-${i}`,
        triggeredBy: "scheduled",
        windowStartAt: "2026-04-24T00:00:00.000Z",
        windowEndAt: "2026-04-24T20:00:00.000Z",
        nowIso: `2026-04-24T20:0${i}:00.000Z`,
      });
    }
    const result = repo.prune(db, {
      keepLatestCount: 2,
      nowMs: Date.parse("2026-04-24T20:10:00.000Z"),
    });
    expect(result.deletedIds.sort()).toEqual(["run-1", "run-2", "run-3"]);
    expect(repo.list(db, { limit: 50 }).map((r) => r.id)).toEqual(["run-5", "run-4"]);
  });

  it("prune deletes rows older than maxAgeDays", () => {
    const repo = createFridayBriefHistoryRepository();
    repo.create(db, {
      id: "old-1",
      triggeredBy: "scheduled",
      windowStartAt: "2026-01-01T00:00:00.000Z",
      windowEndAt: "2026-01-01T01:00:00.000Z",
      nowIso: "2026-01-01T01:00:00.000Z",
    });
    repo.create(db, {
      id: "fresh-1",
      triggeredBy: "scheduled",
      windowStartAt: "2026-04-23T00:00:00.000Z",
      windowEndAt: "2026-04-23T01:00:00.000Z",
      nowIso: "2026-04-23T01:00:00.000Z",
    });
    const result = repo.prune(db, {
      maxAgeDays: 30,
      nowMs: Date.parse("2026-04-24T00:00:00.000Z"),
    });
    expect(result.deletedIds).toEqual(["old-1"]);
    expect(repo.get(db, "old-1")).toBeNull();
    expect(repo.get(db, "fresh-1")).not.toBeNull();
  });

  it("prune unions both policies (count and age)", () => {
    const repo = createFridayBriefHistoryRepository();
    repo.create(db, {
      id: "old",
      triggeredBy: "scheduled",
      windowStartAt: "2026-01-01T00:00:00.000Z",
      windowEndAt: "2026-01-01T01:00:00.000Z",
      nowIso: "2026-01-01T01:00:00.000Z",
    });
    for (let i = 1; i <= 4; i += 1) {
      repo.create(db, {
        id: `recent-${i}`,
        triggeredBy: "scheduled",
        windowStartAt: "2026-04-24T00:00:00.000Z",
        windowEndAt: "2026-04-24T20:00:00.000Z",
        nowIso: `2026-04-24T20:0${i}:00.000Z`,
      });
    }
    const result = repo.prune(db, {
      keepLatestCount: 2,
      maxAgeDays: 30,
      nowMs: Date.parse("2026-04-24T21:00:00.000Z"),
    });
    expect(result.deletedIds.sort()).toEqual(["old", "recent-1", "recent-2"]);
    expect(repo.list(db, { limit: 50 }).map((r) => r.id)).toEqual(["recent-4", "recent-3"]);
  });
});
