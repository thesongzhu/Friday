import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { FridaySqliteLayer } from "#state";
import { createTestDb } from "../../satellites/_helpers/create-test-db.helper.js";
import { createFridayErrorIncidentRepository } from "#learning";
import type { FridayErrorIncidentRepository } from "#learning";
import type { FridayErrorIncidentEntity } from "#learning";

describe("FridayErrorIncidentRepository", () => {
  let db: FridaySqliteLayer;
  let repo: FridayErrorIncidentRepository;
  const NOW = "2025-06-15T10:00:00.000Z";

  const baseIncident: FridayErrorIncidentEntity = {
    incidentId: "inc-001",
    userId: "test-user",
    ts: NOW,
    category: "tool",
    severity: "medium",
    signature: "sig-abc123",
    context: { toolName: "search", error: "timeout" },
    autoFixEligible: false,
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };

  beforeEach(() => {
    db = createTestDb();
    repo = createFridayErrorIncidentRepository();
  });

  afterEach(() => {
    db.close();
  });

  it("inserts and retrieves an incident", () => {
    repo.insert(db.writer, baseIncident);
    const results = repo.listByUser(db.writer, { userId: "test-user" });
    expect(results).toHaveLength(1);
    expect(results[0]!.incidentId).toBe("inc-001");
    expect(results[0]!.context).toEqual({
      toolName: "search",
      error: "timeout",
    });
    expect(results[0]!.autoFixEligible).toBe(false);
  });

  it("listByUser filters by status", () => {
    repo.insert(db.writer, baseIncident);
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-002",
      status: "resolved",
    });

    const open = repo.listByUser(db.writer, {
      userId: "test-user",
      status: "open",
    });
    expect(open).toHaveLength(1);
    expect(open[0]!.incidentId).toBe("inc-001");

    const resolved = repo.listByUser(db.writer, {
      userId: "test-user",
      status: "resolved",
    });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.incidentId).toBe("inc-002");
  });

  it("listByUser filters by time range", () => {
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-001",
      ts: "2025-06-15T08:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-002",
      ts: "2025-06-15T12:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-003",
      ts: "2025-06-15T16:00:00.000Z",
    });

    const filtered = repo.listByUser(db.writer, {
      userId: "test-user",
      fromTs: "2025-06-15T10:00:00.000Z",
      toTs: "2025-06-15T14:00:00.000Z",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.incidentId).toBe("inc-002");
  });

  it("listByUser respects limit", () => {
    for (let i = 0; i < 5; i++) {
      repo.insert(db.writer, {
        ...baseIncident,
        incidentId: `inc-${i}`,
        ts: `2025-06-15T1${i}:00:00.000Z`,
      });
    }

    const limited = repo.listByUser(db.writer, {
      userId: "test-user",
      limit: 2,
    });
    expect(limited).toHaveLength(2);
  });

  it("findRecentBySignature returns matching incidents", () => {
    repo.insert(db.writer, baseIncident);
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-002",
      signature: "sig-abc123",
      ts: "2025-06-15T11:00:00.000Z",
    });
    repo.insert(db.writer, {
      ...baseIncident,
      incidentId: "inc-003",
      signature: "sig-different",
      ts: "2025-06-15T12:00:00.000Z",
    });

    const results = repo.findRecentBySignature(
      db.writer,
      "test-user",
      "sig-abc123",
    );
    expect(results).toHaveLength(2);
    // Most recent first
    expect(results[0]!.incidentId).toBe("inc-002");
  });

  it("handles optional nodeId", () => {
    repo.insert(db.writer, {
      ...baseIncident,
      nodeId: "node-abc",
    });

    const results = repo.listByUser(db.writer, { userId: "test-user" });
    expect(results[0]!.nodeId).toBe("node-abc");
  });

  it("handles missing optional fields as undefined", () => {
    repo.insert(db.writer, baseIncident);

    const results = repo.listByUser(db.writer, { userId: "test-user" });
    expect(results[0]!.runId).toBeUndefined();
    expect(results[0]!.nodeId).toBeUndefined();
  });
});
