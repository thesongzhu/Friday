/**
 * Plugin loader: dynamic import, lifecycle management.
 *
 * Lifecycle: install → configure → enable → run → disable → uninstall
 * Error is reachable from any state.
 */

import * as fs from "node:fs";

import { FridayDomainError } from "#errors";
import type {
  FridayLoadedPlugin,
  FridayPluginEntity,
  FridayPluginEntrypointModule,
  FridayPluginKind,
  FridayPluginLoadPlan,
  FridayPluginStatus,
} from "../model/friday-plugin.types.js";
import { FRIDAY_CORE_CHANNEL_PLUGIN_IDS, FRIDAY_PLUGIN_ERROR_CODES } from "../model/friday-plugin.types.js";
import type { FridayPluginRegistryService } from "./friday-plugin-registry-service.js";
import type { FridayPluginSignatureVerifier } from "../security/friday-plugin-signature-verifier.js";
import { buildPluginLocalPackageBytes, resolvePluginInstallPath } from "./friday-plugin-package-bytes.js";

// ─── Types ───

export interface FridayPluginLoader {
  /** Loads plugins according to a resolved load plan. */
  load(plan: FridayPluginLoadPlan): Promise<FridayLoadedPlugin[]>;
  /** Unloads the given plugin IDs (calls deactivate). */
  unload(pluginIds: string[]): Promise<void>;
  /** Returns the currently loaded plugin map. */
  getLoaded(): Map<string, FridayLoadedPlugin>;
}

export interface CreateFridayPluginLoaderDeps {
  registry: FridayPluginRegistryService;
  signatureVerifier?: FridayPluginSignatureVerifier;
  nowIso: () => string;
  /** Override dynamic import for testing. */
  importModule?: (modulePath: string) => Promise<FridayPluginEntrypointModule>;
  /** Override file reading for fingerprint checks in testing. */
  readPackageBytes?: (installPath: string) => Buffer | null;
}

// ─── Valid Status Transitions ───

const FRIDAY_PLUGIN_STATUS_TRANSITIONS: Record<FridayPluginStatus, FridayPluginStatus[]> = {
  not_installed: ["installed", "error"],
  installed: ["configured", "enabled", "error", "uninstalled"],
  configured: ["enabled", "error", "uninstalled"],
  enabled: ["running", "disabled", "error", "uninstalled"],
  running: ["disabled", "error"],
  disabled: ["enabled", "error", "uninstalled"],
  error: ["installed", "configured", "enabled", "disabled", "uninstalled"],
  uninstalled: ["installed"],
};

// ─── Factory ───

