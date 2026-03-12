import * as path from "node:path";
import {
  resolveStateDir,
  type ResolveStateDirOptions,
} from "../state/paths/friday-state-dir-resolver.js";

export interface ResolveFridayConfigPathOptions extends ResolveStateDirOptions {
  stateDir?: string;
  fileName?: string;
}

/** Resolves the Phase 0 config path. Default: `${resolveStateDir()}/config.json5`. */
export function resolveFridayConfigPath(
  options?: ResolveFridayConfigPathOptions,
): string {
  const stateDir = options?.stateDir ?? resolveStateDir(options);
  const fileName = options?.fileName ?? "config.json5";
  return path.join(stateDir, fileName);
}
