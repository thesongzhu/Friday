import * as crypto from "node:crypto";
import * as path from "node:path";
import { FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR } from "./friday-memory-file-sync.constants.js";

/**
 * Resolve the root export directory.
 */
export function resolveExportRoot(stateDir: string): string {
  return path.join(stateDir, FRIDAY_MEMORY_FILE_SYNC_EXPORT_DIR);
}

/**
 * Deterministic file path for a memory namespace export.
 * Sanitizes namespace to filesystem-safe characters + hash suffix for uniqueness.
 */
export function memoryNamespaceExportPath(stateDir: string, namespace: string): string {
  const safeName = safeFilename(namespace);
  return path.join(resolveExportRoot(stateDir), "memory", `${safeName}.json`);
}

/**
 * Deterministic file path for a session transcript export.
 * Sanitizes session key to filesystem-safe characters + hash suffix for uniqueness.
 */
export function sessionKeyExportPath(stateDir: string, sessionKey: string): string {
  const safeName = safeFilename(sessionKey);
  return path.join(resolveExportRoot(stateDir), "sessions", `${safeName}.jsonl`);
}

/**
 * Build a filesystem-safe filename from an arbitrary key.
 *
 * Strategy:
 *   1. Sanitize to [a-zA-Z0-9._-], collapse runs, trim.
 *   2. Append a 32-hex-char (128-bit) SHA-256 hash suffix for collision resistance.
 *   3. Truncate the sanitized prefix to keep total filename ≤ 200 chars.
 *
 * Same key always produces the same filename (deterministic).
 */
function safeFilename(input: string): string {
  const hash = crypto.createHash("sha256").update(input).digest("hex").slice(0, 32);
  let sanitized = input
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!sanitized) sanitized = "unnamed";

  // Truncate prefix: max 200 - 1 (separator) - 32 (hash) = 167
  const maxPrefix = 167;
  if (sanitized.length > maxPrefix) {
    sanitized = sanitized.slice(0, maxPrefix);
  }

  return `${sanitized}_${hash}`;
}
