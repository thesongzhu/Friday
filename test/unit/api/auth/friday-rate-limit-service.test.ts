import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayRateLimitService } from "#api";
import type { FridayRateLimitService } from "#api";

describe("FridayRateLimitService", () => {
  let db: FridaySqliteLayer;
  let service: FridayRateLimitService;
  const NOW = "2025-06-15T10:00:00.000Z";

  beforeEach(() => {
    db = createTestDb();
    service = createFridayRateLimitService({
      db,
      nowIso: () => NOW,
    });
  });

  afterEach(() => {
    db.close();
  });

  it("allows requests within limit", () => {
    const decision = service.increment("auth.login", "192.168.1.1");
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(9); // 10 max - 1 hit
  });

  it("counts incrementally", () => {
    for (let i = 0; i < 5; i++) {
      service.increment("auth.login", "192.168.1.1");
    }
    const decision = service.check("auth.login", "192.168.1.1");
    expect(decision.remaining).toBe(5); // 10 - 5
  });

  it("rejects when limit exceeded", () => {
    for (let i = 0; i < 10; i++) {
      service.increment("auth.login", "192.168.1.1");
    }
    const decision = service.increment("auth.login", "192.168.1.1");
    expect(decision.allowed).toBe(false);
    expect(decision.remaining).toBe(0);
  });

  it("tracks different keys separately", () => {
    for (let i = 0; i < 10; i++) {
      service.increment("auth.login", "192.168.1.1");
    }
    const decision = service.increment("auth.login", "192.168.1.2");
    expect(decision.allowed).toBe(true);
  });

  it("returns policy info", () => {
    const policy = service.getPolicy("auth.login");
    expect(policy).toBeDefined();
    expect(policy!.windowMs).toBe(60_000);
    expect(policy!.maxHits).toBe(10);
    expect(policy!.keyBy).toBe("ip");
  });

  it("returns undefined for unknown policy", () => {
    const policy = service.getPolicy("nonexistent" as "auth.login");
    expect(policy).toBeUndefined();
  });

  it("defines the write-heavy policies referenced by authenticated routes", () => {
    expect(service.getPolicy("agent.run")).toMatchObject({ maxHits: 60, keyBy: "principal" });
    expect(service.getPolicy("session.write")).toMatchObject({ maxHits: 60, keyBy: "principal" });
    expect(service.getPolicy("memory.write")).toMatchObject({ maxHits: 60, keyBy: "principal" });
  });

  it("allows requests for unknown policy (permissive fallback)", () => {
    const decision = service.increment("nonexistent" as "auth.login", "key");
    expect(decision.allowed).toBe(true);
  });

  it("persists counter rows for agent.run instead of falling back to the zero-limit path", () => {
    const decision = service.increment("agent.run", "user-1");
    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(60);
    expect(decision.remaining).toBe(59);

    const stored = db.withReadConnection((conn) =>
      conn.prepare(
        `SELECT hit_count
           FROM api_rate_limit_counters
          WHERE bucket_key = ? AND window_start = ?`,
      ).get("agent.run:user-1", "2025-06-15T10:00:00.000Z") as { hit_count?: number } | undefined,
    );
    expect(stored?.hit_count).toBe(1);
  });

  it("check does not increment counter", () => {
    const before = service.check("auth.login", "192.168.1.1");
    const after = service.check("auth.login", "192.168.1.1");
    expect(before.remaining).toBe(after.remaining);
  });

  it("includes resetAt in decision", () => {
    const decision = service.increment("auth.login", "192.168.1.1");
    expect(decision.resetAt).toBeTruthy();
    expect(new Date(decision.resetAt).getTime()).toBeGreaterThan(0);
  });

  it("supports policy overrides", () => {
    const customService = createFridayRateLimitService({
      db,
      nowIso: () => NOW,
      policyOverrides: {
        "auth.login": { maxHits: 2 },
      },
    });

    customService.increment("auth.login", "key");
    customService.increment("auth.login", "key");
    const decision = customService.increment("auth.login", "key");
    expect(decision.allowed).toBe(false);
  });
});
