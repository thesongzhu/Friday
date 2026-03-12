import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createFridayChannelLoader,
  type FridayChannelPlugin,
  type FridayChannelLoader,
  type FridayChannelConfigAdapter,
} from "#channels";

// ─── Test Helpers ───

function createMockPlugin(kind = "test"): FridayChannelPlugin {
  return {
    kind,
    init: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: vi.fn(async () => ({ messageId: "sent-1" })),
  };
}

function createMockFactory(kind = "test"): () => FridayChannelPlugin {
  return () => createMockPlugin(kind);
}

// ─── Tests ───

describe("FridayChannelLoader", () => {
  let loader: FridayChannelLoader;

  beforeEach(() => {
    loader = createFridayChannelLoader();
  });

  // ─── Factory Registration ───

  describe("registerFactory", () => {
    it("registers a factory", () => {
      loader.registerFactory("qq", createMockFactory("qq"));
      expect(loader.hasFactory("qq")).toBe(true);
    });

    it("overwrites existing factory", () => {
      const factory1 = vi.fn(() => createMockPlugin("qq"));
      const factory2 = vi.fn(() => createMockPlugin("qq"));

      loader.registerFactory("qq", factory1);
      loader.registerFactory("qq", factory2);

      loader.create("qq");
      expect(factory1).not.toHaveBeenCalled();
      expect(factory2).toHaveBeenCalled();
    });
  });

  describe("unregisterFactory", () => {
    it("removes a registered factory", () => {
      loader.registerFactory("qq", createMockFactory("qq"));
      loader.unregisterFactory("qq");
      expect(loader.hasFactory("qq")).toBe(false);
    });

    it("no-ops for unknown kind", () => {
      loader.unregisterFactory("nonexistent");
      expect(loader.listFactories()).toEqual([]);
    });
  });

  describe("listFactories", () => {
    it("lists all registered kinds", () => {
      loader.registerFactory("qq", createMockFactory("qq"));
      loader.registerFactory("lark", createMockFactory("lark"));
      expect(loader.listFactories()).toEqual(["qq", "lark"]);
    });

    it("returns empty array when none registered", () => {
      expect(loader.listFactories()).toEqual([]);
    });
  });

  // ─── Create ───

  describe("create", () => {
    it("creates a plugin via factory", () => {
      loader.registerFactory("qq", createMockFactory("qq"));
      const plugin = loader.create("qq");
      expect(plugin.kind).toBe("qq");
    });

    it("throws for unknown kind with helpful message", () => {
      loader.registerFactory("lark", createMockFactory("lark"));
      expect(() => loader.create("qq")).toThrow(
        'No channel factory registered for kind "qq". Available: lark',
      );
    });

    it("throws with empty available list when none registered", () => {
      expect(() => loader.create("qq")).toThrow(
        'No channel factory registered for kind "qq". Available: (none)',
      );
    });

    it("creates independent instances on each call", () => {
      loader.registerFactory("qq", createMockFactory("qq"));
      const p1 = loader.create("qq");
      const p2 = loader.create("qq");
      expect(p1).not.toBe(p2);
    });
  });

  // ─── Create and Init ───

  describe("createAndInit", () => {
    it("creates and initializes a plugin", async () => {
      loader.registerFactory("qq", createMockFactory("qq"));
      const plugin = await loader.createAndInit("qq", { appId: "a", appSecret: "b" });
      expect(plugin.kind).toBe("qq");
      expect(plugin.init).toHaveBeenCalledWith({ appId: "a", appSecret: "b" });
    });

    it("uses config adapter validation when available", async () => {
      const configAdapter: FridayChannelConfigAdapter = {
        validate: vi.fn((raw) => ({ ...raw, validated: true })),
        defaults: () => ({}),
      };

      const factory = () => {
        const plugin = createMockPlugin("custom");
        plugin.adapters = { config: configAdapter };
        return plugin;
      };

      loader.registerFactory("custom", factory);
      const plugin = await loader.createAndInit("custom", { key: "value" });

      expect(configAdapter.validate).toHaveBeenCalledWith({ key: "value" });
      expect(plugin.init).toHaveBeenCalledWith({ key: "value", validated: true });
    });

    it("throws for unknown kind", async () => {
      await expect(loader.createAndInit("unknown", {})).rejects.toThrow(
        'No channel factory registered for kind "unknown"',
      );
    });
  });

  // ─── Builtins ───

  describe("builtins", () => {
    it("pre-registers built-in factories", () => {
      const loader = createFridayChannelLoader({
        builtins: {
          qq: createMockFactory("qq"),
          lark: createMockFactory("lark"),
        },
      });

      expect(loader.hasFactory("qq")).toBe(true);
      expect(loader.hasFactory("lark")).toBe(true);
      expect(loader.listFactories()).toEqual(["qq", "lark"]);
    });

    it("builtins can be overwritten", () => {
      const builtinFactory = vi.fn(() => createMockPlugin("qq"));
      const overrideFactory = vi.fn(() => createMockPlugin("qq"));

      const loader = createFridayChannelLoader({
        builtins: { qq: builtinFactory },
      });

      loader.registerFactory("qq", overrideFactory);
      loader.create("qq");

      expect(builtinFactory).not.toHaveBeenCalled();
      expect(overrideFactory).toHaveBeenCalled();
    });

    it("registers all expected channel kinds as builtins", () => {
      const allKinds = [
        "qq", "lark", "feishu", "discord", "telegram",
        "whatsapp", "signal", "slack", "webchat", "irc", "line",
      ];

      const builtins: Record<string, () => FridayChannelPlugin> = {};
      for (const kind of allKinds) {
        builtins[kind] = createMockFactory(kind);
      }

      const loader = createFridayChannelLoader({ builtins });

      for (const kind of allKinds) {
        expect(loader.hasFactory(kind)).toBe(true);
      }

      expect(loader.listFactories().sort()).toEqual(allKinds.sort());
    });
  });
});
