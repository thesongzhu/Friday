import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runFridayMigrations, FRIDAY_SQLITE_MIGRATIONS } from "#state";
import {
  FRIDAY_MIN_AFTER_DAYS,
  FRIDAY_MAX_AFTER_DAYS,
  isValidAfterDays,
  resolveCutoff,
} from "#jobs";

/**
 * RETENTION-R3a Advisor round-2 — the ONE canonical `after_days` domain.
 *
 * Invariant: the ACCEPTED window domain `[FRIDAY_MIN_AFTER_DAYS,
 * FRIDAY_MAX_AFTER_DAYS]` must be a SUBSET of what the reaper's `resolveCutoff`
 * HONORS (returns a non-null cutoff for), and the v105 `CHECK` must enforce
 * exactly that interval — so no layer can accept/persist/report-active a window
 * production silently ignores (DATA-RETENTION-001 truthfulness). This test is the
 * single-source-of-truth guard binding the predicate, the constants, the reaper
 * evaluator, and the DB CHECK together.
 */
describe("retention after_days canonical domain (accept ⊆ honored)", () => {
  it("isValidAfterDays accepts exactly the closed integer interval [MIN, MAX]", () => {
    expect(FRIDAY_MIN_AFTER_DAYS).toBe(1);
    expect(FRIDAY_MAX_AFTER_DAYS).toBe(36500);

    // Inside the interval → valid.
    for (const v of [FRIDAY_MIN_AFTER_DAYS, 30, 3650, FRIDAY_MAX_AFTER_DAYS]) {
      expect(isValidAfterDays(v)).toBe(true);
    }
    // Outside / malformed → invalid.
    for (const v of [
      FRIDAY_MIN_AFTER_DAYS - 1, // 0
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      FRIDAY_MAX_AFTER_DAYS + 1, // 36501
      100_000_000,
      1_000_000_000,
      Number.MAX_SAFE_INTEGER,
      "30",
      null,
      undefined,
      {},
    ]) {
      expect(isValidAfterDays(v as never)).toBe(false);
    }
  });

  it("every accepted window is HONORED by resolveCutoff for any realistic now (accept ⊆ honored)", () => {
    // resolveCutoff is monotonic in `days` (larger days ⇒ more-negative cutoff ⇒
    // closer to Date overflow), so if the MAX boundary is honored, so is every
    // smaller accepted value. Check the extremes across a wide span of `now`.
    const nows = [
      "1970-01-02T00:00:00.000Z",
      "2000-01-01T00:00:00.000Z",
      "2026-07-15T10:00:00.000Z",
      "2100-01-01T00:00:00.000Z",
    ];
    for (const now of nows) {
      for (const days of [FRIDAY_MIN_AFTER_DAYS, 3650, FRIDAY_MAX_AFTER_DAYS]) {
        expect(resolveCutoff(now, { mode: "after_days", days })).not.toBeNull();
      }
    }
  });

  it("the v105 CHECK enforces exactly [MIN, MAX] (migration bound == constants)", () => {
    const db = new Database(":memory:");
    try {
      runFridayMigrations({ db, migrations: FRIDAY_SQLITE_MIGRATIONS });
      const insert = (afterDays: number) =>
        db
          .prepare(
            `INSERT INTO friday_retention_settings
               (id, principal_id, content_category, after_days, created_at, updated_at)
             VALUES (?, 'owner-x', 'auditLogs', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run(`row-${afterDays}`, afterDays);

      // Boundary-valid values are accepted by the CHECK.
      expect(() => insert(FRIDAY_MIN_AFTER_DAYS)).not.toThrow();
      db.prepare("DELETE FROM friday_retention_settings").run();
      expect(() => insert(FRIDAY_MAX_AFTER_DAYS)).not.toThrow();
      db.prepare("DELETE FROM friday_retention_settings").run();

      // Out-of-domain values are rejected fail-closed by the CHECK. Using the
      // constants here ties the migration bound to them: if the ceiling constant
      // and the migration CHECK ever diverge, one of these assertions goes RED.
      expect(() => insert(FRIDAY_MAX_AFTER_DAYS + 1)).toThrow(/CHECK/i);
      expect(() => insert(FRIDAY_MIN_AFTER_DAYS - 1)).toThrow(/CHECK/i);
      expect(() => insert(-1)).toThrow(/CHECK/i);
      expect(() => insert(1_000_000_000)).toThrow(/CHECK/i);
    } finally {
      db.close();
    }
  });
});
