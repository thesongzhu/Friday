/**
 * Non-Builder Product UX (UIX) — Core Runtime Engine.
 *
 * Exports the six engine modules that form the product UX runtime:
 *
 * 1. **Navigation Manager** — Route registry, breadcrumbs, navigation history.
 * 2. **Onboarding Engine** — Step-by-step onboarding flows and checklist tracking.
 * 3. **Command Palette** — Searchable command registry with fuzzy matching.
 * 4. **Notification Center** — In-app notification management and preferences.
 * 5. **Theme Manager** — Theme switching and accessibility settings.
 * 6. **Help System** — Contextual help, tooltips, and guided tours.
 *
 * @module uix/engine
 */

// ─── Navigation Manager ───
export { createNavigationManager } from "./navigation-manager.js";
export type {
  NavigationManager,
  NavigationNode,
  NavigationNodeVisibility,
  NavigationBadge,
  Breadcrumb,
  NavigationHistoryEntry,
} from "./navigation-manager.js";

// ─── Onboarding Engine ───
export { createOnboardingEngine } from "./onboarding-engine.js";
export type {
  OnboardingEngine,
  OnboardingFlowDefinition,
  OnboardingStepDefinition,
  OnboardingSession,
  OnboardingSessionStatus,
  OnboardingStepStatus,
  OnboardingStepProgress,
  OnboardingChecklistItem,
  OnboardingProgress,
  OnboardingTelemetryEventType,
  OnboardingTelemetryEvent,
  OnboardingSessionMetrics,
  OnboardingMetrics,
} from "./onboarding-engine.js";

// ─── Command Palette ───
export { createCommandPalette, fuzzyMatch } from "./command-palette.js";
export type {
  CommandPalette,
  PaletteCommand,
  PaletteCommandAction,
  PaletteSearchResult,
  PaletteSearchOptions,
  KeyboardShortcut,
  ShortcutModifier,
} from "./command-palette.js";

// ─── Notification Center ───
export { createNotificationCenter } from "./notification-center.js";
export type {
  NotificationCenter,
  Notification,
  NotificationPriority,
  NotificationCategory,
  NotificationCategoryPreference,
  NotificationSummary,
  NotificationFilter,
} from "./notification-center.js";

// ─── Theme Manager ───
export { createThemeManager } from "./theme-manager.js";
export type {
  ThemeManager,
  ThemeDefinition,
  ThemeColorTokens,
  ThemeMode,
  ThemePreferences,
  AccessibilitySettings,
  ContrastPreference,
  MotionPreference,
  FontSizePreset,
  ResolvedTheme,
} from "./theme-manager.js";

// ─── Help System ───
export { createHelpSystem } from "./help-system.js";
export type {
  HelpSystem,
  HelpArticle,
  HelpContentType,
  TooltipDefinition,
  TooltipPlacement,
  GuidedTour,
  TourStep,
  TourSession,
  TourSessionStatus,
  HelpSearchResult,
} from "./help-system.js";
