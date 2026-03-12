import { describe, it, expect, beforeEach } from "vitest";
import { createElementInspector } from "../../../../src/desktop/engine/element-inspector.js";
import type { ElementInspector } from "../../../../src/desktop/engine/element-inspector.js";
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

function makeElement(overrides: Partial<FridayDesktopElement> = {}): FridayDesktopElement {
  return {
    elementId: `el-${++idCounter}`,
    role: "button",
    name: "Submit",
    enabled: true,
    focused: false,
    visible: true,
    bounds: { x: 100, y: 200, width: 80, height: 30 },
    appBundleId: "com.example.app",
    displayIndex: 0,
    childCount: 0,
    platformAttributes: {},
    ...overrides,
  };
}

function makeMockAdapter(
  inspectResults: Map<string, FridayDesktopElement | null> = new Map(),
  searchResults: FridayDesktopElement[] = [],
): FridayDesktopAdapterRuntime {
  const metadata: FridayDesktopAdapter = {
    id: "darwin-adapter-v1",
    platform: "darwin",
    displayName: "macOS Adapter",
    version: "1.0.0",
    capabilities: ["click", "read_element", "element_search"],
    supportedOsVersions: ">=14.0",
    detectedOsVersion: "15.0",
    healthy: true,
    statusMessage: "Ready",
    initializedAt: NOW,
  };
  return {
    metadata,
    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      return { id: "r-1", action, status: "success", platform: "darwin", durationMs: 5, startedAt: NOW, completedAt: NOW };
    },
    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      return inspectResults.get(selector.value) ?? null;
    },
    async searchElements(): Promise<FridayDesktopElement[]> {
      return searchResults;
    },
    getCapabilities(): FridayDesktopCapability[] { return ["click", "read_element"]; },
    async checkPermissions(): Promise<FridayDesktopPermission[]> { return []; },
  };
}

// ─── Tests ───

describe("ElementInspector", () => {
  let inspector: ElementInspector;

  beforeEach(() => {
    idCounter = 0;
    inspector = createElementInspector(makeConfig());
  });

  describe("inspect", () => {
    it("resolves element with primary selector", async () => {
      const element = makeElement({ name: "OK Button" });
      const adapter = makeMockAdapter(new Map([["btn-ok", element]]));

      const result = await inspector.inspect(
        { strategy: "accessibility_id", value: "btn-ok" },
        adapter,
      );

      expect(result.element).toBe(element);
      expect(result.resolvedSelector?.value).toBe("btn-ok");
      expect(result.usedFallback).toBe(false);
      expect(result.attemptsCount).toBe(1);
    });

    it("falls back to secondary selector when primary fails", async () => {
      const element = makeElement({ name: "OK Button" });
      const adapter = makeMockAdapter(new Map([["fallback-id", element]]));

      const result = await inspector.inspect(
        {
          strategy: "accessibility_id",
          value: "primary-id",
          fallbacks: [{ strategy: "accessibility_id", value: "fallback-id" }],
        },
        adapter,
      );

      expect(result.element).toBe(element);
      expect(result.resolvedSelector?.value).toBe("fallback-id");
      expect(result.usedFallback).toBe(true);
      expect(result.attemptsCount).toBe(2);
    });

    it("returns null when no selector matches", async () => {
      const adapter = makeMockAdapter();

      const result = await inspector.inspect(
        {
          strategy: "accessibility_id",
          value: "nonexistent",
          fallbacks: [{ strategy: "accessibility_id", value: "also-nonexistent" }],
        },
        adapter,
      );

      expect(result.element).toBeNull();
      expect(result.resolvedSelector).toBeNull();
      expect(result.usedFallback).toBe(false);
      expect(result.attemptsCount).toBe(2);
    });

    it("tries fallbacks in order and stops at first match", async () => {
      const element = makeElement({ name: "Found" });
      const adapter = makeMockAdapter(new Map([["third", element]]));

      const result = await inspector.inspect(
        {
          strategy: "accessibility_id",
          value: "first",
          fallbacks: [
            { strategy: "accessibility_id", value: "second" },
            { strategy: "accessibility_id", value: "third" },
          ],
        },
        adapter,
      );

      expect(result.element).toBe(element);
      expect(result.attemptsCount).toBe(3);
      expect(result.usedFallback).toBe(true);
    });
  });

  describe("search", () => {
    it("delegates to adapter searchElements", async () => {
      const elements = [makeElement({ name: "Result 1" }), makeElement({ name: "Result 2" })];
      const adapter = makeMockAdapter(new Map(), elements);

      const results = await inspector.search("button", adapter);
      expect(results).toHaveLength(2);
    });

    it("passes appBundleId to adapter", async () => {
      let capturedAppId: string | undefined;
      const adapter = makeMockAdapter();
      adapter.searchElements = async (_q: string, appId?: string) => {
        capturedAppId = appId;
        return [];
      };

      await inspector.search("query", adapter, "com.example.app");
      expect(capturedAppId).toBe("com.example.app");
    });
  });

  describe("resolve", () => {
    it("returns element directly without metadata", async () => {
      const element = makeElement();
      const adapter = makeMockAdapter(new Map([["el-1", element]]));

      const result = await inspector.resolve(
        { strategy: "accessibility_id", value: "el-1" },
        adapter,
      );

      expect(result).toBe(element);
    });

    it("returns null when element is not found", async () => {
      const adapter = makeMockAdapter();

      const result = await inspector.resolve(
        { strategy: "accessibility_id", value: "missing" },
        adapter,
      );

      expect(result).toBeNull();
    });
  });
});
