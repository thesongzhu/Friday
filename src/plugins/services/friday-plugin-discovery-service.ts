/**
 * Scans local directories for plugins containing friday.plugin.json.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { FridayDomainError } from "#errors";
import type {
  FridayDiscoveredPluginCandidate,
} from "../model/friday-plugin.types.js";
import { FRIDAY_PLUGIN_ERROR_CODES, FRIDAY_PLUGIN_MANIFEST_FILENAME } from "../model/friday-plugin.types.js";
import type { FridayPluginManifestLoader } from "../manifest/friday-plugin-manifest-loader.js";

// ─── Types ───

export interface FridayPluginDiscoveryInput {
  localPaths?: string[];
}

export interface FridayPluginDiscoveryService {
  /** Discovers plugins in local directories. */
  discoverLocal(paths: string[]): FridayDiscoveredPluginCandidate[];
  /** Discovers all plugins from configured sources. */
  discoverAll(input?: FridayPluginDiscoveryInput): FridayDiscoveredPluginCandidate[];
}

export interface CreateFridayPluginDiscoveryServiceDeps {
  manifestLoader: FridayPluginManifestLoader;
  readdir?: (dirPath: string) => string[];
  isDirectory?: (filePath: string) => boolean;
  fileExists?: (filePath: string) => boolean;
}

// ─── Factory ───

export function createFridayPluginDiscoveryService(
  deps: CreateFridayPluginDiscoveryServiceDeps,
): FridayPluginDiscoveryService {
  const readdir = deps.readdir ?? ((p: string) => {
    try {
      return fs.readdirSync(p);
    } catch (err) {
      console.warn("[friday][plugin-discovery-service] readdir failed:", err instanceof Error ? err.message : String(err));
      return [];
    }
  });
  const isDirectory = deps.isDirectory ?? ((p: string) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch (err) {
      console.warn("[friday][plugin-discovery-service] stat failed:", err instanceof Error ? err.message : String(err));
      return false;
    }
  });
  const fileExists = deps.fileExists ?? ((p: string) => fs.existsSync(p));

  function discoverLocal(paths: string[]): FridayDiscoveredPluginCandidate[] {
    const candidates: FridayDiscoveredPluginCandidate[] = [];

    for (const basePath of paths) {
      if (!isDirectory(basePath)) continue;

      const entries = readdir(basePath);
      for (const entry of entries) {
        const pluginDir = path.join(basePath, entry);
        if (!isDirectory(pluginDir)) continue;

        const manifestPath = path.join(pluginDir, FRIDAY_PLUGIN_MANIFEST_FILENAME);
        if (!fileExists(manifestPath)) continue;

        try {
          const manifest = deps.manifestLoader.loadFromDirectory(pluginDir);
          candidates.push({
            id: manifest.id,
            version: manifest.version,
            source: "local",
            manifest,
            installPath: pluginDir,
          });
        } catch (err) {
          // Log and skip invalid plugins during discovery
          if (err instanceof FridayDomainError) {
            // Skip with warning — discovery is best-effort
            continue;
          }
          throw new FridayDomainError(
            FRIDAY_PLUGIN_ERROR_CODES.DISCOVERY_FAILED,
            `Failed to discover plugin at ${pluginDir}: ${err instanceof Error ? err.message : String(err)}`,
            { httpStatus: 500, cause: err },
          );
        }
      }
    }

    return candidates;
  }

  return {
    discoverLocal,

    discoverAll(input?: FridayPluginDiscoveryInput): FridayDiscoveredPluginCandidate[] {
      const localPaths = input?.localPaths ?? [];
      return discoverLocal(localPaths);
    },
  };
}