export function createFridayPluginLoader(
  deps: CreateFridayPluginLoaderDeps,
): FridayPluginLoader {
  const { registry, nowIso, signatureVerifier, readPackageBytes } = deps;
  const loaded = new Map<string, FridayLoadedPlugin>();

  const importModule = deps.importModule ?? (async (modulePath: string): Promise<FridayPluginEntrypointModule> => {
    const mod = await import(modulePath) as Record<string, unknown>;
    // Support both default and named exports
    if (mod.default && typeof mod.default === "object") {
      return mod.default as FridayPluginEntrypointModule;
    }
    return mod as FridayPluginEntrypointModule;
  });

  function validateTransition(pluginId: string, from: FridayPluginStatus, to: FridayPluginStatus): void {
    const allowed = FRIDAY_PLUGIN_STATUS_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.INVALID_STATUS_TRANSITION,
        `Plugin "${pluginId}" cannot transition from "${from}" to "${to}"`,
        { httpStatus: 400, details: { pluginId, from, to, allowed } },
      );
    }
  }

  function readDefaultPackageBytes(entity: FridayPluginEntity): Buffer | null {
    try {
      return buildPluginLocalPackageBytes(entity.installPath, entity.manifest, (filePath) => fs.readFileSync(filePath));
    } catch (err) {
      if (err instanceof FridayDomainError) {
        throw err;
      }
      return null;
    }
  }

  function verifyTrustOnInstallFingerprint(entity: FridayPluginEntity): void {
    if (entity.trustMode !== "trust_on_install" || entity.source === "bundled") {
      return;
    }

    if (!entity.trustedFingerprintSha256) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.TRUST_FINGERPRINT_MISMATCH,
        `Plugin "${entity.id}" is trust-on-install but has no trusted fingerprint`,
        { httpStatus: 403, details: { pluginId: entity.id } },
      );
    }
    if (!signatureVerifier) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.SIGNATURE_REQUIRED,
        `Plugin "${entity.id}" requires fingerprint verification before loading`,
        { httpStatus: 403, details: { pluginId: entity.id } },
      );
    }

    const packageBytes = readPackageBytes
      ? readPackageBytes(entity.installPath)
      : readDefaultPackageBytes(entity);
    if (!packageBytes) {
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.TRUST_FINGERPRINT_MISMATCH,
        `Unable to read package bytes for plugin "${entity.id}" fingerprint verification`,
        { httpStatus: 403, details: { pluginId: entity.id } },
      );
    }

    const currentFingerprint = signatureVerifier.computeChecksum(
      Buffer.concat([
        Buffer.from(`${entity.id}\n${entity.version}\n`),
        packageBytes,
      ]),
    );
    if (currentFingerprint !== entity.trustedFingerprintSha256) {
      registry.setError(
        entity.id,
        FRIDAY_PLUGIN_ERROR_CODES.TRUST_FINGERPRINT_MISMATCH,
        `Fingerprint mismatch for plugin "${entity.id}": expected ${entity.trustedFingerprintSha256}, got ${currentFingerprint}`,
        nowIso(),
      );
      throw new FridayDomainError(
        FRIDAY_PLUGIN_ERROR_CODES.TRUST_FINGERPRINT_MISMATCH,
        `Fingerprint mismatch for plugin "${entity.id}": package has been modified since installation`,
        {
          httpStatus: 403,
          details: {
            pluginId: entity.id,
            expected: entity.trustedFingerprintSha256,
            actual: currentFingerprint,
          },
        },
      );
    }
  }

  async function loadSinglePlugin(entity: FridayPluginEntity): Promise<FridayLoadedPlugin> {
    const modules = new Map<FridayPluginKind, FridayPluginEntrypointModule>();

    for (const kind of entity.manifest.kinds) {
      const entrypointRelative = entity.manifest.entrypoints[kind];
      if (!entrypointRelative) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ENTRYPOINT_MISSING,
          `Plugin "${entity.id}" is missing entrypoint for kind "${kind}"`,
          { httpStatus: 400, details: { pluginId: entity.id, kind } },
        );
      }

      const entrypointPath = resolvePluginInstallPath(
        entity.installPath,
        entrypointRelative,
        entity.id,
        `entrypoint "${kind}"`,
      );

      try {
        const mod = await importModule(entrypointPath);
        modules.set(kind, mod);
      } catch (err) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.LOAD_FAILED,
          `Failed to load entrypoint for plugin "${entity.id}" kind "${kind}": ${err instanceof Error ? err.message : String(err)}`,
          { httpStatus: 500, cause: err, details: { pluginId: entity.id, kind, path: entrypointPath } },
        );
      }
    }

    return {
      id: entity.id,
      manifest: entity.manifest,
      modules,
    };
  }

  return {
    async load(plan: FridayPluginLoadPlan): Promise<FridayLoadedPlugin[]> {
      const result: FridayLoadedPlugin[] = [];

      for (const pluginId of plan.order) {
        const entity = registry.get(pluginId);
        if (!entity) {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.NOT_FOUND,
            `Plugin "${pluginId}" not found in registry`,
            { httpStatus: 404, details: { pluginId } },
          );
        }

        try {
          // Read actual current status from registry for accurate transition validation
          const currentStatus = entity.status;

          // Only allow load() from statuses that can legally reach "running"
          // via the transition table: configured → enabled → running, or enabled → running
          if (currentStatus !== "configured" && currentStatus !== "enabled") {
            throw new FridayDomainError(
              FRIDAY_PLUGIN_ERROR_CODES.INVALID_STATUS_TRANSITION,
              `Plugin "${pluginId}" cannot be loaded from status "${currentStatus}"; must be "configured" or "enabled"`,
              { httpStatus: 400, details: { pluginId, currentStatus } },
            );
          }

          verifyTrustOnInstallFingerprint(entity);

          // Transition to enabled if currently configured
          if (currentStatus === "configured") {
            validateTransition(pluginId, currentStatus, "enabled");
            registry.setStatus(pluginId, "enabled", nowIso());
          }

          const loadedPlugin = await loadSinglePlugin(entity);

          // Activate all modules
          for (const [kind, mod] of loadedPlugin.modules) {
            if (mod.activate) {
              try {
                await mod.activate({
                  pluginId: entity.id,
                  config: entity.config,
                });
              } catch (err) {
                throw new FridayDomainError(
                  FRIDAY_PLUGIN_ERROR_CODES.LIFECYCLE_ERROR,
                  `Plugin "${entity.id}" activate failed for kind "${kind}": ${err instanceof Error ? err.message : String(err)}`,
                  { httpStatus: 500, cause: err, details: { pluginId: entity.id, kind } },
                );
              }
            }
          }

          // Re-read status from registry to validate the transition to "running"
          // accurately reflects the current persisted state
          const preRunEntity = registry.get(pluginId);
          const preRunStatus = preRunEntity?.status ?? "enabled";
          validateTransition(pluginId, preRunStatus, "running");
          registry.setStatus(pluginId, "running", nowIso());

          loaded.set(pluginId, loadedPlugin);
          result.push(loadedPlugin);
        } catch (err) {
          // Set error status
          const errorMessage = err instanceof Error ? err.message : String(err);
          const errorCode = err instanceof FridayDomainError ? err.code : FRIDAY_PLUGIN_ERROR_CODES.LOAD_FAILED;
          registry.setError(pluginId, errorCode, errorMessage, nowIso());
          throw err;
        }
      }

      return result;
    },

    async unload(pluginIds: string[]): Promise<void> {
      // Unload in reverse order
      for (const pluginId of [...pluginIds].reverse()) {
        const loadedPlugin = loaded.get(pluginId);
        if (!loadedPlugin) continue;

        // Validate plugin is actually in running status before unloading
        const entity = registry.get(pluginId);
        if (entity && entity.status !== "running") {
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.INVALID_STATUS_TRANSITION,
            `Plugin "${pluginId}" cannot be unloaded from status "${entity.status}"; must be "running"`,
            { httpStatus: 400, details: { pluginId, currentStatus: entity.status } },
          );
        }

        // Deactivate in reverse order of kinds
        const kindsReversed = [...loadedPlugin.modules.entries()].reverse();
        for (const [kind, mod] of kindsReversed) {
          if (mod.deactivate) {
            try {
              await mod.deactivate();
            } catch (err) {
              throw new FridayDomainError(
                FRIDAY_PLUGIN_ERROR_CODES.LIFECYCLE_ERROR,
                `Plugin "${pluginId}" deactivate failed for kind "${kind}": ${err instanceof Error ? err.message : String(err)}`,
                { httpStatus: 500, cause: err, details: { pluginId, kind } },
              );
            }
          }
        }

        loaded.delete(pluginId);

        // Transition to disabled
        registry.setStatus(pluginId, "disabled", nowIso());
      }
    },

    getLoaded(): Map<string, FridayLoadedPlugin> {
      return new Map(loaded);
    },
  };
}
