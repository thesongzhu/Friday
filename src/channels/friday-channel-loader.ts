/**
 * Channel Loader — registry-driven channel resolution.
 *
 * Replaces hardcoded bootstrap switch statements with a factory registry.
 * Channel factories are registered by kind, then resolved at runtime
 * based on configuration. Supports both legacy plugins and adapter-based plugins.
 */

import { FridayDomainError } from "#errors";
import type { FridayChannelPlugin } from "./friday-channel.types.js";

// ─── Types ───

/** Factory function that creates a channel plugin instance. */
export type FridayChannelFactory = () => FridayChannelPlugin;

export interface FridayChannelLoaderOptions {
  /** Pre-register built-in channel factories. Defaults to empty (no built-ins). */
  builtins?: Record<string, FridayChannelFactory>;
}

export interface FridayChannelLoader {
  /** Register a factory for a channel kind. Overwrites existing factory. */
  registerFactory(kind: string, factory: FridayChannelFactory): void;

  /** Unregister a factory by kind. */
  unregisterFactory(kind: string): void;

  /** Check if a factory is registered for a kind. */
  hasFactory(kind: string): boolean;

  /** List all registered factory kinds. */
  listFactories(): string[];

  /**
   * Create a channel plugin for the given kind.
   * Throws if no factory is registered for that kind.
   */
  create(kind: string): FridayChannelPlugin;

  /**
   * Create and initialize a channel plugin with the given config.
   * Validates config through the adapter if available, then calls init().
   */
  createAndInit(kind: string, config: Record<string, unknown>): Promise<FridayChannelPlugin>;
}

// ─── Implementation ───

export function createFridayChannelLoader(
  options: FridayChannelLoaderOptions = {},
): FridayChannelLoader {
  const factories = new Map<string, FridayChannelFactory>();

  // Register builtins
  if (options.builtins) {
    for (const [kind, factory] of Object.entries(options.builtins)) {
      factories.set(kind, factory);
    }
  }

  return {
    registerFactory(kind, factory) {
      factories.set(kind, factory);
    },

    unregisterFactory(kind) {
      factories.delete(kind);
    },

    hasFactory(kind) {
      return factories.has(kind);
    },

    listFactories() {
      return Array.from(factories.keys());
    },

    create(kind) {
      const factory = factories.get(kind);
      if (!factory) {
        throw new FridayDomainError(
          "NOT_FOUND",
          `No channel factory registered for kind "${kind}". ` +
            `Available: ${Array.from(factories.keys()).join(", ") || "(none)"}`,
          { httpStatus: 404 },
        );
      }
      return factory();
    },

    async createAndInit(kind, config) {
      const plugin = this.create(kind);

      // Use config adapter validation if available
      if (plugin.adapters?.config) {
        const validated = plugin.adapters.config.validate(config);
        await plugin.init(validated as Record<string, unknown>);
      } else {
        await plugin.init(config);
      }

      return plugin;
    },
  };
}
