import { describe, it, expect } from "vitest";
import {
  xhsRandomDelay,
  xhsRandomUserAgent,
  xhsRandomViewport,
  xhsBuildStealthConfig,
  xhsStealthScripts,
  XHS_STEALTH_CONSTANTS,
} from "#xhs";

describe("XhsStealth", () => {
  // ─── xhsRandomDelay ───

  describe("xhsRandomDelay", () => {
    it("returns a number within default range", () => {
      for (let i = 0; i < 50; i++) {
        const delay = xhsRandomDelay();
        expect(delay).toBeGreaterThanOrEqual(XHS_STEALTH_CONSTANTS.MIN_ACTION_DELAY_MS);
        expect(delay).toBeLessThanOrEqual(XHS_STEALTH_CONSTANTS.MAX_ACTION_DELAY_MS);
      }
    });

    it("respects custom min/max", () => {
      for (let i = 0; i < 50; i++) {
        const delay = xhsRandomDelay(100, 200);
        expect(delay).toBeGreaterThanOrEqual(100);
        expect(delay).toBeLessThanOrEqual(200);
      }
    });

    it("returns an integer", () => {
      const delay = xhsRandomDelay();
      expect(Number.isInteger(delay)).toBe(true);
    });
  });

  // ─── xhsRandomUserAgent ───

  describe("xhsRandomUserAgent", () => {
    it("returns a non-empty string", () => {
      const ua = xhsRandomUserAgent();
      expect(typeof ua).toBe("string");
      expect(ua.length).toBeGreaterThan(0);
    });

    it("returns a string from the known list", () => {
      const ua = xhsRandomUserAgent();
      expect(XHS_STEALTH_CONSTANTS.USER_AGENTS).toContain(ua);
    });

    it("contains Chrome identifier", () => {
      const ua = xhsRandomUserAgent();
      expect(ua).toContain("Chrome");
    });

    it("produces varying results over multiple calls", () => {
      const results = new Set<string>();
      for (let i = 0; i < 100; i++) {
        results.add(xhsRandomUserAgent());
      }
      // With 5 user agents, we should see at least 2 different ones in 100 calls
      expect(results.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ─── xhsRandomViewport ───

  describe("xhsRandomViewport", () => {
    it("returns width within bounds", () => {
      for (let i = 0; i < 50; i++) {
        const { width } = xhsRandomViewport();
        expect(width).toBeGreaterThanOrEqual(XHS_STEALTH_CONSTANTS.MIN_VIEWPORT_WIDTH);
        expect(width).toBeLessThanOrEqual(XHS_STEALTH_CONSTANTS.MAX_VIEWPORT_WIDTH);
      }
    });

    it("returns height within bounds", () => {
      for (let i = 0; i < 50; i++) {
        const { height } = xhsRandomViewport();
        expect(height).toBeGreaterThanOrEqual(XHS_STEALTH_CONSTANTS.MIN_VIEWPORT_HEIGHT);
        expect(height).toBeLessThanOrEqual(XHS_STEALTH_CONSTANTS.MAX_VIEWPORT_HEIGHT);
      }
    });

    it("returns integer dimensions", () => {
      const { width, height } = xhsRandomViewport();
      expect(Number.isInteger(width)).toBe(true);
      expect(Number.isInteger(height)).toBe(true);
    });
  });

  // ─── xhsBuildStealthConfig ───

  describe("xhsBuildStealthConfig", () => {
    it("returns a complete config object", () => {
      const config = xhsBuildStealthConfig();
      expect(config.minDelayMs).toBe(XHS_STEALTH_CONSTANTS.MIN_ACTION_DELAY_MS);
      expect(config.maxDelayMs).toBe(XHS_STEALTH_CONSTANTS.MAX_ACTION_DELAY_MS);
      expect(config.userAgent).toBeTruthy();
      expect(config.viewportWidth).toBeGreaterThanOrEqual(XHS_STEALTH_CONSTANTS.MIN_VIEWPORT_WIDTH);
      expect(config.viewportHeight).toBeGreaterThanOrEqual(XHS_STEALTH_CONSTANTS.MIN_VIEWPORT_HEIGHT);
    });
  });

  // ─── xhsStealthScripts ───

  describe("xhsStealthScripts", () => {
    it("returns webdriver override script", () => {
      const scripts = xhsStealthScripts();
      expect(scripts.webdriverOverride).toContain("webdriver");
      expect(scripts.webdriverOverride).toContain("false");
    });

    it("sets navigator.languages to include zh-CN", () => {
      const scripts = xhsStealthScripts();
      expect(scripts.webdriverOverride).toContain("zh-CN");
    });

    it("defines window.chrome", () => {
      const scripts = xhsStealthScripts();
      expect(scripts.webdriverOverride).toContain("window.chrome");
    });
  });

  // ─── Constants validation ───

  describe("constants", () => {
    it("has reasonable delay bounds", () => {
      expect(XHS_STEALTH_CONSTANTS.MIN_ACTION_DELAY_MS).toBeGreaterThanOrEqual(500);
      expect(XHS_STEALTH_CONSTANTS.MAX_ACTION_DELAY_MS).toBeLessThanOrEqual(5000);
      expect(XHS_STEALTH_CONSTANTS.MIN_ACTION_DELAY_MS).toBeLessThan(
        XHS_STEALTH_CONSTANTS.MAX_ACTION_DELAY_MS,
      );
    });

    it("has reasonable viewport bounds", () => {
      expect(XHS_STEALTH_CONSTANTS.MIN_VIEWPORT_WIDTH).toBeGreaterThanOrEqual(1024);
      expect(XHS_STEALTH_CONSTANTS.MAX_VIEWPORT_WIDTH).toBeLessThanOrEqual(2560);
      expect(XHS_STEALTH_CONSTANTS.MIN_VIEWPORT_HEIGHT).toBeGreaterThanOrEqual(600);
      expect(XHS_STEALTH_CONSTANTS.MAX_VIEWPORT_HEIGHT).toBeLessThanOrEqual(1440);
    });

    it("has at least 3 user agent options", () => {
      expect(XHS_STEALTH_CONSTANTS.USER_AGENTS.length).toBeGreaterThanOrEqual(3);
    });
  });
});
