import { describe, it, expect } from "vitest";
import {
  matchesCronField,
  matchesCron,
  computeNextCronFire,
} from "../../../src/workflows/services/friday-workflow-cron-utils.js";

describe("Cron Utils", () => {
  describe("matchesCronField", () => {
    it("wildcard matches everything", () => {
      expect(matchesCronField("*", 0)).toBe(true);
      expect(matchesCronField("*", 59)).toBe(true);
    });

    it("exact match", () => {
      expect(matchesCronField("5", 5)).toBe(true);
      expect(matchesCronField("5", 6)).toBe(false);
    });

    it("range match", () => {
      expect(matchesCronField("1-5", 3)).toBe(true);
      expect(matchesCronField("1-5", 6)).toBe(false);
      expect(matchesCronField("1-5", 1)).toBe(true);
      expect(matchesCronField("1-5", 5)).toBe(true);
    });

    it("step match", () => {
      expect(matchesCronField("*/5", 0)).toBe(true);
      expect(matchesCronField("*/5", 5)).toBe(true);
      expect(matchesCronField("*/5", 10)).toBe(true);
      expect(matchesCronField("*/5", 3)).toBe(false);
    });

    it("comma-separated values", () => {
      expect(matchesCronField("1,3,5", 1)).toBe(true);
      expect(matchesCronField("1,3,5", 3)).toBe(true);
      expect(matchesCronField("1,3,5", 5)).toBe(true);
      expect(matchesCronField("1,3,5", 2)).toBe(false);
    });

    it("range with step", () => {
      expect(matchesCronField("1-10/3", 1)).toBe(true);
      expect(matchesCronField("1-10/3", 4)).toBe(true);
      expect(matchesCronField("1-10/3", 7)).toBe(true);
      expect(matchesCronField("1-10/3", 10)).toBe(true);
      expect(matchesCronField("1-10/3", 2)).toBe(false);
    });
  });

  describe("matchesCron", () => {
    it("matches exact minute and hour", () => {
      // 2025-06-15 12:30:00 UTC is a Sunday (dow=0)
      const date = new Date("2025-06-15T12:30:00Z");
      expect(matchesCron("30 12 * * *", date)).toBe(true);
      expect(matchesCron("31 12 * * *", date)).toBe(false);
    });

    it("matches every-5-minutes cron", () => {
      const date = new Date("2025-06-15T12:15:00Z");
      expect(matchesCron("*/5 * * * *", date)).toBe(true);
    });

    it("rejects invalid 6-field expression", () => {
      const date = new Date("2025-06-15T12:00:00Z");
      expect(matchesCron("0 12 * * * *", date)).toBe(false);
    });

    it("matches day of week", () => {
      // 2025-06-16 is Monday (dow=1)
      const monday = new Date("2025-06-16T12:00:00Z");
      expect(matchesCron("0 12 * * 1", monday)).toBe(true);
      expect(matchesCron("0 12 * * 2", monday)).toBe(false);
    });
  });

  describe("computeNextCronFire", () => {
    it("finds next minute match", () => {
      const after = new Date("2025-06-15T12:00:00Z");
      const next = computeNextCronFire("*/5 * * * *", after);
      expect(next).not.toBeNull();
      expect(next!.toISOString()).toBe("2025-06-15T12:05:00.000Z");
    });

    it("finds next hour boundary", () => {
      const after = new Date("2025-06-15T12:59:00Z");
      const next = computeNextCronFire("0 * * * *", after);
      expect(next).not.toBeNull();
      expect(next!.toISOString()).toBe("2025-06-15T13:00:00.000Z");
    });

    it("returns null when no match in search window", () => {
      // Feb 30 never exists
      const after = new Date("2025-06-15T12:00:00Z");
      const next = computeNextCronFire("0 0 30 2 *", after, 100);
      expect(next).toBeNull();
    });

    it("skips the current minute", () => {
      const after = new Date("2025-06-15T12:00:00Z");
      const next = computeNextCronFire("0 12 * * *", after);
      // Should NOT return 12:00 (same minute), should find next day
      expect(next).not.toBeNull();
      expect(next!.getUTCHours()).toBe(12);
      expect(next!.getUTCMinutes()).toBe(0);
      expect(next!.getUTCDate()).toBe(16); // next day
    });
  });
});
