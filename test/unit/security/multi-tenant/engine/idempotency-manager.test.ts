import { describe, it, expect, beforeEach } from "vitest";
import { IdempotencyManager } from "../../../../../src/security/multi-tenant/engine/idempotency-manager.js";
import { SecurityEngineError } from "../../../../../src/security/multi-tenant/engine/utils.js";
import { FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES } from "../../../../../src/security/multi-tenant/api/friday-multi-tenant-security-api.types.js";

describe("IdempotencyManager", () => {
  let manager: IdempotencyManager;

  beforeEach(() => {
    manager = new IdempotencyManager();
  });

  describe("check()", () => {
    it("returns undefined for a new key", () => {
      const result = manager.check("user-1", "tenant-a", "createTenant", "key-1", { name: "Test" });
      expect(result).toBeUndefined();
    });

    it("returns cached response for same key + same payload", () => {
      const payload = { name: "Test" };
      const response = { id: "123", name: "Test" };

      manager.record("user-1", "tenant-a", "createTenant", "key-1", payload, response);

      const cached = manager.check("user-1", "tenant-a", "createTenant", "key-1", payload);
      expect(cached).toEqual(response);
    });

    it("matches equivalent nested payloads with different key order", () => {
      const payloadA = {
        name: "Test",
        metadata: {
          z: 1,
          a: {
            k2: "v2",
            k1: "v1",
          },
        },
      };
      const payloadB = {
        metadata: {
          a: {
            k1: "v1",
            k2: "v2",
          },
          z: 1,
        },
        name: "Test",
      };
      const response = { id: "nested-1" };

      manager.record("user-1", "tenant-a", "createTenant", "key-nested", payloadA, response);
      const cached = manager.check("user-1", "tenant-a", "createTenant", "key-nested", payloadB);

      expect(cached).toEqual(response);
    });

    it("throws IDEMPOTENCY_KEY_CONFLICT for same key + different payload", () => {
      const payload1 = { name: "Test" };
      const payload2 = { name: "Different" };
      const response = { id: "123", name: "Test" };

      manager.record("user-1", "tenant-a", "createTenant", "key-1", payload1, response);

      expect(() =>
        manager.check("user-1", "tenant-a", "createTenant", "key-1", payload2),
      ).toThrow(SecurityEngineError);

      try {
        manager.check("user-1", "tenant-a", "createTenant", "key-1", payload2);
      } catch (err) {
        expect((err as SecurityEngineError).code).toBe(
          FRIDAY_MULTI_TENANT_SECURITY_ERROR_CODES.IDEMPOTENCY_KEY_CONFLICT,
        );
      }
    });

    it("returns immutable replay snapshots", () => {
      const payload = { name: "Replay" };
      manager.record("user-1", "tenant-a", "createTenant", "key-replay", payload, { id: "123" });

      const replay = manager.check<{ id: string }>("user-1", "tenant-a", "createTenant", "key-replay", payload);
      expect(replay).toEqual({ id: "123" });
      if (!replay) {
        throw new Error("Expected replay response.");
      }
      expect(Object.isFrozen(replay)).toBe(true);
      expect(() => {
        replay.id = "mutated";
      }).toThrow(TypeError);
    });
  });

  describe("tenant isolation (SEC-FIX-R5-02)", () => {
    it("isolates idempotency keys by tenant", () => {
      const payload = { name: "Test" };
      const responseA = { id: "a", tenant: "a" };
      const responseB = { id: "b", tenant: "b" };

      // Same principal, same operation, same key — but different tenants
      manager.record("user-1", "tenant-a", "createWorkspace", "key-1", payload, responseA);
      manager.record("user-1", "tenant-b", "createWorkspace", "key-1", payload, responseB);

      const cachedA = manager.check("user-1", "tenant-a", "createWorkspace", "key-1", payload);
      const cachedB = manager.check("user-1", "tenant-b", "createWorkspace", "key-1", payload);

      expect(cachedA).toEqual(responseA);
      expect(cachedB).toEqual(responseB);
    });

    it("isolates idempotency keys by principal", () => {
      const payload = { name: "Test" };
      const response1 = { id: "1" };

      manager.record("user-1", "tenant-a", "createTenant", "key-1", payload, response1);

      // Different principal, same tenant+operation+key
      const result = manager.check("user-2", "tenant-a", "createTenant", "key-1", payload);
      expect(result).toBeUndefined();
    });

    it("isolates idempotency keys by operation", () => {
      const payload = { name: "Test" };
      const response1 = { id: "1" };

      manager.record("user-1", "tenant-a", "createTenant", "key-1", payload, response1);

      // Same principal+tenant+key, different operation
      const result = manager.check("user-1", "tenant-a", "updateTenant", "key-1", payload);
      expect(result).toBeUndefined();
    });
  });

  describe("TTL expiry", () => {
    it("evicts expired keys", () => {
      // Use a very short TTL (0.001 hours ≈ 3.6 seconds)
      const shortTtl = new IdempotencyManager(0);

      const payload = { name: "Test" };
      shortTtl.record("user-1", "tenant-a", "op", "key-1", payload, { ok: true });

      // With TTL of 0, the record should be immediately expired
      const result = shortTtl.check("user-1", "tenant-a", "op", "key-1", payload);
      expect(result).toBeUndefined();
    });
  });

  describe("size", () => {
    it("reports the number of active records", () => {
      const payload = { name: "Test" };
      expect(manager.size).toBe(0);

      manager.record("u1", "t1", "op", "k1", payload, {});
      manager.record("u1", "t1", "op", "k2", payload, {});
      expect(manager.size).toBe(2);
    });
  });
});
