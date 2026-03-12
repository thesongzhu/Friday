import { describe, it, expect, beforeEach } from "vitest";
import {
  createThemeManager,
} from "../../../../src/uix/engine/theme-manager.js";
import type {
  ThemeManager,
  ThemeDefinition,
  ThemePreferences,
  AccessibilitySettings,
} from "../../../../src/uix/engine/theme-manager.js";

// ─── Fixtures ───

function makeLightTheme(overrides: Partial<ThemeDefinition> = {}): ThemeDefinition {
  return {
    id: "light-default",
    name: "Light",
    mode: "light",
    colors: {
      primary: "#0066cc",
      secondary: "#6c757d",
      background: "#ffffff",
      surface: "#f8f9fa",
      text: "#212529",
      textSecondary: "#6c757d",
      border: "#dee2e6",
      error: "#dc3545",
      warning: "#ffc107",
      success: "#28a745",
      info: "#17a2b8",
    },
    fontFamily: "Inter, sans-serif",
    baseFontSize: 16,
    borderRadius: 8,
    spacingBase: 4,
    customTokens: {},
    ...overrides,
  };
}

function makeDarkTheme(overrides: Partial<ThemeDefinition> = {}): ThemeDefinition {
  return {
    id: "dark-default",
    name: "Dark",
    mode: "dark",
    colors: {
      primary: "#4da3ff",
      secondary: "#adb5bd",
      background: "#1a1a2e",
      surface: "#16213e",
      text: "#e8e8e8",
      textSecondary: "#adb5bd",
      border: "#495057",
      error: "#ff6b6b",
      warning: "#ffd93d",
      success: "#6bcb77",
      info: "#4ecdc4",
    },
    fontFamily: "Inter, sans-serif",
    baseFontSize: 16,
    borderRadius: 8,
    spacingBase: 4,
    customTokens: {},
    ...overrides,
  };
}

// ─── Tests ───

