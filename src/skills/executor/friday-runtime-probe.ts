import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";

export const FRIDAY_SKILL_PYTHON_BIN_ENV = "FRIDAY_SKILL_PYTHON_BIN";

function trimExecutable(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : null;
  }
  return trimmed;
}

function isPathLikeExecutable(command: string): boolean {
  return isAbsolute(command)
    || dirname(command) !== "."
    || command.includes("/")
    || command.includes("\\");
}

function probeExecutablePath(command: string): boolean {
  const path = normalize(command);
  let isFile = false;
  try {
    // The path comes from explicit local runtime configuration and is never executed here.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    isFile = statSync(path).isFile();
  } catch {
    return false;
  }
  if (!isFile) {
    return false;
  }
  if (process.platform === "win32") {
    return true;
  }
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function probeFridayExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const trimmed = trimExecutable(command);
  if (!trimmed) {
    return false;
  }

  if (isPathLikeExecutable(trimmed)) {
    return probeExecutablePath(trimmed);
  }

  const probe = process.platform === "win32"
    ? spawnSync("where", [trimmed], { encoding: "utf-8", env })
    : spawnSync("which", [trimmed], { encoding: "utf-8", env });
  return probe.status === 0;
}

export function resolveFridayPythonCommand(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = trimExecutable(env.FRIDAY_SKILL_PYTHON_BIN);
  if (explicit) {
    return probeFridayExecutable(explicit, env) ? explicit : null;
  }

  for (const candidate of ["python3", "python"]) {
    if (probeFridayExecutable(candidate, env)) {
      return candidate;
    }
  }

  return null;
}

export function getFridayPythonRuntimeUnavailableMessage(): string {
  return `Python-based skills require an installed Python interpreter. Install python3 or set ${FRIDAY_SKILL_PYTHON_BIN_ENV} to a valid executable.`;
}
