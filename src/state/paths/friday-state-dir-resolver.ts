import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

export interface ResolveStateDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  existsSync?: (path: string) => boolean;
}

/**
 * Resolves Friday state directory.
 * Precedence:
 * 1) FRIDAY_STATE_DIR
 * 2) existing ~/.friday/state
 * 3) existing platform-convention path
 * 4) ~/.friday/state
 */
export function resolveStateDir(options?: ResolveStateDirOptions): string {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;
  const homedir = options?.homedir ?? os.homedir;
  const existsSync = options?.existsSync ?? fs.existsSync;

  const home = homedir();

  // 1) FRIDAY_STATE_DIR override
  const envDir = env.FRIDAY_STATE_DIR;
  if (envDir && envDir.trim() !== "") {
    const expanded = envDir.startsWith("~")
      ? path.join(home, envDir.slice(1))
      : envDir;
    return path.resolve(expanded);
  }

  // 2) Platform-convention path (preferred in Phase 8+)
  const platformPath = resolvePlatformStatePath(platform, home, env);
  if (platformPath && existsSync(platformPath)) {
    return platformPath;
  }

  // 3) Legacy default path (fallback)
  const legacyPath = path.join(home, ".friday", "state");
  if (existsSync(legacyPath)) {
    return legacyPath;
  }

  // 4) Fallback to platform path (create it) or legacy default
  return platformPath ?? legacyPath;
}

/** Resolves `${resolveStateDir()}/friday.db`. */
export function resolveFridayDbPath(options?: ResolveStateDirOptions): string {
  return path.join(resolveStateDir(options), "friday.db");
}

function resolvePlatformStatePath(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Friday", "state");
    case "linux": {
      const xdgState = env.XDG_STATE_HOME || path.join(home, ".local", "state");
      return path.join(xdgState, "friday");
    }
    case "win32": {
      const localAppData = env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      return path.join(localAppData, "Friday", "state");
    }
    default:
      return undefined;
  }
}
