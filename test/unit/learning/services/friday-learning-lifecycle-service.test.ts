import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayLearningLifecycleService, createFridayPreferenceFactRepository } from "#learning";
import type { FridaySqliteLayer } from "#state";

describe("FridayLearningLifecycleService", () => {
  const allocatedDbs: FridaySqliteLayer[] = [];
  const NOW = "2026-04-03T12:00:00.000Z";

  afterEach(() => {
    while (allocatedDbs.length > 0) {
      allocatedDbs.pop()!.close();
    }
  });

  it("uses aggregate counts instead of materializing facts for cold and warmup states", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const factRepo = createFridayPreferenceFactRepository();
    const countByUserSpy = vi.spyOn(factRepo, "countByUser");
    const listByUserSpy = vi.spyOn(factRepo, "listByUser");
    const service = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    expect(service.getState("test-user")).toBe("cold_start");

    db.withWriteTransaction((writerDb) => {
      for (const index of [1, 2, 3]) {
        factRepo.upsert(writerDb, {
          factId: `warmup-fact-${index}`,
          userId: "test-user",
          key: `pref:warmup:${index}`,
          value: index,
          confidence: 0.4,
          evidenceCountDelta: 1,
          lastConfirmedAt: NOW,
          sourceEventId: `evt-warmup-${index}`,
          nowIso: NOW,
        });
      }
    });

    expect(service.getState("test-user")).toBe("warmup");
    expect(countByUserSpy).toHaveBeenCalled();
    expect(listByUserSpy).not.toHaveBeenCalled();
  });

  it("short-circuits on steady_state without querying total facts", () => {
    const db = createTestDb();
    allocatedDbs.push(db);
    const factRepo = createFridayPreferenceFactRepository();
    const countByUserSpy = vi.spyOn(factRepo, "countByUser");
    const service = createFridayLearningLifecycleService({
      db,
      factRepo,
    });

    db.withWriteTransaction((writerDb) => {
      for (const index of Array.from({ length: 10 }, (_, idx) => idx + 1)) {
        factRepo.upsert(writerDb, {
          factId: `steady-fact-${index}`,
          userId: "test-user",
          key: `pref:steady:${index}`,
          value: index,
          confidence: 0.9,
          evidenceCountDelta: 1,
          lastConfirmedAt: NOW,
          sourceEventId: `evt-steady-${index}`,
          nowIso: NOW,
        });
      }
    });

    expect(service.getState("test-user")).toBe("steady_state");
    expect(countByUserSpy).toHaveBeenCalledTimes(1);
    expect(countByUserSpy).toHaveBeenNthCalledWith(1, db.writer, "test-user", 0.7);
  });
});
