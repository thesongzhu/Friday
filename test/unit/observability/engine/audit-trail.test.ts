import { describe, it, expect, beforeEach } from "vitest";
import {
  FridayAuditTrail,
  canonicalizeAuditEntry,
} from "../../../../src/observability/engine/audit-trail.js";
import { FRIDAY_AUDIT_GENESIS_HASH } from "../../../../src/observability/model/friday-observability.types.js";
import type {
  FridayAuditActor,
  FridayAuditEntry,
  FridayAuditResource,
} from "../../../../src/observability/model/friday-observability.types.js";

// ─── Test Helpers ───

const testActor: FridayAuditActor = {
  type: "user",
  id: "user-1",
  displayName: "Alice",
  ip: "10.0.0.1",
};

const testResource: FridayAuditResource = {
  type: "rule",
  id: "rule-1",
  displayName: "Test Rule",
};

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    actor: testActor,
    actionCategory: "create" as const,
    action: "rules.create",
    resource: testResource,
    outcome: "success" as const,
    description: "Created rule rule-1",
    module: "rules" as const,
    ...overrides,
  };
}

describe("FridayAuditTrail", () => {
  let trail: FridayAuditTrail;

  beforeEach(() => {
    trail = new FridayAuditTrail();
  });

  // ─── Append ───

  describe("append", () => {
    it("creates an entry with monotonic sequence numbers", async () => {
      const entry1 = await trail.append(makeEntry());
      const entry2 = await trail.append(makeEntry({ action: "rules.update" }));

      expect(entry1.sequenceNumber).toBe(1);
      expect(entry2.sequenceNumber).toBe(2);
    });

    it("assigns a UUID to each entry", async () => {
      const entry = await trail.append(makeEntry());
      expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("first entry chains from genesis hash", async () => {
      const entry = await trail.append(makeEntry());
      expect(entry.previousHash).toBe(FRIDAY_AUDIT_GENESIS_HASH);
    });

    it("subsequent entries chain from previous entry hash", async () => {
      const entry1 = await trail.append(makeEntry());
      const entry2 = await trail.append(makeEntry());
      expect(entry2.previousHash).toBe(entry1.integrityHash);
    });

    it("computes a SHA-256 integrity hash", async () => {
      const entry = await trail.append(makeEntry());
      expect(entry.integrityHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("includes optional fields when provided", async () => {
      const entry = await trail.append(makeEntry({
        errorCode: "AUTH_DENIED",
        errorMessage: "Permission denied",
        traceId: "trace-123",
        spanId: "span-456",
        metadata: { extra: "data" },
      }));

      expect(entry.errorCode).toBe("AUTH_DENIED");
      expect(entry.errorMessage).toBe("Permission denied");
      expect(entry.traceId).toBe("trace-123");
      expect(entry.spanId).toBe("span-456");
      expect(entry.metadata).toEqual({ extra: "data" });
    });

    it("records the correct actor and resource", async () => {
      const entry = await trail.append(makeEntry());
      expect(entry.actor).toEqual(testActor);
      expect(entry.resource).toEqual(testResource);
      expect(entry.actionCategory).toBe("create");
      expect(entry.action).toBe("rules.create");
      expect(entry.outcome).toBe("success");
    });
  });

  // ─── Chain Verification ───

  describe("verifyChain", () => {
    it("verifies an empty chain", async () => {
      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("verifies a single-entry chain", async () => {
      await trail.append(makeEntry());
      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("verifies a multi-entry chain", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry({ action: "rules.update" }));
      await trail.append(makeEntry({ action: "rules.delete" }));

      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("detects tampered entry", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry({ action: "rules.update" }));
      await trail.append(makeEntry({ action: "rules.delete" }));

      // Simulate internal store tampering (bypassing public immutable getters)
      const state = trail as unknown as { entries: FridayAuditEntry[] };
      state.entries[1] = {
        ...state.entries[1],
        description: "TAMPERED",
      };

      const result = await trail.verifyChain();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });
  });

  // ─── Single Entry Verification ───

  describe("verifyEntry", () => {
    it("verifies a single entry against its previous hash", async () => {
      const entry1 = await trail.append(makeEntry());
      const entry2 = await trail.append(makeEntry({ action: "rules.update" }));

      expect(await trail.verifyEntry(entry1, null)).toBe(true);
      expect(await trail.verifyEntry(entry2, entry1.integrityHash)).toBe(true);
    });

    it("fails verification with wrong previous hash", async () => {
      const entry = await trail.append(makeEntry());
      expect(await trail.verifyEntry(entry, "wrong-hash")).toBe(false);
    });
  });

  // ─── Query ───

  describe("query", () => {
    it("queries by actorId", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry({
        actor: { type: "system", id: "sys-1", displayName: "System" },
      }));

      const results = trail.query({ actorId: "user-1" });
      expect(results).toHaveLength(1);
      expect(results[0].actor.id).toBe("user-1");
    });

    it("queries by actionCategory", async () => {
      await trail.append(makeEntry({ actionCategory: "create" }));
      await trail.append(makeEntry({ actionCategory: "delete" }));

      const results = trail.query({ actionCategory: "delete" });
      expect(results).toHaveLength(1);
    });

    it("queries by module", async () => {
      await trail.append(makeEntry({ module: "rules" }));
      await trail.append(makeEntry({ module: "api" }));

      const results = trail.query({ module: "rules" });
      expect(results).toHaveLength(1);
    });

    it("queries by outcome", async () => {
      await trail.append(makeEntry({ outcome: "success" }));
      await trail.append(makeEntry({ outcome: "failure" }));

      const results = trail.query({ outcome: "failure" });
      expect(results).toHaveLength(1);
    });

    it("queries by resourceType and resourceId", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry({
        resource: { type: "workflow", id: "wf-1" },
      }));

      const results = trail.query({ resourceType: "workflow" });
      expect(results).toHaveLength(1);
    });

    it("queries by traceId", async () => {
      await trail.append(makeEntry({ traceId: "trace-abc" }));
      await trail.append(makeEntry({ traceId: "trace-def" }));

      const results = trail.query({ traceId: "trace-abc" });
      expect(results).toHaveLength(1);
    });

    it("combines multiple filters", async () => {
      await trail.append(makeEntry({ outcome: "success", module: "rules" }));
      await trail.append(makeEntry({ outcome: "failure", module: "rules" }));
      await trail.append(makeEntry({ outcome: "success", module: "api" }));

      const results = trail.query({ outcome: "success", module: "rules" });
      expect(results).toHaveLength(1);
    });
  });

  // ─── Entry Retrieval ───

  describe("getEntry / getEntryBySequence", () => {
    it("retrieves entry by ID", async () => {
      const entry = await trail.append(makeEntry());
      const fetched = trail.getEntry(entry.id);
      expect(fetched).toEqual(entry);
      expect(fetched).not.toBe(entry);
    });

    it("returns null for unknown ID", () => {
      expect(trail.getEntry("unknown")).toBeNull();
    });

    it("retrieves entry by sequence number", async () => {
      await trail.append(makeEntry());
      const entry2 = await trail.append(makeEntry());
      const fetched = trail.getEntryBySequence(2);
      expect(fetched).toEqual(entry2);
      expect(fetched).not.toBe(entry2);
    });

    it("returns null for unknown sequence number", () => {
      expect(trail.getEntryBySequence(999)).toBeNull();
    });
  });

  // ─── Immutability ───

  describe("immutability", () => {
    it("returns deep-frozen entry copies from getEntries", async () => {
      await trail.append(makeEntry({
        metadata: {
          nested: {
            value: "original",
          },
        },
      }));

      const entries = trail.getEntries() as FridayAuditEntry[];
      expect(Object.isFrozen(entries)).toBe(true);
      expect(Object.isFrozen(entries[0])).toBe(true);
      expect(Object.isFrozen(entries[0].metadata!)).toBe(true);
      expect(Object.isFrozen(entries[0].metadata!.nested as object)).toBe(true);

      expect(() => {
        entries[0].description = "mutated";
      }).toThrow(TypeError);

      expect(() => {
        (entries[0].metadata!.nested as Record<string, string>).value = "changed";
      }).toThrow(TypeError);

      expect(trail.getEntries()[0].description).toBe("Created rule rule-1");
      expect((trail.getEntries()[0].metadata!.nested as Record<string, string>).value).toBe("original");
    });

    it("returns deep-frozen copies from all entry/checkpoint getters", async () => {
      await trail.append(makeEntry());
      const retainedEntry = await trail.append(makeEntry({
        action: "rules.update",
        metadata: {
          a: {
            b: 1,
          },
        },
      }));
      await trail.applyRetention(1, "immutability test");

      const byId = trail.getEntry(retainedEntry.id)!;
      const bySeq = trail.getEntryBySequence(retainedEntry.sequenceNumber);
      const queried = trail.query({ action: "rules.update" });
      const checkpoints = trail.getCheckpoints();

      expect(Object.isFrozen(byId)).toBe(true);
      expect(Object.isFrozen(byId.metadata!)).toBe(true);
      expect(Object.isFrozen(byId.metadata!.a as object)).toBe(true);
      expect(Object.isFrozen(bySeq!)).toBe(true);
      expect(Object.isFrozen(queried)).toBe(true);
      expect(Object.isFrozen(queried[0])).toBe(true);
      expect(Object.isFrozen(checkpoints)).toBe(true);
      expect(Object.isFrozen(checkpoints[0])).toBe(true);
    });
  });

  // ─── Retention ───

  describe("applyRetention", () => {
    it("deletes entries at or below the boundary", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry());
      await trail.append(makeEntry());

      const checkpoint = await trail.applyRetention(2, "90-day retention policy");
      expect(checkpoint).not.toBeNull();
      expect(trail.getEntryCount()).toBe(1);
      expect(trail.getEntries()[0].sequenceNumber).toBe(3);
    });

    it("records a retention checkpoint", async () => {
      const e1 = await trail.append(makeEntry());
      const e2 = await trail.append(makeEntry());
      await trail.append(makeEntry());

      const checkpoint = await trail.applyRetention(2, "test retention");
      expect(checkpoint!.lastDeletedSequenceNumber).toBe(2);
      expect(checkpoint!.boundaryHash).toBe(e2.integrityHash);
      expect(checkpoint!.firstRetainedSequenceNumber).toBe(3);
      expect(checkpoint!.reason).toBe("test retention");
    });

    it("chain verification succeeds after retention", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry());
      const e3 = await trail.append(makeEntry());

      await trail.applyRetention(2, "retention");

      // Verification should succeed using the checkpoint's boundary hash as anchor
      const result = await trail.verifyChain();
      expect(result.valid).toBe(true);
    });

    it("returns null when no entries to delete", async () => {
      const result = await trail.applyRetention(0, "no-op");
      expect(result).toBeNull();
    });

    it("stores multiple checkpoints", async () => {
      for (let i = 0; i < 6; i++) await trail.append(makeEntry());
      await trail.applyRetention(2, "first");
      await trail.applyRetention(4, "second");

      const checkpoints = trail.getCheckpoints();
      expect(checkpoints).toHaveLength(2);
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("clears all entries, checkpoints, and resets sequence number", async () => {
      await trail.append(makeEntry());
      await trail.append(makeEntry());
      trail.reset();

      expect(trail.getEntryCount()).toBe(0);
      expect(trail.getCheckpoints()).toHaveLength(0);

      const entry = await trail.append(makeEntry());
      expect(entry.sequenceNumber).toBe(1);
    });
  });
});

// ─── Canonical Serialization ───

describe("canonicalizeAuditEntry", () => {
  it("produces sorted keys, no whitespace", () => {
    const entry = {
      id: "entry-1",
      sequenceNumber: 1,
      actor: { type: "user" as const, id: "u1", displayName: "Alice" },
      actionCategory: "create" as const,
      action: "rules.create",
      resource: { type: "rule" as const, id: "r1" },
      outcome: "success" as const,
      description: "Created rule",
      module: "rules" as const,
      previousHash: null,
      recordedAt: "2026-01-01T00:00:00.000Z",
    };

    const canonical = canonicalizeAuditEntry(entry);

    // Should have no formatting whitespace (newlines, indentation).
    // Spaces inside string values (e.g., "Created rule") are preserved.
    expect(canonical).not.toContain("\n");
    expect(canonical).not.toContain("\t");

    // No whitespace between JSON structural tokens (e.g., no "{ " or ": ")
    // Check by stripping string literals and verifying no spaces remain
    const withoutStrings = canonical.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    expect(withoutStrings).not.toContain(" ");

    // Keys should be sorted: "action" < "actionCategory" < "actor" < ...
    const parsed = JSON.parse(canonical);
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it("preserves null values", () => {
    const entry = {
      id: "entry-1",
      sequenceNumber: 1,
      actor: { type: "user" as const, id: "u1", displayName: "Alice" },
      actionCategory: "create" as const,
      action: "rules.create",
      resource: { type: "rule" as const, id: "r1" },
      outcome: "success" as const,
      description: "Created rule",
      module: "rules" as const,
      previousHash: null,
      recordedAt: "2026-01-01T00:00:00.000Z",
    };

    const canonical = canonicalizeAuditEntry(entry);
    expect(canonical).toContain('"previousHash":null');
  });

  it("preserves array order", () => {
    const entry = {
      id: "entry-1",
      sequenceNumber: 1,
      actor: { type: "user" as const, id: "u1", displayName: "Alice" },
      actionCategory: "create" as const,
      action: "rules.create",
      resource: { type: "rule" as const, id: "r1" },
      outcome: "success" as const,
      description: "Created rule",
      module: "rules" as const,
      previousHash: null,
      recordedAt: "2026-01-01T00:00:00.000Z",
      metadata: { tags: ["b", "a", "c"] },
    };

    const canonical = canonicalizeAuditEntry(entry);
    expect(canonical).toContain('["b","a","c"]');
  });

  it("is deterministic across multiple calls", () => {
    const entry = {
      id: "entry-1",
      sequenceNumber: 1,
      actor: { type: "user" as const, id: "u1", displayName: "Alice" },
      actionCategory: "create" as const,
      action: "rules.create",
      resource: { type: "rule" as const, id: "r1" },
      outcome: "success" as const,
      description: "Created rule",
      module: "rules" as const,
      previousHash: FRIDAY_AUDIT_GENESIS_HASH,
      recordedAt: "2026-01-01T00:00:00.000Z",
    };

    const c1 = canonicalizeAuditEntry(entry);
    const c2 = canonicalizeAuditEntry(entry);
    expect(c1).toBe(c2);
  });
});
