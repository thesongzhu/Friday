/**
 * Adapter Manager — Platform adapter registry and lifecycle management.
 *
 * Maintains a registry of platform adapters keyed by platform identifier.
 * Provides adapter selection based on the current OS platform with fallback
 * to a null adapter that returns `unsupported_platform` for all operations.
 *
 * @module desktop/engine/adapter-manager
 */

import type {
  FridayDesktopAction,
  FridayDesktopActionResult,
  FridayDesktopAdapter,
  FridayDesktopAdapterRuntime,
  FridayDesktopCapability,
  FridayDesktopElement,
  FridayDesktopElementSelector,
  FridayDesktopEngineConfig,
  FridayDesktopPermission,
  FridayDesktopPlatform,
  ISODateTime,
  UUID,
} from "../model/friday-desktop.types.js";

import {
  FRIDAY_DESKTOP_ERROR_CODES,
  FRIDAY_DESKTOP_PLATFORMS,
} from "../model/friday-desktop.types.js";

// ─── Public Types ───

/** Configuration for adapter manager creation. */
export interface AdapterManagerConfig {
  readonly generateId: FridayDesktopEngineConfig["generateId"];
  readonly nowIso: FridayDesktopEngineConfig["nowIso"];
}

/** Adapter manager interface. */
export interface AdapterManager {
  /** Register a platform adapter. Replaces any existing adapter for the same platform. */
  register(adapter: FridayDesktopAdapterRuntime): void;

  /** Unregister an adapter by platform. Returns true if an adapter was removed. */
  unregister(platform: FridayDesktopPlatform): boolean;

  /** Get the adapter for a specific platform (or null if not registered). */
  getAdapter(platform: FridayDesktopPlatform): FridayDesktopAdapterRuntime | null;

  /** Get the active adapter for the current detected platform. Falls back to null adapter. */
  getActiveAdapter(): FridayDesktopAdapterRuntime;

  /** Get the detected platform. */
  getDetectedPlatform(): FridayDesktopPlatform | null;

  /** List all registered adapter metadata. */
  listAdapters(): readonly FridayDesktopAdapter[];

  /** Check if a specific capability is supported by the active adapter. */
  hasCapability(capability: FridayDesktopCapability): boolean;
}

// ─── Null Adapter ───

function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item);
    }
  } else {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return Object.freeze(value);
}

function toFrozenSnapshot<T>(value: T): Readonly<T> {
  return deepFreeze(deepClone(value));
}

function createNullAdapter(
  config: AdapterManagerConfig,
  platform: FridayDesktopPlatform,
): FridayDesktopAdapterRuntime {
  const metadata: FridayDesktopAdapter = {
    id: "null-adapter",
    platform,
    displayName: "Null Adapter (unsupported platform)",
    version: "0.0.0",
    capabilities: [],
    supportedOsVersions: "*",
    detectedOsVersion: typeof process !== "undefined" ? process.version : "0.0.0",
    healthy: false,
    statusMessage: "No adapter available for this platform",
    initializedAt: config.nowIso(),
  };

  return {
    metadata,

    async execute(action: FridayDesktopAction): Promise<FridayDesktopActionResult> {
      const now = config.nowIso();
      return {
        id: config.generateId(),
        action,
        status: "unsupported_platform",
        platform: metadata.platform,
        errorMessage: "No adapter registered for this platform",
        errorCode: FRIDAY_DESKTOP_ERROR_CODES.UNSUPPORTED_PLATFORM,
        durationMs: 0,
        startedAt: now,
        completedAt: now,
      };
    },

    async inspectElement(): Promise<FridayDesktopElement | null> {
      return null;
    },

    async searchElements(): Promise<FridayDesktopElement[]> {
      return [];
    },

    getCapabilities(): FridayDesktopCapability[] {
      return [];
    },

    async checkPermissions(): Promise<FridayDesktopPermission[]> {
      return [];
    },
  };
}

// ─── Platform Detection ───

function detectPlatform(): FridayDesktopPlatform | null {
  const p = typeof process !== "undefined" ? process.platform : undefined;
  if (p === "darwin" || p === "win32" || p === "linux") {
    return p;
  }
  return null;
}

// ─── Factory ───

/** Create an adapter manager instance. */
export function createAdapterManager(
  config: AdapterManagerConfig,
): AdapterManager {
  const registry = new Map<FridayDesktopPlatform, FridayDesktopAdapterRuntime>();
  const detectedPlatform = detectPlatform();
  const nullAdapterPlatform =
    detectedPlatform
    ?? (
      typeof process !== "undefined"
      && FRIDAY_DESKTOP_PLATFORMS.includes(process.platform as FridayDesktopPlatform)
      ? (process.platform as FridayDesktopPlatform)
      : "darwin"
    );
  const nullAdapter = createNullAdapter(config, nullAdapterPlatform);

  return {
    register(adapter: FridayDesktopAdapterRuntime): void {
      registry.set(adapter.metadata.platform, adapter);
    },

    unregister(platform: FridayDesktopPlatform): boolean {
      return registry.delete(platform);
    },

    getAdapter(platform: FridayDesktopPlatform): FridayDesktopAdapterRuntime | null {
      return registry.get(platform) ?? null;
    },

    getActiveAdapter(): FridayDesktopAdapterRuntime {
      if (detectedPlatform !== null) {
        const adapter = registry.get(detectedPlatform);
        if (adapter) return adapter;
      }
      return nullAdapter;
    },

    getDetectedPlatform(): FridayDesktopPlatform | null {
      return detectedPlatform;
    },

    listAdapters(): readonly FridayDesktopAdapter[] {
      return toFrozenSnapshot(Array.from(registry.values()).map((a) => a.metadata));
    },

    hasCapability(capability: FridayDesktopCapability): boolean {
      const adapter = this.getActiveAdapter();
      return adapter.getCapabilities().includes(capability);
    },
  };
}
