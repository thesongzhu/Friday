import { spawnSync } from "node:child_process";

export const FRIDAY_SKILL_PYTHON_BIN_ENV = "FRIDAY_SKILL_PYTHON_BIN";

function trimExecutable(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function probeFridayExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const trimmed = trimExecutable(command);
  if (!trimmed) {
    return false;
  }

  const probe = process.platform === "win32"
    ? spawnSync("where", [trimmed], { encoding: "utf-8", env })
    : spawnSync("which", [trimmed], { encoding: "utf-8", env });
  return probe.status === 0;
}

export function resolveFridayPythonCommand(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = trimExecutable(env[FRIDAY_SKILL_PYTHON_BIN_ENV]);
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
