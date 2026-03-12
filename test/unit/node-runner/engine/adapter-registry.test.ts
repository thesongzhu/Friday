import { describe, it, expect } from "vitest";

import { NodeAdapterRegistry } from "../../../../src/node-runner/engine/adapter-registry.js";
import type { FridayNodeAdapter } from "../../../../src/node-runner/model/friday-node-runner.types.js";

function createEmptyRegistry(): NodeAdapterRegistry {
  return new NodeAdapterRegistry({ registerBuiltIns: false });
}

function createMockAdapter(nodeType: string): FridayNodeAdapter {
  return {
    nodeType,
    load: async () => ({}),
    validateInput: () => ({ valid: true, errors: [] }),
    execute: async () => null,
    validateOutput: () => ({ valid: true, errors: [] }),
  };
}

describe("NodeAdapterRegistry", () => {
  describe("constructor", () => {
    it("does not register built-in adapters by default (opt-in)", () => {
      const registry = new NodeAdapterRegistry();

      expect(registry.listTypes()).toEqual([]);
    });

    it("registers built-in adapters when explicitly opted in", () => {
      const registry = new NodeAdapterRegistry({ registerBuiltIns: true });

      expect(registry.resolve({ type: "action", config: { actionType: "tool" } })?.nodeType).toBe("action:tool");
      expect(registry.resolve({ type: "ai" })?.nodeType).toBe("ai");
    });
  });

  describe("register", () => {
    it("registers an adapter by nodeType", () => {
      const registry = createEmptyRegistry();
      const adapter = createMockAdapter("action");
      registry.register(adapter);
      expect(registry.get("action")).toBe(adapter);
    });

    it("throws on empty nodeType", () => {
      const registry = createEmptyRegistry();
      const adapter = { ...createMockAdapter(""), nodeType: "" };
      expect(() => registry.register(adapter)).toThrow("non-empty nodeType");
    });

    it("overwrites existing registration for same nodeType", () => {
      const registry = createEmptyRegistry();
      const first = createMockAdapter("action");
      const second = createMockAdapter("action");
      registry.register(first);
      registry.register(second);
      expect(registry.get("action")).toBe(second);
    });
  });

  describe("get", () => {
    it("returns undefined for unregistered key", () => {
      const registry = new NodeAdapterRegistry();
      expect(registry.get("nonexistent")).toBeUndefined();
    });
  });

  describe("resolve", () => {
    it("resolves by exact adapterKey (level 1)", () => {
      const registry = createEmptyRegistry();
      const adapter = createMockAdapter("custom-key");
      registry.register(adapter);
      const result = registry.resolve({
        type: "action",
        config: { adapterKey: "custom-key" },
      });
      expect(result).toBe(adapter);
    });

    it("resolves by compound key nodeType:actionType (level 2)", () => {
      const registry = createEmptyRegistry();
      const toolAdapter = createMockAdapter("action:tool");
      registry.register(toolAdapter);
      const result = registry.resolve({
        type: "action",
        config: { actionType: "tool" },
      });
      expect(result).toBe(toolAdapter);
    });

    it("resolves by nodeType fallback (level 3)", () => {
      const registry = createEmptyRegistry();
      const adapter = createMockAdapter("action");
      registry.register(adapter);
      const result = registry.resolve({ type: "action" });
      expect(result).toBe(adapter);
    });

    it("resolves generic action adapter when built-ins are disabled", () => {
      const registry = createEmptyRegistry();
      const actionAdapter = createMockAdapter("action");
      registry.register(actionAdapter);

      const result = registry.resolve({
        type: "action",
        config: { actionType: "tool" },
      });

      expect(result).toBe(actionAdapter);
    });

    it("allows explicit action:tool registration to override built-in adapter", () => {
      const registry = new NodeAdapterRegistry();
      const override = createMockAdapter("action:tool");
      registry.register(override);

      const result = registry.resolve({
        type: "action",
        config: { actionType: "tool" },
      });

      expect(result).toBe(override);
    });

    it("prioritizes adapterKey over compound and fallback", () => {
      const registry = createEmptyRegistry();
      const exactAdapter = createMockAdapter("my-adapter");
      const compoundAdapter = createMockAdapter("action:tool");
      const fallbackAdapter = createMockAdapter("action");
      registry.register(exactAdapter);
      registry.register(compoundAdapter);
      registry.register(fallbackAdapter);
      const result = registry.resolve({
        type: "action",
        config: { adapterKey: "my-adapter", actionType: "tool" },
      });
      expect(result).toBe(exactAdapter);
    });

    it("falls through from adapterKey to compound to fallback", () => {
      const registry = createEmptyRegistry();
      const fallback = createMockAdapter("action");
      registry.register(fallback);
      const result = registry.resolve({
        type: "action",
        config: { adapterKey: "nonexistent", actionType: "missing" },
      });
      expect(result).toBe(fallback);
    });

    it("returns undefined when no adapter matches", () => {
      const registry = new NodeAdapterRegistry();
      expect(registry.resolve({ type: "unknown" })).toBeUndefined();
    });
  });

  describe("listTypes", () => {
    it("returns all registered type keys", () => {
      const registry = createEmptyRegistry();
      registry.register(createMockAdapter("action"));
      registry.register(createMockAdapter("action:tool"));
      registry.register(createMockAdapter("ai"));
      expect(registry.listTypes()).toEqual(
        expect.arrayContaining(["action", "action:tool", "ai"]),
      );
      expect(registry.listTypes()).toHaveLength(3);
    });

    it("returns empty array when no adapters registered", () => {
      const registry = createEmptyRegistry();
      expect(registry.listTypes()).toEqual([]);
    });
  });
});
