/**
 * Safe install directory utilities — backward-compatible re-exports from
 * the canonical security module (`src/security/friday-safe-install-dir.ts`).
 */

export {
  normalizeInstallId,
  validateInstallId,
  safeDirName,
  resolveSafeInstallDir,
} from "../security/friday-safe-install-dir.js";
export type { FridaySafeInstallPolicy } from "../security/friday-safe-install-dir.js";
