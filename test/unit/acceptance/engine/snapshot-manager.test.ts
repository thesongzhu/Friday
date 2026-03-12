import { describe, it, expect, beforeEach } from "vitest";
import {
  AcceptanceSnapshotManager,
  computeDiffs,
} from "../../../../src/acceptance/engine/snapshot-manager.js";

// ─── computeDiffs ───

describe("computeDiffs", () => {
  it("returns empty for identical primitives", () => {
    expect(computeDiffs(42, 42)).toEqual([]);
    expect(computeDiffs("hello", "hello")).toEqual([]);
    expect(computeDiffs(true, true)).toEqual([]);
    expect(computeDiffs(null, null)).toEqual([]);
  });

  it("detects changed primitive", () => {
    const diffs = computeDiffs(42, 99);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("changed");
    expect(diffs[0].expected).toBe(42);
    expect(diffs[0].actual).toBe(99);
  });

  it("detects type mismatch", () => {
    const diffs = computeDiffs(42, "42");
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("type_mismatch");
  });

  it("detects null vs non-null", () => {
    const diffs = computeDiffs(null, { a: 1 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("changed");
  });

  it("detects added object properties", () => {
    const diffs = computeDiffs({ a: 1 }, { a: 1, b: 2 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("added");
    expect(diffs[0].path).toBe("b");
  });

  it("detects removed object properties", () => {
    const diffs = computeDiffs({ a: 1, b: 2 }, { a: 1 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("removed");
    expect(diffs[0].path).toBe("b");
  });

  it("detects changed object properties", () => {
    const diffs = computeDiffs({ a: 1, b: 2 }, { a: 1, b: 3 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("changed");
    expect(diffs[0].path).toBe("b");
  });

  it("detects nested object diffs", () => {
    const diffs = computeDiffs(
      { a: { b: { c: 1 } } },
      { a: { b: { c: 2 } } },
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("a.b.c");
    expect(diffs[0].type).toBe("changed");
  });

  it("detects added array elements", () => {
    const diffs = computeDiffs([1, 2], [1, 2, 3]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("added");
    expect(diffs[0].path).toBe("[2]");
  });

  it("detects removed array elements", () => {
    const diffs = computeDiffs([1, 2, 3], [1, 2]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("removed");
    expect(diffs[0].path).toBe("[2]");
  });

  it("detects changed array elements", () => {
    const diffs = computeDiffs([1, 2, 3], [1, 99, 3]);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].path).toBe("[1]");
    expect(diffs[0].type).toBe("changed");
  });

  it("returns empty for identical objects", () => {
    expect(computeDiffs({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toEqual([]);
  });

  it("handles array vs non-array type mismatch", () => {
    const diffs = computeDiffs([1, 2], { 0: 1, 1: 2 });
    expect(diffs).toHaveLength(1);
    expect(diffs[0].type).toBe("type_mismatch");
  });
});

// ─── AcceptanceSnapshotManager ───

describe("AcceptanceSnapshotManager", () => {
  let manager: AcceptanceSnapshotManager;

  beforeEach(() => {
    manager = new AcceptanceSnapshotManager();
  });

  // ─── save / get / has ───

  describe("save, get, has", () => {
    it("saves and retrieves a snapshot", () => {
      manager.save("key-1", { data: "value" }, "A test snapshot");

      const snapshot = manager.get("key-1");
      expect(snapshot).toBeDefined();
      expect(snapshot!.value).toEqual({ data: "value" });
      expect(snapshot!.description).toBe("A test snapshot");
    });

    it("returns undefined for nonexistent key", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });

    it("has returns true for existing snapshot", () => {
      manager.save("key-1", 42);
      expect(manager.has("key-1")).toBe(true);
    });

    it("has returns false for nonexistent key", () => {
      expect(manager.has("nonexistent")).toBe(false);
    });

    it("overwrites on re-save", () => {
      manager.save("key-1", "old");
      manager.save("key-1", "new");
      expect(manager.get("key-1")!.value).toBe("new");
    });
  });

  // ─── compare ───

  describe("compare", () => {
    it("returns match for identical values", () => {
      manager.save("key-1", { a: 1, b: [2, 3] });

      const result = manager.compare("key-1", { a: 1, b: [2, 3] });
      expect(result.matches).toBe(true);
      expect(result.diffs).toEqual([]);
    });

    it("returns diffs for differing values", () => {
      manager.save("key-1", { a: 1, b: 2 });

      const result = manager.compare("key-1", { a: 1, b: 99 });
      expect(result.matches).toBe(false);
      expect(result.diffs).toHaveLength(1);
      expect(result.diffs[0].path).toBe("b");
    });

    it("creates new snapshot when key does not exist", () => {
      const result = manager.compare("new-key", { data: "hello" });
      expect(result.matches).toBe(true);
      expect(manager.has("new-key")).toBe(true);
    });

    it("updates snapshot on mismatch when updateOnMismatch is true", () => {
      manager.save("key-1", { old: true });

      const result = manager.compare("key-1", { new: true }, { updateOnMismatch: true });
      expect(result.matches).toBe(false);

      // Snapshot should now be updated.
      expect(manager.get("key-1")!.value).toEqual({ new: true });
    });

    it("does NOT update snapshot on mismatch by default", () => {
      manager.save("key-1", { old: true });

      manager.compare("key-1", { new: true });

      // Snapshot should remain unchanged.
      expect(manager.get("key-1")!.value).toEqual({ old: true });
    });
  });

  // ─── remove / clear / listKeys ───

  describe("remove, clear, listKeys", () => {
    it("removes a snapshot", () => {
      manager.save("key-1", 1);
      expect(manager.remove("key-1")).toBe(true);
      expect(manager.has("key-1")).toBe(false);
    });

    it("returns false for removing nonexistent key", () => {
      expect(manager.remove("nonexistent")).toBe(false);
    });

    it("lists all keys", () => {
      manager.save("a", 1);
      manager.save("b", 2);
      manager.save("c", 3);

      expect(manager.listKeys().sort()).toEqual(["a", "b", "c"]);
    });

    it("clears all snapshots", () => {
      manager.save("a", 1);
      manager.save("b", 2);

      manager.clear();
      expect(manager.size).toBe(0);
    });
  });

  // ─── size ───

  describe("size", () => {
    it("returns 0 when empty", () => {
      expect(manager.size).toBe(0);
    });

    it("returns correct count", () => {
      manager.save("a", 1);
      manager.save("b", 2);
      expect(manager.size).toBe(2);
    });
  });

  // ─── exportAll / importAll ───

  describe("exportAll and importAll", () => {
    it("round-trips snapshots through export/import", () => {
      manager.save("key-1", { data: [1, 2, 3] }, "Test");
      manager.save("key-2", "hello");

      const exported = manager.exportAll();

      const newManager = new AcceptanceSnapshotManager();
      newManager.importAll(exported);

      expect(newManager.size).toBe(2);
      expect(newManager.get("key-1")!.value).toEqual({ data: [1, 2, 3] });
      expect(newManager.get("key-2")!.value).toBe("hello");
    });

    it("import overwrites existing snapshots", () => {
      manager.save("key-1", "old");
      manager.importAll({ "key-1": { key: "key-1", value: "new", updatedAt: "2026-01-01T00:00:00Z" } });

      expect(manager.get("key-1")!.value).toBe("new");
    });
  });
});
