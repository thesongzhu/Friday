/**
 * Element Inspector — UI element discovery, inspection, and querying.
 *
 * Provides a high-level API for locating desktop UI elements using multiple
 * selector strategies (accessibility ID, role+name, XPath, coordinates,
 * app menu path, window title). Supports fallback selectors: if the primary
 * selector fails, each fallback is tried in order.
 *
 * Delegates the actual element resolution to the platform adapter.
 *
 * @module desktop/engine/element-inspector
 */

import type {
  FridayDesktopAdapterRuntime,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopEngineConfig,
} from "../model/friday-desktop.types.js";

// ─── Public Types ───

/** Configuration for element inspector creation. */
export interface ElementInspectorConfig {
  readonly generateId: FridayDesktopEngineConfig["generateId"];
  readonly nowIso: FridayDesktopEngineConfig["nowIso"];
}

/** Result of an element inspection with resolution metadata. */
export interface ElementInspectionResult {
  /** The resolved element, or null if not found. */
  readonly element: FridayDesktopElement | null;
  /** Which selector successfully resolved (null if none). */
  readonly resolvedSelector: FridayDesktopElementSelector | null;
  /** Whether a fallback selector was used. */
  readonly usedFallback: boolean;
  /** Number of selectors attempted before resolution. */
  readonly attemptsCount: number;
}

/** Element inspector interface. */
export interface ElementInspector {
  /** Inspect a single element by selector, trying fallbacks if primary fails. */
  inspect(
    selector: FridayDesktopElementSelector,
    adapter: FridayDesktopAdapterRuntime,
  ): Promise<ElementInspectionResult>;

  /** Search for elements matching a text query. */
  search(
    query: string,
    adapter: FridayDesktopAdapterRuntime,
    appBundleId?: string,
  ): Promise<readonly FridayDesktopElement[]>;

  /** Resolve a selector to an element, returning null if not found (no fallback metadata). */
  resolve(
    selector: FridayDesktopElementSelector,
    adapter: FridayDesktopAdapterRuntime,
  ): Promise<FridayDesktopElement | null>;
}

// ─── Factory ───

/** Create an element inspector instance. */
export function createElementInspector(config: ElementInspectorConfig): ElementInspector {
  async function inspectWithFallbacks(
    selector: FridayDesktopElementSelector,
    adapter: FridayDesktopAdapterRuntime,
  ): Promise<ElementInspectionResult> {
    let attemptsCount = 0;

    // Try primary selector
    attemptsCount++;
    const primary = await adapter.inspectElement(selector);
    if (primary !== null) {
      return {
        element: primary,
        resolvedSelector: selector,
        usedFallback: false,
        attemptsCount,
      };
    }

    // Try fallback selectors in order
    if (selector.fallbacks) {
      for (const fallback of selector.fallbacks) {
        attemptsCount++;
        const result = await adapter.inspectElement(fallback);
        if (result !== null) {
          return {
            element: result,
            resolvedSelector: fallback,
            usedFallback: true,
            attemptsCount,
          };
        }
      }
    }

    return {
      element: null,
      resolvedSelector: null,
      usedFallback: false,
      attemptsCount,
    };
  }

  return {
    async inspect(
      selector: FridayDesktopElementSelector,
      adapter: FridayDesktopAdapterRuntime,
    ): Promise<ElementInspectionResult> {
      return inspectWithFallbacks(selector, adapter);
    },

    async search(
      query: string,
      adapter: FridayDesktopAdapterRuntime,
      appBundleId?: string,
    ): Promise<readonly FridayDesktopElement[]> {
      return adapter.searchElements(query, appBundleId);
    },

    async resolve(
      selector: FridayDesktopElementSelector,
      adapter: FridayDesktopAdapterRuntime,
    ): Promise<FridayDesktopElement | null> {
      const result = await inspectWithFallbacks(selector, adapter);
      return result.element;
    },
  };
}
