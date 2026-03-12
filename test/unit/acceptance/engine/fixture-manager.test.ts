import { describe, it, expect, beforeEach } from "vitest";
import {
  AcceptanceFixtureManager,
  type AcceptanceFixture,
} from "../../../../src/acceptance/engine/fixture-manager.js";

// ─── Helpers ───

function makeFixture(overrides: Partial<AcceptanceFixture> = {}): AcceptanceFixture {
  return {
    id: overrides.id ?? "fixture-1",
    name: overrides.name ?? "Test Fixture",
    artifactType: overrides.artifactType ?? "json",
    content: overrides.content ?? { key: "value" },
    metadata: overrides.metadata,
  };
}

// ─── Tests ───

describe("AcceptanceFixtureManager", () => {
  let manager: AcceptanceFixtureManager;

  beforeEach(() => {
    manager = new AcceptanceFixtureManager();
  });

  // ─── load / get ───

  describe("load and get", () => {
    it("loads and retrieves a fixture", () => {
      const fixture = makeFixture();
      manager.load(fixture);

      const result = manager.get("fixture-1");
      expect(result).toEqual(fixture);
    });

    it("returns undefined for nonexistent fixture", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });

    it("throws on duplicate ID without overwrite", () => {
      manager.load(makeFixture());
      expect(() => manager.load(makeFixture())).toThrow("already exists");
    });

    it("allows overwrite with flag", () => {
      manager.load(makeFixture({ content: "old" }));
      manager.load(makeFixture({ content: "new" }), { overwrite: true });

      expect(manager.get("fixture-1")?.content).toBe("new");
    });
  });

  // ─── Namespaces ───

  describe("namespaces", () => {
    it("isolates fixtures by namespace", () => {
      manager.load(makeFixture({ id: "a", content: "default" }));
      manager.load(makeFixture({ id: "a", content: "custom" }), { namespace: "custom" });

      expect(manager.get("a")?.content).toBe("default");
      expect(manager.get("a", "custom")?.content).toBe("custom");
    });

    it("listNamespaces returns all active namespaces", () => {
      manager.load(makeFixture({ id: "a" }));
      manager.load(makeFixture({ id: "b" }), { namespace: "ns1" });
      manager.load(makeFixture({ id: "c" }), { namespace: "ns2" });

      expect(manager.listNamespaces().sort()).toEqual(["default", "ns1", "ns2"]);
    });

    it("clears a single namespace", () => {
      manager.load(makeFixture({ id: "a" }));
      manager.load(makeFixture({ id: "b" }), { namespace: "ns1" });

      manager.clear("ns1");

      expect(manager.get("a")).toBeDefined();
      expect(manager.get("b", "ns1")).toBeUndefined();
    });

    it("clears all namespaces", () => {
      manager.load(makeFixture({ id: "a" }));
      manager.load(makeFixture({ id: "b" }), { namespace: "ns1" });

      manager.clear();

      expect(manager.get("a")).toBeUndefined();
      expect(manager.get("b", "ns1")).toBeUndefined();
    });
  });

  // ─── loadBulk ───

  describe("loadBulk", () => {
    it("loads multiple fixtures at once", () => {
      const fixtures = [
        makeFixture({ id: "a", name: "A" }),
        makeFixture({ id: "b", name: "B" }),
        makeFixture({ id: "c", name: "C" }),
      ];

      manager.loadBulk(fixtures);

      expect(manager.listIds()).toHaveLength(3);
      expect(manager.get("b")?.name).toBe("B");
    });
  });

  // ─── getByArtifactType ───

  describe("getByArtifactType", () => {
    it("filters fixtures by artifact type", () => {
      manager.loadBulk([
        makeFixture({ id: "json-1", artifactType: "json" }),
        makeFixture({ id: "text-1", artifactType: "text" }),
        makeFixture({ id: "json-2", artifactType: "json" }),
      ]);

      const jsonFixtures = manager.getByArtifactType("json");
      expect(jsonFixtures).toHaveLength(2);
      expect(jsonFixtures.map((f) => f.id).sort()).toEqual(["json-1", "json-2"]);
    });

    it("returns empty array for unmatched type", () => {
      manager.load(makeFixture({ artifactType: "json" }));
      expect(manager.getByArtifactType("image")).toEqual([]);
    });

    it("returns empty array for empty namespace", () => {
      expect(manager.getByArtifactType("json", "nonexistent")).toEqual([]);
    });
  });

  // ─── has / remove ───

  describe("has and remove", () => {
    it("has returns true for existing fixture", () => {
      manager.load(makeFixture());
      expect(manager.has("fixture-1")).toBe(true);
    });

    it("has returns false for nonexistent fixture", () => {
      expect(manager.has("nonexistent")).toBe(false);
    });

    it("removes a fixture and returns true", () => {
      manager.load(makeFixture());
      expect(manager.remove("fixture-1")).toBe(true);
      expect(manager.get("fixture-1")).toBeUndefined();
    });

    it("returns false when removing nonexistent fixture", () => {
      expect(manager.remove("nonexistent")).toBe(false);
    });

    it("cleans up empty namespace after removal", () => {
      manager.load(makeFixture({ id: "only" }), { namespace: "temp" });
      manager.remove("only", "temp");

      expect(manager.listNamespaces()).not.toContain("temp");
    });
  });

  // ─── listIds ───

  describe("listIds", () => {
    it("lists all fixture IDs in default namespace", () => {
      manager.loadBulk([
        makeFixture({ id: "a" }),
        makeFixture({ id: "b" }),
      ]);

      expect(manager.listIds().sort()).toEqual(["a", "b"]);
    });

    it("returns empty for unknown namespace", () => {
      expect(manager.listIds("unknown")).toEqual([]);
    });
  });

  // ─── stats ───

  describe("stats", () => {
    it("returns correct statistics", () => {
      manager.loadBulk([
        makeFixture({ id: "a" }),
        makeFixture({ id: "b" }),
      ]);
      manager.load(makeFixture({ id: "c" }), { namespace: "ns1" });

      const stats = manager.stats();
      expect(stats.totalFixtures).toBe(3);
      expect(stats.namespaceCount).toBe(2);
      expect(stats.perNamespace["default"]).toBe(2);
      expect(stats.perNamespace["ns1"]).toBe(1);
    });

    it("returns zero stats when empty", () => {
      const stats = manager.stats();
      expect(stats.totalFixtures).toBe(0);
      expect(stats.namespaceCount).toBe(0);
    });
  });
});
