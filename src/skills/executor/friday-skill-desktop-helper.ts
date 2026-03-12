/**
 * Skill Desktop Helper — Provides desktop control context for skill execution.
 *
 * Follows the same helper injection pattern as FridaySkillAiHelperContext:
 * a lightweight interface that gets passed into the skill execution context
 * so skills can interact with the desktop environment at runtime.
 *
 * @module skills/executor/friday-skill-desktop-helper
 */

import type { DesktopSessionManager } from "../../desktop/engine/session-manager.js";
import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopPermission,
} from "../../desktop/model/friday-desktop.types.js";

// ─── Public Types ───

/** Desktop helper context injected into skill execution. */
export interface FridaySkillDesktopHelperContext {
  /** Execute a desktop action (click, type, screenshot, etc.). */
  executeAction(action: FridayDesktopAction): Promise<FridayDesktopActionResult>;

  /** Inspect a UI element by selector. */
  inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null>;

  /** Search for UI elements by text query. */
  searchElements(query: string, appBundleId?: string): Promise<readonly FridayDesktopElement[]>;

  /** Check OS-level permissions for desktop control. */
  checkPermissions(): Promise<readonly FridayDesktopPermission[]>;

  /** Get the action execution log for this session. */
  getActionLog(): readonly FridayDesktopActionResult[];

  /** Whether the desktop session is currently connected. */
  isConnected(): boolean;
}

export interface CreateFridaySkillDesktopHelperOptions {
  desktopSessionManager: DesktopSessionManager;
}

// ─── Factory ───

/**
 * Create a desktop helper context for skill execution.
 *
 * The returned object is a thin, safe facade over the DesktopSessionManager
 * that exposes only the operations skills should be allowed to perform.
 * Recording control is intentionally excluded — recording lifecycle is
 * managed by the agent or workflow runtime, not by individual skills.
 */
export function createFridaySkillDesktopHelper(
  options: CreateFridaySkillDesktopHelperOptions,
): FridaySkillDesktopHelperContext {
  const { desktopSessionManager } = options;

  return {
    async executeAction(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      if (!desktopSessionManager.isConnected()) {
        throw new Error("Desktop session is not connected");
      }
      return desktopSessionManager.executeAction(action);
    },

    async inspectElement(selector: FridayDesktopElementSelector): Promise<FridayDesktopElement | null> {
      if (!desktopSessionManager.isConnected()) {
        throw new Error("Desktop session is not connected");
      }
      return desktopSessionManager.inspectElement(selector);
    },

    async searchElements(query: string, appBundleId?: string): Promise<readonly FridayDesktopElement[]> {
      if (!desktopSessionManager.isConnected()) {
        throw new Error("Desktop session is not connected");
      }
      return desktopSessionManager.searchElements(query, appBundleId);
    },

    async checkPermissions(): Promise<readonly FridayDesktopPermission[]> {
      if (!desktopSessionManager.isConnected()) {
        throw new Error("Desktop session is not connected");
      }
      return desktopSessionManager.checkPermissions();
    },

    getActionLog(): readonly FridayDesktopActionResult[] {
      return desktopSessionManager.getActionLog();
    },

    isConnected(): boolean {
      return desktopSessionManager.isConnected();
    },
  };
}
