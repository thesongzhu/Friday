/**
 * Package Builder — Build agent packages from source.
 *
 * Bundles skills, config, metadata, and manifest into a structured package
 * representation ready for signing and publishing. Operates on an abstract
 * file-system interface for testability.
 *
 * @module packaging/engine/package-builder
 */

import type {
  FridayPackageManifest,
} from "../model/friday-packaging.types.js";
import { parseManifestJson, serializeManifest } from "./manifest-parser.js";

// ─── File System Abstraction ───

/** Abstract file entry in a package source directory. */
export interface SourceFile {
  /** Relative path within the source directory. */
  readonly path: string;
  /** File content as a UTF-8 string (for text) or raw bytes. */
  readonly content: string | Uint8Array;
  /** File size in bytes. */
  readonly sizeBytes: number;
}

/** Abstract file system for reading source files. */
export interface PackageFileSystem {
  /** Read a file by relative path. Returns null if not found. */
  readFile(path: string): string | null;
  /** List all files matching a glob pattern. */
  glob(pattern: string): readonly string[];
  /** Check if a file exists. */
  exists(path: string): boolean;
}

// ─── Build Result ───

/** A built package ready for signing and publishing. */
export interface BuiltPackage {
  /** The validated manifest. */
  readonly manifest: FridayPackageManifest;
  /** Canonical manifest JSON. */
  readonly manifestJson: string;
  /** Collected asset files organized by category. */
  readonly assets: BuiltPackageAssets;
  /** All files that should be included in the archive. */
  readonly files: readonly PackageFile[];
  /** Total size of all files in bytes. */
  readonly totalSizeBytes: number;
}

/** Categorized asset files. */
export interface BuiltPackageAssets {
  readonly skills: readonly string[];
  readonly rules: readonly string[];
  readonly playbooks: readonly string[];
  readonly providers: readonly string[];
}

/** A file to include in the package archive. */
export interface PackageFile {
  /** Path within the archive. */
  readonly archivePath: string;
  /** File content. */
  readonly content: string;
}

/** Build error. */
export interface BuildError {
  readonly path: string;
  readonly message: string;
}

/** Build result. */
export interface BuildResult {
  readonly success: boolean;
  readonly package: BuiltPackage | null;
  readonly errors: readonly BuildError[];
}

// ─── Builder Configuration ───

/** Configuration for the package builder. */
export interface PackageBuilderConfig {
  /** Maximum total package size in bytes. @default 104_857_600 (100 MB) */
  readonly maxSizeBytes?: number;
}

// ─── Builder ───

/**
 * Build a package from a source directory.
 *
 * Reads the manifest file, validates it, collects all referenced
 * assets, and produces a BuiltPackage ready for archive creation
 * and signing.
 *
 * @param fs - Abstract file system for reading source files
 * @param manifestPath - Path to the manifest file (default: "manifest.json")
 * @param config - Builder configuration
 */
