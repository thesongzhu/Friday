import type Database from "better-sqlite3";

// ─── Row type ───

export interface FridayRateLimitCounterRow {
  bucket_key: string;
  window_start: string;
  hit_count: number;
  updated_at: string;
}

// ─── Repository ───

export interface FridayRateLimitCounterRepository {
  getCount(db: Database.Database, bucketKey: string, windowStart: string): number;
  increment(db: Database.Database, bucketKey: string, windowStart: string, now: string): number;
  cleanupBefore(db: Database.Database, before: string): number;
}

// ─── Factory ───

export function createFridayRateLimitCounterRepository(): FridayRateLimitCounterRepository {
  return {
    getCount(db, bucketKey, windowStart) {
      const row = db
        .prepare(
          "SELECT hit_count FROM api_rate_limit_counters WHERE bucket_key = ? AND window_start = ?",
        )
        .get(bucketKey, windowStart) as { hit_count: number } | undefined;
      return row?.hit_count ?? 0;
    },

    increment(db, bucketKey, windowStart, now) {
      const existing = db
        .prepare(
          "SELECT hit_count FROM api_rate_limit_counters WHERE bucket_key = ? AND window_start = ?",
        )
        .get(bucketKey, windowStart) as { hit_count: number } | undefined;

      if (existing) {
        const newCount = existing.hit_count + 1;
        db.prepare(
          "UPDATE api_rate_limit_counters SET hit_count = ?, updated_at = ? WHERE bucket_key = ? AND window_start = ?",
        ).run(newCount, now, bucketKey, windowStart);
        return newCount;
      }

      db.prepare(
        "INSERT INTO api_rate_limit_counters (bucket_key, window_start, hit_count, updated_at) VALUES (?, ?, 1, ?)",
      ).run(bucketKey, windowStart, now);
      return 1;
    },

    cleanupBefore(db, before) {
      const result = db
        .prepare("DELETE FROM api_rate_limit_counters WHERE window_start < ?")
        .run(before);
      return result.changes;
    },
  };
}
