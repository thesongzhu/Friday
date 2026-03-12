/**
 * Theme Manager — Theme switching, user preferences,
 * and accessibility settings.
 *
 * Manages theme definitions, user theme preferences,
 * and accessibility configuration for the UI layer.
 *
 * @module uix/engine
 */

import type {
  JsonObject,
} from "../model/friday-uix.types.js";

// ─── Types ───

/** Theme mode selection. */
export type ThemeMode = "light" | "dark" | "system";

/** Contrast preference for accessibility. */
export type ContrastPreference = "normal" | "high" | "highest";

/** Motion preference for accessibility. */
export type MotionPreference = "full" | "reduced" | "none";

/** Font size preset. */
export type FontSizePreset = "small" | "medium" | "large" | "x-large";

/** Color token definitions for a theme. */
export interface ThemeColorTokens {
  /** Primary brand color. */
  primary: string;
  /** Secondary accent color. */
  secondary: string;
  /** Background color. */
  background: string;
  /** Surface color (cards, panels). */
  surface: string;
  /** Primary text color. */
  text: string;
  /** Secondary/muted text color. */
  textSecondary: string;
  /** Border color. */
  border: string;
  /** Error/danger color. */
  error: string;
  /** Warning color. */
  warning: string;
  /** Success color. */
  success: string;
  /** Info color. */
  info: string;
}

/** A complete theme definition. */
export interface ThemeDefinition {
  /** Unique theme identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Theme mode. */
  mode: "light" | "dark";
  /** Color tokens. */
  colors: ThemeColorTokens;
  /** Font family stack. */
  fontFamily: string;
  /** Base font size in pixels. */
  baseFontSize: number;
  /** Border radius in pixels. */
  borderRadius: number;
  /** Spacing scale base in pixels. */
  spacingBase: number;
  /** Additional custom tokens. */
  customTokens: JsonObject;
}

/** Accessibility settings for a user. */
export interface AccessibilitySettings {
  /** Contrast preference. */
  contrast: ContrastPreference;
  /** Motion preference. */
  motion: MotionPreference;
  /** Font size preset. */
  fontSize: FontSizePreset;
  /** Whether to use system font instead of theme font. */
  useSystemFont: boolean;
  /** Whether to show focus indicators. */
  showFocusIndicators: boolean;
  /** Whether to underline links. */
  underlineLinks: boolean;
}

/** User theme preferences. */
export interface ThemePreferences {
  /** Selected theme mode. */
  mode: ThemeMode;
  /** Explicitly selected theme ID (overrides mode-based selection). */
  selectedThemeId?: string;
  /** Accessibility settings. */
  accessibility: AccessibilitySettings;
}

/** Resolved theme for rendering: theme definition merged with accessibility overrides. */
export interface ResolvedTheme {
  /** The base theme definition. */
  theme: ThemeDefinition;
  /** The resolved font size in pixels (adjusted for accessibility). */
  resolvedFontSize: number;
  /** Whether reduced motion is active. */
  reducedMotion: boolean;
  /** Whether high contrast is active. */
  highContrast: boolean;
}

/** Read/write interface for the theme manager. */
export interface ThemeManager {
  // ─── Theme Registry ───
  registerTheme(theme: ThemeDefinition): void;
  unregisterTheme(id: string): boolean;
  getTheme(id: string): ThemeDefinition | undefined;
  getAllThemes(): ThemeDefinition[];
  getThemesByMode(mode: "light" | "dark"): ThemeDefinition[];

  // ─── Preferences ───
  setPreferences(prefs: ThemePreferences): void;
  getPreferences(): ThemePreferences;
  setAccessibility(settings: Partial<AccessibilitySettings>): void;
  getAccessibility(): AccessibilitySettings;

  // ─── Resolution ───
  resolveTheme(systemPrefersDark?: boolean): ResolvedTheme | undefined;

  // ─── Defaults ───
  setDefaultLightTheme(id: string): void;
  setDefaultDarkTheme(id: string): void;
}

// ─── Constants ───

/** Font size multipliers for each preset. */
const FONT_SIZE_MULTIPLIER: Readonly<Record<FontSizePreset, number>> = {
  small: 0.875,
  medium: 1.0,
  large: 1.125,
  "x-large": 1.25,
};

/** Default accessibility settings. */
const DEFAULT_ACCESSIBILITY: AccessibilitySettings = {
  contrast: "normal",
  motion: "full",
  fontSize: "medium",
  useSystemFont: false,
  showFocusIndicators: true,
  underlineLinks: false,
};

/** Default theme preferences. */
const DEFAULT_PREFERENCES: ThemePreferences = {
  mode: "system",
  accessibility: { ...DEFAULT_ACCESSIBILITY },
};

// ─── Factory ───

/** Create a theme manager instance. */
export function createThemeManager(): ThemeManager {
  const themes = new Map<string, ThemeDefinition>();
  let preferences: ThemePreferences = { ...DEFAULT_PREFERENCES, accessibility: { ...DEFAULT_ACCESSIBILITY } };
  let defaultLightId: string | undefined;
  let defaultDarkId: string | undefined;

  function findDefaultTheme(mode: "light" | "dark"): ThemeDefinition | undefined {
    const defaultId = mode === "light" ? defaultLightId : defaultDarkId;
    if (defaultId) {
      const theme = themes.get(defaultId);
      if (theme) return theme;
    }
    // Fallback to first theme matching mode
    for (const theme of themes.values()) {
      if (theme.mode === mode) return theme;
    }
    return undefined;
  }

  return {
    // ─── Theme Registry ───

    registerTheme(theme) {
      themes.set(theme.id, theme);
    },

    unregisterTheme(id) {
      if (id === defaultLightId) defaultLightId = undefined;
      if (id === defaultDarkId) defaultDarkId = undefined;
      return themes.delete(id);
    },

    getTheme(id) {
      return themes.get(id);
    },

    getAllThemes() {
      return [...themes.values()];
    },

    getThemesByMode(mode) {
      const result: ThemeDefinition[] = [];
      for (const theme of themes.values()) {
        if (theme.mode === mode) result.push(theme);
      }
      return result;
    },

    // ─── Preferences ───

    setPreferences(prefs) {
      preferences = { ...prefs, accessibility: { ...prefs.accessibility } };
    },

    getPreferences() {
      return { ...preferences, accessibility: { ...preferences.accessibility } };
    },

    setAccessibility(settings) {
      preferences.accessibility = { ...preferences.accessibility, ...settings };
    },

    getAccessibility() {
      return { ...preferences.accessibility };
    },

    // ─── Resolution ───

    resolveTheme(systemPrefersDark = false) {
      let theme: ThemeDefinition | undefined;

      // Explicit theme selection takes precedence
      if (preferences.selectedThemeId) {
        theme = themes.get(preferences.selectedThemeId);
      }

      // Mode-based selection
      if (!theme) {
        const effectiveMode = preferences.mode === "system"
          ? (systemPrefersDark ? "dark" : "light")
          : preferences.mode;
        theme = findDefaultTheme(effectiveMode);
      }

      if (!theme) return undefined;

      const acc = preferences.accessibility;
      const resolvedFontSize = Math.round(theme.baseFontSize * FONT_SIZE_MULTIPLIER[acc.fontSize]);
      const reducedMotion = acc.motion !== "full";
      const highContrast = acc.contrast !== "normal";

      return { theme, resolvedFontSize, reducedMotion, highContrast };
    },

    // ─── Defaults ───

    setDefaultLightTheme(id) {
      defaultLightId = id;
    },

    setDefaultDarkTheme(id) {
      defaultDarkId = id;
    },
  };
}
