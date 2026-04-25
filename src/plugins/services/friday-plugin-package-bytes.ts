import * as path from "node:path";

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