export function buildPackage(
  fs: PackageFileSystem,
  manifestPath: string = "manifest.json",
  config?: PackageBuilderConfig,
): BuildResult {
  const maxSize = config?.maxSizeBytes ?? 104_857_600;
  const errors: BuildError[] = [];

  // 1. Read manifest
  const manifestContent = fs.readFile(manifestPath);
  if (!manifestContent) {
    return {
      success: false,
      package: null,
      errors: [{ path: manifestPath, message: "Manifest file not found" }],
    };
  }

  // 2. Parse and validate manifest
  const parseResult = parseManifestJson(manifestContent);
  if (!parseResult.success || !parseResult.manifest) {
    return {
      success: false,
      package: null,
      errors: parseResult.errors.map((e) => ({
        path: e.path || manifestPath,
        message: e.message,
      })),
    };
  }

  const manifest = parseResult.manifest;
  const manifestJson = serializeManifest(manifest);

  // 3. Collect asset files
  const assetFiles: BuiltPackageAssets = {
    skills: collectAssets(fs, manifest.assets?.skills, "assets.skills", errors),
    rules: collectAssets(fs, manifest.assets?.rules, "assets.rules", errors),
    playbooks: collectAssets(fs, manifest.assets?.playbooks, "assets.playbooks", errors),
    providers: collectAssets(fs, manifest.assets?.providers, "assets.providers", errors),
  };

  // 4. Collect hook scripts
  if (manifest.hooks) {
    for (const [hookName, hookPath] of Object.entries(manifest.hooks)) {
      if (hookPath && typeof hookPath === "string") {
        if (!fs.exists(hookPath)) {
          errors.push({
            path: `hooks.${hookName}`,
            message: `Hook script not found: ${hookPath}`,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return { success: false, package: null, errors };
  }

  // 5. Build file list for archive
  const fileContentsByPath = new Map<string, string>();
  fileContentsByPath.set("manifest.json", manifestJson);

  // Asset files (sorted for deterministic archive generation)
  const allAssetPaths = [
    ...assetFiles.skills,
    ...assetFiles.rules,
    ...assetFiles.playbooks,
    ...assetFiles.providers,
  ].sort((a, b) => a.localeCompare(b));

  for (const assetPath of allAssetPaths) {
    const content = fs.readFile(assetPath);
    if (content) {
      fileContentsByPath.set(assetPath, content);
    }
  }

  // Hook scripts (sorted for deterministic archive generation)
  if (manifest.hooks) {
    const hookPaths = Object.values(manifest.hooks)
      .filter((hookPath): hookPath is string => typeof hookPath === "string")
      .sort((a, b) => a.localeCompare(b));
    for (const hookPath of hookPaths) {
      const content = fs.readFile(hookPath);
      if (content) {
        fileContentsByPath.set(hookPath, content);
      }
    }
  }

  // README
  if (fs.exists("README.md")) {
    const readme = fs.readFile("README.md");
    if (readme) {
      fileContentsByPath.set("README.md", readme);
    }
  }

  const files: PackageFile[] = [...fileContentsByPath.entries()]
    .sort(([pathA], [pathB]) => pathA.localeCompare(pathB))
    .map(([archivePath, content]) => ({ archivePath, content }));

  // 6. Calculate total size
  const totalSizeBytes = files.reduce(
    (sum, f) => sum + new TextEncoder().encode(f.content).length,
    0,
  );

  if (totalSizeBytes > maxSize) {
    return {
      success: false,
      package: null,
      errors: [
        {
          path: "",
          message: `Package size ${totalSizeBytes} bytes exceeds maximum ${maxSize} bytes`,
        },
      ],
    };
  }

  return {
    success: true,
    package: {
      manifest,
      manifestJson,
      assets: assetFiles,
      files,
      totalSizeBytes,
    },
    errors: [],
  };
}

// ─── Asset Collection ───

function collectAssets(
  fs: PackageFileSystem,
  patterns: readonly string[] | undefined,
  fieldPath: string,
  errors: BuildError[],
): readonly string[] {
  if (!patterns || patterns.length === 0) return [];

  const collected: string[] = [];
  for (const pattern of patterns) {
    const matched = fs.glob(pattern);
    if (matched.length === 0) {
      errors.push({
        path: fieldPath,
        message: `No files matched glob pattern: ${pattern}`,
      });
    }
    collected.push(...matched);
  }
  return [...new Set(collected)]; // deduplicate
}

/**
 * Create a simple in-memory file system for testing.
 */
export function createMemoryFileSystem(
  files: ReadonlyMap<string, string>,
): PackageFileSystem {
  return {
    readFile(path: string): string | null {
      return files.get(path) ?? null;
    },

    glob(pattern: string): readonly string[] {
      // Simple glob: support only trailing * (e.g., "assets/skills/*.yaml")
      const paths = [...files.keys()];
      if (pattern.includes("*")) {
        const prefix = pattern.substring(0, pattern.indexOf("*"));
        const suffix = pattern.substring(pattern.lastIndexOf("*") + 1);
        return paths.filter((p) => p.startsWith(prefix) && p.endsWith(suffix));
      }
      return paths.filter((p) => p === pattern);
    },

    exists(path: string): boolean {
      return files.has(path);
    },
  };
}
