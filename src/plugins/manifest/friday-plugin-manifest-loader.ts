/**
 * Reads and validates friday.plugin.json from a directory path.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { FridayDomainError } from "#errors";
import type { FridayPluginManifest } from "../model/friday-plugin.types.js";
import {
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_MANIFEST_FILENAME,
} from "../model/friday-plugin.types.js";
import { validateFridayPluginManifest } from "./friday-plugin-manifest.schema.js";

// ─── Types ───

export interface CreateFridayPluginManifestLoaderDeps {
  readFile?: (filePath: string) => string;
  fileExists?: (filePath: string) => boolean;
}

export interface FridayPluginManifestLoader {
  /** Loads and validates a plugin manifest from a directory. */
  loadFromDirectory(dirPath: string): FridayPluginManifest;
  /** Validates a raw JSON object as a manifest. */
  validate(raw: unknown): FridayPluginManifest;
}

// ─── Factory ───

export function createFridayPluginManifestLoader(
  deps?: CreateFridayPluginManifestLoaderDeps,
): FridayPluginManifestLoader {
  const readFile = deps?.readFile ?? ((p: string) => fs.readFileSync(p, "utf-8"));
  const fileExists = deps?.fileExists ?? ((p: string) => fs.existsSync(p));

  return {
    loadFromDirectory(dirPath: string): FridayPluginManifest {
      const manifestPath = path.join(dirPath, FRIDAY_PLUGIN_MANIFEST_FILENAME);

      if (!fileExists(manifestPath)) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_NOT_FOUND,
          `Plugin manifest not found at ${manifestPath}`,
          { httpStatus: 404, details: { path: manifestPath } },
        );
      }

      let rawContent: string;
      try {
        rawContent = readFile(manifestPath);
      } catch (err) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_PARSE_ERROR,
          `Failed to read plugin manifest at ${manifestPath}`,
          { httpStatus: 500, cause: err, details: { path: manifestPath } },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.MANIFEST_PARSE_ERROR,
          `Failed to parse plugin manifest JSON at ${manifestPath}`,
          { httpStatus: 400, cause: err, details: { path: manifestPath } },
        );
      }

      return validateFridayPluginManifest(parsed);
    },

    validate(raw: unknown): FridayPluginManifest {
      return validateFridayPluginManifest(raw);
    },
  };
}
