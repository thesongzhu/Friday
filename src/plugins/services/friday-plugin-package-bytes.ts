import * as path from "node:path";
import * as fs from "node:fs";

import { FridayDomainError } from "#errors";
import {
  FRIDAY_PLUGIN_ERROR_CODES,
  FRIDAY_PLUGIN_MANIFEST_FILENAME,
} from "../model/friday-plugin.types.js";
import type { FridayPluginManifest } from "../model/friday-plugin.types.js";

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolvePluginInstallPath(
  installPath: string,
  relativePath: string,
  pluginId: string,
  label: string,
): string {
  if (path.isAbsolute(relativePath)) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.ENTRYPOINT_INVALID,
      `Plugin "${pluginId}" ${label} must be relative to the install directory`,
      { httpStatus: 400, details: { pluginId, relativePath, label } },
    );
  }

  const root = path.resolve(installPath);
  const resolved = path.resolve(root, relativePath);
  if (!pathIsInside(root, resolved)) {
    throw new FridayDomainError(
      FRIDAY_PLUGIN_ERROR_CODES.ENTRYPOINT_INVALID,
      `Plugin "${pluginId}" ${label} escapes the install directory`,
      { httpStatus: 400, details: { pluginId, relativePath, resolved, installPath: root, label } },
    );
  }
  return resolved;
}

export function buildPluginLocalPackageBytes(
  installPath: string,
  manifest: FridayPluginManifest,
  readFileAsBuffer: (filePath: string) => Buffer,
): Buffer {
  const root = path.resolve(installPath);
  if (fs.existsSync(root)) {
    const files = collectPluginPackageFiles(root, manifest.id);
    const parts: Buffer[] = [];
    for (const relativePath of files) {
      const fullPath = resolvePluginInstallPath(installPath, relativePath, manifest.id, `package file "${relativePath}"`);
      const content = readFileAsBuffer(fullPath);
      parts.push(Buffer.from(`${relativePath}\0${String(content.length)}\n`, "utf8"), content, Buffer.from("\n", "utf8"));
    }
    return Buffer.concat(parts);
  }

  const manifestPath = resolvePluginInstallPath(
    installPath,
    FRIDAY_PLUGIN_MANIFEST_FILENAME,
    manifest.id,
    "manifest path",
  );
  const parts: Buffer[] = [readFileAsBuffer(manifestPath)];

  const entrypointKeys = Object.keys(manifest.entrypoints).sort();
  for (const kind of entrypointKeys) {
    const relative = manifest.entrypoints[kind as keyof typeof manifest.entrypoints];
    if (!relative) continue;
    const fullPath = resolvePluginInstallPath(installPath, relative, manifest.id, `entrypoint "${kind}"`);
    parts.push(readFileAsBuffer(fullPath));
  }

  return Buffer.concat(parts);
}

function collectPluginPackageFiles(root: string, pluginId: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.resolve(dir, entry.name);
      if (!pathIsInside(root, fullPath)) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ENTRYPOINT_INVALID,
          `Plugin "${pluginId}" package entry escapes the install directory`,
          { httpStatus: 400, details: { pluginId, fullPath, installPath: root } },
        );
      }

      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ENTRYPOINT_INVALID,
          `Plugin "${pluginId}" package contains an unsupported symbolic link`,
          { httpStatus: 400, details: { pluginId, fullPath, installPath: root } },
        );
      }

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stat.isFile()) {
        throw new FridayDomainError(
          FRIDAY_PLUGIN_ERROR_CODES.ENTRYPOINT_INVALID,
          `Plugin "${pluginId}" package contains an unsupported filesystem entry`,
          { httpStatus: 400, details: { pluginId, fullPath, installPath: root } },
        );
      }

      files.push(path.relative(root, fullPath).split(path.sep).join("/"));
    }
  }

  walk(root);
  return files.sort();
}
