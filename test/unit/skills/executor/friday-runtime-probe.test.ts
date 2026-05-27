import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FRIDAY_SKILL_PYTHON_BIN_ENV,
  probeFridayExecutable,
  resolveFridayPythonCommand,
} from "#skills";

describe("Friday runtime probe", () => {
  it("accepts an explicit executable path even when it is not discoverable on PATH", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: "",
      [FRIDAY_SKILL_PYTHON_BIN_ENV]: process.execPath,
    };

    expect(probeFridayExecutable(process.execPath, env)).toBe(true);
    expect(resolveFridayPythonCommand(env)).toBe(process.execPath);
  });

  it("unquotes an explicit executable path from environment configuration", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: "",
      [FRIDAY_SKILL_PYTHON_BIN_ENV]: `"${process.execPath}"`,
    };

    expect(resolveFridayPythonCommand(env)).toBe(process.execPath);
  });

  it("does not treat a missing explicit executable path as available", () => {
    const missingPath = join(
      tmpdir(),
      `friday-missing-python-${Date.now().toString()}-${Math.random().toString(36).slice(2)}`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: "",
      [FRIDAY_SKILL_PYTHON_BIN_ENV]: missingPath,
    };

    expect(probeFridayExecutable(missingPath, env)).toBe(false);
    expect(resolveFridayPythonCommand(env)).toBeNull();
  });
});
