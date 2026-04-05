import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridaySessionSatisfactionRepository } from "#learning";
import { createFridaySessionSatisfactionService } from "#learning";
import type {
  FridaySessionSatisfactionService,
  FridaySessionSatisfactionRepository,
} from "#learning";

describe("FridaySessionSatisfactionService", () => {
  let db: FridaySqliteLayer;
  let service: FridaySessionSatisfactionService;
  let repo: FridaySessionSatisfactionRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    repo = createFridaySessionSatisfactionRepository();
    service = createFridaySessionSatisfactionService({ db, satisfactionRepo: repo });
  });

  afterEach(() => {
    db.close();
  });

  describe("computeSessionScore", () => {
    it("computes mean of valences and counts positive/negative/neutral", () => {
      const result = service.computeSessionScore({
        sessionId: "sess-1",
        userId: "test-user",
        valences: [0.6, -0.3, 0.0, 0.5, -0.7],
        nowIso: NOW,
      });

      expect(result.sessionId).toBe("sess-1");
      expect(result.userId).toBe("test-user");
      // Mean: (0.6 + -0.3 + 0.0 + 0.5 + -0.7) / 5 = 0.02
      expect(result.score).toBeCloseTo(0.02, 2);
      expect(result.signalCount).toBe(5);
      expect(result.positiveCount).toBe(2); // 0.6, 0.5 > 0.1
      expect(result.negativeCount).toBe(2); // -0.3, -0.7 < -0.1
      expect(result.neutralCount).toBe(1); // 0.0
    });

    it("clamps score to [-1, 1]", () => {
      // All very positive — should cap at 1
      const result = service.computeSessionScore({
        sessionId: "sess-2",
        userId: "test-user",
        valences: [1.0, 1.0, 1.0],
        nowIso: NOW,
      });

      expect(result.score).toBeLessThanOrEqual(1.0);
      expect(result.score).toBeGreaterThanOrEqual(-1.0);
    });

    it("handles empty valences array", () => {
      const result = service.computeSessionScore({
        sessionId: "sess-3",
        userId: "test-user",
        valences: [],
        nowIso: NOW,
      });

      expect(result.score).toBe(0);
      expect(result.signalCount).toBe(0);
    });

    it("persists the score to the database", () => {
      service.computeSessionScore({
        sessionId: "sess-4",
        userId: "test-user",
        valences: [0.6, 0.3],
        nowIso: NOW,
      });

      const stored = db.withReadConnection((conn) =>
        repo.getBySession(conn, "sess-4"),
      );
      expect(stored).toBeDefined();
      expect(stored?.score).toBeCloseTo(0.45, 2);
    });
  });

  describe("getUserSatisfactionTrend", () => {
    function seedSessions(userId: string, scores: number[]) {
      scores.forEach((score, i) => {
        const ts = new Date(
          new Date(NOW).getTime() - (scores.length - i) * 86_400_000,
        ).toISOString();
        db.withWriteTransaction((conn) =>
          repo.upsert(conn, {
            sessionId: `sess-trend-${i}`,
            userId,
            score,
            signalCount: 5,
            positiveCount: score > 0 ? 3 : 1,
            negativeCount: score < 0 ? 3 : 1,
            neutralCount: 1,
            nowIso: ts,
          }),
        );
      });
    }

    it("returns stable when scores are similar", () => {
      seedSessions("test-user", [0.1, 0.15, 0.12, 0.09, 0.11, 0.13]);
      const trend = service.getUserSatisfactionTrend({
        userId: "test-user",
        lookbackDays: 365,
        nowIso: NOW,
      });

      expect(trend.trend).toBe("stable");
    });

    it("returns improving when recent scores are significantly higher", () => {
      seedSessions("test-user", [-0.5, -0.4, -0.3, 0.2, 0.3, 0.4]);
      const trend = service.getUserSatisfactionTrend({
        userId: "test-user",
        lookbackDays: 365,
        nowIso: NOW,
      });

      expect(trend.trend).toBe("improving");
    });

    it("returns declining when recent scores are significantly lower", () => {
      seedSessions("test-user", [0.5, 0.4, 0.3, -0.2, -0.3, -0.4]);
      const trend = service.getUserSatisfactionTrend({
        userId: "test-user",
        lookbackDays: 365,
        nowIso: NOW,
      });

      expect(trend.trend).toBe("declining");
    });

    it("handles zero sessions gracefully", () => {
      const trend = service.getUserSatisfactionTrend({
        userId: "user-none",
        lookbackDays: 365,
        nowIso: NOW,
      });

      expect(trend.recentSessions).toBe(0);
      expect(trend.trend).toBe("stable");
    });
  });
});