describe("ThemeManager", () => {
  let tm: ThemeManager;

  beforeEach(() => {
    tm = createThemeManager();
  });

  describe("theme registry", () => {
    it("registers and retrieves a theme", () => {
      const theme = makeLightTheme();
      tm.registerTheme(theme);
      expect(tm.getTheme("light-default")).toEqual(theme);
    });

    it("returns undefined for unknown theme", () => {
      expect(tm.getTheme("unknown")).toBeUndefined();
    });

    it("lists all themes", () => {
      tm.registerTheme(makeLightTheme());
      tm.registerTheme(makeDarkTheme());
      expect(tm.getAllThemes()).toHaveLength(2);
    });

    it("filters themes by mode", () => {
      tm.registerTheme(makeLightTheme());
      tm.registerTheme(makeDarkTheme());

      const lightThemes = tm.getThemesByMode("light");
      expect(lightThemes).toHaveLength(1);
      expect(lightThemes[0].id).toBe("light-default");

      const darkThemes = tm.getThemesByMode("dark");
      expect(darkThemes).toHaveLength(1);
      expect(darkThemes[0].id).toBe("dark-default");
    });

    it("unregisters a theme", () => {
      tm.registerTheme(makeLightTheme());
      expect(tm.unregisterTheme("light-default")).toBe(true);
      expect(tm.getTheme("light-default")).toBeUndefined();
    });

    it("returns false when unregistering unknown theme", () => {
      expect(tm.unregisterTheme("unknown")).toBe(false);
    });
  });

  describe("preferences", () => {
    it("returns default preferences", () => {
      const prefs = tm.getPreferences();
      expect(prefs.mode).toBe("system");
      expect(prefs.accessibility.contrast).toBe("normal");
      expect(prefs.accessibility.motion).toBe("full");
      expect(prefs.accessibility.fontSize).toBe("medium");
    });

    it("sets and retrieves preferences", () => {
      const prefs: ThemePreferences = {
        mode: "dark",
        accessibility: {
          contrast: "high",
          motion: "reduced",
          fontSize: "large",
          useSystemFont: true,
          showFocusIndicators: true,
          underlineLinks: true,
        },
      };
      tm.setPreferences(prefs);
      expect(tm.getPreferences()).toEqual(prefs);
    });

    it("updates accessibility independently", () => {
      tm.setAccessibility({ contrast: "highest", fontSize: "x-large" });
      const acc = tm.getAccessibility();
      expect(acc.contrast).toBe("highest");
      expect(acc.fontSize).toBe("x-large");
      // Other settings remain default
      expect(acc.motion).toBe("full");
    });

    it("returns a copy (not a reference)", () => {
      const prefs = tm.getPreferences();
      prefs.mode = "dark";
      expect(tm.getPreferences().mode).toBe("system");
    });
  });

  describe("theme resolution", () => {
    it("resolves light theme when system prefers light", () => {
      tm.registerTheme(makeLightTheme());
      tm.registerTheme(makeDarkTheme());

      const resolved = tm.resolveTheme(false);
      expect(resolved).toBeDefined();
      expect(resolved!.theme.mode).toBe("light");
    });

    it("resolves dark theme when system prefers dark", () => {
      tm.registerTheme(makeLightTheme());
      tm.registerTheme(makeDarkTheme());

      const resolved = tm.resolveTheme(true);
      expect(resolved).toBeDefined();
      expect(resolved!.theme.mode).toBe("dark");
    });

    it("respects explicit mode preference over system", () => {
      tm.registerTheme(makeLightTheme());
      tm.registerTheme(makeDarkTheme());
      tm.setPreferences({
        mode: "light",
        accessibility: tm.getAccessibility(),
      });

      // System prefers dark, but user selected light
      const resolved = tm.resolveTheme(true);
      expect(resolved!.theme.mode).toBe("light");
    });

    it("uses explicitly selected theme ID", () => {
      tm.registerTheme(makeLightTheme({ id: "custom-light", name: "Custom Light" }));
      tm.registerTheme(makeDarkTheme());
      tm.setPreferences({
        mode: "dark",
        selectedThemeId: "custom-light",
        accessibility: tm.getAccessibility(),
      });

      const resolved = tm.resolveTheme(true);
      expect(resolved!.theme.id).toBe("custom-light");
    });

    it("returns undefined when no themes registered", () => {
      expect(tm.resolveTheme()).toBeUndefined();
    });

    it("adjusts font size based on accessibility preset", () => {
      tm.registerTheme(makeLightTheme());
      tm.setAccessibility({ fontSize: "large" });

      const resolved = tm.resolveTheme(false);
      expect(resolved!.resolvedFontSize).toBe(18); // 16 * 1.125 = 18
    });

    it("reports reduced motion when preference is not full", () => {
      tm.registerTheme(makeLightTheme());
      tm.setAccessibility({ motion: "reduced" });

      const resolved = tm.resolveTheme(false);
      expect(resolved!.reducedMotion).toBe(true);
    });

    it("reports high contrast when contrast is not normal", () => {
      tm.registerTheme(makeLightTheme());
      tm.setAccessibility({ contrast: "high" });

      const resolved = tm.resolveTheme(false);
      expect(resolved!.highContrast).toBe(true);
    });

    it("uses default theme IDs when set", () => {
      tm.registerTheme(makeLightTheme({ id: "l1" }));
      tm.registerTheme(makeLightTheme({ id: "l2" }));
      tm.setDefaultLightTheme("l2");

      const resolved = tm.resolveTheme(false);
      expect(resolved!.theme.id).toBe("l2");
    });

    it("clears default theme ID on unregister", () => {
      tm.registerTheme(makeLightTheme({ id: "l1" }));
      tm.registerTheme(makeLightTheme({ id: "l2" }));
      tm.setDefaultLightTheme("l1");
      tm.unregisterTheme("l1");

      // Should fallback to l2
      const resolved = tm.resolveTheme(false);
      expect(resolved!.theme.id).toBe("l2");
    });
  });

  describe("font size multipliers", () => {
    it("small = 0.875x", () => {
      tm.registerTheme(makeLightTheme());
      tm.setAccessibility({ fontSize: "small" });
      expect(tm.resolveTheme(false)!.resolvedFontSize).toBe(14); // 16 * 0.875
    });

    it("medium = 1.0x", () => {
      tm.registerTheme(makeLightTheme());
      tm.setAccessibility({ fontSize: "medium" });
      expect(tm.resolveTheme(false)!.resolvedFontSize).toBe(16);
    });

    it("x-large = 1.25x", () => {
      tm.registerTheme(makeLightTheme());
      tm.setAccessibility({ fontSize: "x-large" });
      expect(tm.resolveTheme(false)!.resolvedFontSize).toBe(20);
    });
  });
});
