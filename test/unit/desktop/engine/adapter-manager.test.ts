import { describe, it, expect, beforeEach } from "vitest";
import { createAdapterManager } from "../../../../src/desktop/engine/adapter-manager.js";
import type { AdapterManager } from "../../../../src/desktop/engine/adapter-manager.js";
import type {
  FridayDesktopAdapterRuntime,
  FridayDesktopAdapter,
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopPermission,
} from "../../../../src/desktop/model/friday-desktop.types.js";

// ─── Fixtures ───

const NOW = "2026-02-24T12:00:00.000Z";
let idCounter = 0;

function makeConfig() {
  return {
    generateId: () => `id-${++idCounter}`,
    nowIso: () => NOW,
  };
}

function makeMockAdapter(
  platform: "darwin" | "win32" | "linux",
  capabilities: FridayDesktopCapability[] = ["click", "type", "screenshot"],
): FridayDesktopAdapterRuntime {
  const metadata: FridayDesktopAdapter = {
    id: `${platform}-adapter-v1`,
    platform,
    displayName: `${platform} Adapter`,
    version: "1.0.0",
    capabilities,
    supportedOsVersions: ">=14.0",
    detectedOsVersion: "15.0",
    healthy: true,
    statusMessage: "Ready",
    initializedAt: NOW,
  };

  return {
    metadata,
    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      return {
        id: "result-1",
        action,
        status: "success",
        platform,
        durationMs: 10,
        startedAt: NOW,
        completedAt: NOW,
      };
    },
    async inspectElement(): Promise<FridayDesktopElement | null> {
      return null;
    },
    async searchElements(): Promise<FridayDesktopElement[]> {
      return [];
    },
    getCapabilities(): FridayDesktopCapability[] {
      return [...capabilities];
    },
    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      return [];
    },
  };
}

// ─── Tests ───

describe("AdapterManager", () => {
  let manager: AdapterManager;

  beforeEach(() => {
    idCounter = 0;
    manager = createAdapterManager(makeConfig());
  });

  describe("register / unregister", () => {
    it("registers an adapter and retrieves it by platform", () => {
      const adapter = makeMockAdapter("darwin");
      manager.register(adapter);

      const result = manager.getAdapter("darwin");
      expect(result).toBe(adapter);
    });

    it("replaces an existing adapter for the same platform", () => {
      const first = makeMockAdapter("darwin");
      const second = makeMockAdapter("darwin");
      manager.register(first);
      manager.register(second);

      expect(manager.getAdapter("darwin")).toBe(second);
    });

    it("unregisters an adapter by platform", () => {
      manager.register(makeMockAdapter("darwin"));
      const removed = manager.unregister("darwin");

      expect(removed).toBe(true);
      expect(manager.getAdapter("darwin")).toBeNull();
    });

    it("returns false when unregistering a non-existent platform", () => {
      expect(manager.unregister("win32")).toBe(false);
    });
  });

  describe("getAdapter", () => {
    it("returns null for unregistered platforms", () => {
      expect(manager.getAdapter("linux")).toBeNull();
    });
  });

  describe("getActiveAdapter", () => {
    it("returns null adapter when no adapter is registered for detected platform", async () => {
      const adapter = manager.getActiveAdapter();
      const result = await adapter.execute({ type: "click" });
      expect(result.status).toBe("unsupported_platform");
      const detected = manager.getDetectedPlatform();
      if (detected) {
        expect(adapter.metadata.platform).toBe(detected);
      }
    });

    it("returns registered adapter for detected platform", () => {
      // The test environment runs on darwin (macOS) or linux (CI)
      const platform = process.platform as "darwin" | "win32" | "linux";
      const adapter = makeMockAdapter(platform);
      manager.register(adapter);

      expect(manager.getActiveAdapter()).toBe(adapter);
    });
  });

  describe("listAdapters", () => {
    it("returns empty array with no registrations", () => {
      expect(manager.listAdapters()).toEqual([]);
    });

    it("returns metadata for all registered adapters", () => {
      manager.register(makeMockAdapter("darwin"));
      manager.register(makeMockAdapter("linux"));

      const list = manager.listAdapters();
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.platform).sort()).toEqual(["darwin", "linux"]);
    });
  });

  describe("hasCapability", () => {
    it("returns false when no adapter is active", () => {
      expect(manager.hasCapability("click")).toBe(false);
    });

    it("returns true when active adapter supports the capability", () => {
      const platform = process.platform as "darwin" | "win32" | "linux";
      manager.register(makeMockAdapter(platform, ["click", "screenshot"]));

      expect(manager.hasCapability("click")).toBe(true);
      expect(manager.hasCapability("screenshot")).toBe(true);
    });

    it("returns false when active adapter does not support the capability", () => {
      const platform = process.platform as "darwin" | "win32" | "linux";
      manager.register(makeMockAdapter(platform, ["click"]));

      expect(manager.hasCapability("drag")).toBe(false);
    });
  });

  describe("getDetectedPlatform", () => {
    it("returns the current platform", () => {
      const detected = manager.getDetectedPlatform();
      expect(["darwin", "win32", "linux", null]).toContain(detected);
    });
  });
});
